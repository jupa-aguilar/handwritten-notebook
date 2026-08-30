// The progress report: what the deck has cost, and whether it is getting
// cheaper.
//
// The chart worth reading here is not accuracy. A scheduler doing its job
// holds that roughly flat by construction — it shows you the cards you are
// about to forget, so you keep missing about as many as it aims for. What
// moves is the *rung*: the same deck answered with less and less help. That is
// the shape learning has from outside, and no plain flashcard app records it
// because no plain flashcard app has a ladder to record.
//
// The arithmetic all lives in stats.js; this file only draws it and hangs the
// three actions off the cards that are going badly.

import { listCards, listReviewDays, putCard, deleteCard } from './db.js';
import { resolveChatModel } from './chat.js';
import { rewriteCard } from './cards.js';
import {
  series,
  summarise,
  worstCards,
  struggle,
  describeRecord,
  sum,
} from './stats.js';

const $ = (sel) => document.querySelector(sel);

let getContext = null; // () => { id, pages }
let onGoToPage = () => {};
let onChanged = () => {};
let onDeckChanged = () => {}; // the review panel reloads its own copy

let cards = [];
let rows = [];
let unit = 'day';
let busy = null; // AbortController while a rewrite is in flight

const UNITS = { day: 30, month: 12, year: 5 };
// What each rung is called where the reader can see it.
const RUNG_LABELS = ['On your own', 'After the hint', 'With the line', 'From options'];

// ---------- loading ----------

async function load() {
  const { id } = getContext();
  [cards, rows] = await Promise.all([listCards(id), listReviewDays(id)]);
  paint();
}

function paint() {
  paintHeader();
  paintLadder();
  paintChart();
  paintWorst();
}

// ---------- the header ----------

function paintHeader() {
  const all = summarise(rows);
  const recent = summarise(series(rows, 'day', 30));
  const el = $('#progress-head');
  el.replaceChildren();

  const stat = (value, label) => {
    const box = document.createElement('div');
    box.className = 'progress-stat';
    const v = document.createElement('strong');
    v.textContent = value;
    const l = document.createElement('span');
    l.textContent = label;
    box.append(v, l);
    return box;
  };

  el.append(stat(String(cards.length), `card${cards.length === 1 ? '' : 's'}`));
  el.append(stat(String(all.total), 'answers recorded'));
  el.append(
    stat(recent.accuracy === null ? '—' : `${Math.round(recent.accuracy * 100)}%`, 'right, last 30 days')
  );
  el.append(
    stat(recent.unaided === null ? '—' : `${Math.round(recent.unaided * 100)}%`, 'of those, unaided')
  );
}

// ---------- the ladder ----------

function paintLadder() {
  const total = summarise(rows);
  const el = $('#progress-ladder');
  el.replaceChildren();

  if (!total.total) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent =
      'Nothing recorded yet. This fills in as you review — it is the one number that shows the deck getting easier rather than just getting done.';
    el.append(p);
    return;
  }

  for (let i = 0; i < RUNG_LABELS.length; i++) {
    const n = total.answered[i];
    const share = n / total.total;
    const row = document.createElement('div');
    row.className = 'progress-rung';

    const label = document.createElement('span');
    label.className = 'progress-rung-label';
    label.textContent = RUNG_LABELS[i];

    const track = document.createElement('div');
    track.className = 'progress-track';
    const fill = document.createElement('div');
    fill.className = `progress-fill rung-${i}`;
    fill.style.width = `${Math.round(share * 100)}%`;
    track.append(fill);

    const value = document.createElement('span');
    value.className = 'progress-rung-value';
    value.textContent = `${Math.round(share * 100)}% · ${n}`;

    row.append(label, track, value);
    el.append(row);
  }
}

// ---------- the evolution ----------

function paintChart() {
  const data = series(rows, unit, UNITS[unit]);
  const peak = Math.max(1, ...data.map((d) => sum(d.answered)));
  const el = $('#progress-chart');
  el.replaceChildren();

  for (const point of data) {
    const total = sum(point.answered);
    const col = document.createElement('div');
    col.className = 'progress-col';
    // A day with nothing on it is a gap, not a bad day: it gets an empty
    // column rather than a zero-height one that reads as a failure.
    col.classList.toggle('empty', total === 0);
    col.title = total
      ? `${point.key} — ${total} answered, ${sum(point.missed)} missed`
      : `${point.key} — nothing`;

    const stack = document.createElement('div');
    stack.className = 'progress-stack';
    for (let i = RUNG_LABELS.length - 1; i >= 0; i--) {
      if (!point.answered[i]) continue;
      const seg = document.createElement('div');
      seg.className = `progress-seg rung-${i}`;
      seg.style.height = `${(point.answered[i] / peak) * 100}%`;
      stack.append(seg);
    }
    col.append(stack);
    el.append(col);
  }

  for (const btn of document.querySelectorAll('#progress-units .progress-unit')) {
    btn.classList.toggle('active', btn.dataset.unit === unit);
  }

  const legend = $('#progress-legend');
  legend.replaceChildren();
  for (let i = 0; i < RUNG_LABELS.length; i++) {
    const item = document.createElement('span');
    item.className = 'progress-key';
    const dot = document.createElement('i');
    dot.className = `progress-dot rung-${i}`;
    const text = document.createElement('span');
    text.textContent = RUNG_LABELS[i];
    item.append(dot, text);
    legend.append(item);
  }
}

// ---------- the cards that are going badly ----------

function paintWorst() {
  const worst = worstCards(cards, 8);
  const el = $('#progress-worst');
  el.replaceChildren();

  if (!worst.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent =
      'No card is doing badly enough to name. A card needs a few answers, or a couple of outright misses, before its record says anything.';
    el.append(p);
    return;
  }

  for (const { card, record } of worst) {
    const row = document.createElement('div');
    row.className = 'progress-card';

    const q = document.createElement('div');
    q.className = 'progress-card-q';
    q.textContent = card.q;

    // The evidence, not the score: the ranking mixes cards judged on the new
    // tallies with cards judged on the lapses they have always carried, and a
    // single number would hide which is which.
    const rec = document.createElement('div');
    rec.className = 'progress-card-rec';
    rec.textContent = describeRecord(record);

    const actions = document.createElement('div');
    actions.className = 'progress-card-actions';
    actions.append(
      button('Open the page', () => goToCard(card)),
      button('Rewrite', () => rewrite(card), 'progress-rewrite'),
      button('Delete', () => drop(card))
    );

    row.append(q, rec, actions);
    el.append(row);
  }
}

function button(label, onClick, extra = '') {
  const b = document.createElement('button');
  b.className = `btn ghost small ${extra}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function setStatus(text, isError = false) {
  const el = $('#progress-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = !text;
}

// ---------- acting on them ----------

function goToCard(card) {
  const { pages } = getContext();
  const index = pages.findIndex((p) => p.id === card.pageId);
  if (index === -1) return;
  closeProgress();
  onGoToPage(index);
}

async function drop(card) {
  cards = cards.filter((c) => c.id !== card.id);
  await deleteCard(card.id);
  onChanged();
  onDeckChanged();
  setStatus('Card deleted.');
  paint();
}

// The record goes into the prompt, not into a verdict: what the model is asked
// for is a better question about the same material, told what went wrong with
// the one it is replacing.
async function rewrite(card) {
  if (busy) return;
  const { pages } = getContext();
  const page = pages.find((p) => p.id === card.pageId);
  if (!page) {
    setStatus('The page this card came from is no longer in this notebook.', true);
    return;
  }

  busy = new AbortController();
  setStatus('Writing a new question…');
  try {
    const model = (await resolveChatModel()).id;
    const fresh = await rewriteCard(page, card, struggle(card), {
      signal: busy.signal,
      model,
    });
    if (!fresh) {
      setStatus('The model did not return a usable question. Try again.', true);
      return;
    }
    await putCard(fresh);
    const at = cards.findIndex((c) => c.id === card.id);
    if (at !== -1) cards[at] = fresh;
    onChanged();
    onDeckChanged();
    setStatus('Rewritten. Its schedule starts over — it is a different question now.');
    paint();
  } catch (err) {
    console.error('Could not rewrite the card', err);
    setStatus(err.message, true);
  } finally {
    busy = null;
  }
}

// ---------- open/close ----------

export function openProgress() {
  $('#progress').hidden = false;
  setStatus('');
  load();
}

export function closeProgress() {
  if (busy) busy.abort();
  busy = null;
  $('#progress').hidden = true;
}

export function initProgress(opts) {
  getContext = opts.getContext;
  onGoToPage = opts.onGoToPage || onGoToPage;
  onChanged = opts.onChanged || onChanged;
  onDeckChanged = opts.onDeckChanged || onDeckChanged;

  $('#progress-close').addEventListener('click', closeProgress);
  for (const btn of document.querySelectorAll('#progress-units .progress-unit')) {
    btn.addEventListener('click', () => {
      unit = btn.dataset.unit;
      paintChart();
    });
  }
}
