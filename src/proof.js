// Assisted proofreading of a page's transcription.
//
// Vision reads handwriting well and not perfectly, and its mistakes are
// invisible: the transcript reads like something, so nothing looks wrong until
// a search comes up empty or the chat answers from a word the user never
// wrote. A model reading the page's own text can spot them — "this is not a
// word, and one letter away is the word this sentence needs" — but it must
// never be trusted with the change itself. Every fix is shown against the
// handwriting it came from and applied only when the user says so.
//
// Everything except proofreadPage() is pure, so the prompt, the parsing, the
// locating and the application are testable without a model or a DOM.

import { complete } from './chat.js';
import { foldText } from './text.js';

// Pages with almost nothing on them have nothing to proofread, and each page
// costs a request.
export const MIN_TEXT_CHARS = 60;

const SYSTEM = `You are proofreading the machine transcription of one page of a student's handwritten notebook.

The transcription came from OCR of their handwriting, so the mistakes you are looking for belong to the machine: misread letters, split or joined words, confused digits or accents. The writing itself is theirs and is not yours to improve.

Rules:
- Propose a fix only when the transcribed text is not a word, or cannot be the word the sentence needs, AND a small letter-level change makes it right.
- Never rewrite phrasing, never correct the writer's grammar or spelling choices, never add, remove, reorder or translate anything.
- Leave names, formulas, abbreviations and made-up terms alone: a notebook is full of them, and you cannot tell them from errors.
- "before" must be copied verbatim from the transcription, as short as possible while still unique.
- "context" is the whole line "before" sits on, copied verbatim, so it can be found.
- "why" is a few words on what gives the error away, in the language of the page.
- When nothing is clearly wrong, return an empty list. That is the expected answer for a clean page.

Reply with JSON only: {"fixes":[{"before":"…","after":"…","context":"…","why":"…"}]}`;

export function buildProofPrompt(page) {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Page ${(page.order ?? 0) + 1}:\n\n${page.text || ''}` },
  ];
}

export function parseCorrections(raw) {
  if (!raw) return [];
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  let list = [];
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start === -1 || end <= start) continue;
    let data;
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    const found = Array.isArray(data) ? data : Array.isArray(data?.fixes) ? data.fixes : [];
    if (found.length) {
      list = found;
      break;
    }
  }

  const out = [];
  const seen = new Set();
  for (const item of list) {
    const before = typeof item?.before === 'string' ? item.before.trim() : '';
    const after = typeof item?.after === 'string' ? item.after.trim() : '';
    // A fix that changes nothing is the model filling its quota.
    if (!before || !after || before === after) continue;
    const key = `${before}→${after}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      before,
      after,
      context: typeof item?.context === 'string' ? item.context.trim() : '',
      why: typeof item?.why === 'string' ? item.why.trim() : '',
    });
  }
  return out;
}

// Where in the page's text the fix belongs: an index and a length, ready to
// splice. Folding is 1:1 per character (see text.js), which is what lets the
// accent- and case-insensitive search hand back an index into the original.
//
// Ambiguity is answered with silence rather than a guess: a fix applied to the
// wrong occurrence is a transcription error the user never had.
export function locateCorrection(page, fix) {
  const text = page?.text || '';
  if (!text || !fix?.before) return null;
  const folded = foldText(text);
  const before = foldText(fix.before);
  const context = foldText(fix.context || '');

  if (context) {
    const at = folded.indexOf(context);
    if (at !== -1 && folded.indexOf(context, at + 1) === -1) {
      const rel = folded.slice(at, at + context.length).indexOf(before);
      if (rel !== -1) return { index: at + rel, length: fix.before.length };
    }
  }
  const first = folded.indexOf(before);
  if (first === -1) return null;
  if (folded.indexOf(before, first + 1) !== -1) return null; // more than one candidate
  return { index: first, length: fix.before.length };
}

const tokens = (s) => foldText(s || '').split(/\s+/).filter(Boolean);

// The word boxes that spell out `before`, so the fix can be shown on the page
// and carried into them. Returns the indices into page.words.
export function wordsForCorrection(page, fix) {
  const words = page?.words;
  const want = tokens(fix?.before);
  if (!words?.length || !want.length) return [];
  const folded = words.map((w) => foldText(w.t));
  for (let i = 0; i + want.length <= folded.length; i++) {
    let all = true;
    for (let j = 0; j < want.length; j++) {
      // Vision keeps punctuation attached to the word it touches, so a comma
      // must not be what stops a fix from finding its ink.
      if (folded[i + j].replace(/^\W+|\W+$/g, '') !== want[j]) {
        all = false;
        break;
      }
    }
    if (all) return Array.from({ length: want.length }, (_, k) => i + k);
  }
  return [];
}

// The rectangle to show the user: the whole line the error sits on, because a
// word alone is not enough to judge whether it was misread.
export function boxForCorrection(page, fix) {
  const indices = wordsForCorrection(page, fix);
  if (!indices.length) return null;
  const hit = indices.map((i) => page.words[i]);
  const top = Math.min(...hit.map((w) => w.y));
  const bottom = Math.max(...hit.map((w) => w.y + w.h));
  // Everything sharing the error's rows, which is the line as written.
  const line = page.words.filter((w) => w.y + w.h > top && w.y < bottom);
  const from = line.length ? line : hit;
  const x = Math.min(...from.map((w) => w.x));
  const y = Math.min(...from.map((w) => w.y));
  return {
    x,
    y,
    w: Math.max(...from.map((w) => w.x + w.w)) - x,
    h: Math.max(...from.map((w) => w.y + w.h)) - y,
  };
}

// Apply a fix. Returns the new text and words, or null when it can no longer
// be placed — a page edited since the run started, most likely.
export function applyCorrection(page, fix) {
  const at = locateCorrection(page, fix);
  if (!at) return null;
  const text = page.text.slice(0, at.index) + fix.after + page.text.slice(at.index + at.length);

  // The boxes carry their own copy of each word, and search draws its
  // highlights from them, so a fix that only touched the text would leave the
  // corrected word unfindable on the image. Word for word only: anything that
  // splits or joins them has no honest mapping onto boxes measured in ink.
  let words = page.words || [];
  const from = tokens(fix.before);
  const to = (fix.after || '').split(/\s+/).filter(Boolean);
  const indices = wordsForCorrection(page, fix);
  if (indices.length && from.length === to.length) {
    words = words.map((w, i) => {
      const k = indices.indexOf(i);
      return k === -1 ? w : { ...w, t: to[k] };
    });
  }
  return { text, words };
}

export function pagesToProof(pages) {
  return pages.filter(
    (p) => p.ocrStatus === 'done' && (p.text || '').trim().length >= MIN_TEXT_CHARS
  );
}

// Ask the model to read one page back. Returns the fixes it could place.
export async function proofreadPage(page, { signal, model } = {}) {
  const raw = await complete(buildProofPrompt(page), { signal, model });
  return parseCorrections(raw)
    .map((fix) => ({ ...fix, at: locateCorrection(page, fix) }))
    // A fix that can't be located is one we would have to guess at.
    .filter((fix) => fix.at)
    .map(({ at, ...fix }) => fix);
}
