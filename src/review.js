// The review panel: the deck summary, the card generator and the sitting
// itself.
//
// What makes this worth building rather than exporting to a flashcard app is
// the answer side. Every card knows the rectangle on the page its answer was
// written in (see cards.js), so revealing it shows the user's own handwriting
// — the ink they wrote it with, in the margin they wrote it in — instead of a
// paraphrase produced by a model reading a transcript.

import { listCards, addCards, putCard, deleteCard, deleteCardsForPage } from './db.js';
import { resolveChatModel } from './chat.js';
import { generateForPage, pagesToGenerate, cropRect } from './cards.js';
import { review, nextInterval, dueCards, isDue, formatInterval, GRADES } from './srs.js';

const $ = (sel) => document.querySelector(sel);

let getContext = null; // () => { id, name, pages }, supplied by main.js
let onGoToPage = () => {};
let onDueCount = () => {}; // main.js paints the badge on the reading bar
// Cards changed: main.js schedules a push. Deliberately not touchNotebook() —
// cards ride in their own file, and bumping the notebook would drag every
// page's text back up to Drive for the sake of one grade.
let onChanged = () => {};

let cards = []; // every card of the current notebook
let queue = []; // what's left of this sitting
let current = null;
let generating = null; // AbortController while a run is in flight
let currentPageIndex = () => 0; // which page the reader has open, from main.js
let cropUrl = null; // object URL of the answer image, revoked as we go

const GRADE_LABELS = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

// ---------- deck ----------

async function load() {
  const { id } = getContext();
  cards = await listCards(id);
  paintDeck();
  onDueCount(cards.filter((c) => isDue(c)).length);
}

function paintDeck() {
  const { pages } = getContext();
  // The deck's own actions have no business under a card that is being
  // answered — starting a second sitting, or clearing the page the question
  // came from, mid-question.
  const sitting = !$('#review-session').hidden;
  const due = cards.filter((c) => isDue(c)).length;
  const pending = pagesToGenerate(pages, cards).length;

  const stats = $('#review-stats');
  if (cards.length === 0) {
    stats.textContent = pending
      ? `No cards yet. ${pending} transcribed page${pending === 1 ? '' : 's'} can make some.`
      : 'No cards yet, and no transcribed pages to draw them from.';
  } else {
    const parts = [`${cards.length} card${cards.length === 1 ? '' : 's'}`];
    parts.push(due ? `${due} due now` : 'nothing due — come back later');
    if (pending) parts.push(`${pending} page${pending === 1 ? '' : 's'} without cards`);
    stats.textContent = parts.join(' · ');
  }

  const start = $('#review-start');
  start.hidden = sitting || due === 0;
  start.textContent = `Start review (${due})`;

  // Redoing a page means clearing it first, so the button names the page the
  // reader has open behind the panel — the one they just decided came out
  // wrong.
  const onScreen = pages[currentPageIndex()];
  const clear = $('#review-clear-page');
  const clearable = onScreen ? cards.filter((c) => c.pageId === onScreen.id).length : 0;
  clear.hidden = sitting || !clearable;
  clear.textContent = `🗑 Clear page ${onScreen ? onScreen.order + 1 : ''} (${clearable})`;

  const gen = $('#review-generate');
  gen.hidden = sitting || !!generating || pending === 0;
  gen.textContent = `✨ Generate cards (${pending} page${pending === 1 ? '' : 's'})`;
  $('#review-stop').hidden = sitting || !generating;
}

function setStatus(text, isError = false) {
  const el = $('#review-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = !text;
}

// ---------- generating ----------

async function generate() {
  if (generating) return;
  const { id, pages } = getContext();
  const todo = pagesToGenerate(pages, cards);
  if (!todo.length) return;

  generating = new AbortController();
  const { signal } = generating;
  paintDeck();

  // Fail on the first click rather than halfway through the notebook: without
  // a key (or a model loaded locally) every page would fail the same way.
  let model;
  try {
    model = (await resolveChatModel()).id;
  } catch (err) {
    generating = null;
    setStatus(err.message, true);
    paintDeck();
    return;
  }

  let made = 0;
  let failed = 0;
  for (const [i, page] of todo.entries()) {
    if (signal.aborted) break;
    setStatus(`Reading page ${page.order + 1} — ${i + 1} of ${todo.length}, ${made} cards so far…`);
    try {
      const fresh = await generateForPage(page, id, { signal, model });
      if (fresh.length) {
        await addCards(fresh);
        cards.push(...fresh);
        made += fresh.length;
        onChanged();
      }
    } catch (err) {
      if (signal.aborted) break;
      // One page's failure is not the run's: a model that returned nonsense
      // for page 12 will still answer for page 13.
      console.error('Could not make cards for page', page.order + 1, err);
      failed++;
    }
    onDueCount(cards.filter((c) => isDue(c)).length);
    paintDeck();
  }

  const stopped = signal.aborted;
  generating = null;
  setStatus(
    `${stopped ? 'Stopped — ' : ''}${made} card${made === 1 ? '' : 's'} from ${todo.length} page${todo.length === 1 ? '' : 's'}` +
      (failed ? `, ${failed} page${failed === 1 ? '' : 's'} failed` : ''),
    failed > 0 && made === 0
  );
  paintDeck();
}

// ---------- the sitting ----------

function startSession() {
  queue = dueCards(cards);
  if (!queue.length) return;
  setStatus('');
  $('#review-deck').hidden = true;
  $('#review-session').hidden = false;
  paintDeck();
  nextCard();
}

function endSession() {
  queue = [];
  current = null;
  releaseCrop();
  $('#review-session').hidden = true;
  $('#review-deck').hidden = false;
  paintDeck();
}

function nextCard() {
  releaseCrop();
  current = queue.shift() || null;
  if (!current) {
    endSession();
    setStatus('Done for now — nothing else is due.');
    return;
  }
  $('#review-remaining').textContent = `${queue.length + 1} left`;
  $('#review-q').textContent = current.q;
  $('#review-answer-text').textContent = current.a;
  $('#review-answer').hidden = true;
  $('#review-grades').hidden = true;
  $('#review-show').hidden = false;
  $('#review-show').focus();
  $('#review-crop').hidden = true;
  $('#review-crop-note').hidden = true;
}

async function showAnswer() {
  if (!current || !$('#review-answer').hidden) return;
  $('#review-answer').hidden = false;
  $('#review-show').hidden = true;

  // Label each grade with what it costs you: "Good — 15 d" is the difference
  // between a scheduler you trust and four buttons you press at random.
  const grades = $('#review-grades');
  grades.replaceChildren();
  for (const grade of GRADES) {
    const btn = document.createElement('button');
    btn.className = `btn review-grade grade-${grade}`;
    btn.dataset.grade = grade;
    const label = document.createElement('span');
    label.textContent = GRADE_LABELS[grade];
    const when = document.createElement('small');
    when.textContent = formatInterval(nextInterval(current, grade));
    btn.append(label, when);
    btn.addEventListener('click', () => gradeCurrent(grade));
    grades.appendChild(btn);
  }
  grades.hidden = false;

  await paintCrop(current);
}

async function gradeCurrent(grade) {
  if (!current || $('#review-answer').hidden) return;
  const card = review(current, grade, Date.now());
  const at = cards.findIndex((c) => c.id === card.id);
  if (at !== -1) cards[at] = card;
  // A failed card comes back in ten minutes, which is usually inside this
  // sitting — so it goes back on the end of the queue rather than waiting for
  // the panel to be opened again.
  if (grade === 'again') queue.push(card);
  await putCard(card);
  onChanged();
  onDueCount(cards.filter((c) => isDue(c)).length);
  nextCard();
}

// ---------- the handwriting behind the answer ----------

function releaseCrop() {
  if (cropUrl) URL.revokeObjectURL(cropUrl);
  cropUrl = null;
}

// Cut the card's rectangle out of the page image. Padded, because a box that
// hugs the letters reads as a ransom note — a little of the surrounding paper
// is what makes it look like a piece of the notebook.
async function paintCrop(card) {
  const fig = $('#review-crop');
  const note = $('#review-crop-note');
  const { pages } = getContext();
  const page = pages.find((p) => p.id === card.pageId);

  if (!page || !card.box) {
    note.textContent = page
      ? 'The passage this came from could not be located on the page.'
      : 'The page this came from is no longer in this notebook.';
    note.hidden = false;
    return;
  }
  // The box was measured in the pixels of an image that has since been
  // replaced (swapPageImage mints a new uuid), so those coordinates now point
  // into a different picture.
  if (card.pageUuid && page.uuid && card.pageUuid !== page.uuid) {
    note.textContent = 'This page was re-scanned since the card was made, so the passage is no longer marked.';
    note.hidden = false;
    return;
  }

  try {
    const bitmap = await createImageBitmap(page.blob);
    const cut = cropRect(page, card.box);
    const x = Math.max(0, cut.x);
    const y = Math.max(0, cut.y);
    const w = Math.min(bitmap.width - x, cut.w);
    const h = Math.min(bitmap.height - y, cut.h);

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w);
    canvas.height = Math.round(h);
    canvas.getContext('2d').drawImage(bitmap, x, y, w, h, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
    releaseCrop();
    cropUrl = URL.createObjectURL(blob);
    $('#review-crop-img').src = cropUrl;
    $('#review-crop-cap').textContent = `Page ${page.order + 1}`;
    fig.hidden = false;
  } catch (err) {
    console.error('Could not crop the page', err);
    note.textContent = 'The page image could not be read.';
    note.hidden = false;
  }
}

// ---------- card actions ----------

function gotoCurrentPage() {
  if (!current) return;
  const { pages } = getContext();
  const index = pages.findIndex((p) => p.id === current.pageId);
  if (index === -1) return;
  setReviewOpen(false);
  onGoToPage(index);
}

async function dropCurrent() {
  if (!current) return;
  const id = current.id;
  cards = cards.filter((c) => c.id !== id);
  queue = queue.filter((c) => c.id !== id);
  await deleteCard(id);
  onChanged();
  onDueCount(cards.filter((c) => isDue(c)).length);
  nextCard();
}

// Everything drawn from the page on screen. The way to redo a page whose
// questions came out wrong: clear it, then generate again.
async function clearCurrentPage() {
  const { pages } = getContext();
  const page = pages[currentPageIndex()];
  if (!page) return;
  const n = await deleteCardsForPage(page.id);
  cards = cards.filter((c) => c.pageId !== page.id);
  if (n) onChanged();
  onDueCount(cards.filter((c) => isDue(c)).length);
  setStatus(n ? `Cleared ${n} card${n === 1 ? '' : 's'} from page ${page.order + 1}.` : 'That page had no cards.');
  paintDeck();
}

// ---------- open/close ----------

function setReviewOpen(open) {
  const el = $('#review');
  if (open === !el.hidden) return;
  el.hidden = !open;
  $('#review-btn')?.classList.toggle('active', open);
  if (open) {
    setStatus('');
    load();
  } else {
    if (generating) generating.abort();
    endSession();
  }
}

export function openReview() {
  setReviewOpen($('#review').hidden);
}

export function closeReview() {
  setReviewOpen(false);
}

// The notebook changed under us: its cards are a different deck.
export async function reviewNotebookChanged() {
  endSession();
  await load();
}

export function initReview(opts) {
  getContext = opts.getContext;
  onGoToPage = opts.onGoToPage || onGoToPage;
  onDueCount = opts.onDueCount || onDueCount;
  onChanged = opts.onChanged || onChanged;
  currentPageIndex = opts.currentPageIndex || currentPageIndex;

  $('#review-btn').addEventListener('click', openReview);
  $('#review-close').addEventListener('click', () => setReviewOpen(false));
  $('#review-generate').addEventListener('click', generate);
  $('#review-stop').addEventListener('click', () => generating?.abort());
  $('#review-start').addEventListener('click', startSession);
  $('#review-show').addEventListener('click', showAnswer);
  $('#review-goto').addEventListener('click', gotoCurrentPage);
  $('#review-drop').addEventListener('click', dropCurrent);
  $('#review-clear-page').addEventListener('click', clearCurrentPage);
  $('#review-end').addEventListener('click', endSession);

  // The keyboard is the whole point of a review loop: space to reveal, then a
  // number for how it went. Only while the panel is open and a card is up.
  document.addEventListener('keydown', (e) => {
    if ($('#review').hidden || $('#review-session').hidden) return;
    if (e.target.matches('input, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if ($('#review-answer').hidden) showAnswer();
      else gradeCurrent('good');
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 4 && !$('#review-answer').hidden) {
      e.preventDefault();
      gradeCurrent(GRADES[n - 1]);
    }
  });

  load();
}

// So main.js can paint the badge before the panel has ever been opened, and
// repaint it after a sync brings a sitting's worth of grades from the phone.
// Never mid-sitting: the queue on screen is already in hand.
export function refreshDueCount() {
  if (!$('#review-session').hidden) return Promise.resolve();
  return load();
}
