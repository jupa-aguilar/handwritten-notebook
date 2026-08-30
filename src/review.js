// The review panel: the deck summary, the card generator and the sitting
// itself.
//
// What makes this worth building rather than exporting to a flashcard app is
// the answer side. Every card knows the rectangle on the page its answer was
// written in (see cards.js), so revealing it shows the user's own handwriting
// — the ink they wrote it with, in the margin they wrote it in — instead of a
// paraphrase produced by a model reading a transcript.

import {
  listCards,
  addCards,
  putCard,
  deleteCard,
  deleteCardsForPage,
  bumpReviewDay,
} from './db.js';
import { recordAnswer, CHOICE_RUNG } from './stats.js';
import { buildChoices, cardsNeedingDecoys } from './choices.js';
import { resolveChatModel } from './chat.js';
import {
  generateForPage,
  pagesToGenerate,
  hintRect,
  cardsToTopUp,
  topUpForPage,
  writeDecoysForPage,
} from './cards.js';
import { cropHint, cropAnswer } from './crop.js';
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
let hintUrl = null; // and of the hint's, which is a different crop of the page
// How far up the ladder this card has been walked: 0 nothing shown, 1 the
// written hint, 2 the line it was written on. Anything above 0 withdraws Easy.
// A card answered from options is CHOICE_RUNG outright — that mode replaces
// the ladder rather than sitting on it.
let hintStep = 0;
// The options on screen and what was picked, or null when this card is being
// asked the ordinary way.
let choice = null;

const CHOICES_KEY = 'notebook.reviewChoices';
const choicesMode = () => localStorage.getItem(CHOICES_KEY) === '1';

const GRADE_LABELS = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

// After a hint, Easy is off the table — the line was in front of you. Only that
// one: hiding more would be a punishment, and the other three still mean
// exactly what they say. Both the buttons and the number keys read this, so
// there is one answer to what the card is currently offering.
const offeredGrades = () => (hintStep > 0 ? GRADES.filter((g) => g !== 'easy') : GRADES);

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

  // Cards drawn before hints and takeaways existed. Offered separately from
  // generating because it is the opposite trade: it writes onto the cards you
  // already have rather than making new ones, so nothing you have sat with is
  // lost.
  const thin = cardsToTopUp(cards).length;
  const topup = $('#review-topup');
  topup.hidden = sitting || !!generating || thin === 0;
  topup.textContent = `💡 Add hints (${thin} card${thin === 1 ? '' : 's'})`;

  // Only worth offering while the choice mode is on: it is the only thing
  // that spends these, and a button for a mode you are not using is noise.
  const needy = choicesMode() ? cardsNeedingDecoys(cards).length : 0;
  const decoys = $('#review-decoys');
  decoys.hidden = sitting || !!generating || needy === 0;
  decoys.textContent = `🎲 Better options (${needy} card${needy === 1 ? '' : 's'})`;

  $('#review-progress').hidden = sitting;
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

// A card already sat with cannot be regenerated — clearing a page takes its
// schedule down with the cards — so the hint and the takeaway are asked for on
// their own and written onto the cards in place. Deliberately putCard and
// onChanged, never touchNotebook: cards ride in a file of their own, and a
// hint must not drag a manifest full of page text up to Drive.
// A pass over the deck that asks the model for something the cards are
// missing, a page at a time — the model is being shown that page's text, so
// grouping by page is both cheaper and the only way the request makes sense.
//
// Shared by the two passes that fill fields in rather than making cards:
// hints and takeaways, and decoys for the choice mode. Both write with
// putCard and onChanged and never touchNotebook, because cards ride in a file
// of their own and a hint must not drag a manifest full of page text to Drive.
async function fillIn({ pick, forPage, verb }) {
  if (generating) return;
  const { pages } = getContext();
  const wanted = pick(cards);
  if (!wanted.length) return;

  const byPage = new Map();
  for (const card of wanted) {
    if (!byPage.has(card.pageId)) byPage.set(card.pageId, []);
    byPage.get(card.pageId).push(card);
  }
  const todo = [...byPage.entries()]
    .map(([pageId, group]) => [pages.find((p) => p.id === pageId), group])
    .filter(([page]) => page);
  if (!todo.length) return;

  generating = new AbortController();
  const { signal } = generating;
  paintDeck();

  let model;
  try {
    model = (await resolveChatModel()).id;
  } catch (err) {
    generating = null;
    setStatus(err.message, true);
    paintDeck();
    return;
  }

  let filled = 0;
  let failed = 0;
  for (const [i, [page, group]] of todo.entries()) {
    if (signal.aborted) break;
    setStatus(`Reading page ${page.order + 1} — ${i + 1} of ${todo.length}, ${filled} cards so far…`);
    try {
      const updated = await forPage(page, group, { signal, model });
      for (const card of updated) {
        const at = cards.findIndex((c) => c.id === card.id);
        if (at !== -1) cards[at] = card;
        await putCard(card);
        filled++;
      }
      if (updated.length) onChanged();
    } catch (err) {
      if (signal.aborted) break;
      console.error(`Could not ${verb} page`, page.order + 1, err);
      failed++;
    }
    paintDeck();
  }

  const stopped = signal.aborted;
  generating = null;
  setStatus(
    `${stopped ? 'Stopped — ' : ''}${filled} card${filled === 1 ? '' : 's'} filled in` +
      (failed ? `, ${failed} page${failed === 1 ? '' : 's'} failed` : ''),
    failed > 0 && filled === 0
  );
  paintDeck();
}

// A card already sat with cannot be regenerated — clearing a page takes its
// schedule down with the cards — so the hint and the takeaway are asked for on
// their own and written onto the cards in place.
const topUp = () =>
  fillIn({ pick: cardsToTopUp, forPage: topUpForPage, verb: 'top up' });

// And where the notebook holds no answer with anything to do with a question,
// the wrong options are asked for rather than scraped together from whatever
// happens to be on the page.
const writeDecoys = () =>
  fillIn({ pick: cardsNeedingDecoys, forPage: writeDecoysForPage, verb: 'write decoys for' });

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
  choice = null;
  releaseCrop();
  releaseHint();
  $('#review-session').hidden = true;
  $('#review-deck').hidden = false;
  paintDeck();
}

function nextCard() {
  releaseCrop();
  releaseHint();
  current = queue.shift() || null;
  if (!current) {
    endSession();
    setStatus('Done for now — nothing else is due.');
    return;
  }
  $('#review-remaining').textContent = `${queue.length + 1} left`;
  // Cards made before the model was asked for one carry no topic; the chip
  // simply isn't there for them.
  const topic = $('#review-topic');
  topic.textContent = current.topic || '';
  topic.hidden = !current.topic;
  $('#review-q').textContent = current.q;
  $('#review-answer-text').textContent = current.a;
  $('#review-answer').hidden = true;
  $('#review-grades').hidden = true;
  $('#review-show').hidden = false;
  $('#review-show').focus();
  $('#review-crop').hidden = true;
  $('#review-crop-note').hidden = true;
  $('#review-insight').hidden = true;
  hintStep = 0;
  $('#review-hint-text').hidden = true;
  $('#review-hint-crop').hidden = true;
  $('#review-next').hidden = true;
  paintChoices();
  if (!choice) paintHintButton();
}

// With the mode on, the card is answered by picking. Null when this notebook
// can't supply enough believable decoys — that card is asked the ordinary way,
// and says so, or it would look as though the mode had switched itself off.
function paintChoices() {
  const box = $('#review-choices');
  const note = $('#review-choices-note');
  box.replaceChildren();
  box.hidden = true;
  note.hidden = true;
  choice = null;
  if (!choicesMode()) return;

  const built = buildChoices(current, cards);
  if (!built) {
    note.textContent =
      'Not enough other answers in this notebook to build options for this one, so it is asked outright.';
    note.hidden = false;
    return;
  }

  choice = { ...built, picked: null };
  for (const [i, text] of built.options.entries()) {
    const btn = document.createElement('button');
    btn.className = 'btn ghost review-choice';
    btn.dataset.index = String(i);
    const key = document.createElement('small');
    key.textContent = String(i + 1);
    const label = document.createElement('span');
    label.textContent = text;
    btn.append(key, label);
    btn.addEventListener('click', () => pick(i));
    box.appendChild(btn);
  }
  box.hidden = false;
  // Nothing to reveal until something is chosen; the ladder is off, because
  // the options are already the help.
  $('#review-show').hidden = true;
  $('#review-hint').hidden = true;
}

// Choosing is answering. The card grades itself on the way out — there is
// nothing left to assess about how it went.
async function pick(index) {
  if (!choice || choice.picked !== null) return;
  choice.picked = index;
  hintStep = CHOICE_RUNG;

  for (const btn of $('#review-choices').querySelectorAll('.review-choice')) {
    const i = Number(btn.dataset.index);
    btn.disabled = true;
    btn.classList.toggle('correct', i === choice.correct);
    btn.classList.toggle('wrong', i === index && index !== choice.correct);
  }

  await showAnswer({ grades: false });
  const next = $('#review-next');
  next.hidden = false;
  next.focus();
}

// Whether there is a line worth showing: the card knows where its answer was
// written, that page is still in the notebook, it is still the picture the box
// was measured against, and the crop would leave ink visible around the mask.
// The first three are what paintCrop checks before it crops at all.
function inkHintAvailable(card) {
  if (!card?.box) return false;
  const page = getContext().pages.find((p) => p.id === card.pageId);
  if (!page) return false;
  if (card.pageUuid && page.uuid && card.pageUuid !== page.uuid) return false;
  return !!hintRect(page, card.box);
}

// One button walks the ladder, so it names the next step rather than itself.
// Cards made before hints existed have only the ink step, and for them it
// reads exactly as it did before.
function paintHintButton() {
  const btn = $('#review-hint');
  const written = hintStep < 1 && !!current?.hint;
  const ink = hintStep < 2 && inkHintAvailable(current);
  btn.hidden = !written && !ink;
  $('#review-hint-label').textContent = written ? 'Hint' : 'Show the line';
}

// A step up the ladder. The written nudge first because it gives away least;
// the line it was written on second, with the answer covered — no model and no
// stored text, since the box has been on the card since it was made.
async function showHint() {
  if (!current || $('#review-hint').hidden) return;
  const card = current;

  if (hintStep < 1 && card.hint) {
    hintStep = 1;
    $('#review-hint-text').textContent = card.hint;
    $('#review-hint-text').hidden = false;
    paintHintButton();
    return;
  }

  const page = getContext().pages.find((p) => p.id === card.pageId);
  // Set before the crop, and kept even if it fails: what counts is that the
  // reader asked to be shown the neighbourhood, not whether we managed it.
  hintStep = 2;
  paintHintButton();

  try {
    const url = await cropHint(page, card.box);
    if (!url) return;
    // Overtaken while the crop was in flight: the card was graded, or the
    // reader gave up and pressed through to the answer. Either way this
    // picture has nowhere to go.
    if (current !== card || !$('#review-answer').hidden) {
      URL.revokeObjectURL(url);
      return;
    }
    releaseHint();
    hintUrl = url;
    $('#review-hint-img').src = hintUrl;
    $('#review-hint-cap').textContent = `Page ${page.order + 1} — the answer is covered`;
    $('#review-hint-crop').hidden = false;
  } catch (err) {
    console.error('Could not crop the hint', err);
  }
}

async function showAnswer({ grades = true } = {}) {
  if (!current || !$('#review-answer').hidden) return;
  $('#review-answer').hidden = false;
  $('#review-show').hidden = true;
  $('#review-hint').hidden = true;
  // The masked crop is overtaken, not the context in it: paintCrop puts the
  // same picture back with the block lifted and the answer marked instead.
  // Hiding it and dropping to the tight crop was the bug — it handed over the
  // answer with the sentence it lived in cut away from around it.
  $('#review-hint-crop').hidden = true;
  releaseHint();

  const insight = $('#review-insight');
  $('#review-insight-text').textContent = current.insight || '';
  insight.hidden = !current.insight;

  // Label each grade with what it costs you: "Good — 15 d" is the difference
  // between a scheduler you trust and four buttons you press at random.
  const buttons = $('#review-grades');
  buttons.replaceChildren();
  if (!grades) {
    buttons.hidden = true;
    await paintCrop(current);
    return;
  }
  for (const grade of offeredGrades()) {
    const btn = document.createElement('button');
    btn.className = `btn review-grade grade-${grade}`;
    btn.dataset.grade = grade;
    const label = document.createElement('span');
    label.textContent = GRADE_LABELS[grade];
    const when = document.createElement('small');
    when.textContent = formatInterval(nextInterval(current, grade));
    btn.append(label, when);
    btn.addEventListener('click', () => gradeCurrent(grade));
    buttons.appendChild(btn);
  }
  buttons.hidden = false;

  await paintCrop(current);
}

async function gradeCurrent(grade) {
  if (!current || $('#review-answer').hidden) return;
  // Read before nextCard() resets it: which rung this was answered at is half
  // of what the tallies are for, and by the time the write lands the ladder
  // belongs to the next card.
  const step = hintStep;
  const card = {
    ...review(current, grade, Date.now()),
    stats: recordAnswer(current.stats, grade, step),
  };
  const at = cards.findIndex((c) => c.id === card.id);
  if (at !== -1) cards[at] = card;
  // A failed card comes back in ten minutes, which is usually inside this
  // sitting — so it goes back on the end of the queue rather than waiting for
  // the panel to be opened again.
  if (grade === 'again') queue.push(card);
  await putCard(card);
  await bumpReviewDay(getContext().id, grade, step);
  onChanged();
  onDueCount(cards.filter((c) => isDue(c)).length);
  nextCard();
}

// ---------- the handwriting behind the answer ----------

function releaseCrop() {
  if (cropUrl) URL.revokeObjectURL(cropUrl);
  cropUrl = null;
}

function releaseHint() {
  if (hintUrl) URL.revokeObjectURL(hintUrl);
  hintUrl = null;
}

// The page behind the answer: the passage in the lines it was written among,
// with the words that answered the question marked. Padded, because a box that
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
    const url = await cropAnswer(page, card.box);
    releaseCrop();
    cropUrl = url;
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
  $('#review-topup').addEventListener('click', topUp);
  $('#review-decoys').addEventListener('click', writeDecoys);
  $('#review-stop').addEventListener('click', () => generating?.abort());
  $('#review-start').addEventListener('click', startSession);
  $('#review-hint').addEventListener('click', showHint);
  // Choosing already said how it went, so this only moves on.
  $('#review-next').addEventListener('click', () => {
    if (choice?.picked === null) return;
    gradeCurrent(choice.picked === choice.correct ? 'good' : 'again');
  });
  const mode = $('#review-choices-mode');
  mode.checked = choicesMode();
  mode.addEventListener('change', () => {
    localStorage.setItem(CHOICES_KEY, mode.checked ? '1' : '0');
    paintDeck(); // the decoy pass is only offered while the mode is on
  });
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
      // In the choice mode space never grades: the answer was already given by
      // picking, and taking it as "good" would score a wrong pick as right.
      if (choice) {
        if (choice.picked !== null) $('#review-next').click();
      } else if ($('#review-answer').hidden) showAnswer();
      else gradeCurrent('good');
      return;
    }
    if (e.key === 'h' && $('#review-answer').hidden) {
      e.preventDefault();
      showHint();
      return;
    }
    const n = Number(e.key);
    // Before anything is picked the numbers choose an option; the grades are
    // not on screen to be pressed.
    if (choice && choice.picked === null) {
      if (n >= 1 && n <= choice.options.length) {
        e.preventDefault();
        pick(n - 1);
      }
      return;
    }
    if (n >= 1 && n <= 4 && !$('#review-answer').hidden) {
      e.preventDefault();
      // Indexed into what is on screen, so 4 does nothing on a card whose
      // Easy was withdrawn rather than quietly grading it anyway.
      const grade = offeredGrades()[n - 1];
      if (grade) gradeCurrent(grade);
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
