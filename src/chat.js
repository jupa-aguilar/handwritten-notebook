// Chat about the current notebook. Two backends, one wire protocol — both
// speak OpenAI-style Chat Completions with SSE, so only the address, the auth
// header and the model name differ:
//
//   - An API key in Settings → OpenAI's hosted gpt-5.6-luna. Costs money per
//     message; the notebook pages are sent to OpenAI.
//   - No key → whatever model LM Studio has loaded on this machine (Developer
//     tab → Start Server, with CORS enabled). Free, private, works offline.
//
// Conversations are kept in memory per notebook and reset on reload.

import { foldText, escapeHtml } from './text.js';
import { getChat, saveChat } from './db.js';
import { latexToUnicode } from './latex.js';
import { recordSpend } from './usage.js';

const URL_KEY = 'notebook.lmstudio.url';
const DEFAULT_URL = 'http://localhost:1234';

// The hosted backend. Luna is the cheap tier of the GPT-5.6 family ($1/$6 per
// million tokens as of 2026-07) — plenty for reading transcribed pages back.
// Note the exact id: the bare `gpt-5.6` alias routes to Sol, six times the
// output price, and nothing in the response would tell you.
const OPENAI_KEY_STORAGE = 'notebook.openaiKey';
const OPENAI_URL = 'https://api.openai.com';
const OPENAI_MODEL = 'gpt-5.6-luna';
const OPENAI_CONTEXT_TOKENS = 1_050_000;

export function getOpenAiKey() {
  return (localStorage.getItem(OPENAI_KEY_STORAGE) || '').trim();
}

export function setOpenAiKey(key) {
  if (key) localStorage.setItem(OPENAI_KEY_STORAGE, key);
  else localStorage.removeItem(OPENAI_KEY_STORAGE);
}

// Which backend this request goes to. Resolved per call, so pasting a key in
// Settings (or clearing it) takes effect on the very next message.
function backend() {
  const key = getOpenAiKey();
  return key
    ? {
        hosted: true,
        url: OPENAI_URL,
        headers: { Authorization: `Bearer ${key}` },
        model: OPENAI_MODEL,
        contextLength: OPENAI_CONTEXT_TOKENS,
      }
    : { hosted: false, url: getChatServerUrl(), headers: {} };
}

// Reasoning ("thinking") is off by default: local models spend minutes on
// hidden chain-of-thought before the first visible word, and hosted ones bill
// for every one of those tokens. The 🧠 toggle turns it back on for hard
// questions. Two mechanisms, belt and suspenders: reasoning_effort:"none" in
// the request (native on gpt-5.6, honored by LM Studio for current
// Qwen/gpt-oss-style models, ignored by the rest) plus Qwen's legacy
// "/no_think" soft switch on the outgoing message copy (older local hybrids
// only respect that; never shown in the bubble, never stored).
const THINK_KEY = 'notebook.chat.think';

function isThinkingOn() {
  return localStorage.getItem(THINK_KEY) === '1';
}

// Page transcriptions travel as plain text in the system prompt, so this cap
// is what every message costs before a word is generated. It binds for a
// different reason on each backend, hence two of them: locally it's the
// model's small window and the seconds spent reading it, so stay frugal; on
// the hosted one the window is 1M tokens and the only limit is the bill, so
// the cap is set where a whole notebook usually fits — which is also what
// lets the prompt cache work (see buildSystemPrompt). Whatever doesn't fit is
// reported to the model rather than silently dropped.
const CONTEXT_CHAR_BUDGET = 14000;
const HOSTED_CONTEXT_CHAR_BUDGET = 120000; // ~34K tokens, ~3¢ uncached
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
export function contextCharBudget(contextTokens, sentHistory, hosted = false) {
  const ctx = contextTokens || FALLBACK_CONTEXT_TOKENS;
  const historyTokens = Math.ceil(
    sentHistory.reduce((n, m) => n + m.content.length, 0) / CHARS_PER_TOKEN
  );
  const availTokens =
    ctx - REPLY_TOKEN_RESERVE - BOILERPLATE_TOKEN_RESERVE - historyTokens;
  return Math.min(
    hosted ? HOSTED_CONTEXT_CHAR_BUDGET : CONTEXT_CHAR_BUDGET,
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

// Can the chat work on a device that isn't the one running LM Studio? True
// with a hosted key, or when the configured address points at another machine
// on the network. A plain localhost address can't: on a phone it resolves to
// the phone itself, which is why the panel used to be hidden there outright.
export function chatWorksWithoutLocalServer() {
  if (getOpenAiKey()) return true;
  return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(
    getChatServerUrl()
  );
}

const $ = (sel) => document.querySelector(sel);

let getContext = null; // () => { id, name, pages }, supplied by main.js
let onSpendChanged = () => {}; // main.js redraws its counter
let onGoToPage = () => {}; // main.js turns to a cited page
let onVisibilityChanged = () => {}; // main.js keeps the viewer's chat tab in step
const histories = new Map(); // notebookId -> [{ id, role, content, error?, marked? }]
const loaded = new Set(); // notebookIds already read back from IndexedDB
let streamCtrl = null; // AbortController while a reply is streaming
let serverOk = false;

function history() {
  const { id } = getContext();
  if (!histories.has(id)) histories.set(id, []);
  return histories.get(id);
}

// Read a notebook's stored conversation into memory, once per session. The
// in-memory copy is authoritative from then on — it's what a streaming reply
// mutates — so a second call must not clobber it.
async function loadHistory(notebookId) {
  if (notebookId == null || loaded.has(notebookId)) return;
  loaded.add(notebookId);
  const stored = await getChat(notebookId);
  if (stored.length && !histories.get(notebookId)?.length) {
    histories.set(notebookId, stored.map(withId));
  }
}

// A handle for the marks list to point at, stable across re-renders and
// reloads. Conversations stored before marks existed have none, so they get
// one on the way in — the array index would have done until the day a message
// is ever removed from the middle.
function withId(m) {
  if (!m.id) m.id = crypto.randomUUID();
  return m;
}

// Conversations cost money to produce, so they outlive a reload. Writes are
// fire-and-forget: a failed save must never break the reply on screen.
function persist(notebookId) {
  saveChat(notebookId, histories.get(notebookId) || []).catch((err) =>
    console.error('Could not save the conversation', err)
  );
}

// ---------- LM Studio client ----------

// Pick the model to talk to. Hosted: a fixed id, so the only question is
// whether the key works — /v1/models answers that in one cheap call. Local:
// whichever model LM Studio has loaded, so there is nothing to choose in the
// app. Called before every request; also serves as the "can we reach it?"
// probe. Returns { id, contextLength } in tokens (null when unknown).
async function resolveModel() {
  const be = backend();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);

  if (be.hosted) {
    try {
      let resp;
      try {
        resp = await fetch(`${be.url}/v1/models`, {
          headers: be.headers,
          signal: ctrl.signal,
        });
      } catch {
        // Never reached the server: offline, DNS, or a blocked request.
        throw new Error("can't be reached — are you online?");
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new Error('rejected the API key — check it in ⚙ Settings');
      }
      if (!resp.ok) throw new Error(`returned HTTP ${resp.status}`);
      return { id: be.model, contextLength: be.contextLength };
    } finally {
      clearTimeout(t);
    }
  }

  const noModel =
    'the server is running but no model is loaded — load one in LM Studio';
  try {
    try {
      const resp = await fetch(`${be.url}/api/v0/models`, {
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
    const resp = await fetch(`${be.url}/v1/models`, {
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

async function streamCompletion(model, messages, signal, onDelta, extra = {}) {
  const be = backend();
  const resp = await fetch(`${be.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...be.headers },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.7,
      // Ask for a final usage chunk so the reply can be priced. Hosted only:
      // it's an OpenAI extension, and an unknown field can make a local
      // server reject the whole request.
      ...(be.hosted ? { stream_options: { include_usage: true } } : {}),
      ...extra,
    }),
    signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const who = be.hosted ? 'OpenAI' : 'LM Studio';
    throw new Error(`${who} ${resp.status}: ${body.slice(0, 200)}`);
  }

  // OpenAI-style SSE: `data: {json}` lines, closed by `data: [DONE]`.
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // The usage chunk arrives last, after the content, carrying empty choices.
  // Recorded on the way out so an aborted reply still bills what it used.
  let usage = null;
  const finish = () => {
    if (usage && recordSpend(usage)) onSpendChanged();
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) return finish();
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return finish();
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // keep-alive or partial line
      }
      if (parsed.usage) usage = parsed.usage;
      const delta = parsed.choices?.[0]?.delta;
      // Reasoning models stream their hidden thinking as reasoning_content;
      // surface it so the UI can show progress instead of looking stuck.
      if (delta?.content || delta?.reasoning_content) {
        onDelta({ content: delta.content, reasoning: delta.reasoning_content });
      }
    }
  }
}

// One non-streaming completion on whichever backend is configured. The review
// cards need a single JSON answer rather than a conversation, but they must go
// through the same key, the same model and the same spend counter — so this is
// exported instead of letting cards.js learn how to reach a model on its own.
export async function complete(messages, { signal, model, ...extra } = {}) {
  const be = backend();
  const id = model || (await resolveChatModel()).id;
  const resp = await fetch(`${be.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...be.headers },
    body: JSON.stringify({
      model: id,
      messages,
      stream: false,
      temperature: 0.3, // reading facts back off a page, not writing prose
      ...(isThinkingOn() ? {} : { reasoning_effort: 'none' }),
      ...extra,
    }),
    signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const who = be.hosted ? 'OpenAI' : 'LM Studio';
    throw new Error(`${who} ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (data.usage && recordSpend(data.usage)) onSpendChanged();
  return data.choices?.[0]?.message?.content || '';
}

// Which model a batch of requests should use, phrased for a caller that has
// no panel of its own to explain itself in. The card generator asks once
// before a long run — so a missing key fails on the first click rather than
// halfway through the notebook — and then passes the id to every completion,
// which saves a probe per page.
export async function resolveChatModel() {
  const be = backend();
  try {
    return await resolveModel();
  } catch (err) {
    throw new Error(
      be.hosted ? `OpenAI ${err.message}` : `Can't reach LM Studio at ${be.url} — ${err.message}`
    );
  }
}

// ---------- notebook context ----------

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
      foldText(q)
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

// The system prompt carrying the notebook. When every transcribed page fits
// the budget, this is byte-identical for every question about that notebook —
// nothing here depends on the query — which is what lets the hosted backend
// serve it from its prompt cache at a tenth of the input price. That property
// is load-bearing, not incidental: test/chat.test.js pins it.
export function buildSystemPrompt(
  name,
  pages,
  query,
  budget = CONTEXT_CHAR_BUDGET,
  focus = []
) {
  const terms = queryTerms(query);
  const onScreen = new Set(focus);
  const entries = [];
  let withText = 0;
  pages.forEach((p, i) => {
    const text = (p.text || '').trim();
    if (!text) return;
    withText++;
    entries.push({
      i,
      chunk: `--- Page ${i + 1} ---\n${text}`,
      score: scorePage(foldText(text), terms),
    });
  });

  // Fit pages to the budget most-relevant-first, so the pages that answer the
  // question survive truncation even when they sit deep in a long notebook.
  // When everything fits, every page is kept whatever the ranking said, so the
  // result is the same prompt for every question — the cacheable case. Ranking
  // only starts to matter, and to vary the prompt, once the notebook overflows.
  //
  // What's on screen goes in first: an unanchored question ("explain this")
  // usually means the open pages, and those must not be the ones truncation
  // drops. Which page is on screen is deliberately NOT marked in the chunks —
  // the prompt cache keys on a byte-identical prefix, so a mark that moved with
  // every page turn would cost a full-price re-read of the whole notebook. The
  // reading position travels in the tail instead (see focusNote).
  const kept = new Set();
  let used = 0;
  const byRelevance = (a, b) => b.score - a.score || a.i - b.i;
  const order = [
    ...entries.filter((e) => onScreen.has(e.i)).sort(byRelevance),
    ...entries.filter((e) => !onScreen.has(e.i)).sort(byRelevance),
  ];
  for (const e of order) {
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
    'Use the notebook as context, not as a limit: when the answer is on its pages, cite them, and feel free to combine that with your general knowledge to explain, expand, or answer beyond it. Just never claim the notebook says something it does not.',
    'Write every citation as "(p. 3)" — that exact form, with the English "p.", even when the rest of your answer is in another language. The app turns those into links to the page, and only recognises that spelling. For several pages write (p. 3, 7) or a range (p. 3-5).',
    'When you mean a particular passage rather than the whole page, add a short quote of it: (p. 3: "las tres leyes"). Copy the page\'s own words — five or six of them, exactly as transcribed above, not your paraphrase — because the app searches the scan for them and draws a box around them so the reader lands on the right lines.',
    'If the notebook has nothing on the question, say so briefly and answer it anyway from your general knowledge.',
    'Write in a warm, close, plain-spoken tone — clear and to the point. Reply in the same language the user writes in.',
    'Write maths and logic as plain text with Unicode symbols — ∧ ∨ ¬ ⊕ ≤ ≥ ≠ → ∀ ∃ ∈ ∑ √ π, subscripts like x₁, superscripts like x². Never use LaTeX: no \\( \\), no \\[ \\], no $…$, no \\land or \\frac. This chat shows plain text, so LaTeX reaches the reader as backslashes.',
    '',
    notes.join(' '),
    '',
    chunks.join('\n\n'),
  ].join('\n');
}

// Where the reader is, phrased for the model. This rides in the tail of the
// outgoing message rather than in the system prompt on purpose: it changes
// with every page turn, and the hosted backend only bills cached input for a
// byte-identical *prefix*, so anything that moves has to come last.
//
// `focus` is the on-screen page indexes (both halves of a landscape spread),
// 0-based like the array; the model is told them 1-based like the app's own
// page numbers. A page with no transcription is named as such — it is on
// screen, the model just can't read it, and left unsaid that's an invitation
// to invent what's on it.
export function focusNote(pages, focus = []) {
  const shown = focus.filter((i) => pages[i]);
  if (shown.length === 0) return '';
  const list = shown.map((i) => i + 1);
  const where =
    list.length > 1
      ? `pages ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
      : `page ${list[0]}`;
  const blank = shown.filter((i) => !(pages[i].text || '').trim()).map((i) => i + 1);
  const caveat = blank.length
    ? ` No transcription yet for ${
        blank.length > 1 ? `pages ${blank.join(', ')}` : `page ${blank[0]}`
      }, so say you can't read ${blank.length > 1 ? 'them' : 'it'} rather than guessing.`
    : '';
  return (
    `\n\n[Reading position, from the app — not part of the question: the reader has ` +
    `${where} open on screen. If the question doesn't name a page or a topic, answer about ` +
    `${list.length > 1 ? 'those pages' : 'that page'} first and cite which one you used. ` +
    `If it names another page or topic, follow the question.${caveat}]`
  );
}

// A passage the reader marked in the transcription panel, carried with the
// question so "why is this?" has a referent.
//
// Capped, because this rides on top of a system prompt that already holds as
// much of the notebook as fits: half a page pasted in would push the whole
// thing against the model's window. What gets cut is said in the card above
// the input, so nobody is surprised by an answer about the first half.
export const PASSAGE_LIMIT = 1200;

export function passageNote(passage) {
  const text = trimPassage(passage);
  if (!text) return '';
  const cut = text.length > PASSAGE_LIMIT;
  const shown = cut ? `${text.slice(0, PASSAGE_LIMIT)}…` : text;
  return (
    `\n\n[Marked passage, from the app — not part of the question: the reader has ` +
    `singled out this text on the page${cut ? ' (truncated)' : ''}. Answer about it ` +
    `unless the question points somewhere else, and say so if it does not contain ` +
    `the answer rather than filling the gap from elsewhere.\n\n"${shown}"]`
  );
}

const trimPassage = (p) => String(p || '').trim().replace(/\s+/g, ' ');

// ---------- rendering ----------

// Local models answer in Markdown; render a small safe subset (headings,
// bold/italic, inline code, fenced code, lists). Everything is HTML-escaped
// first, so only the tags emitted here ever reach innerHTML.

// Page citations → buttons that jump there. The system prompt asks for
// "(p. 3)", but a model writing Spanish will reach for "página 3" often
// enough that both are worth recognising, along with ranges and lists.
// Only the numbers become links; the surrounding words are left alone.
//
// A citation may carry the passage it means — (p. 3: "las tres leyes") — and
// that quote rides along on the link, so opening the page can box those words
// on the scan instead of leaving a whole page to scan by eye. The text is
// already HTML-escaped by the time this runs, which is why the straight
// double quote is matched as &quot;.
const PAGE_CITATION =
  /\b(pp?\.|p[áa]gs?\.|p[áa]ginas?|pages?)(\s*)(\d+(?:\s*(?:[-–—,]|y|and|to|a)\s*\d+)*)(\s*[:,]?\s*(?:&quot;|[“"])([^&“”"]{2,120})(?:&quot;|[”"]))?/gi;

// `pageCount` gates the links: a model can cite a page that doesn't exist,
// and a link that goes nowhere is worse than plain text.
function linkPageCitations(s, pageCount) {
  if (!pageCount) return s;
  // Without a quote of its own a citation falls back to the meaningful words
  // of the line it sits in. Rougher than a quote, but it is what makes this
  // work on the conversations that already exist, written before the model
  // was ever asked for one.
  let fallback = null;
  const lineTerms = () => {
    if (fallback === null) {
      // Tags and entities both have to go: this text is already escaped, so a
      // stray &quot; left in would be read as the word "quot" and boxed as if
      // the page were supposed to contain it.
      const plain = s.replace(/<[^>]*>/g, ' ').replace(/&(?:[a-z]+|#\d+);/gi, ' ');
      fallback = queryTerms(plain).slice(0, 6).join(' ');
    }
    return fallback;
  };
  return s.replace(PAGE_CITATION, (match, word, gap, numbers, quotePart, quote) => {
    // Safe to drop into the attribute as-is: the quote's own pattern excludes
    // " and &, and queryTerms only ever yields [a-z0-9] words.
    const terms = (quote || lineTerms()).trim();
    const linked = numbers.replace(/\d+/g, (n) => {
      const page = Number(n);
      if (page < 1 || page > pageCount) return n;
      // The label keeps the number the model wrote; data-page is 0-based.
      const attr = terms ? ` data-terms="${terms}"` : '';
      const what = terms ? `Go to page ${page} and mark that passage` : `Go to page ${page}`;
      return `<button type="button" class="page-ref" data-page="${page - 1}"${attr} title="${what}">${n}</button>`;
    });
    // The quote stays in the sentence: it is the reader's summary of what to
    // expect there, not markup.
    return `${word}${gap}${linked}${quotePart || ''}`;
  });
}

function mdInline(s, pageCount) {
  // Citations are linked outside `code` spans: a page number inside code is
  // being quoted, not pointed at. Splitting on the tags the previous step
  // just inserted keeps that simple.
  const withCode = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  const linked = withCode
    .split(/(<code>.*?<\/code>)/g)
    .map((part) => (part.startsWith('<code>') ? part : linkPageCitations(part, pageCount)))
    .join('');
  return linked
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export function renderMarkdown(md, pageCount = 0) {
  // LaTeX → Unicode before anything else, so \land becomes ∧ rather than
  // reaching the reader as backslashes. Code spans and fenced blocks are
  // held out: there, the LaTeX source is the point.
  const unlatexed = md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part) => (part.startsWith('`') ? part : latexToUnicode(part)))
    .join('');
  const lines = escapeHtml(unlatexed).split('\n');
  const out = [];
  let para = []; // pending paragraph lines
  let list = null; // 'ul' | 'ol' while inside a list
  let code = null; // pending code-block lines while inside a ``` fence

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => mdInline(l, pageCount)).join('<br>')}</p>`);
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
      out.push(`<div class="md-h">${mdInline(h[1], pageCount)}</div>`);
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
      out.push(`<li>${mdInline((ul || ol)[1], pageCount)}</li>`);
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
  if (m.id) div.dataset.id = m.id;
  if (m.role === 'assistant' && !m.error) {
    div.classList.add('md');
    div.innerHTML = renderMarkdown(m.content, getContext().pages.length);
  } else {
    div.textContent = m.content;
  }
  attachMark(div, m);
  return div;
}

// The 🔖 in the bubble's corner. Added first so the markdown rules that key
// on the last child still find the message's own last block, and re-addable
// because a streaming reply rewrites the bubble's innerHTML on every delta —
// which throws this away until the turn ends.
function attachMark(div, m) {
  if (!m.id || div.querySelector(':scope > .chat-mark')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chat-mark';
  btn.dataset.id = m.id;
  setMarkState(btn, m.marked);
  div.prepend(btn);
}

function setMarkState(btn, on) {
  btn.classList.toggle('on', !!on);
  btn.textContent = on ? '🔖' : '🏷';
  btn.title = on ? 'Unmark this message' : 'Mark this message';
  btn.setAttribute('aria-pressed', String(!!on));
}

function toggleMark(id) {
  const m = history().find((x) => x.id === id);
  if (!m) return;
  m.marked = !m.marked;
  const btn = $(`#chat-messages .chat-msg[data-id="${id}"] .chat-mark`);
  if (btn) setMarkState(btn, m.marked);
  persist(getContext().id);
  renderMarks();
}

// ---------- marked messages ----------

function markedMessages() {
  return history().filter((m) => m.marked);
}

// The count on the header button doubles as the hint that marking exists —
// silent at zero, so it costs nothing in a conversation that never uses it.
function updateMarksButton() {
  const btn = $('#chat-marks-btn');
  if (!btn) return;
  const n = markedMessages().length;
  btn.textContent = n ? `🔖 ${n}` : '🔖';
  btn.title = n ? `${n} marked message${n === 1 ? '' : 's'}` : 'No marked messages yet';
}

function renderMarks() {
  updateMarksButton();
  const ul = $('#chat-marks-list');
  if (!ul) return;
  const marked = markedMessages();
  if (marked.length === 0) {
    ul.innerHTML =
      '<li class="cm-empty">Nothing marked yet — tap the 🏷 on a message to keep it here.</li>';
    return;
  }
  ul.innerHTML = marked
    .map((m) => {
      const gist = m.content.trim().replace(/\s+/g, ' ').slice(0, 70);
      return `<li><button type="button" class="cm-jump" data-id="${m.id}">
        <span class="cm-who">${m.role === 'user' ? 'You' : 'Reply'}</span>
        <span class="cm-gist">${escapeHtml(gist)}</span>
      </button></li>`;
    })
    .join('');
}

// Walk back to a marked message. Scrolling alone leaves you guessing which
// one it was in a wall of text, so it also lights up for a moment.
function jumpToMessage(id) {
  const el = $(`#chat-messages .chat-msg[data-id="${id}"]`);
  if (!el) return;
  setMarksOpen(false);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation if it is already running
  el.classList.add('flash');
}

function setMarksOpen(open) {
  const pop = $('#chat-marks');
  if (!pop) return;
  if (open) renderMarks();
  pop.hidden = !open;
  $('#chat-marks-btn')?.setAttribute('aria-expanded', String(open));
}

function updateContextLine() {
  const { pages, focus = [] } = getContext();
  const withText = pages.filter((p) => (p.text || '').trim()).length;
  // Name the backend: with a key configured every message is billed and the
  // pages leave this machine, which the reader should not have to guess.
  const where = backend().hosted ? `${OPENAI_MODEL} · billed` : 'local model';
  // Say which pages an unanchored question will be answered about, so the
  // anchor is visible rather than something to deduce from the answers.
  const shown = focus.filter((i) => pages[i]).map((i) => i + 1);
  const reading = shown.length
    ? ` · reading p. ${shown.length > 1 ? `${shown[0]}–${shown[shown.length - 1]}` : shown[0]}`
    : '';
  $('#chat-context').textContent = pages.length
    ? `Context: ${withText} of ${pages.length} page${
        pages.length === 1 ? '' : 's'
      } transcribed${reading} · ${where}`
    : 'This notebook has no pages yet.';
}

function render() {
  updateContextLine();
  updateMarksButton();
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

// Probe the backend and flip between the composer and the "can't reach it"
// notice. The model itself is resolved fresh on every send.
async function connect() {
  const offline = $('#chat-offline');
  const note = $('#chat-offline-note');
  const be = backend();
  serverOk = false;
  setComposerEnabled(false);
  offline.hidden = false;
  $('#chat-retry').hidden = true;
  note.textContent = be.hosted
    ? 'Checking the OpenAI key…'
    : 'Looking for the LM Studio server…';
  try {
    await resolveModel();
    serverOk = true;
    offline.hidden = true;
    setComposerEnabled(true);
    $('#chat-input').focus();
  } catch (err) {
    note.textContent = be.hosted
      ? `OpenAI ${err.message}`
      : `Can't reach LM Studio at ${be.url} — ${err.message}`;
    $('#chat-retry').hidden = false;
  }
}

// ---------- sending ----------

async function send() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || streamCtrl || !serverOk) return;
  const { name, pages, focus = [] } = getContext();
  const msgs = history();

  msgs.push(withId({ role: 'user', content: text }));
  input.value = '';
  autosize(input);
  render();

  // The conversation history to send (failed exchanges are shown but never
  // sent back). Captured before the empty reply below so it isn't included.
  const priorMsgs = msgs
    .filter((m) => !m.error)
    .slice(-HISTORY_SENT)
    .map(({ role, content }) => ({ role, content }));

  const reply = withId({ role: 'assistant', content: '' });
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
    // Both of these tag only the outgoing copy of this turn's message — the
    // stored history stays clean, so the reading position never piles up turn
    // after turn and every turn follows the current thinking toggle.
    const outgoing = priorMsgs.map((m) => ({ ...m }));
    const last = outgoing[outgoing.length - 1];
    if (last?.role === 'user') last.content += focusNote(pages, focus);
    // Same treatment, same reason: it tags the copy that goes out, so the
    // stored history never accumulates it and every turn carries the passage
    // that is pinned *now*.
    if (last?.role === 'user') last.content += passageNote(subject);
    // Spent here, once: cleared whatever happens next, so a failed request
    // cannot leave the next ordinary question wearing it.
    const explaining = pendingExplain;
    pendingExplain = false;
    // Qwen's soft switch has to stay at the very end of the message.
    if (!isThinkingOn() && /qwen/i.test(model) && last?.role === 'user') {
      last.content += ' /no_think';
    }
    // An explain turn is sent on its own: its prompt, the passage, and no
    // conversation behind it. Everything else goes the usual way.
    const sent = explaining
      ? explainPrompt(subject)
      : [
          {
            role: 'system',
            content: buildSystemPrompt(
              name,
              pages,
              text,
              contextCharBudget(contextLength, priorMsgs, backend().hosted),
              focus
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
    const extra = isThinkingOn() ? {} : { reasoning_effort: 'none' };
    await streamCompletion(model, sent, streamCtrl.signal, ({ content, reasoning }) => {
      if (content) {
        reply.content += content;
        div.classList.remove('pending');
        div.innerHTML = renderMarkdown(reply.content, pages.length);
      } else if (reasoning && !reply.content) {
        thinkingLen += reasoning.length;
        thinkingTail = (thinkingTail + reasoning).slice(-280).trimStart();
        div.textContent = `Thinking…\n${thinkingLen > 280 ? '…' : ''}${thinkingTail}`;
      }
      // Follow the reply unless the user scrolled up to read something.
      if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) {
        box.scrollTop = box.scrollHeight;
      }
    }, extra);
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
    } else if (!reply.content.trim()) {
      // Tokens arrived carrying nothing but whitespace. The bubble is kept —
      // it was paid for — but a blank one reads as a failure with no
      // explanation, which is precisely what it is, so it says so.
      reply.error = true;
      reply.content = 'The model sent an empty reply. Nothing was answered — try again.';
      div.classList.add('error');
      div.classList.remove('md');
      div.textContent = reply.content;
      attachMark(div, reply);
    } else {
      // Something came through that the markdown rendered away to nothing.
      // Whatever it made of it, the text itself arrived: show it as it came,
      // rather than leaving a bubble with no words in it.
      if (!div.textContent.trim()) {
        div.classList.remove('md');
        div.textContent = reply.content;
      }
      attachMark(div, reply); // the stream's innerHTML writes ate the first one
    }
    streamCtrl = null;
    setSendStopping(false);
    // Save whatever the turn ended up being — answered, failed, or stopped
    // halfway. The user paid for it either way.
    persist(getContext().id);
  }
}

// ---------- panel wiring ----------

async function setChatHidden(hidden) {
  $('#chat').hidden = hidden;
  if (!hidden) $('#panel').hidden = true; // one side panel at a time
  // Keep the reading bar's lit button in step with which panel is open.
  $('#chat-btn').classList.toggle('active', !hidden);
  $('#panel-toggle').classList.toggle('active', !$('#panel').hidden);
  onVisibilityChanged(hidden);
  // The book shares the row with this panel; StPageFlip refits on 'resize'.
  // Harmless over the viewer, which re-fits to a stage this panel doesn't
  // resize — it floats above it rather than taking room from it.
  window.dispatchEvent(new Event('resize'));
  if (!hidden) {
    render(); // draw immediately; the stored thread arrives a tick later
    await loadHistory(getContext().id);
    render();
    connect(); // re-probe every open — the server may have started/stopped
  }
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
}

// Opened from outside the chat's own buttons — the tab the viewer shows when
// it is covering the reading bar this would normally be reached from.
export function openChat() {
  return setChatHidden(false);
}

// The passage the reader marked, if any. Held in memory only: it is the most
// ephemeral thing here, and persisting it would mean carrying state per
// notebook for something two gestures put back.
let subject = '';

function paintSubject() {
  const box = $('#chat-subject');
  $('#chat-subject-text').textContent = subject;
  box.hidden = !subject;
}

// How the reader wants a passage explained, written by them. It refers to the
// marked passage rather than carrying it, because passageNote already delivers
// that — a placeholder with half a paragraph pushed into it reads badly and
// says the same thing twice.
const EXPLAIN_INSTRUCTION =
  'Actúa como un profesor experto y explícame el concepto del pasaje marcado de la ' +
  'forma más sencilla, clara y memorable posible, utilizando la técnica Feynman: usa ' +
  'un lenguaje directo, evita modismos técnicos y emplea una analogía o metáfora ' +
  'cotidiana que conecte la idea central con algo que yo ya conozca bien. Para ' +
  'asegurar que la explicación sea concisa y no se me olvide jamás, estructura la ' +
  'respuesta en un máximo de tres párrafos breves donde primero me des la idea básica ' +
  'sin rodeos, luego la metáfora visual para recordarlo y finalmente el porqué o la ' +
  'clave fundamental de su funcionamiento.';

// What the bubble says instead. The instruction above is what the model reads,
// but a transcript with that wall of text repeated at every explanation is a
// transcript nobody can skim — and the split between what is stored and what
// is sent is already how the reading position and the passage travel.
const EXPLAIN_SHOWN = 'Explícame este pasaje.';

// Set for the one turn Explain this was pressed for, and no further. Unlike
// the passage, which stays pinned, this belongs to that question alone: a
// follow-up should not come back as another lecture.
let pendingExplain = false;

// Explaining a passage is a different job from answering about the notebook,
// and it needs a prompt of its own rather than a rider on the notebook's.
//
// It was tried both cheaper ways first. In the tail of the user message it was
// ignored outright — the system prompt above it sets a persona ("the reading
// assistant built into a notebook app"), a citation format and a tone, and
// those won. Appended to the end of that system prompt it was ignored too,
// and this time the evidence was flat: the reply still ended in (p. 4: "…"),
// against an instruction two lines long saying never to write that. The
// reason is position. That prompt carries the whole notebook, up to a hundred
// and twenty thousand characters of it, and an instruction after all of that
// weighs nothing beside the persona declared in its opening lines.
//
// So this turn gets a short prompt with the passage in it and no notebook at
// all. It costs the prompt cache for that one request and buys the request
// being obeyed; it is also far cheaper to send. What it gives up is the rest
// of the notebook, which an explanation of one passage does not need — and
// the follow-up, asked the ordinary way, has it all back.
export function explainPrompt(passage, instruction = EXPLAIN_INSTRUCTION) {
  return [
    {
      role: 'system',
      content: [
        "You are an expert teacher explaining one passage from a student's own notebook.",
        'Do the request below and nothing else. It is the whole of the format.',
        'Never cite a page and never write "(p. 3)" or anything like it: this is not a lookup, and a citation breaks the shape being asked for.',
        'No headings, no bullet lists, no bold labels. Prose.',
        'Ordinary words. Where a technical term cannot be avoided, say what it means in the same breath.',
        'Reply in the same language as the passage.',
        '',
        instruction,
      ].join('\n'),
    },
    { role: 'user', content: `The passage:\n\n"${trimPassage(passage).slice(0, PASSAGE_LIMIT)}"` },
  ];
}

// Pin the passage and ask for it to be explained, without waiting for anything
// to be typed.
export function explainSubject(text) {
  setSubject(text);
  if (!subject) return;
  const input = $('#chat-input');
  // Nothing to send it to: leave the question written rather than swallowing
  // the press and looking broken.
  if (!serverOk) {
    input.value = EXPLAIN_SHOWN;
    autosize(input);
    return;
  }
  pendingExplain = true;
  input.value = EXPLAIN_SHOWN;
  send();
}

// Called when something is marked in the text panel. Opening the chat and
// landing in the input is the point — the reader has a question in mind.
export function setSubject(text) {
  subject = String(text || '').trim().replace(/\s+/g, ' ');
  paintSubject();
  if (subject) {
    setChatHidden(false);
    $('#chat-input').focus();
  }
}

// The keyboard has no idea which of the two states the panel is in.
export function toggleChat() {
  return setChatHidden($('#chat').hidden === false);
}

// Called by main.js on every page change, so the open chat keeps showing which
// pages an unanchored question would be answered about. Cheap and idempotent:
// it only rewrites one line of text.
export function chatFocusChanged() {
  if (!getContext || $('#chat').hidden) return;
  updateContextLine();
}

// Called by main.js whenever another notebook is loaded, so an open chat
// switches to that notebook's conversation and context.
export async function chatNotebookChanged() {
  // Cleared whether or not the chat is open: the passage came off a page of
  // the notebook being left behind.
  subject = '';
  paintSubject();
  if (!getContext || $('#chat').hidden) return;
  setMarksOpen(false); // another notebook, another set of marked messages
  render();
  await loadHistory(getContext().id);
  render();
}

export function initChat(opts) {
  getContext = opts.getContext;
  if (opts.onSpendChanged) onSpendChanged = opts.onSpendChanged;
  if (opts.onGoToPage) onGoToPage = opts.onGoToPage;
  if (opts.onVisibilityChanged) onVisibilityChanged = opts.onVisibilityChanged;

  $('#chat-subject-clear').addEventListener('click', () => setSubject(''));

  // Delegated: reply bubbles are rebuilt on every streamed token, so a
  // listener bound to the buttons themselves would be discarded immediately.
  $('#chat-messages').addEventListener('click', (e) => {
    const ref = e.target.closest('.page-ref');
    if (ref) {
      // On a phone the chat is the whole screen, not a panel beside the page,
      // so following a citation has to step out of it — otherwise the page
      // turns and the passage lights up behind a screen still covering both.
      if (document.body.classList.contains('is-mobile')) setChatHidden(true);
      onGoToPage(Number(ref.dataset.page), ref.dataset.terms || '');
      return;
    }
    const mark = e.target.closest('.chat-mark');
    if (mark) toggleMark(mark.dataset.id);
  });

  $('#chat-marks-btn').addEventListener('click', () =>
    setMarksOpen($('#chat-marks').hidden)
  );
  $('#chat-marks-close').addEventListener('click', () => setMarksOpen(false));
  $('#chat-marks-list').addEventListener('click', (e) => {
    const jump = e.target.closest('.cm-jump');
    if (jump) jumpToMessage(jump.dataset.id);
  });

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
    const { id } = getContext();
    histories.set(id, []);
    persist(id); // an empty thread deletes the stored row
    setMarksOpen(false); // its entries point at messages that no longer exist
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
      return;
    }
    // Opening the chat puts the caret in here, which leaves no key able to
    // close it again: the global handler steps aside for text fields, so both
    // C and Escape were being typed rather than acted on. Escape is the one
    // that belongs to the panel — C is a letter people write. Same bargain the
    // search box makes, and it peels the same way: the marks drawer first.
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation(); // never let it reach the viewer and close that too
    if (!$('#chat-marks').hidden) setMarksOpen(false);
    else setChatHidden(true);
  });
}
