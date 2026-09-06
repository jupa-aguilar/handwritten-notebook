// The proofreading panel: run the check over a page or the whole notebook,
// then walk the proposals one at a time.
//
// Nothing here changes a transcript without an explicit press. The model is
// allowed to point at a word; the user's own handwriting, cropped from the
// page beside the proposal, is what settles it.

import { putPage, touchNotebook } from './db.js';
import { resolveChatModel } from './chat.js';
import { proofreadPage, pagesToProof, applyCorrection, boxForCorrection } from './proof.js';
import { cropPage, pageForModel } from './crop.js';
import { escapeHtml } from './text.js';

const $ = (sel) => document.querySelector(sel);

let getContext = null; // () => { id, pages }
let onGoToPage = () => {};
let onChanged = () => {}; // main.js re-renders and schedules the push
let currentPageIndex = () => 0;

let queue = []; // { page, fix } still to be judged
let current = null;
let running = null; // AbortController while a check is in flight
let cropUrl = null;
let applied = 0;
let skipped = 0;

// ---------- the run ----------

async function check(all) {
  if (running) return;
  const { pages } = getContext();
  const todo = all ? pagesToProof(pages) : pagesToProof([pages[currentPageIndex()]].filter(Boolean));
  if (!todo.length) {
    setStatus('Nothing to check: a page needs a transcription with something on it.');
    return;
  }

  running = new AbortController();
  const { signal } = running;
  applied = 0;
  skipped = 0;
  paint();

  let model;
  try {
    model = (await resolveChatModel()).id;
  } catch (err) {
    running = null;
    setStatus(err.message, true);
    paint();
    return;
  }

  let found = 0;
  // Whether the model behind this run will take a page image. Resolved on the
  // first refusal and remembered, so a notebook-wide check against a text-only
  // model doesn't pay for the same rejected request on every page.
  let canSee = true;
  let blinded = false;
  for (const [i, page] of todo.entries()) {
    if (signal.aborted) break;
    setStatus(`Reading page ${page.order + 1} — ${i + 1} of ${todo.length}, ${found} to look at…`);
    try {
      const image = canSee ? await pageForModel(page).catch(() => null) : null;
      let fixes;
      try {
        fixes = await proofreadPage(page, { signal, model, image });
      } catch (err) {
        // A model that can't read images refuses the request rather than
        // failing to reach us, so only a refusal is worth a second try — and
        // only the one, without the page. Anything else is a real failure and
        // belongs to the catch below.
        if (!image || signal.aborted || !(err.status >= 400 && err.status < 500)) throw err;
        canSee = false;
        blinded = true;
        fixes = await proofreadPage(page, { signal, model, image: null });
      }
      for (const fix of fixes) queue.push({ page, fix });
      found += fixes.length;
    } catch (err) {
      if (signal.aborted) break;
      console.error('Could not proofread page', page.order + 1, err);
    }
    paint();
  }

  const stopped = signal.aborted;
  running = null;
  // Worth saying out loud: a check that couldn't see the page only catches a
  // misreading that left a hole in the meaning, so "nothing to correct" from a
  // blind run means much less than it looks like.
  const blindNote = blinded
    ? ' The model in use can\'t read images, so this was checked against the text alone.'
    : '';
  if (queue.length) {
    setStatus(blindNote.trim());
    next();
  } else {
    setStatus(
      `${stopped ? 'Stopped — ' : ''}Nothing to correct on ${todo.length} page${todo.length === 1 ? '' : 's'}.${blindNote}`
    );
  }
  paint();
}

// ---------- one proposal at a time ----------

function next() {
  releaseCrop();
  current = queue.shift() || null;
  if (!current) {
    $('#proof-fix').hidden = true;
    setStatus(summary());
    paint();
    return;
  }
  const { page, fix } = current;
  $('#proof-fix').hidden = false;
  $('#proof-remaining').textContent = `${queue.length + 1} left · page ${page.order + 1}`;
  $('#proof-why').textContent = fix.why || '';
  $('#proof-line').innerHTML = renderChange(fix);
  $('#proof-crop').hidden = true;
  $('#proof-crop-note').hidden = true;
  paintCrop(page, fix);
  paint();
}

// The line as transcribed, with the word that would change marked in it, and
// the replacement beside it. Escaped by hand because it is the one place OCR
// text (and a model's echo of it) reaches innerHTML.
function renderChange(fix) {
  const context = fix.context || fix.before;
  const at = context.indexOf(fix.before);
  const before = escapeHtml(fix.before);
  const after = escapeHtml(fix.after);
  const line =
    at === -1
      ? `<span class="proof-wrong">${before}</span>`
      : escapeHtml(context.slice(0, at)) +
        `<span class="proof-wrong">${before}</span>` +
        escapeHtml(context.slice(at + fix.before.length));
  return `<div class="proof-context">${line}</div>
    <div class="proof-arrow">${before} → <strong class="proof-right">${after}</strong></div>`;
}

async function paintCrop(page, fix) {
  const box = boxForCorrection(page, fix);
  const note = $('#proof-crop-note');
  if (!box) {
    // Two different reasons, and the common one changed when the check started
    // reading the page: a model looking at the ink proposes fixes to formulae
    // and symbols, which are exactly what Vision's word list cuts differently
    // from its text, so the words are there and the fix still can't be found
    // among them. Either way the reader is being asked to approve a change
    // without the handwriting in front of them, and should be told to go look.
    note.textContent = page.words?.length
      ? 'This one couldn’t be placed among the page’s words, so the line can’t be shown — open the page and check it yourself before applying.'
      : 'This page was transcribed before word positions were saved, so the line can’t be shown.';
    note.hidden = false;
    return;
  }
  try {
    const url = await cropPage(page, box);
    // Another proposal came up while this was decoding.
    if (!current || current.page !== page || current.fix !== fix) {
      if (url) URL.revokeObjectURL(url);
      return;
    }
    releaseCrop();
    cropUrl = url;
    $('#proof-crop-img').src = url;
    $('#proof-crop').hidden = false;
  } catch (err) {
    console.error('Could not crop the line', err);
    note.textContent = 'The page image could not be read.';
    note.hidden = false;
  }
}

async function apply() {
  if (!current) return;
  const { page, fix } = current;
  const out = applyCorrection(page, fix);
  if (!out) {
    // The page changed under the run; better to drop the fix than to guess.
    setStatus('That line has changed since the check ran, so the fix was dropped.', true);
    next();
    return;
  }
  page.text = out.text;
  page.words = out.words;
  // The full ritual: a transcript is notebook content, and sync has to carry it.
  await putPage(page);
  await touchNotebook(page.notebookId);
  applied++;
  onChanged(page);
  next();
}

function skip() {
  if (!current) return;
  skipped++;
  next();
}

function summary() {
  if (!applied && !skipped) return '';
  const bits = [];
  if (applied) bits.push(`${applied} correction${applied === 1 ? '' : 's'} applied`);
  if (skipped) bits.push(`${skipped} left alone`);
  return bits.join(' · ') + '.';
}

// ---------- panel plumbing ----------

function setStatus(text, isError = false) {
  const el = $('#proof-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = !text;
}

function paint() {
  const { pages } = getContext();
  const busy = !!running;
  const judging = !$('#proof-fix').hidden;
  const page = pages[currentPageIndex()];
  const all = pagesToProof(pages).length;

  $('#proof-stop').hidden = !busy;
  const one = $('#proof-check-page');
  one.hidden = busy || judging || !page;
  one.textContent = `✨ Check page ${page ? page.order + 1 : ''}`;
  const every = $('#proof-check-all');
  every.hidden = busy || judging || all === 0;
  every.textContent = `✨ Check all pages (${all})`;
}

function releaseCrop() {
  if (cropUrl) URL.revokeObjectURL(cropUrl);
  cropUrl = null;
}

function setOpen(open) {
  const el = $('#proof');
  if (open === !el.hidden) return;
  el.hidden = !open;
  if (open) {
    setStatus('');
    paint();
  } else {
    running?.abort();
    queue = [];
    current = null;
    applied = 0;
    skipped = 0;
    releaseCrop();
    $('#proof-fix').hidden = true;
  }
}

export function openProof() {
  setOpen($('#proof').hidden);
}

export function closeProof() {
  setOpen(false);
}

export function initProof(opts) {
  getContext = opts.getContext;
  onGoToPage = opts.onGoToPage || onGoToPage;
  onChanged = opts.onChanged || onChanged;
  currentPageIndex = opts.currentPageIndex || currentPageIndex;

  $('#proof-close').addEventListener('click', () => setOpen(false));
  $('#proof-check-page').addEventListener('click', () => check(false));
  $('#proof-check-all').addEventListener('click', () => check(true));
  $('#proof-stop').addEventListener('click', () => running?.abort());
  $('#proof-apply').addEventListener('click', apply);
  $('#proof-skip').addEventListener('click', skip);
  $('#proof-goto').addEventListener('click', () => {
    if (!current) return;
    const { pages } = getContext();
    const index = pages.indexOf(current.page);
    if (index === -1) return;
    setOpen(false);
    onGoToPage(index);
  });

  document.addEventListener('keydown', (e) => {
    if ($('#proof').hidden || $('#proof-fix').hidden) return;
    if (e.target.matches('input, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      skip();
    }
  });
}
