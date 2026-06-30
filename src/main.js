// Import the ESM build directly: the package's "main" points at a UMD bundle
// whose interop breaks under Vite, so the named/default import resolves to undefined.
import { PageFlip } from 'page-flip/dist/js/page-flip.module.js';
import './style.css';
import {
  listNotebooks,
  addNotebook,
  renameNotebook,
  deleteNotebook,
  getPages,
  countPages,
  addPage,
  putPage,
  deletePage,
  reorderPages,
  nextOrder,
  clearAll,
} from './db.js';
import { transcribeImage } from './ocr.js';

// Handwriting OCR via Google Cloud Vision. Flip to `false` to disable.
const TRANSCRIPTION_ENABLED = true;

const MAX_EDGE = 2000; // long-edge cap (px) for stored/transcribed images
const JPEG_QUALITY = 0.85;
const KEY_STORAGE = 'notebook.googleVisionKey';
const CURRENT_KEY = 'notebook.currentId';
const POSITIONS_KEY = 'notebook.positions'; // { [notebookId]: lastPageIndex }
const USAGE_KEY = 'notebook.usage';
const FREE_TIER = 1000; // Google Cloud Vision free pages per month

let pages = [];          // page records for the current notebook, ordered
let currentNotebookId = null;
let objectUrls = [];     // live object URLs to revoke on re-render
let gridUrls = [];       // thumbnail object URLs for the pages overview
let dragSrcIndex = null;  // index of the page being dragged in the overview
let pageFlip = null;
let currentPage = 0;
let ocrRunning = false;

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function getApiKey() {
  return localStorage.getItem(KEY_STORAGE) || '';
}

// Remember which page each notebook was left on, so it reopens there.
function getSavedPage(notebookId) {
  try {
    const map = JSON.parse(localStorage.getItem(POSITIONS_KEY) || '{}');
    const idx = map[notebookId];
    return Number.isInteger(idx) && idx >= 0 ? idx : 0;
  } catch {
    return 0;
  }
}

function savePage(notebookId, index) {
  if (notebookId == null) return;
  let map = {};
  try {
    map = JSON.parse(localStorage.getItem(POSITIONS_KEY) || '{}');
  } catch {
    /* ignore */
  }
  map[notebookId] = index;
  localStorage.setItem(POSITIONS_KEY, JSON.stringify(map));
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function highlight(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

// Downscale + re-encode to JPEG via canvas. Returns { blob, mediaType, width, height }.
function processImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve({ blob, mediaType: 'image/jpeg', width, height });
          else reject(new Error('Could not encode image'));
        },
        'image/jpeg',
        JPEG_QUALITY
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not load image'));
    };
    img.src = url;
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // strip data: prefix
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- rendering ----------

// Decode an image fully so StPageFlip can read its natural size synchronously.
function preloadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = () => resolve();
    img.src = url;
  });
}

// Each renderBook() call gets a token; if another render starts while this one
// is awaiting image decode, the stale one bails out instead of clobbering it.
let renderToken = 0;

async function renderBook() {
  const token = ++renderToken;

  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];

  // StPageFlip's destroy() ends with `this.block.remove()`, which deletes the
  // #book element from the DOM. So after the first notebook we must recreate it;
  // otherwise the flipbook is built on a detached node and renders blank until a
  // full page refresh puts a fresh #book back.
  if (pageFlip) {
    pageFlip.destroy();
    pageFlip = null;
  }
  let el = document.getElementById('book');
  if (!el) {
    el = document.createElement('div');
    el.id = 'book';
    el.className = 'book';
    $('.book-area').insertBefore(el, $('#pager'));
  } else {
    el.innerHTML = '';
  }

  const empty = $('#empty');
  if (pages.length === 0) {
    empty.hidden = false;
    el.hidden = true;
    $('#pager').hidden = true;
    return;
  }
  empty.hidden = true;
  el.hidden = false;
  $('#pager').hidden = false;

  const urls = pages.map((p) => {
    const u = URL.createObjectURL(p.blob);
    objectUrls.push(u);
    return u;
  });

  // Decode the images before building the flipbook. Without this, StPageFlip
  // measures zero-sized images and renders blank until something forces a
  // relayout (which is why a manual refresh "fixed" it).
  await Promise.all(urls.map(preloadImage));
  if (token !== renderToken) return; // a newer render superseded this one

  pageFlip = new PageFlip(el, {
    width: 550,
    height: 733,
    size: 'stretch',
    minWidth: 315,
    maxWidth: 1200,
    minHeight: 400,
    maxHeight: 1500,
    maxShadowOpacity: 0.5,
    showCover: false,
    usePortrait: true,
    mobileScrollSupport: true,
  });
  pageFlip.loadFromImages(urls);
  pageFlip.on('flip', (e) => {
    currentPage = e.data;
    savePage(currentNotebookId, currentPage);
    updatePanel();
    updatePager();
    updateHighlights();
  });
  // Hide the boxes while a page is mid-flip (they'd float over the 3D curl) and
  // redraw them once it settles back to a flat "read" state.
  pageFlip.on('changeState', (e) => {
    if (e.data === 'read') updateHighlights();
    else clearHighlights();
  });
  pageFlip.on('changeOrientation', () => updateHighlights());
  // Nudge StPageFlip to recompute its stretched size now that the fresh
  // container is in the DOM and visible (e.g. after a modal closes), then
  // position the highlight boxes against the freshly measured geometry.
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'));
    updateHighlights();
  });
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
    updateHighlights();
  }, 150);
  currentPage = Math.max(0, Math.min(currentPage, pages.length - 1));
  // Jump (no animation) to the page this notebook was last left on.
  if (currentPage > 0) pageFlip.turnToPage(currentPage);
  savePage(currentNotebookId, currentPage);
  updatePanel();
  updatePager();
}

function updatePager() {
  const indicator = $('#page-indicator');
  if (!indicator) return;
  indicator.textContent = pages.length ? `${currentPage + 1} / ${pages.length}` : '';
  $('#first').disabled = currentPage <= 0;
  $('#last').disabled = currentPage >= pages.length - 1;
}

function goFirst() {
  if (pageFlip && currentPage > 0) pageFlip.flip(0);
}
function goLast() {
  if (pageFlip && currentPage < pages.length - 1) pageFlip.flip(pages.length - 1);
}

// Delete one specific page (by id), wherever it sits in the notebook.
async function removePage(id) {
  const index = pages.findIndex((p) => p.id === id);
  if (index === -1) return;
  const page = pages[index];
  if (
    !confirm(`Delete page ${index + 1} (${page.name})? This cannot be undone.`)
  )
    return;
  await deletePage(id);
  pages = await getPages(currentNotebookId);
  // Keep the viewer roughly where it was: shift back if we removed a page
  // at or before the one being shown, then clamp into range.
  if (index <= currentPage) currentPage--;
  currentPage = Math.max(0, Math.min(currentPage, pages.length - 1));
  renderBook();
  refreshSearch();
  setOcrStatus('Page deleted');
}

function updatePanel() {
  const body = $('#panel-body');
  const page = pages[currentPage];
  if (!page) {
    body.innerHTML = '';
    return;
  }
  const query = $('#search').value.trim();
  let html = `<div class="panel-meta">Page ${currentPage + 1} of ${pages.length} · ${escapeHtml(
    page.name
  )}</div>`;
  if (page.ocrStatus === 'skipped') {
    html += `<div class="panel-note">Transcription is turned off, so page text and search aren't available yet.</div>`;
  } else if (page.ocrStatus === 'pending') {
    html += `<div class="panel-note">Transcribing…</div>`;
  } else if (page.ocrStatus === 'error') {
    html += `<div class="panel-note error">Transcription failed: ${escapeHtml(
      page.error || 'unknown error'
    )}</div>
      <div class="panel-actions">
        <button id="retry-page" class="btn small">Retry this page</button>
        <button id="retry-all" class="btn ghost small">Retry all failed</button>
      </div>`;
  } else if (!page.text) {
    html += `<div class="panel-note">No text detected on this page.</div>`;
  } else {
    html += `<pre class="transcript">${highlight(page.text, query)}</pre>`;
  }
  body.innerHTML = html;

  const retryPage = body.querySelector('#retry-page');
  if (retryPage) retryPage.addEventListener('click', () => retryFailed(page.id));
  const retryAll = body.querySelector('#retry-all');
  if (retryAll) retryAll.addEventListener('click', () => retryFailed());
}

async function retryFailed(onlyId) {
  for (const p of pages) {
    if (p.ocrStatus === 'error' && (onlyId == null || p.id === onlyId)) {
      p.ocrStatus = 'pending';
      p.error = '';
      await putPage(p);
    }
  }
  updatePanel();
  runOcrQueue();
}

// ---------- search ----------

function refreshSearch() {
  const query = $('#search').value.trim();
  const results = $('#results');
  const count = $('#search-count');

  if (!query) {
    count.textContent = '';
    results.hidden = true;
    results.innerHTML = '';
    updatePanel();
    clearHighlights();
    return;
  }

  const q = query.toLowerCase();
  const matches = pages
    .map((p, i) => ({ page: p, index: i }))
    .filter(({ page }) => (page.text || '').toLowerCase().includes(q));

  count.textContent = `${matches.length} page${matches.length === 1 ? '' : 's'}`;

  results.hidden = false;
  results.innerHTML =
    matches.length === 0
      ? '<div class="panel-note">No matches.</div>'
      : `<div class="results-head">Found on ${matches.length} page${
          matches.length === 1 ? '' : 's'
        }</div>` +
        matches
          .map(({ page, index }) => {
            const text = page.text || '';
            const at = text.toLowerCase().indexOf(q);
            const start = Math.max(0, at - 30);
            const snippet =
              (start > 0 ? '…' : '') +
              text.slice(start, at + query.length + 40).replace(/\s+/g, ' ') +
              '…';
            return `<button class="result" data-page="${index}">
                <span class="result-page">p.${index + 1}</span>
                <span class="result-snippet">${highlight(snippet, query)}</span>
              </button>`;
          })
          .join('');

  results.querySelectorAll('.result').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.page);
      if (pageFlip) pageFlip.flip(idx);
      currentPage = idx;
      updatePanel();
    });
  });

  openPanel();
  updatePanel();
  updateHighlights();
}

// ---------- highlight boxes over the page image ----------

function clearHighlights() {
  const layer = $('#highlights');
  if (layer) layer.replaceChildren();
}

// Draw a box over every word on the visible page(s) that matches the search.
// StPageFlip draws onto a <canvas>, so we position an absolute overlay using the
// page geometry it exposes via getRender().getRect(). Called only with the page
// at rest (boxes are cleared during the 3D flip, which would distort them).
function updateHighlights() {
  const layer = $('#highlights');
  if (!layer) return;
  layer.replaceChildren();

  if (!pageFlip || pages.length === 0) return;
  const query = $('#search').value.trim().toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return;

  const canvas = $('#book').querySelector('canvas');
  const rect = pageFlip.getRender().getRect(); // { left, top, height, pageWidth }
  if (!canvas || !rect) return;

  // Which page indices are on screen, and each one's x-offset inside the spread.
  // Without a cover, landscape spreads are [0,1], [2,3], … (even index on left);
  // portrait shows a single page in the right-hand slot.
  const idx = pageFlip.getCurrentPageIndex();
  const visible = [];
  if (pageFlip.getOrientation() === 'portrait') {
    visible.push({ i: idx, offset: rect.pageWidth });
  } else {
    const left = idx - (idx % 2);
    visible.push({ i: left, offset: 0 });
    if (left + 1 < pages.length) visible.push({ i: left + 1, offset: rect.pageWidth });
  }

  const canvasBox = canvas.getBoundingClientRect();
  const layerBox = layer.getBoundingClientRect();
  const frag = document.createDocumentFragment();

  for (const { i, offset } of visible) {
    const page = pages[i];
    if (!page?.words?.length || !page.width || !page.height) continue;
    const pageLeft = canvasBox.left - layerBox.left + rect.left + offset;
    const pageTop = canvasBox.top - layerBox.top + rect.top;
    const sx = rect.pageWidth / page.width;
    const sy = rect.height / page.height;
    for (const w of page.words) {
      if (!tokens.some((t) => w.t.toLowerCase().includes(t))) continue;
      const box = document.createElement('div');
      box.className = 'hl-box';
      box.style.left = `${pageLeft + w.x * sx}px`;
      box.style.top = `${pageTop + w.y * sy}px`;
      box.style.width = `${w.w * sx}px`;
      box.style.height = `${w.h * sy}px`;
      frag.appendChild(box);
    }
  }
  layer.appendChild(frag);
}

// ---------- OCR queue ----------

async function runOcrQueue() {
  if (!TRANSCRIPTION_ENABLED) return;
  if (ocrRunning) return;
  ocrRunning = true;
  try {
    while (true) {
      const page = pages.find((p) => p.ocrStatus === 'pending');
      if (!page) break;

      const apiKey = getApiKey();
      if (!apiKey) {
        setOcrStatus('Add an API key to transcribe pages →');
        break;
      }

      setOcrStatus(`Transcribing page ${pages.indexOf(page) + 1}…`);
      try {
        const base64 = await blobToBase64(page.blob);
        const { text, words } = await transcribeImage({
          base64,
          mediaType: page.mediaType,
          apiKey,
        });
        page.text = text;
        page.words = words;
        page.ocrStatus = 'done';
        page.error = '';
        bumpUsage();
      } catch (err) {
        console.error('OCR failed', err);
        page.ocrStatus = 'error';
        page.error = err.message;
        page.text = '';
        page.words = [];
      }
      await putPage(page);
      if (pages[currentPage] === page) updatePanel();
      refreshSearch();
    }
  } finally {
    ocrRunning = false;
    const pending = pages.filter((p) => p.ocrStatus === 'pending').length;
    setOcrStatus(pending ? `${pending} page(s) waiting` : '');
  }
}

function setOcrStatus(text) {
  $('#ocr-status').textContent = text;
}

// ---------- monthly usage estimate (local, resets on the 1st) ----------

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM'
}

function getUsage() {
  try {
    const u = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
    if (u.month === currentMonth() && typeof u.count === 'number') return u;
  } catch {
    /* ignore */
  }
  return { month: currentMonth(), count: 0 };
}

function bumpUsage() {
  const u = getUsage();
  u.count += 1;
  localStorage.setItem(USAGE_KEY, JSON.stringify(u));
  updateUsageDisplay();
}

function updateUsageDisplay() {
  const el = $('#usage');
  if (!el) return;
  if (!TRANSCRIPTION_ENABLED) {
    el.textContent = '';
    return;
  }
  const { count } = getUsage();
  el.textContent = `OCR: ${count} / ${FREE_TIER} this month`;
  el.classList.toggle('over', count >= FREE_TIER);
  el.classList.toggle('warn', count >= FREE_TIER * 0.8 && count < FREE_TIER);
}

// ---------- uploads ----------

async function handleFiles(fileList) {
  const files = [...fileList]
    .filter(
      (f) =>
        f.type.startsWith('image/') ||
        /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(f.name)
    )
    .sort((a, b) => naturalCompare(a.name, b.name));
  if (files.length === 0) {
    setOcrStatus('No image files found in that selection');
    return;
  }

  setOcrStatus(`Importing ${files.length} page(s)…`);
  let order = await nextOrder(currentNotebookId);
  let added = 0;
  const errors = [];
  for (const file of files) {
    try {
      const { blob, mediaType, width, height } = await processImage(file);
      const record = {
        notebookId: currentNotebookId,
        order: order++,
        name: file.name,
        blob,
        mediaType,
        width,
        height,
        text: '',
        words: [],
        ocrStatus: TRANSCRIPTION_ENABLED ? 'pending' : 'skipped',
      };
      record.id = await addPage(record);
      added++;
    } catch (err) {
      console.error('Skipping unreadable image', file.name, err);
      errors.push(`${file.name}: ${err.message}`);
    }
  }

  pages = await getPages(currentNotebookId);
  renderBook();

  if (added === 0) {
    setOcrStatus('Could not import any pages');
    alert('No pages could be added:\n\n' + errors.join('\n'));
    return;
  }
  setOcrStatus(`Added ${added} page(s)`);
  runOcrQueue();
}

// ---------- settings modal ----------

function openSettings() {
  $('#api-key').value = getApiKey();
  $('#settings').hidden = false;
  $('#api-key').focus();
}

function closeSettings() {
  $('#settings').hidden = true;
}

function saveSettings() {
  const key = $('#api-key').value.trim();
  if (key) localStorage.setItem(KEY_STORAGE, key);
  else localStorage.removeItem(KEY_STORAGE);
  closeSettings();
  runOcrQueue(); // resume any pending transcriptions now that a key exists
}

// ---------- panel ----------

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

// Showing/hiding the text panel changes the book's available width. StPageFlip
// only refits on a window 'resize', so fire one; the ResizeObserver on the book
// area then repositions the highlight boxes against the new geometry.
function setPanelHidden(hidden) {
  $('#panel').hidden = hidden;
  if (!hidden) updatePanel();
  window.dispatchEvent(new Event('resize'));
}

function openPanel() {
  setPanelHidden(false);
}
function togglePanel() {
  setPanelHidden($('#panel').hidden === false);
}

// ---------- notebooks ----------

function updateCurrentName(notebooks) {
  const nb = notebooks.find((n) => n.id === currentNotebookId);
  const name = nb ? nb.name : '';
  $('#current-notebook').textContent = name;
  document.title = name ? `${name} — My Notebook` : 'My Notebook';
}

async function loadCurrentNotebook() {
  pages = await getPages(currentNotebookId);
  currentPage = getSavedPage(currentNotebookId);
  $('#search').value = '';
  renderBook();
  refreshSearch();
}

// Pick the current notebook on startup, creating a default one if none exist.
async function ensureNotebook() {
  let notebooks = await listNotebooks();
  if (notebooks.length === 0) {
    currentNotebookId = await addNotebook('My Notebook');
    notebooks = await listNotebooks();
  } else {
    const saved = Number(localStorage.getItem(CURRENT_KEY));
    currentNotebookId = notebooks.some((n) => n.id === saved)
      ? saved
      : notebooks[0].id;
  }
  localStorage.setItem(CURRENT_KEY, String(currentNotebookId));
  updateCurrentName(notebooks);
}

async function switchNotebook(id, { closeModal = true } = {}) {
  currentNotebookId = id;
  localStorage.setItem(CURRENT_KEY, String(id));
  updateCurrentName(await listNotebooks());
  // Close the modal first so the book renders into a fully visible, laid-out
  // stage (StPageFlip measures the container when it builds the flipbook).
  if (closeModal) $('#notebooks').hidden = true;
  await loadCurrentNotebook();
  if (TRANSCRIPTION_ENABLED && pages.some((p) => p.ocrStatus === 'pending')) {
    runOcrQueue();
  }
}

async function renderNotebookList() {
  const notebooks = await listNotebooks();
  const ul = $('#notebook-list');
  ul.innerHTML = notebooks
    .map(
      (nb) => `<li class="nb-item ${nb.id === currentNotebookId ? 'active' : ''}">
        <button class="nb-open" data-id="${nb.id}">
          ${escapeHtml(nb.name)}
          <span class="nb-count" id="nb-count-${nb.id}"></span>
        </button>
        <span class="nb-actions">
          <button class="btn ghost small nb-rename" data-id="${nb.id}" title="Rename">✏️</button>
          <button class="btn ghost small nb-retrans" data-id="${nb.id}" title="Re-transcribe">🔄</button>
          <button class="btn ghost small nb-export" data-id="${nb.id}" title="Export / backup">📤</button>
          <button class="btn ghost small nb-delete" data-id="${nb.id}" title="Delete">🗑️</button>
        </span>
      </li>`
    )
    .join('');

  for (const nb of notebooks) {
    const n = await countPages(nb.id);
    const el = document.getElementById(`nb-count-${nb.id}`);
    if (el) el.textContent = `· ${n} page${n === 1 ? '' : 's'}`;
  }

  ul.querySelectorAll('.nb-open').forEach((b) =>
    b.addEventListener('click', () => switchNotebook(Number(b.dataset.id)))
  );
  ul.querySelectorAll('.nb-rename').forEach((b) =>
    b.addEventListener('click', () => renameNotebookPrompt(Number(b.dataset.id)))
  );
  ul.querySelectorAll('.nb-retrans').forEach((b) =>
    b.addEventListener('click', () => retranscribeNotebook(Number(b.dataset.id)))
  );
  ul.querySelectorAll('.nb-export').forEach((b) =>
    b.addEventListener('click', () => exportNotebook(Number(b.dataset.id)))
  );
  ul.querySelectorAll('.nb-delete').forEach((b) =>
    b.addEventListener('click', () => deleteNotebookFlow(Number(b.dataset.id)))
  );
}

function openNotebooks() {
  $('#notebooks').hidden = false;
  renderNotebookList();
}

async function createNotebook() {
  const input = $('#new-notebook-name');
  const name = input.value.trim() || 'Untitled notebook';
  const id = await addNotebook(name);
  input.value = '';
  await switchNotebook(id, { closeModal: false });
  renderNotebookList();
}

async function renameNotebookPrompt(id) {
  const notebooks = await listNotebooks();
  const nb = notebooks.find((n) => n.id === id);
  const name = prompt('Notebook name:', nb ? nb.name : '');
  if (name == null || !name.trim()) return;
  await renameNotebook(id, name.trim());
  updateCurrentName(await listNotebooks());
  renderNotebookList();
}

async function deleteNotebookFlow(id) {
  if (!confirm('Delete this notebook and all its pages? This cannot be undone.'))
    return;
  await deleteNotebook(id);
  let remaining = await listNotebooks();
  if (remaining.length === 0) {
    currentNotebookId = await addNotebook('My Notebook');
    remaining = await listNotebooks();
  } else if (id === currentNotebookId) {
    currentNotebookId = remaining[0].id;
  }
  localStorage.setItem(CURRENT_KEY, String(currentNotebookId));
  updateCurrentName(remaining);
  await loadCurrentNotebook();
  renderNotebookList();
}

// Re-run OCR for every page in a notebook.
async function retranscribeNotebook(id) {
  if (
    !confirm('Re-transcribe every page in this notebook? This re-runs OCR on all of them.')
  )
    return;
  $('#notebooks').hidden = true;
  if (id !== currentNotebookId) await switchNotebook(id, { closeModal: false });
  for (const p of pages) {
    p.ocrStatus = TRANSCRIPTION_ENABLED ? 'pending' : 'skipped';
    p.text = '';
    p.words = [];
    p.error = '';
    await putPage(p);
  }
  updatePanel();
  refreshSearch();
  renderNotebookList();
  runOcrQueue();
}

// ---------- export / import (backup) ----------

const EXPORT_FORMAT = 'my-notebook-export';
const EXPORT_VERSION = 1;

function base64ToBlob(base64, mediaType) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mediaType || 'image/jpeg' });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Bundle a whole notebook (images + transcripts + word boxes) into one JSON
// file the user can keep as a backup or move to another device/browser.
async function exportNotebook(id) {
  const notebooks = await listNotebooks();
  const nb = notebooks.find((n) => n.id === id);
  if (!nb) return;
  setOcrStatus(`Exporting “${nb.name}”…`);
  try {
    const nbPages = await getPages(id);
    const exported = [];
    for (const p of nbPages) {
      exported.push({
        order: p.order,
        name: p.name,
        mediaType: p.mediaType,
        width: p.width,
        height: p.height,
        text: p.text || '',
        words: p.words || [],
        ocrStatus: p.ocrStatus,
        error: p.error || '',
        image: await blobToBase64(p.blob), // base64, no data: prefix
      });
    }
    const data = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: Date.now(),
      notebook: { name: nb.name },
      pages: exported,
    };
    const safe = (nb.name || 'notebook').replace(/[^\w.-]+/g, '_').slice(0, 60);
    downloadBlob(
      new Blob([JSON.stringify(data)], { type: 'application/json' }),
      `${safe}.notebook.json`
    );
    setOcrStatus(`Exported ${exported.length} page(s)`);
  } catch (err) {
    console.error('Export failed', err);
    setOcrStatus('Export failed');
    alert('Could not export this notebook:\n\n' + err.message);
  }
}

async function importNotebookFromFile(file) {
  setOcrStatus(`Importing “${file.name}”…`);
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    setOcrStatus('Import failed');
    alert('That file is not a valid notebook backup (could not parse JSON).');
    return;
  }
  if (data?.format !== EXPORT_FORMAT || !Array.isArray(data.pages)) {
    setOcrStatus('Import failed');
    alert('That file is not a My Notebook backup.');
    return;
  }

  try {
    const name = (data.notebook?.name || 'Imported notebook').trim();
    const newId = await addNotebook(name);
    let order = 0;
    for (const p of data.pages) {
      if (!p.image) continue;
      await addPage({
        notebookId: newId,
        order: typeof p.order === 'number' ? p.order : order,
        name: p.name || `page-${order + 1}`,
        blob: base64ToBlob(p.image, p.mediaType),
        mediaType: p.mediaType || 'image/jpeg',
        width: p.width,
        height: p.height,
        text: p.text || '',
        words: p.words || [],
        ocrStatus: p.ocrStatus || (p.text ? 'done' : 'skipped'),
        error: p.error || '',
      });
      order++;
    }
    setOcrStatus(`Imported ${order} page(s)`);
    await switchNotebook(newId, { closeModal: true });
    if (TRANSCRIPTION_ENABLED && pages.some((p) => p.ocrStatus === 'pending')) {
      runOcrQueue();
    }
  } catch (err) {
    console.error('Import failed', err);
    setOcrStatus('Import failed');
    alert('Could not import that notebook:\n\n' + err.message);
  }
}

// ---------- pages overview ----------

function openPagesOverview() {
  $('#pages-overview').hidden = false;
  renderPagesGrid();
}

function closePagesOverview() {
  $('#pages-overview').hidden = true;
  gridUrls.forEach((u) => URL.revokeObjectURL(u));
  gridUrls = [];
}

function renderPagesGrid() {
  gridUrls.forEach((u) => URL.revokeObjectURL(u));
  gridUrls = [];

  const grid = $('#pages-grid');
  if (pages.length === 0) {
    grid.innerHTML = '<div class="panel-note">This notebook has no pages.</div>';
    return;
  }

  grid.innerHTML = pages
    .map((p, i) => {
      const u = URL.createObjectURL(p.blob);
      gridUrls.push(u);
      return `<figure class="page-card" draggable="true" data-index="${i}">
          <button class="page-thumb" data-index="${i}" title="Open page ${i + 1}">
            <img src="${u}" alt="Page ${i + 1}" loading="lazy" />
          </button>
          <figcaption class="page-card-meta">
            <span class="page-card-num">${i + 1}</span>
            <span class="page-card-name">${escapeHtml(p.name)}</span>
            <button class="btn ghost small page-card-delete" data-id="${p.id}" title="Delete this page">🗑️</button>
          </figcaption>
        </figure>`;
    })
    .join('');

  grid.querySelectorAll('.page-thumb').forEach((b) =>
    b.addEventListener('click', () => {
      const idx = Number(b.dataset.index);
      closePagesOverview();
      if (pageFlip) pageFlip.flip(idx);
      currentPage = idx;
      updatePanel();
      updatePager();
    })
  );

  grid.querySelectorAll('.page-card-delete').forEach((b) =>
    b.addEventListener('click', async () => {
      await removePage(Number(b.dataset.id));
      if (pages.length === 0) closePagesOverview();
      else renderPagesGrid();
    })
  );

  grid.querySelectorAll('.page-card').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      dragSrcIndex = Number(card.dataset.index);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      dragSrcIndex = null;
      grid.querySelectorAll('.page-card').forEach((c) =>
        c.classList.remove('dragging', 'drag-over')
      );
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (Number(card.dataset.index) !== dragSrcIndex) card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const target = Number(card.dataset.index);
      if (dragSrcIndex != null && dragSrcIndex !== target) {
        movePage(dragSrcIndex, target);
      }
    });
  });
}

// Move the page at index `from` to index `to`, then persist the new order.
async function movePage(from, to) {
  // Remember the open page so the viewer can follow it after reordering.
  const openId = pages[currentPage] ? pages[currentPage].id : null;
  const [moved] = pages.splice(from, 1);
  pages.splice(to, 0, moved);
  await reorderPages(pages.map((p) => p.id));
  pages = await getPages(currentNotebookId);
  const newIdx = pages.findIndex((p) => p.id === openId);
  if (newIdx !== -1) currentPage = newIdx;
  currentPage = Math.max(0, Math.min(currentPage, pages.length - 1));
  renderBook();
  refreshSearch();
  renderPagesGrid();
}

// ---------- wiring ----------

function wire() {
  $('#file-input').addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
  });

  let searchTimer;
  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshSearch, 150);
  });

  $('#prev').addEventListener('click', () => pageFlip && pageFlip.flipPrev());
  $('#next').addEventListener('click', () => pageFlip && pageFlip.flipNext());
  $('#first').addEventListener('click', goFirst);
  $('#last').addEventListener('click', goLast);
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowLeft') pageFlip && pageFlip.flipPrev();
    if (e.key === 'ArrowRight') pageFlip && pageFlip.flipNext();
    if (e.key === 'Home') goFirst();
    if (e.key === 'End') goLast();
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });

  // Reposition highlight boxes whenever the book area changes size — window
  // resize, fullscreen toggles, or the text panel opening/closing. The observer
  // fires after layout settles, so StPageFlip (which refits on window 'resize')
  // has already recomputed its geometry by the time we read it.
  new ResizeObserver(() => requestAnimationFrame(updateHighlights)).observe(
    $('.book-area')
  );

  $('#fullscreen-btn').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    $('#fullscreen-btn').textContent = document.fullscreenElement ? '⤡' : '⛶';
    // Let StPageFlip's own resize handler re-fit the book after the viewport
    // settles into/out of fullscreen (fire twice to catch the final size).
    setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 500);
  });

  $('#pages-btn').addEventListener('click', openPagesOverview);
  $('#pages-overview-close').addEventListener('click', closePagesOverview);

  $('#panel-toggle').addEventListener('click', togglePanel);
  $('#panel-close').addEventListener('click', () => setPanelHidden(true));

  $('#settings-btn').addEventListener('click', openSettings);
  $('#settings-save').addEventListener('click', saveSettings);
  $('#settings-cancel').addEventListener('click', closeSettings);

  $('#notebooks-btn').addEventListener('click', openNotebooks);
  $('#notebooks-close').addEventListener('click', () => ($('#notebooks').hidden = true));
  $('#new-notebook-btn').addEventListener('click', createNotebook);
  $('#new-notebook-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createNotebook();
  });
  $('#import-notebook-btn').addEventListener('click', () => $('#import-input').click());
  $('#import-input').addEventListener('change', (e) => {
    if (e.target.files[0]) importNotebookFromFile(e.target.files[0]);
    e.target.value = '';
  });

  // Drag-and-drop onto the book area.
  const area = $('.book-area');
  ['dragover', 'dragenter'].forEach((ev) =>
    area.addEventListener(ev, (e) => {
      e.preventDefault();
      area.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    area.addEventListener(ev, (e) => {
      e.preventDefault();
      area.classList.remove('drag');
    })
  );
  area.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });
}

// ---------- init ----------

async function init() {
  wire();
  await ensureNotebook();
  await loadCurrentNotebook();
  updateUsageDisplay();

  if (TRANSCRIPTION_ENABLED) {
    if (!getApiKey()) {
      setOcrStatus('Add an API key to transcribe pages →');
    }
    // Resume transcription for any pages left pending from a previous session.
    if (pages.some((p) => p.ocrStatus === 'pending')) runOcrQueue();
  }
}

// Expose a reset for convenience in the console (wipes ALL notebooks).
window.resetNotebook = async () => {
  await clearAll();
  location.reload();
};

init();
