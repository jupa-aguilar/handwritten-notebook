// What a page's vertical corridors mean.
//
// guided.js can find them exactly — they are the ink's own gaps, and a word
// box is measured, not guessed — and cannot tell a table's columns from the
// air around a drawing. Measured over 160 pages of these notebooks, that
// judgement is where it goes wrong: the corridors it believed on a hand-drawn
// page cut a heading in half and read the right-hand box of a diagram before
// the middle one. Every threshold in guided.js is a proxy for the question a
// model answers by looking: is this a table, or is it a picture?
//
// So it is asked once per page, the way the transcription is, and the answer
// is stored on the page and synced with it.
//
// Two things keep a wrong answer cheap. It may only confirm or discard
// corridors the geometry already found, so it can misread a page and never
// invent one. And a page with no corridors is never sent at all, which is
// most pages: nothing to judge, nothing to pay for.

import { complete } from './chat.js';
import { corridorsOf } from './guided.js';

const HEAD = `You are looking at one page from a student's notebook.

A measurement of the ink has found vertical corridors that no word crosses. They are listed below as percentages of the page's width. Your job is to say which of them separate material that is read one part after another — the columns of a table, a two-column layout, a list with its values in a column of their own — and which are only space.`;

const RULES = `Rules:
- Judge only the corridors listed, by their position on the page. Never propose others.
- A corridor counts when what sits either side of it is read separately. If the page reads straight across it, it does not count, however clear the gap is.
- The parts of a drawing often line up, and a diagram is not a table. Boxes joined by arrows, a sketch with labels beside it, a worked example with a note in the margin: those corridors are space.
- When you are unsure, leave the corridor out. Reading the page as ordinary lines is the answer that is never badly wrong.
- "kind" describes the page as a whole: "table", "columns", "diagram" or "prose".

Reply with JSON only: {"kind":"…","columns":[12,53]}`;

// `image` is a data: URL of the page (crop.js's pageForModel). The caller
// encodes it, so this file stays pure and its prompt can be tested without a
// canvas.
export function buildLayoutPrompt(page, corridors, image = null) {
  const width = page?.width || 1;
  const at = corridors
    .map((c) => `${Math.round((c.x / width) * 100)}% (runs through ${c.rows} rows)`)
    .join(', ');
  const text = `Corridors found: ${at}.`;
  return [
    { role: 'system', content: `${HEAD}\n\n${RULES}` },
    {
      role: 'user',
      // The page first: the question is about what is on it, and the list of
      // numbers means nothing until it has been seen.
      content: image
        ? [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text }]
        : text,
    },
  ];
}

// How far a returned percentage may sit from a corridor and still be taken to
// name it. Wide enough for a model that rounds, far short of the gap between
// two columns of anything.
const SNAP = 4; // % of the page's width

const KINDS = ['table', 'columns', 'diagram', 'prose'];

// The answer, mapped back onto the corridors it is about. Anything that does
// not name one of them is dropped: the model is judging this page's ink, not
// describing a page of its own.
export function parseLayout(raw, page, corridors) {
  const width = page?.width || 1;
  let text = String(raw ?? '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let data = null;
  if (start !== -1 && end > start) {
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch {
      data = null;
    }
  }
  // No answer at all is not the same as "no columns": leaving `columns`
  // undefined sends the page back to the geometry, while an empty list is a
  // verdict the reader is entitled to.
  if (!data) return null;

  const kind = KINDS.includes(data.kind) ? data.kind : 'prose';
  const named = Array.isArray(data.columns) ? data.columns : [];
  const columns = [];
  for (const value of named) {
    const pct = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(pct)) continue;
    let best = null;
    for (const c of corridors) {
      const d = Math.abs((c.x / width) * 100 - pct);
      if (d <= SNAP && (!best || d < best.d)) best = { d, x: c.x };
    }
    if (best && !columns.includes(best.x)) columns.push(best.x);
  }
  columns.sort((a, b) => a - b);
  return { kind, columns, at: Date.now() };
}

// The whole job for one page. Null when there is nothing to ask about, which
// is the common case and costs nothing; the caller stores whatever comes back
// on the page, including an empty verdict.
export async function readLayout(page, { signal, model, image = null } = {}) {
  const corridors = corridorsOf(page);
  if (!corridors.length) return { kind: 'prose', columns: [], at: Date.now() };
  const raw = await complete(buildLayoutPrompt(page, corridors, image), { signal, model });
  return parseLayout(raw, page, corridors);
}
