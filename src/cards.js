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
- Every question must stand on its own, naming the thing it asks about. The
  reader has the question and nothing else in front of them, so never lean on
  "the text", "the page", "the author" or "the previous point": none of them
  will be there.
- Ask only what somebody who studied this page a month ago, without it to hand,
  could answer.
- Never ask for a list to be recited. Ask for one of its items, or for what
  tells them apart.
- The answer must be short — a phrase or one sentence.
- "hint" points at the answer without containing it: one line that makes the
  reader retrieve it rather than recognise it. Never the answer reworded, never
  a synonym of it, never a word the answer itself uses.
- "insight" is one sentence adding what the answer does not say: the reason it
  is so, what it is easily confused with, or what follows from it. It must be
  supported by this page — never general encouragement, never a restatement of
  the answer, and never something you know from elsewhere. Leave it empty
  rather than pad it.
- "anchor" must be copied verbatim from the page text: the 3-10 consecutive
  words where the answer is written. Never invent or reword an anchor.
- "topic" names what this page is about in 2-4 words, in the page's language.
- Skip anything you cannot ask about with confidence. Fewer good cards beats
  filling a quota; an empty list is a valid answer.

Reply with JSON only:
{"topic":"…","cards":[{"q":"…","a":"…","hint":"…","insight":"…","anchor":"…"}]}`;

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
//
// Both bracket shapes are tried, and the first that yields actual cards wins:
// a bare array's outermost `{` ... `}` is its first element, which parses
// perfectly well and holds no list at all.
function extractCardJson(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

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
    if (found.length) return { data, cards: found };
  }
  return null;
}

// What the page is about, in two or three words. It is the frame a question
// loses on its way off the page: the model wrote it with the whole sheet in
// view, and it is answered with nothing in view at all.
export function parseTopic(raw) {
  const topic = extractCardJson(raw)?.data?.topic;
  return typeof topic === 'string' ? topic.trim() : '';
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// A hint that hands over the answer is not a hint, and it is the way models
// fail at this: asked to point at something, they name it. Dropped rather than
// shown, so the ladder's first step can't be the last one.
export function usableHint(hint, answer) {
  const h = foldText(hint || '');
  const a = foldText(answer || '');
  if (!h || !a) return '';
  return h.includes(a) || a.includes(h) ? '' : hint;
}

export function parseCards(raw) {
  const list = extractCardJson(raw)?.cards || [];
  const seen = new Set();
  const cards = [];
  for (const item of list) {
    const q = str(item?.q);
    const a = str(item?.a);
    if (!q || !a) continue;
    // Same question twice is a model looping, not two cards.
    const key = foldText(q);
    if (seen.has(key)) continue;
    seen.add(key);
    const insight = str(item?.insight);
    cards.push({
      q,
      a,
      hint: usableHint(str(item?.hint), a),
      // An insight that only says the answer again is the padding the prompt
      // asked it not to write.
      insight: foldText(insight) === foldText(a) ? '' : insight,
      anchor: str(item?.anchor),
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

  // Only the words that actually matched go into the box. Taking the whole
  // window instead would be the same thing right up until the page has two
  // columns: Vision's reading order walks straight across the gutter, so one
  // unmatched word in the middle of the run dragged the neighbouring table
  // into the picture.
  const hit = (k) =>
    wanted.has(folded[k]) || want.some((t) => t.length > 3 && folded[k].includes(t));
  const matched = [];
  for (let k = best.start; k < best.start + size; k++) if (hit(k)) matched.push(words[k]);
  return matched.length ? union(matched) : null;
}

function union(boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
  };
}

// The rectangle actually cut out of the page image: the card's box, padded so
// it looks like a piece of paper rather than a ransom note, and then snapped
// to whole words and whole lines.
//
// The snapping is the part that matters. Padding alone lands wherever it
// lands, which meant crops that opened on the bottom halves of the line above
// and closed on the top halves of the line below — legible, but plainly an
// accident. Any line or word the padding *mostly* covers is taken in full;
// anything it merely grazes is pushed back out.
const KEEP = 0.4; // fraction of a word or line that has to be inside to keep it

export function cropRect(page, box) {
  if (!box) return null;
  // Padding is measured against one line, never against the box: a passage
  // spanning two lines is twice as tall, and a margin scaled to *that* reached
  // far enough to swallow the next bullet down whole.
  const pad = Math.max(12, lineHeight(page, box) * 0.4);
  let rect = {
    x0: Math.max(0, box.x - pad),
    y0: Math.max(0, box.y - pad),
    x1: Math.min(page.width || Infinity, box.x + box.w + pad),
    y1: Math.min(page.height || Infinity, box.y + box.h + pad),
  };
  const words = page?.words || [];
  if (!words.length) return fromEdges(rect);

  rect = snap(
    rect,
    rows(words).map((r) => ({ lo: r.y0, hi: r.y1, keep: r })),
    'y0',
    'y1',
    box.y,
    box.y + box.h
  );
  // Horizontally only against the words on the lines the crop now shows —
  // words elsewhere on the page have no say in where its edges fall.
  const onScreen = words.filter((w) => w.y + w.h > rect.y0 && w.y < rect.y1);
  rect = snap(
    rect,
    onScreen.map((w) => ({ lo: w.x, hi: w.x + w.w })),
    'x0',
    'x1',
    box.x,
    box.x + box.w
  );
  return fromEdges(rect);
}

// How tall a line of this handwriting is: the median word height on the page,
// which shrugs off both the stray tall capital and the lone accent.
function lineHeight(page, box) {
  const hs = (page?.words || []).map((w) => w.h).sort((a, b) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)] : box.h;
}

const fromEdges = (r) => ({ x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 });

// Grow or shrink one axis of `rect` so no span is left half-shown. `keepLo`
// and `keepHi` bound what must survive: the card's own box, which is never
// trimmed away however little of a line it happens to cover.
function snap(rect, spans, loKey, hiKey, keepLo, keepHi) {
  const out = { ...rect };
  for (const span of spans) {
    const size = span.hi - span.lo;
    if (size <= 0) continue;
    const inside = Math.min(out[hiKey], span.hi) - Math.max(out[loKey], span.lo);
    if (inside <= 0) continue;
    const wanted = inside / size >= KEEP || (span.lo < keepHi && span.hi > keepLo);
    if (wanted) {
      out[loKey] = Math.min(out[loKey], span.lo);
      out[hiKey] = Math.max(out[hiKey], span.hi);
    } else if (span.lo <= keepLo) {
      out[loKey] = Math.max(out[loKey], span.hi); // grazed from above
    } else {
      out[hiKey] = Math.min(out[hiKey], span.lo); // grazed from below
    }
  }
  return out;
}

// Words grouped into the lines they were written on, by vertical overlap.
function rows(words) {
  const sorted = [...words].sort((a, b) => a.y - b.y);
  const out = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    // More than half of the word's height shared with the row it is joining:
    // a superscript or a caret sits above its line, not on it.
    const overlap = last ? Math.min(last.y1, w.y + w.h) - Math.max(last.y0, w.y) : 0;
    if (last && overlap > w.h * 0.5) {
      last.y0 = Math.min(last.y0, w.y);
      last.y1 = Math.max(last.y1, w.y + w.h);
    } else {
      out.push({ y0: w.y, y1: w.y + w.h });
    }
  }
  return out;
}

// The rectangle behind a hint: the card's passage with a line of context above
// and below, so the crop can be shown with the answer itself covered and still
// say something. What comes back is the sentence around the gap — which is how
// you find a word you wrote yourself, instead of being handed it.
//
// Whole lines, edge to edge, rather than cropRect's snapping: half a line of
// context is not a sentence.
const HINT_CONTEXT = 1; // lines kept either side of the answer
// Below this much ink left uncovered there is no hint to give: one or two
// stray words are not a sentence, and a mask over everything else is a grey
// slab. Counted in words rather than in area, because the padding inflates the
// area — a single-line page passes an area test and still shows nothing.
const MIN_VISIBLE_WORDS = 3;

// How far the mask overshoots the answer's own box, as a fraction of a line.
// A word box bounds the ink Vision was sure of, and a descender or an accent
// regularly falls outside one — an uncovered tail is enough to give the word
// away, and the cost of being generous is a little blank paper.
const MASK_PAD = 0.18;

// What the hint covers. Kept here rather than in the drawing code so all the
// geometry stays in the module that can be tested without a canvas.
export function maskRect(page, box) {
  if (!box) return null;
  const pad = Math.max(3, lineHeight(page, box) * MASK_PAD);
  return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
}

export function hintRect(page, box, context = HINT_CONTEXT) {
  const words = page?.words;
  if (!box || !words?.length) return null;

  const lines = rows(words);
  let first = -1;
  let last = -1;
  for (const [i, r] of lines.entries()) {
    if (r.y1 <= box.y || r.y0 >= box.y + box.h) continue;
    if (first === -1) first = i;
    last = i;
  }
  if (first === -1) return null;

  const lo = lines[Math.max(0, first - context)];
  const hi = lines[Math.min(lines.length - 1, last + context)];
  const on = words.filter((w) => w.y + w.h > lo.y0 && w.y < hi.y1);
  if (!on.length) return null;

  const pad = Math.max(12, lineHeight(page, box) * 0.4);
  const x = Math.max(0, Math.min(...on.map((w) => w.x)) - pad);
  const y = Math.max(0, lo.y0 - pad);
  const rect = {
    x,
    y,
    w: Math.min(page.width || Infinity, Math.max(...on.map((w) => w.x + w.w)) + pad) - x,
    h: Math.min(page.height || Infinity, hi.y1 + pad) - y,
  };
  if (rect.w <= 0 || rect.h <= 0) return null;

  const visible = on.filter(
    (w) =>
      w.x + w.w <= box.x ||
      w.x >= box.x + box.w ||
      w.y + w.h <= box.y ||
      w.y >= box.y + box.h
  );
  return visible.length >= MIN_VISIBLE_WORDS ? rect : null;
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
  // One topic for the page, copied onto each of its cards rather than stored
  // beside the page: a card syncs on its own and is shown on its own, so it has
  // to carry its own frame.
  const topic = parseTopic(raw);
  return parseCards(raw).map((c) => ({
    // Its identity across devices; the autoincrement id is local-only.
    uuid: crypto.randomUUID(),
    notebookId,
    pageId: page.id,
    // The page's identity at the time the box was measured: if the image is
    // ever replaced the uuid changes, and the answer side falls back to text
    // rather than cropping coordinates from a picture that no longer exists.
    pageUuid: page.uuid || '',
    q: c.q,
    a: c.a,
    topic,
    hint: c.hint,
    insight: c.insight,
    anchor: c.anchor,
    box: locateAnchor(page, c.anchor),
    createdAt: now,
    modifiedAt: now,
    suspended: false,
    ...newSchedule(now),
  }));
}

// ---------- topping up cards that were made before the fields existed ----------
//
// A deck of cards already sat with cannot be regenerated: clearing a page takes
// its schedule down with the cards. So the hint and the insight are asked for
// on their own, against the questions that already exist, and written onto the
// cards in place.

export function cardsToTopUp(cards) {
  return (cards || []).filter((c) => c?.q && (!c.hint || !c.insight));
}

const TOP_UP_SYSTEM = `You are given one page of a student's handwritten notebook and the review questions already drawn from it. For each question, write two things.

Rules:
- Write in the same language as the page.
- "hint" points at the answer without containing it: one line that makes the
  reader retrieve it rather than recognise it. Never the answer reworded, never
  a synonym of it, never a word the answer itself uses.
- "insight" is one sentence adding what the answer does not say: the reason it
  is so, what it is easily confused with, or what follows from it. It must be
  supported by this page — never general encouragement, never a restatement of
  the answer, and never something you know from elsewhere.
- Copy each "q" back exactly as it was given. Leave out any question you cannot
  do this well for; a short list is a valid answer.
- Invent no new questions and change no answers.

Reply with JSON only: {"cards":[{"q":"…","hint":"…","insight":"…"}]}`;

export function buildTopUpPrompt(page, cards) {
  const asked = (cards || [])
    .map((c) => `Q: ${c.q}\nA: ${c.a}`)
    .join('\n\n');
  return [
    { role: 'system', content: TOP_UP_SYSTEM },
    {
      role: 'user',
      content: `Page ${(page.order ?? 0) + 1}.\n\n${page.text || ''}\n\n---\n\n${asked}`,
    },
  ];
}

export function parseTopUp(raw) {
  const list = extractCardJson(raw)?.cards || [];
  const out = [];
  for (const item of list) {
    const q = str(item?.q);
    if (!q) continue;
    out.push({ q, hint: str(item?.hint), insight: str(item?.insight) });
  }
  return out;
}

// Written onto the cards by matching the question, never by position: a model
// that answers for three of four questions would otherwise shift every hint
// onto the wrong card, and a hint attached to the wrong question is worse than
// none. Returns only the cards that actually changed, so the caller writes
// exactly those — every put is a modifiedAt the card sync has to carry.
export function applyTopUp(cards, parsed) {
  const byQuestion = new Map((parsed || []).map((p) => [foldText(p.q), p]));
  const changed = [];
  for (const card of cards || []) {
    const found = byQuestion.get(foldText(card.q || ''));
    if (!found) continue;
    const hint = card.hint || usableHint(found.hint, card.a);
    const insight = card.insight || found.insight;
    if (hint === (card.hint || '') && insight === (card.insight || '')) continue;
    changed.push({ ...card, hint, insight });
  }
  return changed;
}

export async function topUpForPage(page, cards, { signal, model } = {}) {
  const raw = await complete(buildTopUpPrompt(page, cards), { signal, model });
  return applyTopUp(cards, parseTopUp(raw));
}
