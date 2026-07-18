// Chat about the current notebook, answered by a local model served from
// LM Studio's OpenAI-compatible server (Developer tab → Start Server, with
// CORS enabled — the app runs on a different origin than the server).
// Everything stays on this machine; the panel only works while that server is
// running. Conversations are kept in memory per notebook and reset on reload.

const URL_KEY = 'notebook.lmstudio.url';
const DEFAULT_URL = 'http://localhost:1234';

// Reasoning ("thinking") is off by default: local models spend minutes on
// hidden chain-of-thought before the first visible word. The 🧠 toggle turns
// it back on for hard questions. Implemented with Qwen's soft switch — the
// outgoing message gets "/no_think" appended (never shown, never stored), and
// only when the loaded model is a Qwen; other models don't know the tag.
const THINK_KEY = 'notebook.chat.think';

function isThinkingOn() {
  return localStorage.getItem(THINK_KEY) === '1';
}

// Page transcriptions travel as plain text in the system prompt. Local models
// have small context windows and modest hardware pays for every token at the
// start of each conversation, so cap what we send and say what was left out.
// This is only a ceiling: the real budget is sized to the loaded model's
// context length per request (see contextCharBudget).
const CONTEXT_CHAR_BUDGET = 14000;
const HISTORY_SENT = 12; // most recent messages included per request

// Rough char↔token ratio for sizing the context. Deliberately low (mixed
// prose, code and math OCR pack more tokens per char than plain English) so
// we under-fill rather than overflow the model's window.
const CHARS_PER_TOKEN = 3.5;
// Token headroom kept free within the context for the model's own answer and
// the fixed system-prompt instructions.
const REPLY_TOKEN_RESERVE = 800;
const BOILERPLATE_TOKEN_RESERVE = 400;
// Assumed context length when the server won't report one (older LM Studio
// without /api/v0). Conservative on purpose — better a short prompt than a
// crash on a small-context model.
const FALLBACK_CONTEXT_TOKENS = 4096;

// How many characters of notebook text fit alongside the reply, the boilerplate
// and this turn's conversation history, given the loaded model's context.
function contextCharBudget(contextTokens, sentHistory) {
  const ctx = contextTokens || FALLBACK_CONTEXT_TOKENS;
  const historyTokens = Math.ceil(
    sentHistory.reduce((n, m) => n + m.content.length, 0) / CHARS_PER_TOKEN
  );
  const availTokens =
    ctx - REPLY_TOKEN_RESERVE - BOILERPLATE_TOKEN_RESERVE - historyTokens;
  return Math.min(
    CONTEXT_CHAR_BUDGET,
    Math.max(0, Math.floor(availTokens * CHARS_PER_TOKEN))
  );
}

export function getChatServerUrl() {
  return (
    (localStorage.getItem(URL_KEY) || '').trim().replace(/\/+$/, '') || DEFAULT_URL
  );
}

export function getStoredChatServerUrl() {
  return localStorage.getItem(URL_KEY) || '';
}

export function setChatServerUrl(url) {
  if (url) localStorage.setItem(URL_KEY, url);
  else localStorage.removeItem(URL_KEY);
}

const $ = (sel) => document.querySelector(sel);

let getContext = null; // () => { id, name, pages }, supplied by main.js
const histories = new Map(); // notebookId -> [{ role, content, error? }]
let streamCtrl = null; // AbortController while a reply is streaming
let serverOk = false;

function history() {
  const { id } = getContext();
  if (!histories.has(id)) histories.set(id, []);
  return histories.get(id);
}

// ---------- LM Studio client ----------

// Pick the model to talk to — whichever one is loaded in LM Studio, so there
// is nothing to choose in the app. Called before every request; also serves
// as the "is the server up?" probe. Returns { id, contextLength }, where
// contextLength is the loaded context window in tokens (null if the server
// doesn't report it). LM Studio's own REST API says what is in memory; servers
// without it fall back to the first chat model /v1 lists.
async function resolveModel() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  const noModel =
    'the server is running but no model is loaded — load one in LM Studio';
  try {
    try {
      const resp = await fetch(`${getChatServerUrl()}/api/v0/models`, {
        signal: ctrl.signal,
      });
      if (resp.ok) {
        const loaded = ((await resp.json()).data || []).find(
          (m) => m.state === 'loaded' && m.type !== 'embeddings'
        );
        if (!loaded) throw new Error(noModel);
        return {
          id: loaded.id,
          contextLength:
            loaded.loaded_context_length ?? loaded.max_context_length ?? null,
        };
      }
    } catch (err) {
      if (err.message === noModel || err.name === 'AbortError') throw err;
      // Older server without /api/v0 — fall through to the OpenAI endpoint.
    }
    const resp = await fetch(`${getChatServerUrl()}/v1/models`, {
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const ids = ((await resp.json()).data || [])
      .map((m) => m.id)
      .filter((id) => !/embed/i.test(id)); // embedding models can't chat
    if (ids.length === 0) throw new Error(noModel);
    return { id: ids[0], contextLength: null };
  } finally {
    clearTimeout(t);
  }
}

async function streamCompletion(model, messages, signal, onDelta) {
  const resp = await fetch(`${getChatServerUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.7,
    }),
    signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`LM Studio ${resp.status}: ${body.slice(0, 200)}`);
  }

  // OpenAI-style SSE: `data: {json}` lines, closed by `data: [DONE]`.
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let delta;
      try {
        delta = JSON.parse(payload).choices?.[0]?.delta;
      } catch {
        continue; // keep-alive or partial line
      }
      // Reasoning models stream their hidden thinking as reasoning_content;
      // surface it so the UI can show progress instead of looking stuck.
      if (delta?.content || delta?.reasoning_content) {
        onDelta({ content: delta.content, reasoning: delta.reasoning_content });
      }
    }
  }
}

// ---------- notebook context ----------

// Fold case + strip accents so query terms match regardless of accent/case.
function fold(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Meaningful terms from the question, used to pull the pages that actually
// answer it into a limited context. Drops short words and common stopwords so
// "¿qué es PCIe?" keys on "pcie", not "que"/"es".
const STOPWORDS = new Set(
  (
    'que qué de la el los las un una unos unas y o u en del al con por para se su sus lo mas más ' +
    'como cómo cual cuál cuales cuáles donde dónde cuando cuándo sobre este esta esto ese esa eso ' +
    'what is are was the a an of in on for to and or how does do about my me tell explain give'
  ).split(/\s+/)
);

function queryTerms(q) {
  return [
    ...new Set(
      fold(q)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    ),
  ];
}

// How many times the query terms appear in a page's (folded) text.
function scorePage(foldedText, terms) {
  let score = 0;
  for (const term of terms) {
    let idx = 0;
    while ((idx = foldedText.indexOf(term, idx)) !== -1) {
      score++;
      idx += term.length;
    }
  }
  return score;
}

function buildSystemPrompt(name, pages, query, budget = CONTEXT_CHAR_BUDGET) {
  const terms = queryTerms(query);
  const entries = [];
  let withText = 0;
  pages.forEach((p, i) => {
    const text = (p.text || '').trim();
    if (!text) return;
    withText++;
    entries.push({
      i,
      chunk: `--- Page ${i + 1} ---\n${text}`,
      score: scorePage(fold(text), terms),
    });
  });

  // Fit pages to the budget most-relevant-first, so the pages that answer the
  // question survive truncation even when they sit deep in a long notebook.
  // With no usable query terms this is a stable no-op and pages fill in order.
  const kept = new Set();
  let used = 0;
  for (const e of [...entries].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (used + e.chunk.length + 2 > budget) continue;
    kept.add(e.i);
    used += e.chunk.length + 2;
  }
  // Emit the kept pages in page order for a natural top-to-bottom read.
  const chunks = entries.filter((e) => kept.has(e.i)).map((e) => e.chunk);

  const notes = [
    `The notebook has ${pages.length} page(s); ${withText} of them are transcribed.`,
  ];
  if (chunks.length < withText) {
    notes.push(
      terms.length
        ? `Only ${chunks.length} of the transcribed pages fit below; they were chosen for relevance to the question. Others you have may still cover it, so if the answer isn't here, say it may be on a page not shown rather than that the notebook lacks it.`
        : `Only ${chunks.length} transcribed page(s) fit below; the rest were cut to fit the model's context.`
    );
  }

  return [
    `You are the reading assistant built into a digital notebook app. The user has open their notebook titled "${name}".`,
    'Below are OCR transcriptions of its handwritten pages, so occasional transcription mistakes are possible.',
    'Use the notebook as context, not as a limit: when the answer is on its pages, point to them like (p. 3), and feel free to combine that with your general knowledge to explain, expand, or answer beyond it. Just never claim the notebook says something it does not.',
    'If the notebook has nothing on the question, say so briefly and answer it anyway from your general knowledge.',
    'Write in a warm, close, plain-spoken tone — clear and to the point. Reply in the same language the user writes in.',
    '',
    notes.join(' '),
    '',
    chunks.join('\n\n'),
  ].join('\n');
}

// ---------- rendering ----------

// Local models answer in Markdown; render a small safe subset (headings,
// bold/italic, inline code, fenced code, lists). Everything is HTML-escaped
// first, so only the tags emitted here ever reach innerHTML.

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function renderMarkdown(md) {
  const lines = escapeHtml(md).split('\n');
  const out = [];
  let para = []; // pending paragraph lines
  let list = null; // 'ul' | 'ol' while inside a list
  let code = null; // pending code-block lines while inside a ``` fence

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${code.join('\n')}</code></pre>`);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushPara();
      closeList();
      code = [];
      continue;
    }
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) {
      flushPara();
      closeList();
      out.push(`<div class="md-h">${mdInline(h[1])}</div>`);
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) {
        closeList();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${mdInline((ul || ol)[1])}</li>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    closeList();
    para.push(line);
  }
  if (code) out.push(`<pre><code>${code.join('\n')}</code></pre>`); // fence still open mid-stream
  flushPara();
  closeList();
  return out.join('');
}

function bubble(m) {
  const div = document.createElement('div');
  div.className = `chat-msg ${m.role}${m.error ? ' error' : ''}`;
  if (m.role === 'assistant' && !m.error) {
    div.classList.add('md');
    div.innerHTML = renderMarkdown(m.content);
  } else {
    div.textContent = m.content;
  }
  return div;
}

function updateContextLine() {
  const { pages } = getContext();
  const withText = pages.filter((p) => (p.text || '').trim()).length;
  $('#chat-context').textContent = pages.length
    ? `Context: ${withText} of ${pages.length} page${
        pages.length === 1 ? '' : 's'
      } transcribed`
    : 'This notebook has no pages yet.';
}

function render() {
  updateContextLine();
  const box = $('#chat-messages');
  box.replaceChildren();
  const msgs = history();
  if (msgs.length === 0) {
    const { name } = getContext();
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = `Ask anything about “${name}” — its transcribed pages are the model's context.`;
    box.appendChild(empty);
    return;
  }
  for (const m of msgs) box.appendChild(bubble(m));
  box.scrollTop = box.scrollHeight;
}

function setComposerEnabled(on) {
  $('#chat-input').disabled = !on;
  $('#chat-send').disabled = !on;
}

// While a reply streams, the send button turns into a stop button.
function setSendStopping(on) {
  const btn = $('#chat-send');
  btn.textContent = on ? '◼' : '➤';
  btn.title = on ? 'Stop' : 'Send';
}

// Probe the server and flip between the composer and the "server not
// running" notice. The model itself is resolved fresh on every send.
async function connect() {
  const offline = $('#chat-offline');
  const note = $('#chat-offline-note');
  serverOk = false;
  setComposerEnabled(false);
  offline.hidden = false;
  $('#chat-retry').hidden = true;
  note.textContent = 'Looking for the LM Studio server…';
  try {
    await resolveModel();
    serverOk = true;
    offline.hidden = true;
    setComposerEnabled(true);
    $('#chat-input').focus();
  } catch (err) {
    note.textContent = `Can't reach LM Studio at ${getChatServerUrl()} — ${err.message}`;
    $('#chat-retry').hidden = false;
  }
}

// ---------- sending ----------

async function send() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || streamCtrl || !serverOk) return;
  const { name, pages } = getContext();
  const msgs = history();

  msgs.push({ role: 'user', content: text });
  input.value = '';
  autosize(input);
  render();

  // The conversation history to send (failed exchanges are shown but never
  // sent back). Captured before the empty reply below so it isn't included.
  const priorMsgs = msgs
    .filter((m) => !m.error)
    .slice(-HISTORY_SENT)
    .map(({ role, content }) => ({ role, content }));

  const reply = { role: 'assistant', content: '' };
  msgs.push(reply);
  const box = $('#chat-messages');
  const div = bubble(reply);
  div.classList.add('streaming', 'pending');
  // On modest hardware the model can spend minutes reading the context and
  // then thinking (reasoning models) before the first visible word, so name
  // the phase instead of showing an empty bubble that looks frozen.
  div.textContent = 'Reading the notebook…';
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;

  streamCtrl = new AbortController();
  setSendStopping(true);
  try {
    // Re-resolve so switching models in LM Studio mid-conversation is picked
    // up by the very next message. Its context length sizes how much notebook
    // text we can attach without overflowing the model's window.
    const { id: model, contextLength } = await resolveModel();
    // With thinking off, tag only the outgoing copy of this turn's message —
    // the stored history stays clean, so every turn follows the toggle.
    const outgoing = priorMsgs.map((m) => ({ ...m }));
    const last = outgoing[outgoing.length - 1];
    if (!isThinkingOn() && /qwen/i.test(model) && last?.role === 'user') {
      last.content += ' /no_think';
    }
    const sent = [
      {
        role: 'system',
        content: buildSystemPrompt(
          name,
          pages,
          text,
          contextCharBudget(contextLength, priorMsgs)
        ),
      },
      ...outgoing,
    ];
    // Reasoning models spend long stretches on hidden thinking before the
    // first visible word. Stream that thinking live (LM Studio-style, just
    // the rolling tail) so the wait reads as progress, not a hang; the
    // answer replaces it and the reasoning is never kept in the history.
    let thinkingLen = 0;
    let thinkingTail = '';
    await streamCompletion(model, sent, streamCtrl.signal, ({ content, reasoning }) => {
      if (content) {
        reply.content += content;
        div.classList.remove('pending');
        div.innerHTML = renderMarkdown(reply.content);
      } else if (reasoning && !reply.content) {
        thinkingLen += reasoning.length;
        thinkingTail = (thinkingTail + reasoning).slice(-280).trimStart();
        div.textContent = `Thinking…\n${thinkingLen > 280 ? '…' : ''}${thinkingTail}`;
      }
      // Follow the reply unless the user scrolled up to read something.
      if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) {
        box.scrollTop = box.scrollHeight;
      }
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Chat failed', err);
      reply.error = true;
      reply.content = reply.content
        ? `${reply.content}\n\n[Interrupted: ${err.message}]`
        : `Request failed: ${err.message}`;
      div.classList.add('error');
      div.classList.remove('pending', 'md');
      div.textContent = reply.content;
    }
  } finally {
    div.classList.remove('streaming', 'pending');
    // Stopped before the first token: drop the empty bubble.
    if (!reply.content) {
      msgs.pop();
      div.remove();
    }
    streamCtrl = null;
    setSendStopping(false);
  }
}

// ---------- panel wiring ----------

function setChatHidden(hidden) {
  $('#chat').hidden = hidden;
  if (!hidden) $('#panel').hidden = true; // one side panel at a time
  // The book shares the row with this panel; StPageFlip refits on 'resize'.
  window.dispatchEvent(new Event('resize'));
  if (!hidden) {
    render();
    connect(); // re-probe every open — the server may have started/stopped
  }
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
}

// Called by main.js whenever another notebook is loaded, so an open chat
// switches to that notebook's conversation and context.
export function chatNotebookChanged() {
  if (!getContext || $('#chat').hidden) return;
  render();
}

export function initChat(opts) {
  getContext = opts.getContext;

  $('#chat-btn').addEventListener('click', () =>
    setChatHidden($('#chat').hidden === false)
  );
  $('#chat-close').addEventListener('click', () => setChatHidden(true));

  const think = $('#chat-think');
  const applyThink = () => {
    const on = isThinkingOn();
    think.classList.toggle('active', on);
    think.setAttribute('aria-pressed', String(on));
    think.title = on
      ? 'Thinking is ON: deeper answers, but slow to start. Click for instant replies.'
      : 'Thinking is OFF: replies start right away. Click to let the model think first (better for hard questions, slower).';
  };
  think.addEventListener('click', () => {
    if (isThinkingOn()) localStorage.removeItem(THINK_KEY);
    else localStorage.setItem(THINK_KEY, '1');
    applyThink();
  });
  applyThink();
  $('#chat-retry').addEventListener('click', connect);
  $('#chat-clear').addEventListener('click', () => {
    histories.set(getContext().id, []);
    render();
  });
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (streamCtrl) streamCtrl.abort();
    else send();
  });

  const input = $('#chat-input');
  input.addEventListener('input', () => autosize(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });
}
