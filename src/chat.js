// Chat about the current notebook, answered by a local model served from
// LM Studio's OpenAI-compatible server (Developer tab → Start Server, with
// CORS enabled — the app runs on a different origin than the server).
// Everything stays on this machine; the panel only works while that server is
// running. Conversations are kept in memory per notebook and reset on reload.

const URL_KEY = 'notebook.lmstudio.url';
const MODEL_KEY = 'notebook.lmstudio.model';
const DEFAULT_URL = 'http://localhost:1234';

// Page transcriptions travel as plain text in the system prompt. Local models
// have small context windows and modest hardware pays for every token at the
// start of each conversation, so cap what we send and say what was left out.
const CONTEXT_CHAR_BUDGET = 14000;
const HISTORY_SENT = 12; // most recent messages included per request

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

// Also serves as the "is the server up?" probe.
async function fetchModels() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const resp = await fetch(`${getChatServerUrl()}/v1/models`, {
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    // Embedding models can't chat; keep them out of the picker.
    return (data.data || []).map((m) => m.id).filter((id) => !/embed/i.test(id));
  } finally {
    clearTimeout(t);
  }
}

async function streamCompletion(messages, signal, onDelta) {
  const resp = await fetch(`${getChatServerUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: $('#chat-model').value,
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

function buildSystemPrompt(name, pages) {
  const chunks = [];
  let used = 0;
  let included = 0;
  let withText = 0;
  pages.forEach((p, i) => {
    const text = (p.text || '').trim();
    if (!text) return;
    withText++;
    const chunk = `--- Page ${i + 1} ---\n${text}`;
    if (used + chunk.length > CONTEXT_CHAR_BUDGET) return;
    chunks.push(chunk);
    used += chunk.length;
    included++;
  });

  const notes = [
    `The notebook has ${pages.length} page(s); ${withText} of them are transcribed.`,
  ];
  if (included < withText) {
    notes.push(
      `Only ${included} transcribed page(s) fit below; the rest were cut to fit the model's context.`
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

function bubble(m) {
  const div = document.createElement('div');
  div.className = `chat-msg ${m.role}${m.error ? ' error' : ''}`;
  div.textContent = m.content;
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

// Probe the server, fill the model picker, and flip between the composer and
// the "server not running" notice.
async function connect() {
  const offline = $('#chat-offline');
  const note = $('#chat-offline-note');
  const select = $('#chat-model');
  serverOk = false;
  select.hidden = true;
  setComposerEnabled(false);
  offline.hidden = false;
  $('#chat-retry').hidden = true;
  note.textContent = 'Looking for the LM Studio server…';
  try {
    const models = await fetchModels();
    if (models.length === 0) {
      throw new Error('the server is running but no chat model is loaded');
    }
    select.replaceChildren(
      ...models.map((id) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        return opt;
      })
    );
    const saved = localStorage.getItem(MODEL_KEY);
    select.value = models.includes(saved) ? saved : models[0];
    select.hidden = false;
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

  // Failed exchanges are shown but never sent back to the model.
  const sent = [
    { role: 'system', content: buildSystemPrompt(name, pages) },
    ...msgs
      .filter((m) => !m.error)
      .slice(-HISTORY_SENT)
      .map(({ role, content }) => ({ role, content })),
  ];

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
    await streamCompletion(sent, streamCtrl.signal, ({ content, reasoning }) => {
      if (content) {
        reply.content += content;
        div.classList.remove('pending');
        div.textContent = reply.content;
      } else if (reasoning && !reply.content) {
        div.textContent = 'Thinking…';
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
      div.classList.remove('pending');
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
  $('#chat-retry').addEventListener('click', connect);
  $('#chat-clear').addEventListener('click', () => {
    histories.set(getContext().id, []);
    render();
  });
  $('#chat-model').addEventListener('change', (e) =>
    localStorage.setItem(MODEL_KEY, e.target.value)
  );

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
