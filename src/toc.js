// The notebook's own table of contents, read out of its pages by the model.
//
// A notebook is read one spread at a time and nothing says what is in it. The
// pager gives numbers, ⌘⌥G jumps to one, bookmarks save places marked by hand
// — but there is no way to go to "J.2 La intención: escribir una vez" by name,
// and on seventy pages that is the difference between a document and a stack
// of scans.
//
// Printed notebooks have headings to find. Handwritten ones have none at all,
// and there the model has to *name* a run of pages from what is on it, which is
// the part nothing else here can do. Both come back in the same shape.
//
// Everything except tocForPages() is pure, so the prompt and the parsing are
// testable without a model.

import { complete } from './chat.js';

const SYSTEM = `You are building the table of contents of a student's notebook, from the transcriptions of its pages.

Return the sections that BEGIN in the pages you are given, in the order they appear.

Rules:
- A section is a real division of the material: a chapter, a numbered heading, an exercise set, a topic the pages move on to. Not every paragraph, and not a heading you invented for one sentence. Fewer, truer entries are worth more than a dense list.
- Where the page prints its own heading, use it as the title, exactly as written. Where the pages have no headings — handwritten notes usually do not — name the section yourself, in a few words, in the language of the page.
- "level" is 1 for a top-level section, 2 for a subsection inside it, 3 at the deepest. Follow the numbering the page itself uses when it has one (I.4 sits under I; J.2 under J).
- "page" is the page number the section starts on, from the numbers given below, and nothing else.
- "anchor" is copied VERBATIM from that page's text: the first few words of the heading, or of the first line of the section where there is no heading. The app searches the scan for those words to mark the spot, so a paraphrase finds nothing.
- If a section was already listed in "Found so far", it began earlier: do not list it again.
- Pages that only continue what came before contribute nothing. An empty list is the right answer for them.

Reply with JSON only: {"entries":[{"level":1,"title":"…","page":12,"anchor":"…"}]}`;

// `batch` is [{ number, text }] with 1-based page numbers as the reader sees
// them; `sofar` is the tail of what earlier batches found, so the levels stay
// coherent across a boundary instead of every batch restarting at 1.
export function buildTocPrompt(batch, sofar = []) {
  const seen = sofar.length
    ? `Found so far, most recent last:\n${sofar
        .map((e) => `${'  '.repeat(Math.max(0, e.level - 1))}${e.level}. ${e.title} (p. ${e.page})`)
        .join('\n')}\n\n`
    : '';
  const pages = batch
    .map((p) => `--- Page ${p.number} ---\n${(p.text || '').trim()}`)
    .join('\n\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${seen}${pages}` },
  ];
}

// `allowed` is the set of page numbers this batch covered. A model that cites a
// page it was not shown is guessing from the numbering it saw, and an entry
// pointing at the wrong page is worse than a missing one.
export function parseToc(raw, allowed = null) {
  const list = digJson(raw);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const title = typeof item?.title === 'string' ? item.title.trim() : '';
    const page = Number(item?.page);
    if (!title || !Number.isInteger(page)) continue;
    if (allowed && !allowed.has(page)) continue;
    // One entry per title per page: a model asked for the same pages twice
    // returns the same heading twice.
    const key = `${page}::${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      level: Math.min(3, Math.max(1, Math.round(Number(item?.level)) || 1)),
      title,
      page,
      anchor: typeof item?.anchor === 'string' ? item.anchor.trim() : '',
    });
  }
  // Page order, and within a page the order the model gave them: a subsection
  // listed before its parent would render as a stray indent.
  return out.sort((a, b) => a.page - b.page);
}

// Same defensiveness as proof.js's parseCorrections: the reply may be fenced,
// prefaced, or an array rather than the object that was asked for.
function digJson(raw) {
  if (!raw) return [];
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
    const found = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : [];
    if (found.length) return found;
  }
  return [];
}

// How the run is cut up. A table of contents needs to see consecutive pages to
// place a subsection under its parent, so this batches rather than going page
// by page — and it sizes the batch from the model's own context rather than a
// constant of ours, because the same code runs against a 1M-token hosted model
// and a local one with a few thousand.
export function batchPages(pages, budget) {
  const out = [];
  let batch = [];
  let used = 0;
  for (const p of pages) {
    const size = (p.text || '').length + 40; // the "--- Page N ---" line included
    if (batch.length && used + size > budget) {
      out.push(batch);
      batch = [];
      used = 0;
    }
    batch.push(p);
    used += size;
  }
  if (batch.length) out.push(batch);
  return out;
}

export async function tocForPages(batch, sofar, { signal, model } = {}) {
  const allowed = new Set(batch.map((p) => p.number));
  return parseToc(await complete(buildTocPrompt(batch, sofar), { signal, model }), allowed);
}
