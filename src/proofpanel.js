// The proofreading panel: run the check over a page or the whole notebook,
// then walk the proposals one at a time.
//
// Nothing here changes a transcript without an explicit press. The model is
// allowed to point at a word; the user's own handwriting, cropped from the
// page beside the proposal, is what settles it.

import { putPage, touchNotebook } from './db.js';
import { resolveChatModel } from './chat.js';
import { proofreadPage, pagesToProof, applyCorrection, boxForCorrection } from './proof.js';
import { cropPage } from './crop.js';
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
  for (const [i, page] of todo.entries()) {
    if (signal.aborted) break;
    setStatus(`Reading page ${page.order + 1} — ${i + 1} of ${todo.length}, ${found} to look at…`);
    try {
      const fixes = await proofreadPage(page, { signal, model });
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
  if (queue.length) {
    setStatus('');
    next();
  } else {
    setStatus(
      `${stopped ? 'Stopped — ' : ''}Nothing to correct on ${todo.length} page${todo.length === 1 ? '' : 's'}.`
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
    note.textContent = 'This page was transcribed before word positions were saved, so the line can’t be shown.';
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
