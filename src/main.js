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
  reorderNotebooks,
  nextOrder,
  clearAll,
  touchNotebook,
  recordPageTombstone,
  recordNotebookTombstone,
  getSyncedState,
} from './db.js';
import { transcribeImage } from './ocr.js';
import {
  naturalCompare,
  escapeHtml,
  foldText,
  searchTokens,
  pageHasAllTokens,
  highlight,
} from './text.js';
import { buildZip } from './zip.js';
import { buildPdf } from './pdf.js';
import { bumpOcr, getTotals, resetOwnUsage } from './usage.js';
import {
  initChat,
  openChat,
  chatNotebookChanged,
  chatFocusChanged,
  getStoredChatServerUrl,
  setChatServerUrl,
  getOpenAiKey,
  setOpenAiKey,
  chatWorksWithoutLocalServer,
} from './chat.js';
import {
  syncNow,
  isSyncConfigured,
  getSyncClientId,
  setSyncClientId,
  getSyncClientSecret,
  setSyncClientSecret,
} from './sync.js';

// Handwriting OCR via Google Cloud Vision. Flip to `false` to disable.
const TRANSCRIPTION_ENABLED = true;

// Phones skip the flipbook entirely and read in the zoom viewer (lighter: no
// decoding of every page up front, and touch gestures instead of page curls).
// Tablets keep the flipbook — it works well with touch at that size.
const IS_MOBILE = /iPhone|iPod|Android.*Mobile/i.test(navigator.userAgent);

const MAX_EDGE = 3000; // long-edge cap (px) for stored/transcribed images
                       // (higher = sharper zoom, more storage; new imports only)
const JPEG_QUALITY = 0.85;
const KEY_STORAGE = 'notebook.googleVisionKey';
const CURRENT_KEY = 'notebook.currentId';
const POSITIONS_KEY = 'notebook.positions'; // { [notebookId]: lastPageIndex }
const FREE_TIER = 1000; // Google Cloud Vision free pages per month

// Both automations are opt-in, and default to off for the same reason: a batch
// of freshly added pages is exactly when you discover the scan came out wrong,
// and both of them act before you can look. Transcription is the expensive one
// — Vision bills per page, immediately — while sync merely publishes pages
// you're about to delete. Off, they wait for ＋Transcribe and ☁ Sync now.
const AUTO_SYNC_KEY = 'notebook.autoSync';
const AUTO_OCR_KEY = 'notebook.autoTranscribe';

function isAutoSyncOn() {
  return localStorage.getItem(AUTO_SYNC_KEY) === '1';
}

function isAutoTranscribeOn() {
  return localStorage.getItem(AUTO_OCR_KEY) === '1';
}

let pages = [];          // page records for the current notebook, ordered
let currentNotebookId = null;
let objectUrls = [];     // live object URLs to revoke on re-render
let gridUrls = [];       // thumbnail object URLs for the pages overview
let selectedPageIds = new Set(); // page ids ticked in the pages overview
let selectionAnchorId = null; // last page ticked — the far end of a range select
let dragSrcIndex = null;  // index of the page being dragged in the overview
let replaceTargetId = null; // page whose 🔁 button opened the file picker
let dragBlockIds = null;  // ids moving together when a selected card is dragged
let pageFlip = null;
let currentPage = 0;
let ocrRunning = false;

// Reading zoom viewer state.
let viewerPage = 0;
let viewerUrl = null;     // object URL of the image currently in the viewer
let vScale = 1;           // current zoom (relative to native pixels)
let vFit = 1;             // scale that fits the page in the stage (baseline)
let vTx = 0;              // pan translate x/y (px, in stage coords)
let vTy = 0;
let vNatW = 0;            // page image natural size (px)
let vNatH = 0;
let vDrag = null;         // { x, y, tx, ty } while panning

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);

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
    if (IS_MOBILE) $('#viewer').hidden = true; // let the empty message show
    return;
  }
  empty.hidden = true;

  if (IS_MOBILE) {
    // Phone: no flipbook — the zoom viewer is the reading view. This also
    // avoids decoding every page image up front.
    el.hidden = true;
    $('#pager').hidden = true;
    currentPage = Math.max(0, Math.min(currentPage, pages.length - 1));
    openViewer(currentPage);
    return;
  }

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

// ---------- the floating reading bar ----------

const READING_BAR_KEY = 'notebook.readingBarPos';

// Keep it reachable. Off the screen edges, obviously — a bar left in a corner
// would be lost the moment the window shrank — but also below the top bar:
// dropped up there it slid under the search row and became a thing you could
// see the edge of and not click.
function clampBarPosition(x, y, bar) {
  const { width, height } = bar.getBoundingClientRect();
  const margin = 8;
  const ceiling = ($('.toolbar')?.getBoundingClientRect().bottom || 0) + margin;
  return {
    x: Math.max(margin, Math.min(window.innerWidth - width - margin, x)),
    y: Math.max(ceiling, Math.min(window.innerHeight - height - margin, y)),
  };
}

function placeReadingBar(x, y, { save = true } = {}) {
  const bar = $('#reading-bar');
  const at = clampBarPosition(x, y, bar);
  bar.classList.add('placed');
  bar.style.left = `${at.x}px`;
  bar.style.top = `${at.y}px`;
  if (save) localStorage.setItem(READING_BAR_KEY, JSON.stringify(at));
}

function recentreReadingBar() {
  const bar = $('#reading-bar');
  bar.classList.remove('placed');
  bar.style.left = '';
  bar.style.top = '';
  localStorage.removeItem(READING_BAR_KEY);
}

const READING_BAR_COLLAPSED_KEY = 'notebook.readingBarCollapsed';

// Drag by the grip, like the tool palettes in iPad drawing apps: moving it
// collapses it to the tool last used, and it *stays* that way once dropped —
// a small pill parked wherever you left it. Click the pill to open it again.
function makeReadingBarDraggable() {
  const bar = $('#reading-bar');
  let drag = null;
  let suppressClick = false;

  const isCollapsed = () => bar.classList.contains('collapsed');
  function setCollapsed(on) {
    bar.classList.toggle('collapsed', on);
    localStorage.setItem(READING_BAR_COLLAPSED_KEY, on ? '1' : '0');
    // Expanding needs more room than the pill did, so re-fit it on screen.
    if (bar.classList.contains('placed')) {
      const r = bar.getBoundingClientRect();
      placeReadingBar(r.left, r.top);
    }
  }

  // Which tool the pill shows. Defaults to the first until something is used.
  const buttons = [...bar.querySelectorAll('.read-btn')];
  buttons[0]?.classList.add('last-used');
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.read-btn');
    if (!btn || btn.classList.contains('read-btn-more')) return;
    buttons.forEach((b) => b.classList.toggle('last-used', b === btn));
  });

  // A click that ends a drag, or that opens the pill, must not also fire the
  // tool underneath it. Caught in the capture phase, before the button sees it.
  bar.addEventListener(
    'click',
    (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true
  );

  // Expanded, only the grip drags. Collapsed, the whole pill does — there is
  // no grip to aim at, and a press that doesn't move opens it instead.
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (!isCollapsed() && !e.target.closest('.read-grip')) return;
    e.preventDefault();
    const rect = bar.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
    // Capture on the bar, never on the grip: collapsing hides the grip, and a
    // hidden element loses pointer capture — which stranded the bar mid-drag,
    // stuck collapsed and deaf to the mouse.
    bar.setPointerCapture(e.pointerId);
  });

  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // A few pixels of slack so a slightly shaky click on the pill still reads
    // as a click rather than a drag.
    if (!drag.moved && Math.hypot(e.clientX - drag.dx - bar.getBoundingClientRect().left,
                                  e.clientY - drag.dy - bar.getBoundingClientRect().top) < 3) {
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      if (!isCollapsed()) {
        // Collapsing changes the width, so re-anchor the grab point to the
        // middle of what's left — otherwise the bar leaps out of the cursor.
        bar.classList.add('collapsed');
        const pill = bar.getBoundingClientRect();
        drag.dx = Math.min(drag.dx, pill.width / 2);
        drag.dy = pill.height / 2;
      }
    }
    placeReadingBar(e.clientX - drag.dx, e.clientY - drag.dy, { save: false });
  });

  const endDrag = (e) => {
    if (!drag) return;
    const { moved } = drag;
    drag = null;
    if (bar.hasPointerCapture?.(e.pointerId)) bar.releasePointerCapture(e.pointerId);
    if (moved) {
      suppressClick = true; // don't fire the tool we happened to let go over
      setCollapsed(true); // dropped where you put it, and it stays small
    } else if (isCollapsed()) {
      suppressClick = true;
      setCollapsed(false); // a plain click on the pill opens it back up
    }
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);

  // Double-click the grip to put it back in the middle, expanded.
  bar.querySelector('.read-grip').addEventListener('dblclick', () => {
    setCollapsed(false);
    recentreReadingBar();
  });

  // Restore where and how it was left.
  if (localStorage.getItem(READING_BAR_COLLAPSED_KEY) === '1') {
    bar.classList.add('collapsed');
  }
  try {
    const saved = JSON.parse(localStorage.getItem(READING_BAR_KEY) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      placeReadingBar(saved.x, saved.y, { save: false });
    }
  } catch {
    /* ignore a corrupt position and stay centred */
  }
  window.addEventListener('resize', () => {
    if (!bar.classList.contains('placed')) return;
    const rect = bar.getBoundingClientRect();
    placeReadingBar(rect.left, rect.top, { save: false });
  });
}

// Jump to a page from anywhere — search hits, bookmarks, thumbnails, chat
// citations. Whichever reading view is on screen follows: the zoom viewer if
// it's open, the flipbook otherwise. Out-of-range indices are ignored rather
// than clamped, so a bad citation does nothing instead of something wrong.
function goToPage(index) {
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) return false;
  if (!$('#viewer').hidden) loadViewerPage(index, { fit: true });
  if (pageFlip) pageFlip.flip(index);
  currentPage = index;
  updatePanel();
  updatePager();
  return true;
}

// A citation clicked in the chat. Turning to the page is half the answer —
// which lines on it were meant is the other half, so when the citation quoted
// a passage those words are boxed on the scan the way a search hit would be.
// Short words are dropped: boxing every "de" on the page points at nothing.
function goToCitedPage(index, terms = '') {
  const tokens = searchTokens(terms).filter((t) => t.length >= 3);
  citedPassage = tokens.length ? { index, tokens } : null;
  if (!goToPage(index)) return;
  updateHighlights();
  renderViewerHighlights();
}

// One page forward or back in whichever reading view is on screen. Shared by
// the arrow keys wherever they are pressed, so the flipbook and the zoom
// viewer can't drift apart on what "next page" means.
function turnPage(delta) {
  if (!$('#viewer').hidden) loadViewerPage(viewerPage + delta);
  else if (pageFlip) {
    if (delta > 0) pageFlip.flipNext();
    else pageFlip.flipPrev();
  }
}

function updatePager() {
  const indicator = $('#page-indicator');
  if (!indicator) return;
  // A landscape spread shows two sheets, so name both: "7–8 / 57". Saying just
  // "7" left the right-hand page unnamed anywhere on screen — and the chat
  // anchors to what's visible, so it has to be visible what that is.
  const shown = visiblePages().map((p) => pages.indexOf(p) + 1);
  const where = shown.length > 1 ? `${shown[0]}–${shown[shown.length - 1]}` : shown[0];
  indicator.textContent = pages.length ? `${where} / ${pages.length}` : '';
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
  if (!confirm(`Delete page ${index + 1}? This cannot be undone.`)) return;
  await deletePage(id);
  await touchNotebook(currentNotebookId);
  scheduleSync();
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
  updateBookmarkButtons(); // every page change funnels through here
  chatFocusChanged(); // …including the chat's "reading p. 7–8" anchor
  const body = $('#panel-body');
  const page = pages[currentPage];
  if (!page) {
    body.innerHTML = '';
    return;
  }
  const query = $('#search').value.trim();
  let html = `<div class="panel-meta">Page ${currentPage + 1} of ${pages.length}</div>`;
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
  // Typing a query takes the overlay over from any chat citation for good, so
  // that clearing the box later doesn't bring a stale passage back.
  if (query) citedPassage = null;

  if (!query) {
    count.textContent = '';
    results.hidden = true;
    results.innerHTML = '';
    $('#panel').classList.remove('searching');
    updatePanel();
    updateHighlights(); // redraw without word boxes; bookmark ribbons stay
    renderViewerHighlights();
    return;
  }

  // A page matches when it contains every query word (in any order), not the
  // literal phrase — so "musica manana" finds a page mentioning both.
  const tokens = searchTokens(query);
  const matches = pages
    .map((p, i) => ({ page: p, index: i }))
    .filter(({ page }) => pageHasAllTokens(page, tokens));

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
            // Anchor the snippet on the earliest word that matched.
            const hay = foldText(text);
            let at = Math.min(
              ...tokens.map((t) => hay.indexOf(t)).filter((i) => i >= 0)
            );
            if (!Number.isFinite(at)) at = 0;
            const start = Math.max(0, at - 30);
            const snippet =
              (start > 0 ? '…' : '') +
              text.slice(start, at + 70).replace(/\s+/g, ' ') +
              '…';
            return `<button class="result" data-page="${index}">
                <span class="result-page">p.${index + 1}</span>
                <span class="result-snippet">${highlight(snippet, query)}</span>
              </button>`;
          })
          .join('');

  results.querySelectorAll('.result').forEach((btn) => {
    btn.addEventListener('click', () => goToPage(Number(btn.dataset.page)));
  });

  // Marks the panel as showing search results rather than just the page text.
  // On a phone that turns it into a half-height sheet: opened full-screen for
  // a search it covered the page being searched, so there was nothing left to
  // swipe and no way to see the hits in context.
  $('#panel').classList.add('searching');
  openPanel();
  updatePanel();
  updateHighlights();
  renderViewerHighlights();
}

// ---------- highlight boxes over the page image ----------

// The passage a chat citation pointed at: the page, and the words to box on
// it. Kept apart from the search box because it answers a different question
// — the search asks where something is in the notebook, a citation says where
// on this page to read — and because a search has to be able to take the
// overlay over without the two fighting for it.
let citedPassage = null; // { index, tokens }

// Which words to box on a page, and how strictly. The search wins while it is
// running; a citation only shows on the page it was about.
function highlightPlan(index) {
  const search = searchTokens($('#search').value.trim());
  if (search.length) return { tokens: search, requireAll: true, cited: false };
  if (citedPassage?.index === index && citedPassage.tokens.length) {
    // A quote is matched word by word rather than all-or-nothing: it reaches
    // us from a model reading an OCR transcript, so one mistranscribed word
    // must not silence the whole passage.
    return { tokens: citedPassage.tokens, requireAll: false, cited: true };
  }
  return { tokens: [], requireAll: true, cited: false };
}

function clearHighlights() {
  const layer = $('#highlights');
  if (layer) layer.replaceChildren();
}

// Draw the overlays for the visible page(s): a ribbon on bookmarked pages and
// a box over every word that matches the search.
// StPageFlip draws onto a <canvas>, so we position an absolute overlay using the
// page geometry it exposes via getRender().getRect(). Called only with the page
// at rest (overlays are cleared during the 3D flip, which would distort them).
function updateHighlights() {
  const layer = $('#highlights');
  if (!layer) return;
  layer.replaceChildren();

  if (!pageFlip || pages.length === 0) return;

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
    if (!page) continue;
    const pageLeft = canvasBox.left - layerBox.left + rect.left + offset;
    const pageTop = canvasBox.top - layerBox.top + rect.top;
    if (page.bookmarked) {
      const rw = Math.max(18, Math.min(30, rect.pageWidth * 0.05));
      const rib = document.createElement('div');
      rib.className = 'hl-ribbon';
      rib.style.left = `${pageLeft + rect.pageWidth * 0.86}px`;
      rib.style.top = `${pageTop}px`;
      rib.style.width = `${rw}px`;
      rib.style.height = `${rw * 1.8}px`;
      frag.appendChild(rib);
    }
    const { tokens, requireAll, cited } = highlightPlan(i);
    if (
      tokens.length === 0 ||
      !page.words?.length ||
      !page.width ||
      !page.height ||
      (requireAll && !pageHasAllTokens(page, tokens))
    )
      continue;
    const sx = rect.pageWidth / page.width;
    const sy = rect.height / page.height;
    for (const w of page.words) {
      if (!tokens.some((t) => foldText(w.t).includes(t))) continue;
      const box = document.createElement('div');
      box.className = cited ? 'hl-box cited' : 'hl-box';
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

// Transcribe every page still marked pending. Vision bills per page and the
// pages are gone the moment they're read, so unless the user turned automatic
// transcription on, this only runs when they ask for it — every automatic
// caller (adding, replacing, importing, startup, saving a key) leaves the
// pages queued and lets the ＋Transcribe button offer the work instead.
async function runOcrQueue({ manual = false } = {}) {
  if (!TRANSCRIPTION_ENABLED) return;
  if (!manual && !isAutoTranscribeOn()) {
    updateOcrCue();
    return;
  }
  if (ocrRunning) return;
  ocrRunning = true;
  updateOcrCue();
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
        bumpOcr();
        updateUsageDisplay();
      } catch (err) {
        console.error('OCR failed', err);
        page.ocrStatus = 'error';
        page.error = err.message;
        page.text = '';
        page.words = [];
      }
      await putPage(page);
      await touchNotebook(page.notebookId);
      if (pages[currentPage] === page) updatePanel();
      refreshSearch();
    }
  } finally {
    ocrRunning = false;
    const pending = pages.filter((p) => p.ocrStatus === 'pending').length;
    setOcrStatus(pending ? `${pending} page(s) waiting` : '');
    updateOcrCue();
    // Push the fresh transcriptions to other devices.
    if (!pending && isSyncConfigured() && isAutoSyncOn()) doSync(false);
    else scheduleSync(); // …or just light the dot
  }
}

// The ＋Transcribe button: shown whenever pages are queued, so the work is one
// click away right after adding them — which is when you're looking at the
// scans and deciding whether they're worth transcribing at all.
function updateOcrCue() {
  const btn = $('#transcribe-now');
  if (!btn) return;
  const pending = TRANSCRIPTION_ENABLED
    ? pages.filter((p) => p.ocrStatus === 'pending').length
    : 0;
  btn.hidden = pending === 0 || ocrRunning;
  btn.textContent = `Transcribe ${pending} page${pending === 1 ? '' : 's'}`;
  btn.title = getApiKey()
    ? `Send ${pending} page(s) to Google Cloud Vision`
    : 'Add a Vision API key in ⚙ Settings first';
}

function setOcrStatus(text) {
  $('#ocr-status').textContent = text;
}

// Both meters, inside the ☁ popover. They're reference figures — how much of
// the Vision free tier is left, what the chat has cost — so they're a click
// away instead of holding a permanent slice of the toolbar.
function updateUsageDisplay() {
  const el = $('#usage');
  if (!el) return;
  // Totals across devices — both quotas are shared, so a per-device figure
  // would understate what's actually been used. See usage.js.
  const t = getTotals();
  const lines = [];
  if (TRANSCRIPTION_ENABLED) {
    lines.push(`<div>Pages transcribed: <strong>${t.ocr}</strong> / ${FREE_TIER}</div>`);
  }
  if (t.messages > 0) {
    // Below a cent, a rounded figure would read as free; show it as such.
    const shown = t.dollars < 0.01 ? '&lt;$0.01' : `$${t.dollars.toFixed(2)}`;
    lines.push(
      `<div>Chat: <strong>${shown}</strong> over ${t.messages} message(s)</div>`,
      `<div class="usage-detail">${t.input.toLocaleString()} input · ` +
        `${t.cachedInput.toLocaleString()} cached · ` +
        `${t.output.toLocaleString()} output tokens</div>`
    );
  } else {
    lines.push('<div class="usage-detail">The chat hasn\'t been used this month.</div>');
  }
  // Say where the figures come from: without sync they only know this device,
  // which is exactly the misreading this is meant to prevent.
  lines.push(
    t.otherDevices > 0
      ? `<div class="usage-detail">Across this and ${t.otherDevices} other device(s).</div>`
      : isSyncConfigured()
        ? '<div class="usage-detail">This device only until the next sync.</div>'
        : '<div class="usage-detail">This device only — set up ☁ Sync to combine them.</div>'
  );
  el.innerHTML = lines.join('');
  el.title = 'Estimated locally from published prices — the bill is what the provider says it is.';
  el.classList.toggle('over', TRANSCRIPTION_ENABLED && t.ocr >= FREE_TIER);
  el.classList.toggle(
    'warn',
    TRANSCRIPTION_ENABLED && t.ocr >= FREE_TIER * 0.8 && t.ocr < FREE_TIER
  );
}

function toggleUsagePop() {
  const pop = $('#usage-pop');
  if (!pop.hidden) {
    pop.hidden = true;
    return;
  }
  updateUsageDisplay();
  pop.hidden = false;
  // Narrow screens position it across the window (see the media query), so
  // it needs a top: the toolbar's height varies with how the title wraps.
  pop.style.top =
    window.innerWidth <= 600
      ? `${Math.round($('.toolbar').getBoundingClientRect().bottom + 8)}px`
      : '';
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
        uuid: crypto.randomUUID(),
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
        bookmarked: false,
        bookmarkLabel: '',
        createdAt: Date.now(),
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
  await touchNotebook(currentNotebookId);
  setOcrStatus(`Added ${added} page(s)`);
  scheduleSync();
  runOcrQueue();
}

// ---------- sync (Google Drive) ----------

let syncRunning = false;
let syncTimer = null;

// Push local edits ~30s after the last change, batching bursts of edits into
// one upload. Silent: if sign-in expired, doSync leaves the ⚠ Sync cue.
//
// With automatic sync off this is where every mutation still lands, so it is
// also where the "there is something to push" dot gets refreshed: nothing goes
// to Drive, but the ☁ button stops looking idle.
function scheduleSync() {
  if (!isSyncConfigured()) return;
  if (!isAutoSyncOn()) {
    updateSyncCue();
    return;
  }
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSync(false), 30_000);
}

// Does any notebook carry edits made since this device last synced it? Derived
// from the syncState record rather than tracked in a flag of its own, so it
// survives a reload and can't drift out of step with what sync actually did.
// A whole notebook deleted since the last sync doesn't light the dot — that
// lives in a tombstone, not in an updatedAt.
async function hasUnsyncedChanges() {
  if (!isSyncConfigured()) return false;
  for (const nb of await listNotebooks()) {
    if (!nb.uuid) return true; // never synced, so never pushed
    const st = await getSyncedState(nb.uuid);
    if (!st || (nb.updatedAt || 0) > (st.localAt || 0)) return true;
  }
  return false;
}

async function updateSyncCue() {
  const btn = $('#sync-btn');
  if (!btn || syncRunning) return;
  const pending = !isAutoSyncOn() && (await hasUnsyncedChanges());
  btn.classList.toggle('pending', pending);
  btn.title = pending
    ? 'Changes not synced yet — open ☁ and press Sync now'
    : 'Sync notebooks across devices via your Google Drive';
}

async function doSync(interactive) {
  if (!isSyncConfigured()) {
    openSettings();
    $('#sync-client-id').focus();
    return;
  }
  if (syncRunning) return;
  syncRunning = true;
  const btn = $('#sync-btn');
  const icon = $('#sync-icon');
  btn.disabled = true;
  icon.textContent = '⏳';
  try {
    const res = await syncNow({ interactive, onStatus: setOcrStatus });
    if (res.pulled.length || res.deletedLocal.length) {
      // Remote changes landed locally: refresh the whole view.
      let notebooks = await listNotebooks();
      if (notebooks.length === 0) {
        currentNotebookId = await addNotebook('My Notebook');
        notebooks = await listNotebooks();
      } else if (!notebooks.some((n) => n.id === currentNotebookId)) {
        currentNotebookId = notebooks[0].id;
      }
      localStorage.setItem(CURRENT_KEY, String(currentNotebookId));
      updateCurrentName(notebooks);
      await loadCurrentNotebook();
      if (!$('#notebooks').hidden) renderNotebookList();
    }
    setOcrStatus('');
    icon.textContent = '✓';
    btn.classList.remove('pending'); // everything local is on Drive now
    setTimeout(() => {
      if (icon.textContent === '✓') icon.textContent = '☁';
    }, 4000);
  } catch (err) {
    console.error('Sync failed', err);
    if (interactive) {
      icon.textContent = '☁';
      setOcrStatus(`Sync failed: ${err.message}`);
    } else {
      // A silent attempt failed (usually: sign-in expired). Don't open any
      // UI, but leave a visible cue that local changes haven't been pushed.
      icon.textContent = '⚠';
      setOcrStatus('Not synced yet — click ⚠ Sync');
    }
  } finally {
    syncRunning = false;
    btn.disabled = false;
    updateSyncCue();
  }
}

// ---------- settings modal ----------

function openSettings() {
  $('#api-key').value = getApiKey();
  $('#auto-transcribe').checked = isAutoTranscribeOn();
  $('#sync-client-id').value = getSyncClientId();
  $('#sync-client-secret').value = getSyncClientSecret();
  $('#auto-sync').checked = isAutoSyncOn();
  $('#openai-key').value = getOpenAiKey();
  $('#lmstudio-url').value = getStoredChatServerUrl();
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
  setAutoPref(AUTO_OCR_KEY, $('#auto-transcribe').checked);
  setAutoPref(AUTO_SYNC_KEY, $('#auto-sync').checked);
  const hadSync = isSyncConfigured();
  const secretChanged = $('#sync-client-secret').value.trim() !== getSyncClientSecret();
  setSyncClientId($('#sync-client-id').value.trim());
  setSyncClientSecret($('#sync-client-secret').value.trim());
  setOpenAiKey($('#openai-key').value.trim());
  setChatServerUrl($('#lmstudio-url').value.trim());
  updateChatAvailability();
  closeSettings();
  // Resume pending transcriptions now that a key exists — but only if that was
  // asked for; otherwise just re-label the ＋Transcribe button.
  runOcrQueue();
  updateOcrCue();
  updateSyncCue();
  // First-time setup or a new secret: sign in now. A new secret needs one
  // interactive sign-in to mint the refresh token that keeps the Mac app
  // signed in from then on.
  if ((!hadSync || secretChanged) && isSyncConfigured()) doSync(true);
}

function setAutoPref(key, on) {
  if (on) localStorage.setItem(key, '1');
  else localStorage.removeItem(key);
}

// ---------- panel ----------

// Phones only get the chat when it doesn't need a server on this device —
// see chatWorksWithoutLocalServer. Re-evaluated whenever settings change, so
// pasting a key lights the 💬 button up without a reload.
function updateChatAvailability() {
  const unavailable = IS_MOBILE && !chatWorksWithoutLocalServer();
  document.body.classList.toggle('chat-unavailable', unavailable);
  if (unavailable) $('#chat').hidden = true;
  syncViewerChatTab(); // its tab has nothing to open when the chat is off
}

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
  if (!hidden) {
    $('#chat').hidden = true; // one side panel at a time — two would squeeze the book
    updatePanel();
  }
  // The reading bar shows which view you're in, so an open panel is visible
  // even when the panel itself is off to the side.
  $('#panel-toggle').classList.toggle('active', !hidden);
  $('#chat-btn').classList.toggle('active', !$('#chat').hidden);
  window.dispatchEvent(new Event('resize'));
}

function openPanel() {
  setPanelHidden(false);
}
function togglePanel() {
  setPanelHidden($('#panel').hidden === false);
}

// ---------- bookmarks ----------

// The page(s) on screen: both halves of a landscape spread in the flipbook,
// otherwise just the current page (portrait, phones, zoom viewer). The spread
// is derived from `currentPage`, not from the flipbook's own index: the two
// agree, but `currentPage` is set first (the 'flip' handler assigns it before
// anything reads back), so it can't lag by a turn.
function visiblePages() {
  if (
    pageFlip &&
    $('#viewer').hidden &&
    pages.length > 0 &&
    pageFlip.getOrientation() !== 'portrait'
  ) {
    const left = currentPage - (currentPage % 2);
    return [pages[left], pages[left + 1]].filter(Boolean);
  }
  return pages[currentPage] ? [pages[currentPage]] : [];
}

// Toggle the ribbon. Called with a specific page from the bookmarks list and
// the pages overview; with no argument it acts on what's being read — and in
// a two-page spread the button stands for the whole opening, so it unmarks
// whichever visible page is marked before it ever marks a new one. The flag
// lives on the page record, so export/import and Drive sync carry it along.
async function toggleBookmark(page) {
  let targets;
  if (page) {
    targets = [page];
  } else {
    const visible = visiblePages();
    if (visible.length === 0) return;
    const marked = visible.filter((p) => p.bookmarked);
    targets = marked.length ? marked : [pages[currentPage] || visible[0]];
  }
  for (const p of targets) {
    p.bookmarked = !p.bookmarked;
    if (!p.bookmarked) p.bookmarkLabel = '';
    await putPage(p);
  }
  await touchNotebook(currentNotebookId);
  scheduleSync();
  updateBookmarkButtons();
  updateHighlights();
  renderViewerHighlights();
  if (!$('#bookmarks-pop').hidden) renderBookmarksList();
  if (!$('#pages-overview').hidden) renderPagesGrid();
  const nums = targets.map((p) => pages.indexOf(p) + 1).join(' and ');
  setOcrStatus(
    targets[0].bookmarked
      ? `Bookmarked page ${nums}`
      : `Removed bookmark from page ${nums}`
  );
}

function updateBookmarkButtons() {
  const set = (btn, on) => {
    if (!btn) return;
    btn.classList.toggle('active', on);
    btn.title = on ? 'Remove bookmark (B)' : 'Bookmark this page (B)';
    btn.setAttribute('aria-pressed', String(on));
  };
  // The toolbar button reflects the whole visible spread, not just the
  // current index — a ribbon on either page counts.
  set($('#bookmark-toggle'), visiblePages().some((p) => p.bookmarked));
  set($('#viewer-bookmark'), !!pages[viewerPage]?.bookmarked);
}

function openBookmarks() {
  renderBookmarksList();
  const pop = $('#bookmarks-pop');
  pop.hidden = false;
  // On a phone it's a full-screen sheet placed entirely by CSS: the reading
  // bar is docked to the bottom edge, so anchoring under its ▾ button put the
  // list off the screen. Clear any anchoring left over from a desktop layout.
  if (IS_MOBILE) {
    pop.style.top = '';
    pop.style.left = '';
    return;
  }
  // Anchor under the ▾ button, right-aligned, clamped into the viewport.
  const r = $('#bookmarks-btn').getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  // …and flipped above the button when there isn't room below it, which is
  // what happens once the reading bar has been dragged near the bottom edge.
  const h = pop.offsetHeight;
  const below = r.bottom + 6;
  pop.style.top =
    below + h > window.innerHeight - 8
      ? `${Math.max(8, r.top - 6 - h)}px`
      : `${below}px`;
}

function closeBookmarks() {
  $('#bookmarks-pop').hidden = true;
}

function toggleBookmarksPop() {
  if ($('#bookmarks-pop').hidden) openBookmarks();
  else closeBookmarks();
}

function renderBookmarksList() {
  const ul = $('#bm-list');
  const marked = pages.map((p, i) => ({ p, i })).filter(({ p }) => p.bookmarked);
  if (marked.length === 0) {
    ul.innerHTML =
      '<li class="bm-empty">No bookmarks yet — press 🔖 (or B) while reading a page.</li>';
    return;
  }
  ul.innerHTML = marked
    .map(({ p, i }) => {
      // Unlabeled entries fall back to the transcript's opening words (or the
      // scan's filename) so they can still be told apart.
      const fallback =
        (p.text || '').trim().replace(/\s+/g, ' ').slice(0, 46) || p.name || '';
      const label = p.bookmarkLabel || fallback;
      return `<li class="bm-item" data-id="${p.id}">
        <button class="bm-jump" data-index="${i}" title="Go to page ${i + 1}">
          <span class="bm-page">p.${i + 1}</span>
          <span class="bm-label${p.bookmarkLabel ? '' : ' faded'}">${escapeHtml(label)}</span>
        </button>
        <button class="btn ghost small bm-edit-btn" data-id="${p.id}" title="Edit label" aria-label="Edit label">✏️</button>
        <button class="btn ghost small bm-remove" data-id="${p.id}" title="Remove bookmark" aria-label="Remove bookmark">✕</button>
      </li>`;
    })
    .join('');

  ul.querySelectorAll('.bm-jump').forEach((b) =>
    b.addEventListener('click', () => {
      closeBookmarks();
      goToPage(Number(b.dataset.index));
    })
  );
  ul.querySelectorAll('.bm-edit-btn').forEach((b) =>
    b.addEventListener('click', () => editBookmarkLabel(Number(b.dataset.id)))
  );
  ul.querySelectorAll('.bm-remove').forEach((b) =>
    b.addEventListener('click', () => {
      const page = pages.find((p) => p.id === Number(b.dataset.id));
      if (page) toggleBookmark(page);
    })
  );
}

// Swap the bookmark's row for an inline text input — same pattern as the
// notebook rename (window.prompt is not available in Electron).
function editBookmarkLabel(id) {
  const item = $(`#bm-list .bm-item[data-id="${id}"]`);
  const jump = item?.querySelector('.bm-jump');
  if (!jump || item.querySelector('.bm-edit')) return;
  const page = pages.find((p) => p.id === id);
  if (!page) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'bm-edit';
  input.placeholder = 'Label…';
  input.value = page.bookmarkLabel || '';
  jump.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const label = input.value.trim();
    if (commit && label !== (page.bookmarkLabel || '')) {
      page.bookmarkLabel = label;
      await putPage(page);
      await touchNotebook(currentNotebookId);
      scheduleSync();
    }
    renderBookmarksList();
  };

  input.addEventListener('keydown', (e) => {
    // Keep Escape from bubbling to the global handler that closes the popover;
    // here it just cancels the edit.
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
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
  citedPassage = null; // it pointed at a page in the notebook we just left
  $('#search').value = '';
  renderBook();
  refreshSearch();
  chatNotebookChanged();
  updateOcrCue(); // pages waiting are counted per notebook
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

// Move a notebook so it sits just before or just after the one with
// `targetId`, then persist and refresh (mirrors movePagesTo for pages).
async function moveNotebookTo(srcId, targetId, after) {
  if (srcId === targetId) return;
  const notebooks = await listNotebooks();
  const moving = notebooks.find((n) => n.id === srcId);
  if (!moving) return;
  const rest = notebooks.filter((n) => n.id !== srcId);
  const at = rest.findIndex((n) => n.id === targetId) + (after ? 1 : 0);
  rest.splice(at, 0, moving);
  if (rest.every((n, i) => n.id === notebooks[i].id)) return; // same slot
  await reorderNotebooks(rest.map((n) => n.id));
  scheduleSync();
  renderNotebookList();
}

let nbDragId = null; // id of the notebook being dragged in the manager

async function renderNotebookList() {
  const notebooks = await listNotebooks();
  const ul = $('#notebook-list');
  ul.innerHTML = notebooks
    .map(
      (nb) => `<li class="nb-item ${nb.id === currentNotebookId ? 'active' : ''}" draggable="true" data-id="${nb.id}">
        <button class="nb-open" data-id="${nb.id}">
          ${escapeHtml(nb.name)}
          <span class="nb-count" id="nb-count-${nb.id}"></span>
        </button>
        <span class="nb-actions">
          <button class="btn ghost small nb-rename" data-id="${nb.id}" title="Rename" aria-label="Rename notebook">✏️</button>
          <button class="btn ghost small nb-retrans" data-id="${nb.id}" title="Re-transcribe" aria-label="Re-transcribe notebook">🔄</button>
          <button class="btn ghost small nb-export" data-id="${nb.id}" title="Export / backup" aria-label="Export notebook">📤</button>
          <button class="btn ghost small nb-delete" data-id="${nb.id}" title="Delete" aria-label="Delete notebook">🗑️</button>
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
    b.addEventListener('click', () => renameNotebookInline(Number(b.dataset.id)))
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

  // Drag a row to reorder. The half of the row the cursor is on decides
  // whether the drop lands above (top half) or below (bottom half) it —
  // same pattern as the pages overview, with a horizontal insertion bar.
  const dropAfter = (item, e) => {
    const r = item.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  ul.querySelectorAll('.nb-item').forEach((item) => {
    item.addEventListener('dragstart', (e) => {
      nbDragId = Number(item.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      nbDragId = null;
      ul.querySelectorAll('.nb-item').forEach((i) =>
        i.classList.remove('dragging', 'drop-before', 'drop-after')
      );
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (nbDragId === null || Number(item.dataset.id) === nbDragId) return;
      const after = dropAfter(item, e);
      item.classList.toggle('drop-after', after);
      item.classList.toggle('drop-before', !after);
    });
    item.addEventListener('dragleave', () =>
      item.classList.remove('drop-before', 'drop-after')
    );
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drop-before', 'drop-after');
      if (nbDragId === null) return;
      moveNotebookTo(nbDragId, Number(item.dataset.id), dropAfter(item, e));
    });
  });
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
  await switchNotebook(id); // closes the modal, same as opening an existing one
  scheduleSync();
}

// Swap the notebook's row for an inline text input. window.prompt() is not
// available in Electron, so the rename has to happen inside the modal itself.
async function renameNotebookInline(id) {
  const li = $(`#notebook-list .nb-rename[data-id="${id}"]`)?.closest('.nb-item');
  const openBtn = li?.querySelector('.nb-open');
  if (!openBtn || li.querySelector('.nb-edit')) return;

  const notebooks = await listNotebooks();
  const nb = notebooks.find((n) => n.id === id);
  if (!nb) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'nb-edit';
  input.value = nb.name;
  openBtn.replaceWith(input);
  li.draggable = false; // selecting text must not start a drag; re-render restores it
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (commit && name && name !== nb.name) {
      await renameNotebook(id, name);
      updateCurrentName(await listNotebooks());
      scheduleSync();
    }
    renderNotebookList();
  };

  input.addEventListener('keydown', (e) => {
    // Keep Escape from bubbling to the global handler that closes the modal;
    // here it just cancels the rename.
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function deleteNotebookFlow(id) {
  if (!confirm('Delete this notebook and all its pages? This cannot be undone.'))
    return;
  const notebooks = await listNotebooks();
  // Record before deleting: deleteNotebook drops the notebook's uuid with it.
  await recordNotebookTombstone(notebooks.find((n) => n.id === id)?.uuid);
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
  scheduleSync();
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
  await touchNotebook(id);
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
        bookmarked: !!p.bookmarked,
        bookmarkLabel: p.bookmarkLabel || '',
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
        uuid: crypto.randomUUID(),
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
        bookmarked: !!p.bookmarked,
        bookmarkLabel: p.bookmarkLabel || '',
        createdAt: Date.now(),
      });
      order++;
    }
    setOcrStatus(`Imported ${order} page(s)`);
    await switchNotebook(newId, { closeModal: true });
    scheduleSync();
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
  selectedPageIds.clear();
  selectionAnchorId = null;
  setPagesStatus(''); // last visit's outcome isn't news any more
  $('#pages-overview').hidden = false;
  renderPagesGrid();
  // Land on the page being read, not at the top — with hundreds of pages the
  // scroll back down is a chore. Only on open; re-renders keep their scroll.
  $('#pages-grid')
    .querySelector(`.page-card[data-index="${currentPage}"]`)
    ?.scrollIntoView({ block: 'center' });
}

function closePagesOverview() {
  $('#pages-overview').hidden = true;
  gridUrls.forEach((u) => URL.revokeObjectURL(u));
  gridUrls = [];
}

function renderPagesGrid() {
  gridUrls.forEach((u) => URL.revokeObjectURL(u));
  gridUrls = [];

  // Drop selections that point at pages that no longer exist.
  const alive = new Set(pages.map((p) => p.id));
  for (const id of [...selectedPageIds]) {
    if (!alive.has(id)) selectedPageIds.delete(id);
  }
  if (selectionAnchorId != null && !alive.has(selectionAnchorId)) {
    selectionAnchorId = null;
  }

  const grid = $('#pages-grid');
  if (pages.length === 0) {
    grid.innerHTML = '<div class="panel-note">This notebook has no pages.</div>';
    updatePagesSelectionUI();
    return;
  }

  grid.innerHTML = pages
    .map((p, i) => {
      const u = URL.createObjectURL(p.blob);
      gridUrls.push(u);
      const selected = selectedPageIds.has(p.id);
      return `<figure class="page-card${selected ? ' selected' : ''}${p.bookmarked ? ' bookmarked' : ''}${i === currentPage ? ' current' : ''}" draggable="true" data-index="${i}">
          <label class="page-select" title="Select page ${i + 1} — shift-click (or hold, on touch) to select up to here">
            <input type="checkbox" data-id="${p.id}"${selected ? ' checked' : ''} />
          </label>
          <span class="card-ribbon" aria-hidden="true"></span>
          <button class="page-thumb" data-index="${i}" title="Open page ${i + 1}">
            <img src="${u}" alt="Page ${i + 1}" loading="lazy" />
          </button>
          <figcaption class="page-card-meta">
            <span class="page-card-num">Page ${i + 1}</span>
            <button class="btn ghost small page-card-replace" data-id="${p.id}" title="Replace with an edited image…" aria-label="Replace page image">🔁</button>
            <button class="btn ghost small page-card-bookmark${p.bookmarked ? ' on' : ''}" data-id="${p.id}" title="${p.bookmarked ? 'Remove bookmark' : 'Bookmark this page'}" aria-label="${p.bookmarked ? 'Remove bookmark' : 'Bookmark this page'}" aria-pressed="${p.bookmarked}">🔖</button>
            <button class="btn ghost small page-card-delete" data-id="${p.id}" title="Delete this page" aria-label="Delete this page">🗑️</button>
          </figcaption>
        </figure>`;
    })
    .join('');

  // Ticking runs off `click`, not `change`, because that's the only event that
  // carries shiftKey — and it already sees the box's new checked state.
  grid.querySelectorAll('.page-select input').forEach((box) => {
    const id = Number(box.dataset.id);
    let holdTimer = null;
    let holdStart = null;
    let heldRange = false;

    box.addEventListener('click', (e) => {
      // A long press already picked the range; undo the toggle this click
      // would otherwise apply on top of it.
      if (heldRange) {
        heldRange = false;
        setPageSelected(id, selectedPageIds.has(id));
        return;
      }
      if (!(e.shiftKey && selectPageRange(selectionAnchorId, id, box.checked))) {
        setPageSelected(id, box.checked);
      }
      selectionAnchorId = id;
      updatePagesSelectionUI();
    });

    // Touch has no shift key, so press and hold extends the selection instead.
    const cancelHold = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      holdStart = null;
    };
    box.addEventListener('pointerdown', (e) => {
      // Clear here rather than trusting the click after a hold to arrive: some
      // touch browsers swallow it, and a stale latch would eat the next tick.
      heldRange = false;
      cancelHold();
      if (e.pointerType === 'mouse' || selectionAnchorId == null) return;
      holdStart = { x: e.clientX, y: e.clientY };
      holdTimer = setTimeout(() => {
        holdTimer = null;
        // Follow the anchor: holding from a ticked page selects the run,
        // holding from an unticked one clears it.
        const on = selectedPageIds.has(selectionAnchorId);
        if (!selectPageRange(selectionAnchorId, id, on)) return;
        heldRange = true;
        selectionAnchorId = id;
        updatePagesSelectionUI();
        navigator.vibrate?.(15); // the only feedback that the hold registered
      }, 450);
    });
    box.addEventListener('pointermove', (e) => {
      // Finger jitter shouldn't kill the hold; a real drag should.
      if (!holdStart) return;
      const moved =
        Math.abs(e.clientX - holdStart.x) + Math.abs(e.clientY - holdStart.y);
      if (moved > 12) cancelHold();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
      box.addEventListener(ev, cancelHold)
    );
  });

  grid.querySelectorAll('.page-thumb').forEach((b) =>
    b.addEventListener('click', () => {
      closePagesOverview();
      goToPage(Number(b.dataset.index));
    })
  );

  grid.querySelectorAll('.page-card-bookmark').forEach((b) =>
    b.addEventListener('click', () => {
      const page = pages.find((p) => p.id === Number(b.dataset.id));
      if (page) toggleBookmark(page); // re-renders the grid while it's open
    })
  );

  grid.querySelectorAll('.page-card-delete').forEach((b) =>
    b.addEventListener('click', async () => {
      await removePage(Number(b.dataset.id));
      if (pages.length === 0) closePagesOverview();
      else renderPagesGrid();
    })
  );

  grid.querySelectorAll('.page-card-replace').forEach((b) =>
    b.addEventListener('click', () => {
      replaceTargetId = Number(b.dataset.id);
      const input = $('#replace-input');
      input.multiple = false;
      input.click();
    })
  );

  // The half of the card the cursor is on decides whether the drop lands
  // before (left half) or after (right half) that card.
  const dropAfter = (card, e) => {
    const r = card.getBoundingClientRect();
    return e.clientX > r.left + r.width / 2;
  };

  grid.querySelectorAll('.page-card').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      dragSrcIndex = Number(card.dataset.index);
      // Grabbing a selected card drags the whole selection as one block.
      dragBlockIds =
        selectedPageIds.size > 1 && selectedPageIds.has(pages[dragSrcIndex].id)
          ? new Set(selectedPageIds)
          : null;
      e.dataTransfer.effectAllowed = 'move';
      grid.querySelectorAll('.page-card').forEach((c) => {
        const inDrag = dragBlockIds
          ? dragBlockIds.has(pages[Number(c.dataset.index)].id)
          : c === card;
        if (inDrag) c.classList.add('dragging');
      });
      // Dragging a block: pin a "N pages" badge to the cursor instead of the
      // single card's ghost image.
      if (dragBlockIds) {
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.textContent = `${dragBlockIds.size} pages`;
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 24, 18);
        setTimeout(() => ghost.remove());
      }
    });
    card.addEventListener('dragend', () => {
      dragSrcIndex = null;
      dragBlockIds = null;
      grid.querySelectorAll('.page-card').forEach((c) =>
        c.classList.remove('dragging', 'drop-before', 'drop-after')
      );
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const idx = Number(card.dataset.index);
      const inDrag = dragBlockIds
        ? dragBlockIds.has(pages[idx].id)
        : idx === dragSrcIndex;
      if (inDrag) return;
      const after = dropAfter(card, e);
      card.classList.toggle('drop-after', after);
      card.classList.toggle('drop-before', !after);
    });
    card.addEventListener('dragleave', () =>
      card.classList.remove('drop-before', 'drop-after')
    );
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drop-before', 'drop-after');
      if (dragSrcIndex == null) return;
      const ids = dragBlockIds || new Set([pages[dragSrcIndex].id]);
      movePagesTo(ids, pages[Number(card.dataset.index)].id, dropAfter(card, e));
    });
  });

  updatePagesSelectionUI();
}

// Keep the bulk-delete button and the "Select all" box in step with the
// current selection.
function updatePagesSelectionUI() {
  const n = selectedPageIds.size;
  // PDF is the one action that works on the whole notebook when nothing is
  // ticked, so it says which of the two it's about to do.
  const pdf = $('#pages-pdf');
  if (!pdf.disabled) pdf.textContent = n ? `📄 PDF (${n})` : '📄 PDF';
  const dl = $('#pages-download-selected');
  dl.hidden = n === 0;
  if (!dl.disabled) dl.textContent = `⬇ Download selected (${n})`;
  const rp = $('#pages-replace-selected');
  rp.hidden = n === 0;
  if (!rp.disabled) rp.textContent = `🔁 Replace selected (${n})`;
  const del = $('#pages-delete-selected');
  del.hidden = n === 0;
  del.textContent = `🗑 Delete selected (${n})`;
  const all = $('#pages-select-all');
  all.disabled = pages.length === 0;
  all.checked = n > 0 && n === pages.length;
  all.indeterminate = n > 0 && n < pages.length;
}

// Tick or untick one page, keeping the Set, the checkbox and the card's
// highlight in step — the grid is not re-rendered, so all three must move
// together by hand.
function setPageSelected(id, on) {
  if (on) selectedPageIds.add(id);
  else selectedPageIds.delete(id);
  const box = $('#pages-grid').querySelector(`.page-select input[data-id="${id}"]`);
  if (box) {
    box.checked = on;
    box.closest('.page-card').classList.toggle('selected', on);
  }
}

// Apply `on` to every page between the two ids, inclusive. Returns false when
// there is no usable range (no anchor yet, or it points at a deleted page), so
// the caller can fall back to a plain single toggle.
function selectPageRange(fromId, toId, on) {
  if (fromId == null) return false;
  const a = pages.findIndex((p) => p.id === fromId);
  const b = pages.findIndex((p) => p.id === toId);
  if (a < 0 || b < 0) return false;
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
    setPageSelected(pages[i].id, on);
  }
  return true;
}

function setAllPagesSelected(selected) {
  selectedPageIds = selected ? new Set(pages.map((p) => p.id)) : new Set();
  selectionAnchorId = null;
  $('#pages-grid')
    .querySelectorAll('.page-select input')
    .forEach((box) => {
      box.checked = selected;
      box.closest('.page-card').classList.toggle('selected', selected);
    });
  updatePagesSelectionUI();
}

// Save the selected pages as image files — the stored JPEGs, the best
// quality the app has — named after the notebook and page number. One page
// downloads directly; several leave as a single .zip.
async function downloadSelectedPages() {
  const selected = pages
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => selectedPageIds.has(p.id));
  if (selected.length === 0) return;
  const nbName = ($('#current-notebook').textContent || 'notebook').replace(/[/\\:]/g, '-');
  const fileName = ({ p, i }) => {
    const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[p.mediaType] || 'jpg';
    return `${nbName} - p${String(i + 1).padStart(2, '0')}.${ext}`;
  };
  let blob, downloadName;
  if (selected.length === 1) {
    blob = selected[0].p.blob;
    downloadName = fileName(selected[0]);
  } else {
    // The toolbar status is dimmed behind the dialog, so progress lives in
    // the button that started the download.
    const btn = $('#pages-download-selected');
    btn.disabled = true;
    try {
      const entries = [];
      for (const [k, s] of selected.entries()) {
        btn.textContent = `⏳ Packing ${k + 1} / ${selected.length}…`;
        // Reading blobs rarely yields long enough to paint; give the event
        // loop a beat every few pages so the count visibly ticks. (Not
        // requestAnimationFrame: that never fires in a backgrounded tab and
        // would freeze the pack if the user switches away mid-download.)
        if (k % 10 === 0) await new Promise((r) => setTimeout(r));
        entries.push({ name: fileName(s), bytes: new Uint8Array(await s.p.blob.arrayBuffer()) });
      }
      blob = buildZip(entries);
    } finally {
      btn.disabled = false;
      updatePagesSelectionUI();
    }
    downloadName = `${nbName} - ${selected.length} pages.zip`;
  }
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = downloadName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setOcrStatus(`Downloaded ${selected.length === 1 ? '1 page' : downloadName}`);
}

// Save pages as a PDF. The transcriptions ride along as an invisible text
// layer, so the file is searchable in any reader while showing the original
// handwriting — the one thing this export does that the ZIP of images can't.
//
// PDF can only carry JPEG directly, so anything stored in another format is
// re-encoded first. That's the only reason a page is ever recompressed here.
async function downloadPdf() {
  const chosen = selectedPageIds.size
    ? pages.filter((p) => selectedPageIds.has(p.id))
    : pages;
  if (chosen.length === 0) return;

  const btn = $('#pages-pdf');
  btn.disabled = true;
  const label = btn.textContent;
  try {
    const built = [];
    for (const [i, p] of chosen.entries()) {
      btn.textContent = `⏳ ${i + 1} / ${chosen.length}…`;
      // Yield now and then so the count paints; setTimeout rather than rAF,
      // which never fires in a backgrounded tab.
      if (i % 5 === 0) await new Promise((r) => setTimeout(r));
      let { blob, width, height } = p;
      if (p.mediaType !== 'image/jpeg') {
        const jpeg = await processImage(new File([blob], p.name || 'page'));
        ({ blob, width, height } = jpeg);
      }
      built.push({
        jpeg: new Uint8Array(await blob.arrayBuffer()),
        width,
        height,
        words: p.words,
        text: p.text,
      });
    }
    const nbName = ($('#current-notebook').textContent || 'notebook').replace(/[/\\:]/g, '-');
    downloadBlob(buildPdf(built), `${nbName}.pdf`);
    setOcrStatus(`Saved ${chosen.length} page(s) as PDF`);
  } catch (err) {
    console.error('PDF export failed', err);
    setOcrStatus(`PDF export failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// Swap one page's image for an edited file. The page keeps its slot,
// bookmark and label; the transcript is redone from the new image.
// Sync-wise this is a brand-new page (fresh uuid + createdAt): Drive images
// are immutable (uploaded once per uuid), and the merge logic must treat the
// edit as newer than any remote manifest, or a concurrent pull would drop it.
async function swapPageImage(page, file) {
  const processed = await processImage(file);
  // The old image identity dies here: tombstone it so a pull can't bring the
  // pre-edit page back from a manifest that still lists it.
  await recordPageTombstone(page.uuid);
  Object.assign(page, {
    uuid: crypto.randomUUID(),
    createdAt: Date.now(),
    name: file.name,
    blob: processed.blob,
    mediaType: processed.mediaType,
    width: processed.width,
    height: processed.height,
    text: '',
    words: [],
    error: '',
    ocrStatus: TRANSCRIPTION_ENABLED ? 'pending' : 'skipped',
  });
  await putPage(page);
}

// Anything the pages overview needs to say. The toolbar's own status line is
// behind the dialog, which is why a failed bulk replace used to look like
// nothing had happened at all.
function setPagesStatus(text, isError = false) {
  const el = $('#pages-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = !text;
}

// Replace a batch of pages ([{ page, file }] pairs), then refresh everything
// once: reading view, search, overview grid, OCR queue and sync.
//
// `extras` are files left over when more were picked than there were pages
// selected — a re-captured section that came back longer. They're added as new
// pages and slotted in directly after the last page replaced, so the section
// stays in one piece instead of landing at the end of the notebook.
async function replacePages(pairs, extras = []) {
  // Re-encoding images takes real time; tick the progress off in the bulk
  // button (the toolbar status is dimmed behind the dialog).
  const btn = $('#pages-replace-selected');
  const showProgress = pairs.length + extras.length > 1;
  if (showProgress) btn.disabled = true;
  let done = 0;
  let added = 0;
  const errors = [];
  setPagesStatus('');
  try {
    for (const [k, { page, file }] of pairs.entries()) {
      if (showProgress) btn.textContent = `⏳ Replacing ${k + 1} / ${pairs.length}…`;
      try {
        await swapPageImage(page, file);
        done++;
      } catch (err) {
        console.error('Could not replace page', file.name, err);
        errors.push(`${file.name}: ${err.message}`);
      }
    }

    // The surplus becomes new pages, then the whole notebook is re-ordered so
    // they follow the last page that was replaced.
    if (extras.length) {
      const created = [];
      for (const [k, file] of extras.entries()) {
        if (showProgress) btn.textContent = `⏳ Adding ${k + 1} / ${extras.length}…`;
        try {
          const { blob, mediaType, width, height } = await processImage(file);
          const record = {
            uuid: crypto.randomUUID(),
            notebookId: currentNotebookId,
            order: await nextOrder(currentNotebookId),
            name: file.name,
            blob,
            mediaType,
            width,
            height,
            text: '',
            words: [],
            ocrStatus: TRANSCRIPTION_ENABLED ? 'pending' : 'skipped',
            bookmarked: false,
            bookmarkLabel: '',
            createdAt: Date.now(),
          };
          record.id = await addPage(record);
          created.push(record.id);
          added++;
        } catch (err) {
          console.error('Could not add page', file.name, err);
          errors.push(`${file.name}: ${err.message}`);
        }
      }
      const anchor = pairs.length ? pairs[pairs.length - 1].page.id : null;
      if (created.length && anchor != null) {
        const fresh = await getPages(currentNotebookId);
        const isNew = new Set(created);
        const rest = fresh.filter((p) => !isNew.has(p.id));
        const at = rest.findIndex((p) => p.id === anchor);
        const ordered = [
          ...rest.slice(0, at + 1),
          ...created.map((id) => fresh.find((p) => p.id === id)),
          ...rest.slice(at + 1),
        ];
        await reorderPages(ordered.map((p) => p.id));
      }
    }
  } finally {
    if (showProgress) {
      btn.disabled = false;
      updatePagesSelectionUI();
    }
  }
  if (done > 0 || added > 0) {
    await touchNotebook(currentNotebookId);
    scheduleSync();
    pages = await getPages(currentNotebookId);
    renderBook();
    refreshSearch();
    if (!$('#pages-overview').hidden) renderPagesGrid();
    runOcrQueue();
  }
  const summary =
    `Replaced ${done} page${done === 1 ? '' : 's'}` +
    (added ? `, inserted ${added} more after them` : '');
  setOcrStatus(
    errors.length ? `${summary}; ${errors.length} failed: ${errors.join('; ')}` : summary
  );
  setPagesStatus(
    errors.length ? `${summary} — ${errors.length} failed: ${errors.join('; ')}` : summary,
    errors.length > 0
  );
}

// Delete every selected page in one go, behind a single confirmation.
async function deleteSelectedPages() {
  const ids = new Set(selectedPageIds);
  if (ids.size === 0) return;
  const label = `${ids.size} selected page${ids.size === 1 ? '' : 's'}`;
  if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
  // Aim the reading view at the slot the open page will occupy once the
  // selected ones are gone (or the nearest surviving page before it).
  const targetIndex =
    pages.slice(0, currentPage + 1).filter((p) => !ids.has(p.id)).length - 1;
  for (const id of ids) await deletePage(id);
  selectedPageIds.clear();
  await touchNotebook(currentNotebookId);
  scheduleSync();
  pages = await getPages(currentNotebookId);
  currentPage = Math.max(0, Math.min(targetIndex, pages.length - 1));
  renderBook();
  refreshSearch();
  setOcrStatus(`Deleted ${ids.size} page${ids.size === 1 ? '' : 's'}`);
  if (pages.length === 0) closePagesOverview();
  else renderPagesGrid();
}

// Persist `newOrder` as the notebook's page order and refresh every view.
// Remembers the open page (by id) so the reading view follows it.
async function applyPageOrder(newOrder) {
  const openId = pages[currentPage] ? pages[currentPage].id : null;
  pages = newOrder;
  await reorderPages(pages.map((p) => p.id));
  await touchNotebook(currentNotebookId);
  scheduleSync();
  pages = await getPages(currentNotebookId);
  const newIdx = pages.findIndex((p) => p.id === openId);
  if (newIdx !== -1) currentPage = newIdx;
  currentPage = Math.max(0, Math.min(currentPage, pages.length - 1));
  renderBook();
  refreshSearch();
  renderPagesGrid();
}

// Move the pages in `ids` as one block (keeping their relative order) so they
// sit just before or just after the page with `targetId`.
async function movePagesTo(ids, targetId, after) {
  if (ids.has(targetId)) return;
  const moving = pages.filter((p) => ids.has(p.id));
  const rest = pages.filter((p) => !ids.has(p.id));
  const at = rest.findIndex((p) => p.id === targetId) + (after ? 1 : 0);
  rest.splice(at, 0, ...moving);
  if (rest.every((p, i) => p === pages[i])) return; // dropped where it already sat
  await applyPageOrder(rest);
}

// ---------- reading zoom viewer ----------

function openViewer(index = currentPage) {
  if (pages.length === 0) return;
  $('#viewer').hidden = false;
  setViewing(true);
  loadViewerPage(index, { fit: true });
}

// The viewer covers the whole window, so anything that has to stay reachable
// while it is open — the chat — is lifted above it by this class rather than
// by a z-index war between two panels that are siblings the rest of the time.
function setViewing(on) {
  document.body.classList.toggle('viewing', on && !IS_MOBILE);
  syncViewerChatTab();
}

// The tab is the chat's collapsed state: showing while the viewer is open and
// the panel isn't, so the two are never both asking to be clicked.
function syncViewerChatTab() {
  const tab = $('#viewer-chat-tab');
  if (!tab) return;
  const canChat = !document.body.classList.contains('chat-unavailable');
  tab.hidden = !document.body.classList.contains('viewing') || !canChat || !$('#chat').hidden;
}

function closeViewer() {
  if (IS_MOBILE) return; // on phones the viewer IS the reading view
  $('#viewer').hidden = true;
  setViewing(false);
  if (viewerUrl) {
    URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
  }
  // Bring the flipbook to whatever page we ended on in the viewer.
  currentPage = viewerPage;
  if (pageFlip) pageFlip.turnToPage(currentPage);
  savePage(currentNotebookId, currentPage);
  updatePanel();
  updatePager();
  updateHighlights();
}

// Show a page in the viewer. Sequential turns (buttons, arrows, swipes) keep
// the reader's current magnification so they don't have to re-zoom every
// page; jumps that land somewhere new (opening the viewer, a search/bookmark/
// thumbnail jump) pass { fit:true } to reset to fit-to-screen.
function loadViewerPage(index, { fit = false } = {}) {
  // Capture the zoom relative to the OLD page's fit before its dimensions
  // change, so the new page opens at the same magnification, not the same
  // raw scale (pages may differ in size).
  const factor = fit || vFit <= 0 ? 1 : vScale / vFit;

  viewerPage = Math.max(0, Math.min(index, pages.length - 1));
  const page = pages[viewerPage];
  if (!page) return;

  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(page.blob);

  vNatW = page.width || 1000;
  vNatH = page.height || 1400;
  const content = $('#viewer-content');
  content.style.width = `${vNatW}px`;
  content.style.height = `${vNatH}px`;
  $('#viewer-img').src = viewerUrl;

  $('#viewer-indicator').textContent = `${viewerPage + 1} / ${pages.length}`;
  $('#viewer-prev').disabled = viewerPage <= 0;
  $('#viewer-next').disabled = viewerPage >= pages.length - 1;

  // Keep the rest of the app (text panel, saved position) on this page too.
  currentPage = viewerPage;
  savePage(currentNotebookId, viewerPage);
  updatePanel();

  showViewerAtFactor(factor);
  renderViewerHighlights();
}

// Fit the current page to the stage, then multiply by `factor` (1 = plain
// fit). Anchored top-left so a kept-zoom page turn starts reading at the top
// of the page; clampViewerPan re-centers whichever axis still fits.
function showViewerAtFactor(factor) {
  const rect = $('#viewer-stage').getBoundingClientRect();
  vFit = Math.min(rect.width / vNatW, rect.height / vNatH) || 1;
  vScale = Math.min(Math.max(8, vFit), vFit * Math.max(1, factor));
  vTx = 0;
  vTy = 0;
  clampViewerPan();
  applyViewerTransform();
}

// Scale so the whole page fits the stage, and center it.
function fitViewer() {
  const rect = $('#viewer-stage').getBoundingClientRect();
  vFit = Math.min(rect.width / vNatW, rect.height / vNatH) || 1;
  vScale = vFit;
  vTx = (rect.width - vNatW * vScale) / 2;
  vTy = (rect.height - vNatH * vScale) / 2;
  applyViewerTransform();
}

function applyViewerTransform() {
  $('#viewer-content').style.transform =
    `translate(${vTx}px, ${vTy}px) scale(${vScale})`;
  $('#viewer-zoom-level').textContent = `${Math.round(vScale * 100)}%`;
}

// Keep the page from drifting off-screen: center it on any axis where it's
// smaller than the stage, otherwise clamp so an edge can't move inward.
function clampViewerPan() {
  const rect = $('#viewer-stage').getBoundingClientRect();
  const w = vNatW * vScale;
  const h = vNatH * vScale;
  vTx = w <= rect.width ? (rect.width - w) / 2 : Math.min(0, Math.max(rect.width - w, vTx));
  vTy = h <= rect.height ? (rect.height - h) / 2 : Math.min(0, Math.max(rect.height - h, vTy));
}

// Zoom toward a point (cx, cy) given in stage coordinates.
function zoomViewer(nextScale, cx, cy) {
  const min = vFit;
  const max = Math.max(8, vFit);
  const s = Math.max(min, Math.min(max, nextScale));
  const imgX = (cx - vTx) / vScale;
  const imgY = (cy - vTy) / vScale;
  vScale = s;
  vTx = cx - imgX * vScale;
  vTy = cy - imgY * vScale;
  clampViewerPan();
  applyViewerTransform();
}

function zoomViewerBy(factor) {
  const rect = $('#viewer-stage').getBoundingClientRect();
  zoomViewer(vScale * factor, rect.width / 2, rect.height / 2);
}

// After the stage changes size (rotation, immersive toggle, window resize):
// re-fit if the page was at fit scale, otherwise just keep the pan in bounds.
function refitViewer() {
  if ($('#viewer').hidden) return;
  if (Math.abs(vScale - vFit) < 0.001) {
    fitViewer();
  } else {
    clampViewerPan();
    applyViewerTransform();
  }
}

// Distraction-free reading on phones: hide the app and viewer toolbars,
// leaving only the page. (The real Fullscreen API is unavailable on iOS.)
function toggleImmersive() {
  const on = document.body.classList.toggle('immersive');
  $('#immersive-btn').textContent = on ? '⤡' : '⛶';
  requestAnimationFrame(refitViewer);
}

// Overlays live inside the transformed content sized to the page's native
// pixels, so coordinates map 1:1 and scale/pan for free with the CSS transform.
function renderViewerHighlights() {
  const layer = $('#viewer-highlights');
  if (!layer) return;
  layer.replaceChildren();
  if ($('#viewer').hidden) return;

  const page = pages[viewerPage];
  if (!page) return;
  const frag = document.createDocumentFragment();

  if (page.bookmarked) {
    const rw = Math.round(vNatW * 0.045);
    const rib = document.createElement('div');
    rib.className = 'hl-ribbon';
    rib.style.left = `${Math.round(vNatW * 0.86)}px`;
    rib.style.top = '0px';
    rib.style.width = `${rw}px`;
    rib.style.height = `${Math.round(rw * 1.8)}px`;
    frag.appendChild(rib);
  }

  const { tokens, requireAll, cited } = highlightPlan(viewerPage);
  if (
    tokens.length &&
    page.words?.length &&
    (!requireAll || pageHasAllTokens(page, tokens))
  ) {
    for (const w of page.words) {
      if (!tokens.some((t) => foldText(w.t).includes(t))) continue;
      const box = document.createElement('div');
      box.className = cited ? 'vhl-box cited' : 'vhl-box';
      box.style.left = `${w.x}px`;
      box.style.top = `${w.y}px`;
      box.style.width = `${w.w}px`;
      box.style.height = `${w.h}px`;
      frag.appendChild(box);
    }
  }
  layer.appendChild(frag);
}

function wireViewer() {
  const stage = $('#viewer-stage');

  $('#zoom-btn').addEventListener('click', () => openViewer());
  $('#viewer-close').addEventListener('click', closeViewer);
  $('#immersive-btn').addEventListener('click', toggleImmersive);
  $('#viewer-prev').addEventListener('click', () => loadViewerPage(viewerPage - 1));
  $('#viewer-next').addEventListener('click', () => loadViewerPage(viewerPage + 1));
  $('#viewer-zoom-in').addEventListener('click', () => zoomViewerBy(1.25));
  $('#viewer-zoom-out').addEventListener('click', () => zoomViewerBy(1 / 1.25));
  $('#viewer-reset').addEventListener('click', fitViewer);
  $('#viewer-bookmark').addEventListener('click', () => toggleBookmark());

  // Double-click the book to jump straight into the zoom viewer.
  $('.book-area').addEventListener('dblclick', () => openViewer(currentPage));

  // Trackpad: a pinch arrives as a ctrl+wheel event in Chromium, so plain
  // two-finger scrolling is free to pan the zoomed page (with macOS momentum
  // for free). At fit scale there's nothing to pan, so a horizontal swipe
  // flips pages instead, Preview-style.
  let vPinchPast = 0; // pinch-in accumulated while already at fit → close
  let wheelNavDx = 0; // horizontal scroll accumulated while at fit → flip
  let wheelNavT = 0;
  let wheelNavLock = null; // swallows macOS momentum after a flip
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();

    if (e.ctrlKey || e.metaKey) {
      // Pinch (ctrl) or cmd+wheel zoom toward the cursor. Pinches stream
      // small pixel deltas; clamping keeps a mouse notch (±120) from jumping
      // the scale in one step.
      const d = Math.max(-50, Math.min(50, e.deltaY));
      zoomViewer(vScale * Math.exp(-d * 0.01), e.clientX - rect.left, e.clientY - rect.top);
      // Keep pinching in past fit and the viewer closes (Photos-style).
      if (e.ctrlKey && e.deltaY > 0 && vScale <= vFit + 0.001) {
        vPinchPast += e.deltaY;
        if (vPinchPast > 80) {
          vPinchPast = 0;
          closeViewer();
        }
      } else {
        vPinchPast = 0;
      }
      return;
    }

    if (vScale > vFit + 0.001) {
      vTx -= e.deltaX;
      vTy -= e.deltaY;
      clampViewerPan();
      applyViewerTransform();
      return;
    }

    // At fit: horizontal two-finger swipe turns the page. After a flip,
    // ignore the momentum tail until events pause for a beat.
    if (wheelNavLock) {
      clearTimeout(wheelNavLock);
      wheelNavLock = setTimeout(() => { wheelNavLock = null; }, 250);
      return;
    }
    const now = Date.now();
    if (now - wheelNavT > 300) wheelNavDx = 0;
    wheelNavT = now;
    wheelNavDx += e.deltaX;
    if (Math.abs(wheelNavDx) > 120 && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      loadViewerPage(viewerPage + (wheelNavDx > 0 ? 1 : -1));
      wheelNavDx = 0;
      wheelNavLock = setTimeout(() => { wheelNavLock = null; }, 250);
    }
  }, { passive: false });

  // Double-click toggles between fit and a readable zoom at that spot
  // (smart-zoom feel).
  stage.addEventListener('dblclick', (e) => {
    const rect = stage.getBoundingClientRect();
    if (vScale > vFit + 0.001) fitViewer();
    else zoomViewer(vFit * 2.5, e.clientX - rect.left, e.clientY - rect.top);
  });

  // Pinch-out on the flipbook zooms straight into the viewer.
  let bookPinch = 0;
  let bookPinchT = 0;
  $('.book-area').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault(); // keep Chromium from zooming the whole page
    const now = Date.now();
    if (e.deltaY > 0 || now - bookPinchT > 300) bookPinch = 0;
    bookPinchT = now;
    bookPinch += -e.deltaY;
    if (bookPinch > 30 && $('#viewer').hidden) {
      bookPinch = 0;
      openViewer(currentPage);
    }
  }, { passive: false });

  // Touch gestures: at fit scale a 1-finger horizontal swipe turns the page;
  // zoomed in, 1 finger pans instead (like iOS Photos — easier than two-finger
  // panning on a phone), and pulling well past a side edge flips the page.
  // 2 fingers always pinch-zoom and pan together. Mouse keeps drag-to-pan.
  const pointers = new Map(); // active pointerId -> { x, y }
  let pinch = null; // { dist, midX, midY, scale, tx, ty } at pinch start
  let swipe = null; // { x, y, t } at single-touch start

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const rect = stage.getBoundingClientRect();
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        midX: (a.x + b.x) / 2 - rect.left,
        midY: (a.y + b.y) / 2 - rect.top,
        scale: vScale,
        tx: vTx,
        ty: vTy,
      };
      swipe = null; // a second finger cancels any pending page swipe
      vDrag = null;
    } else if (pointers.size === 1) {
      if (e.pointerType === 'touch' && vScale <= vFit + 0.001) {
        swipe = { x: e.clientX, y: e.clientY, t: Date.now() };
      } else {
        vDrag = { x: e.clientX, y: e.clientY, tx: vTx, ty: vTy };
        if (e.pointerType !== 'touch') stage.classList.add('grabbing');
      }
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const rect = stage.getBoundingClientRect();
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const midX = (a.x + b.x) / 2 - rect.left;
      const midY = (a.y + b.y) / 2 - rect.top;
      const s = Math.max(
        vFit,
        Math.min(Math.max(8, vFit), pinch.scale * (dist / pinch.dist))
      );
      // The image point under the initial midpoint follows the current
      // midpoint — this yields pinch-zoom and two-finger pan in one motion.
      const ix = (pinch.midX - pinch.tx) / pinch.scale;
      const iy = (pinch.midY - pinch.ty) / pinch.scale;
      vScale = s;
      vTx = midX - ix * s;
      vTy = midY - iy * s;
      clampViewerPan();
      applyViewerTransform();
    } else if (vDrag) {
      const rawTx = vDrag.tx + (e.clientX - vDrag.x);
      vTx = rawTx;
      vTy = vDrag.ty + (e.clientY - vDrag.y);
      clampViewerPan();
      applyViewerTransform();
      // Photos-style: pulling well past a side edge while zoomed flips the
      // page. rawTx - vTx is how far the finger went beyond the clamp; the
      // vertical-delta guard keeps sideways drift during a vertical scroll
      // from flipping.
      if (e.pointerType === 'touch') {
        const over = rawTx - vTx;
        const next = viewerPage + (over < 0 ? 1 : -1);
        if (
          Math.abs(over) > 70 &&
          Math.abs(over) > Math.abs(e.clientY - vDrag.y) / 2 &&
          next >= 0 && next < pages.length
        ) {
          vDrag = null;
          loadViewerPage(next); // keeps the current zoom on the new page
        }
      }
    }
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2 && pinch) {
      pinch = null;
      // Lifting one finger of a pinch while zoomed hands the pan to the
      // remaining finger, so the motion never stalls.
      if (pointers.size === 1 && e.pointerType === 'touch' && vScale > vFit + 0.001) {
        const [p] = pointers.values();
        vDrag = { x: p.x, y: p.y, tx: vTx, ty: vTy };
      }
    }
    if (swipe && pointers.size === 0 && e.pointerType === 'touch') {
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      const dt = Date.now() - swipe.t;
      if (dt < 600 && Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
        loadViewerPage(viewerPage + (dx < 0 ? 1 : -1));
      }
      swipe = null;
    }
    if (pointers.size === 0) {
      vDrag = null;
      stage.classList.remove('grabbing');
    }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    pinch = null;
    swipe = null;
    if (pointers.size === 0) {
      vDrag = null;
      stage.classList.remove('grabbing');
    }
  });

  // macOS three-finger swipe (Electron only; needs the "swipe between pages"
  // trackpad setting) turns pages in the viewer or the flipbook.
  window.onMacSwipe?.((dir) => {
    if (dir !== 'left' && dir !== 'right') return;
    if (!$('#viewer').hidden) {
      loadViewerPage(viewerPage + (dir === 'left' ? 1 : -1));
    } else if (pageFlip) {
      if (dir === 'left') pageFlip.flipNext();
      else pageFlip.flipPrev();
    }
  });

  window.addEventListener('resize', refitViewer);
}

// ---------- wiring ----------

function wire() {
  wireViewer();
  if (!IS_MOBILE) makeReadingBarDraggable(); // docked to the bottom on phones
  $('#file-input').addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
  });

  let searchTimer;
  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshSearch, 150);
  });
  // Typing a query leaves the box holding the keyboard, so the reading
  // shortcuts are answered by the field instead of the book — Enter and the
  // arrows below are the two ways back out of it.
  $('#search').addEventListener('keydown', (e) => {
    const box = $('#search');

    // Enter commits the query and hands the keyboard back to the reading view
    // with the hits still on screen (and drops the on-screen keyboard on a
    // phone).
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      refreshSearch();
      box.blur();
      return;
    }

    // ← and → still move through the query, but once the caret has nowhere
    // left to go they turn the page rather than doing nothing — so the arrows
    // keep working with a search on screen, without waiting for Enter. A
    // selection or a modifier means the press is about the text: leave it.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const caret = box.selectionStart;
      const collapsed = caret !== null && caret === box.selectionEnd;
      const stuck =
        e.key === 'ArrowLeft' ? caret === 0 : caret === box.value.length;
      if (collapsed && stuck && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        turnPage(e.key === 'ArrowLeft' ? -1 : 1);
      }
      return;
    }

    // Escape drops the search: the text, the result list and the word boxes on
    // the page. Handled here rather than left to the browser's native clearing
    // of type="search", which doesn't fire `input` and so leaves the highlights
    // behind. Once the box is already empty, Escape gives the keyboard back to
    // the reading shortcuts; it never reaches the global handler, so it can't
    // close a modal on the way.
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if ($('#search').value === '') {
      $('#search').blur();
      return;
    }
    clearTimeout(searchTimer);
    $('#search').value = '';
    refreshSearch();
  });

  $('#prev').addEventListener('click', () => pageFlip && pageFlip.flipPrev());
  $('#next').addEventListener('click', () => pageFlip && pageFlip.flipNext());
  $('#first').addEventListener('click', goFirst);
  $('#last').addEventListener('click', goLast);

  $('#bookmark-toggle').addEventListener('click', () => toggleBookmark());
  $('#bookmarks-btn').addEventListener('click', toggleBookmarksPop);
  $('#bm-close').addEventListener('click', closeBookmarks);
  // Any press outside the popover (or its toolbar buttons, which manage it
  // themselves) closes it, like a menu.
  document.addEventListener('pointerdown', (e) => {
    const pop = $('#bookmarks-pop');
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.bm-wrap')) {
      closeBookmarks();
    }
  });
  // Every modal also closes on Escape or a click on the backdrop, behaving
  // like its Close/Cancel button — i.e. #settings discards, never saves.
  const modals = [
    { el: $('#notebooks'), close: () => ($('#notebooks').hidden = true) },
    { el: $('#pages-overview'), close: closePagesOverview },
    { el: $('#settings'), close: closeSettings },
    { el: $('#shortcuts'), close: () => ($('#shortcuts').hidden = true) },
  ];
  $('#shortcuts-close').addEventListener('click', () => ($('#shortcuts').hidden = true));
  for (const { el, close } of modals) {
    // Track where the press started: a drag that merely *ends* on the
    // backdrop (e.g. selecting text in an input) must not close the modal.
    let pressedBackdrop = false;
    el.addEventListener('pointerdown', (e) => {
      pressedBackdrop = e.target === el;
    });
    el.addEventListener('click', (e) => {
      if (pressedBackdrop && e.target === el) close();
    });
  }

  // StPageFlip tracks the pointer through window-level mousemove/touchmove,
  // so it kept folding page corners underneath open dialogs. Stop those
  // moves at capture — before the flipbook's window handlers see them —
  // whenever they happen over an overlay. Moves over the visible book still
  // flip normally, and the app's own widgets are untouched: everything else
  // here runs on pointer events, clicks or drag&drop.
  for (const type of ['mousemove', 'touchmove']) {
    window.addEventListener(
      type,
      (e) => {
        const el = e.target instanceof Element ? e.target : null;
        if (el?.closest('.modal, .viewer, .panel, .bookmarks-pop')) {
          e.stopImmediatePropagation();
        }
      },
      { capture: true, passive: true }
    );
  }

  document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl+F jumps to the notebook search (the native find bar is useless
    // here). Works from anywhere; closes the zoom viewer if it's covering the
    // toolbar.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (!$('#viewer').hidden) closeViewer();
      $('#search').focus();
      $('#search').select();
      return;
    }

    // Escape closes any open modal — checked before the input guard so it
    // also works while typing in a modal's field. The bookmarks popover
    // behaves the same, and closes first.
    if (e.key === 'Escape') {
      if (!$('#bookmarks-pop').hidden) {
        closeBookmarks();
        return;
      }
      const open = modals.find(({ el }) => !el.hidden);
      if (open) {
        open.close();
        return;
      }
    }

    if (e.target.matches('input, textarea')) return;

    // When the zoom viewer is open it captures the keyboard.
    if (!$('#viewer').hidden) {
      // Escape peels off one layer at a time: the chat floating over the
      // viewer first, the viewer only once nothing is left on top of it.
      if (e.key === 'Escape' && document.body.classList.contains('viewing') && !$('#chat').hidden) {
        $('#chat-close').click();
      } else if (e.key === 'Escape') closeViewer();
      else if (e.key === 'ArrowLeft') turnPage(-1);
      else if (e.key === 'ArrowRight') turnPage(1);
      else if (e.key === '+' || e.key === '=') zoomViewerBy(1.25);
      else if (e.key === '-' || e.key === '_') zoomViewerBy(1 / 1.25);
      else if (e.key === '0') fitViewer();
      else if (e.key === 'b' || e.key === 'B') toggleBookmark();
      return;
    }

    if (e.key === 'ArrowLeft') turnPage(-1);
    if (e.key === 'ArrowRight') turnPage(1);
    if (e.key === 'Home') goFirst();
    if (e.key === 'End') goLast();
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    if (e.key === 'z' || e.key === 'Z') openViewer();
    if (e.key === 'b' || e.key === 'B') toggleBookmark();
    if (e.key === '?') $('#shortcuts').hidden = !$('#shortcuts').hidden;
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
  $('#pages-select-all').addEventListener('change', (e) =>
    setAllPagesSelected(e.target.checked)
  );
  $('#pages-delete-selected').addEventListener('click', deleteSelectedPages);
  $('#pages-pdf').addEventListener('click', downloadPdf);
  $('#pages-download-selected').addEventListener('click', downloadSelectedPages);
  // Bulk replace: replaceTargetId === null tells the change handler that the
  // picked files belong to the selection, not to a single card's 🔁.
  $('#pages-replace-selected').addEventListener('click', () => {
    replaceTargetId = null;
    const input = $('#replace-input');
    input.multiple = true;
    input.click();
  });
  $('#replace-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = ''; // so picking the same file again still fires change
    if (files.length === 0) return;
    if (replaceTargetId != null) {
      const page = pages.find((p) => p.id === replaceTargetId);
      if (page) replacePages([{ page, file: files[0] }]);
      return;
    }
    // Pair the picked files with the selected pages, both in order: pages by
    // notebook position, files by natural name order (p02 before p10).
    const targets = pages.filter((p) => selectedPageIds.has(p.id));
    // Fewer files than pages would mean deleting the leftovers, which nobody
    // asked for; more is the ordinary case of a re-captured section that grew,
    // so the surplus is inserted after the pages it extends.
    if (files.length < targets.length) {
      setPagesStatus(
        `${targets.length} pages selected but only ${files.length} file(s) picked — nothing replaced. Pick at least one file per selected page.`,
        true
      );
      return;
    }
    files.sort((a, b) => naturalCompare(a.name, b.name));
    replacePages(
      targets.map((page, k) => ({ page, file: files[k] })),
      files.slice(targets.length)
    );
  });

  $('#panel-toggle').addEventListener('click', togglePanel);
  $('#panel-close').addEventListener('click', () => setPanelHidden(true));

  initChat({
    getContext: () => ({
      id: currentNotebookId,
      name: $('#current-notebook').textContent,
      pages,
      // What's on screen right now, so a question that names no page ("explain
      // this") is answered about what the reader is actually looking at.
      focus: visiblePages().map((p) => pages.indexOf(p)),
    }),
    onSpendChanged: updateUsageDisplay,
    onGoToPage: goToCitedPage,
    onVisibilityChanged: syncViewerChatTab,
  });

  $('#viewer-chat-tab').addEventListener('click', () => openChat());

  // The manual transcription trigger. Without a key there is nothing to run,
  // so send the user where the key goes instead of failing quietly.
  $('#transcribe-now').addEventListener('click', () => {
    if (!getApiKey()) {
      openSettings();
      return;
    }
    runOcrQueue({ manual: true });
  });

  $('#settings-btn').addEventListener('click', openSettings);
  $('#settings-save').addEventListener('click', saveSettings);
  $('#settings-cancel').addEventListener('click', closeSettings);
  // ☁ opens the meters; syncing is the button inside, so a stray click on the
  // cloud can't kick off a network round-trip you didn't ask for.
  $('#sync-btn').addEventListener('click', toggleUsagePop);
  $('#sync-now').addEventListener('click', () => {
    $('#usage-pop').hidden = true;
    doSync(true);
  });
  document.addEventListener('pointerdown', (e) => {
    const pop = $('#usage-pop');
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.sync-wrap')) {
      pop.hidden = true;
    }
  });

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
  document.body.classList.toggle('is-mobile', IS_MOBILE);
  updateChatAvailability();
  showBuildStamp();
  watchForUpdates();
  wire();
  await ensureNotebook();
  await loadCurrentNotebook();
  updateUsageDisplay();

  if (TRANSCRIPTION_ENABLED) {
    if (!getApiKey()) {
      setOcrStatus('Add an API key to transcribe pages →');
    }
    // Resume transcription for any pages left pending from a previous session
    // — or, with automatic transcription off, just offer it on the button.
    if (pages.some((p) => p.ocrStatus === 'pending')) runOcrQueue();
    updateOcrCue();
  }

  // Pull/push changes on startup (silent: if sign-in is needed, the ☁ Sync
  // button does it interactively). Skipped entirely when automatic sync is
  // off: opening the app is not the user asking to publish anything.
  if (isSyncConfigured() && navigator.onLine && isAutoSyncOn()) doSync(false);
  else updateSyncCue();
}

// Which build is on screen, in the ☁ popover next to the meters. The service
// worker hands out the previous version until the new one takes over, so
// without this there is no way to tell a change that hasn't shipped from one
// that shipped and is being served from cache.
function showBuildStamp() {
  const el = $('#build-stamp');
  if (!el) return;
  const when = new Date(__BUILD_TIME__);
  el.textContent = `build ${__BUILD_SHA__} · ${when.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
  })} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  el.title = `Built ${when.toLocaleString()}`;
}

// The service worker claims the page as soon as it installs a new version
// (skipWaiting + clientsClaim), but the code already running stays the old
// one — which is why a deploy used to need two reloads, the first one silently
// fetching what the second one showed. `controllerchange` is that moment, so
// offer the reload instead of doing it underfoot: a forced refresh mid-page
// would throw away whatever was half-typed in the chat.
function watchForUpdates() {
  const btn = $('#update-btn');
  if (!btn || !('serviceWorker' in navigator)) return;
  btn.addEventListener('click', () => location.reload());
  // No controller yet means this is the first visit: the claim that follows is
  // the app installing itself, not an update to announce.
  if (!navigator.serviceWorker.controller) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    btn.hidden = false;
    setOcrStatus('A new version is ready — press ⟳ Update');
  });
  // A window left open for days would otherwise never ask.
  navigator.serviceWorker.ready
    .then((reg) => setInterval(() => reg.update().catch(() => {}), 30 * 60_000))
    .catch(() => {});
}

// Expose a reset for convenience in the console (wipes ALL notebooks).
window.resetNotebook = async () => {
  await clearAll();
  resetOwnUsage(); // the meters describe notebooks that no longer exist
  location.reload();
};

init();
