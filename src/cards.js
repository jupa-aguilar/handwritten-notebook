// Review cards drawn from a transcribed page.
//
// The point of generating them here rather than in a general-purpose study app
// is the anchor: every card names a literal fragment of the page it came from,
// which we locate in that page's OCR word boxes to get a rectangle. The answer
// side then shows the user's own handwriting instead of a paraphrase of it —
// which is the one thing a tool that never saw the paper cannot do.
//
// Everything except generateForPage() is pure, so the prompt, the parsing and
// the anchoring are all testable without a model or a DOM.

import { complete } from './chat.js';
import { foldText } from './text.js';
import { newSchedule } from './srs.js';

export const CARDS_PER_PAGE = 4;

// Pages with a line or two of text yield questions about nothing; skipping
// them keeps a run from spending money to produce "¿qué dice el título?".
export const MIN_TEXT_CHARS = 120;

const SYSTEM = `You turn one page of a student's handwritten notebook into review cards.

Rules:
- Write the questions and answers in the same language as the page.
- Ask about what the page actually claims: definitions, causes, steps, numbers,
  distinctions. Never ask about the page's layout, its title, or how it looks.
- The answer must be short — a phrase or one sentence.
- "anchor" must be copied verbatim from the page text: the 3-10 consecutive
  words where the answer is written. Never invent or reword an anchor.
- Skip anything you cannot ask about with confidence. Fewer good cards beats
  filling a quota; an empty list is a valid answer.

Reply with JSON only: {"cards":[{"q":"…","a":"…","anchor":"…"}]}`;

export function buildCardPrompt(page, limit = CARDS_PER_PAGE) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Page ${(page.order ?? 0) + 1}. Write at most ${limit} cards.\n\n${page.text || ''}`,
    },
  ];
}

// Models wrap JSON in prose, in ``` fences, or answer with a bare array
// however firmly the prompt asks for an object. Rather than trusting any of
// that, take the outermost bracketed run and parse it.
export function parseCards(raw) {
  if (!raw) return [];
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // Both bracket shapes are tried, and the first that yields actual cards
  // wins: a bare array's outermost `{` ... `}` is its first element, which
  // parses perfectly well and holds no list at all.
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
    const found = Array.isArray(data) ? data : Array.isArray(data?.cards) ? data.cards : [];
    if (found.length) {
      list = found;
      break;
    }
  }

  const seen = new Set();
  const cards = [];
  for (const item of list) {
    const q = typeof item?.q === 'string' ? item.q.trim() : '';
    const a = typeof item?.a === 'string' ? item.a.trim() : '';
    if (!q || !a) continue;
    // Same question twice is a model looping, not two cards.
    const key = foldText(q);
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({
      q,
      a,
      anchor: typeof item?.anchor === 'string' ? item.anchor.trim() : '',
    });
  }
  return cards;
}

const tokens = (s) =>
  foldText(s || '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// Where on the page an anchor was written: the union of the word boxes of the
// best-matching run of words, in image pixels.
//
// Matched as a bag of words inside a sliding window rather than as a literal
// substring, because both sides are approximations of the same ink — the model
// retypes what it read, Vision split the strokes its own way — and an exact
// comparison fails on the one transcription error the box would have revealed.
export function locateAnchor(page, anchor) {
  const words = page?.words;
  if (!words?.length) return null;
  const want = tokens(anchor);
  if (!want.length) return null;

  const folded = words.map((w) => foldText(w.t));
  const size = Math.min(want.length, folded.length);
  const wanted = new Set(want);

  let best = { score: 0, start: 0 };
  for (let i = 0; i + size <= folded.length; i++) {
    let score = 0;
    for (let j = 0; j < size; j++) {
      const w = folded[i + j];
      if (wanted.has(w) || want.some((t) => t.length > 3 && w.includes(t))) score++;
    }
    if (score > best.score) best = { score, start: i };
  }
  // Half the words is the line between "the model quoted this passage" and
  // "these words happen to be common". Below it, no box at all: an honest
  // text-only card beats a rectangle over the wrong sentence.
  if (best.score < Math.max(2, Math.ceil(size * 0.5))) return null;

  // Trim the window back to the words that actually matched, so a short quote
  // inside a long line doesn't box the whole line.
  let from = best.start;
  let to = best.start + size - 1;
  const hit = (k) =>
    wanted.has(folded[k]) || want.some((t) => t.length > 3 && folded[k].includes(t));
  while (from < to && !hit(from)) from++;
  while (to > from && !hit(to)) to--;

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = from; k <= to; k++) {
    const w = words[k];
    x0 = Math.min(x0, w.x);
    y0 = Math.min(y0, w.y);
    x1 = Math.max(x1, w.x + w.w);
    y1 = Math.max(y1, w.y + w.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Which pages are worth a request: transcribed, long enough to hold an idea,
// and without cards already. Regenerating a page is deliberate (clear it
// first), so a second run over a notebook only pays for what it skipped.
export function pagesToGenerate(pages, existingCards) {
  const done = new Set(existingCards.map((c) => c.pageId));
  return pages.filter(
    (p) =>
      !done.has(p.id) &&
      p.ocrStatus === 'done' &&
      (p.text || '').trim().length >= MIN_TEXT_CHARS
  );
}

// Ask the model for one page's cards and return them ready for the store.
export async function generateForPage(page, notebookId, { signal, model } = {}) {
  const raw = await complete(buildCardPrompt(page), { signal, model });
  const now = Date.now();
  return parseCards(raw).map((c) => ({
    notebookId,
    pageId: page.id,
    // The page's identity at the time the box was measured: if the image is
    // ever replaced the uuid changes, and the answer side falls back to text
    // rather than cropping coordinates from a picture that no longer exists.
    pageUuid: page.uuid || '',
    q: c.q,
    a: c.a,
    anchor: c.anchor,
    box: locateAnchor(page, c.anchor),
    createdAt: now,
    suspended: false,
    ...newSchedule(now),
  }));
}
