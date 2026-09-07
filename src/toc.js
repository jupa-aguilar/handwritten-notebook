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
import { bareTokens, foldText } from './text.js';

const SYSTEM = `You are building the table of contents of a student's notebook, from the transcriptions of its pages.

Return the sections that BEGIN in the pages you are given, in the order they appear.

Rules:
- A section is a division the page itself makes: a heading it writes, a numbered division, an exercise set, a topic the pages move on to. List every heading a page writes — the one it opens with and the ones written under it — because the sections under a subject are the shape of the material and this list is what shows it. Not a paragraph that merely goes on, and not a heading you invented for a sentence that has none: a page with four headings gives four entries, not nine.
- Where the page prints its own heading, take its words as the title. Where the pages have no headings — handwritten notes usually do not — name the section yourself, in a few words, in the language of the page.
- Write every title the way it would be written inside a sentence, whatever the page does: the first word capitalised, the rest lower case, and capitals only where ordinary writing puts them — proper nouns and acronyms (RAID, CPU, IPv4, Docker). A heading the page prints in capitals is not a title in capitals, and a heading that capitalises Every Important Word is not one either.
- "level" is 1 for a top-level section, 2 for a subsection inside it, 3 at the deepest. Where the page numbers its headings, follow that numbering (I.4 sits under I; J.2 under J). Where it does not, follow the page: the heading a page opens with is that page's own subject and is level 1, and a heading that begins further down the same page is a section of it, level 2.
- "page" is the page number the section starts on, from the "--- Page N ---" lines below, and nothing else. Many scans print a number of their own ("PÁG. 9/14", "- 3 -"): that one belongs to the document that was scanned, not to this notebook, and is never the answer.
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

// A batch's reply carries every heading its pages write, and the budget above
// only measures what goes up. Against a hosted model the budget alone puts the
// whole notebook in one request — forty pages asking for one JSON of a hundred
// and thirty entries, long enough to be cut off by the model's own output
// limit. A cut-off reply is not JSON at all, so the batch would yield nothing
// rather than less. A dozen pages is still a run long enough to put a section
// under the subject it belongs to, and it costs the same: every page is sent
// once either way.
const MAX_PAGES_PER_BATCH = 12;

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
    if (batch.length && (used + size > budget || batch.length >= MAX_PAGES_PER_BATCH)) {
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

// Where each section really starts.
//
// The page number is the one field in the reply that nothing checks against the
// page it names, and it is the field the model gets wrong. Three fourteen-page
// documents scanned into one notebook, every scan printing its own "PÁG. 9/14",
// came back with each section placed by the number written on the page instead
// of the "--- Page N ---" it was given: all three runs collapsed onto the
// notebook's first fifteen pages, and most entries pointed at a page about
// something else. The prompt now says not to, which helps and does not settle
// it — a number is a claim, and this is the check.
//
// The anchor is the part that can be checked, because it was quoted from the
// page. Where its words are on the page the model named, the number stands.
// Where they are clearly on another page, the entry moves there. Where the
// anchor is nowhere — a paraphrase, a page whose transcription is thin — there
// is nothing to argue with and the claim is kept: this overrules a number it
// can disprove, not one it merely cannot confirm.
export function placeEntries(entries, batch) {
  const pages = batch.filter((p) => (p.text || '').trim());
  const textOf = new Map(batch.map((p) => [p.number, p.text || '']));
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    const want = bareTokens(e.anchor);
    const found = want.length ? bestPage(pages, want, e.page) : { page: e.page, at: -1 };
    if (found === null) continue;
    const { page, at } = found;
    // Relocation can bring two entries onto one page, the same way asking for
    // the same pages twice could: one title per page either way.
    const key = `${page}::${e.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e, page, at, title: sentenceCase(e.title, textOf.get(page) || '') });
  }
  levelByPlace(out);
  // Page order, and within a page the order the headings were written in —
  // which is what the anchors' offsets give us. It used to be the order the
  // model listed them, with the note that a subsection ahead of its parent
  // renders as a stray indent; now the page itself settles it. An entry whose
  // anchor was never located goes last on its page: it is the one we know
  // least about, and it was never promoted, so it cannot be a parent.
  return out
    .sort((a, b) => a.page - b.page || writtenAt(a) - writtenAt(b))
    .map(({ at, ...e }) => e);
}

const writtenAt = (e) => (e.at >= 0 ? e.at : Number.MAX_SAFE_INTEGER);

// How far into a page a heading can start and still be the page's own title.
// Enough for the printed furniture these scans carry above it — "TEMA", "DÍA
// MES AÑO", "PÁGINA 2/16" — and not enough for a line of prose to have gone by.
const HEADS_THE_PAGE = 200;

// Which entries are a page's subject and which are sections of it.
//
// These notebooks are written to a convention: the page's subject at its head,
// underlined twice, and its sections below it underlined once. The underline is
// ink and the index is built from the transcription, so the model never sees
// it — but position says the same thing, and says it in the text. The heading a
// page opens with is its subject; a heading that begins further down that page
// is a section of it.
//
// So the earliest-placed entry on a page is level 1, provided its anchor really
// is at the head of the page — a page that opens mid-paragraph is a page whose
// title was on the one before, and there is nothing here to promote. Only then
// are that page's other entries pushed under it, since the demotion only means
// anything relative to a title we actually found.
function levelByPlace(placed) {
  const byPage = new Map();
  for (const e of placed) {
    if (!byPage.has(e.page)) byPage.set(e.page, []);
    byPage.get(e.page).push(e);
  }
  for (const group of byPage.values()) {
    const located = group.filter((e) => e.at >= 0).sort((a, b) => a.at - b.at);
    const head = located[0];
    if (!head || head.at > HEADS_THE_PAGE) continue;
    head.level = 1;
    for (const e of group) if (e !== head) e.level = Math.max(2, e.level);
  }
}

// The page an anchor was written on, and where on it: { page, at }, or null
// when the anchor is on two pages equally. `page` falls back to the model's
// claim when the anchor is nowhere, and `at` is -1 when nothing located it.
function bestPage(pages, want, claimed) {
  // cards.js's line, for the same reason: half the words is where "the model
  // quoted this passage" stops and "these words are just common" starts.
  const need = Math.max(2, Math.ceil(want.length * 0.5));
  const scored = pages
    .map((p) => ({ number: p.number, ...findAnchor(p.text, want) }))
    .filter((p) => p.score >= need)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { page: claimed, at: -1 }; // nothing to say
  const mine = scored.find((p) => p.number === claimed);
  if (mine) return { page: mine.number, at: mine.at };
  // Two pages carrying the heading equally well is a running header or a topic
  // named twice, and choosing between them is a guess — the one thing this
  // file will not do, since an entry on the wrong page is worse than none.
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;
  return { page: scored[0].number, at: scored[0].at };
}

// How much of the anchor is written on a page, and where. The best run of
// consecutive words matching it, as a bag of words inside a sliding window:
// the same rule as locateAnchor in cards.js, which matches the same anchors
// against the same pages' word boxes, and for the same reason — the model
// retypes what it read and Vision split the strokes its own way, so a literal
// comparison fails on the one word either of them got wrong.
//
// `at` is where that run starts in the text, which is what tells a page's own
// heading from a section further down it.
function findAnchor(text, want) {
  const words = wordsWithPlace(text);
  const size = Math.min(want.length, words.length);
  if (!size) return { score: 0, at: -1 };
  const wanted = new Set(want);
  const hit = words.map(
    ({ w }) => wanted.has(w) || want.some((t) => t.length > 3 && w.includes(t))
  );
  let run = 0;
  for (let i = 0; i < size; i++) if (hit[i]) run++;
  let best = { score: run, start: 0 };
  for (let i = size; i < words.length; i++) {
    if (hit[i]) run++;
    if (hit[i - size]) run--;
    if (run > best.score) best = { score: run, start: i - size + 1 };
  }
  return { score: best.score, at: words[best.start].at };
}

// bareTokens' words, each with the offset it was written at. Same splitting, so
// the two cannot disagree about what a word is.
function wordsWithPlace(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/[\p{L}\p{N}]+/gu)) {
    const [w] = bareTokens(m[0]);
    if (w) out.push({ w, at: m.index });
  }
  return out;
}

// One index, one way of writing. A notebook's headings are not consistent with
// each other — this one shouts CONTENEDORES VS. MÁQUINAS VIRTUALES and the next
// Capitalises Every Important Word — and a title copied off the page carries
// that into a list where the entries sit one under another and the difference
// is all you see. The prompt asks for ordinary sentence writing; this is the
// same check the page numbers get, for the headings that arrive shouting
// anyway.
//
// Which words keep their capitals is not a judgement to make in the abstract:
// the page already made it. RAID is written RAID in the middle of a line about
// striping, IPv4 is written IPv4, and "contenedores" is written in lower case
// everywhere the writer was not shouting — so the page's own spelling of a word
// is the answer, and a word the page never writes ordinarily is simply lowered.
export function sentenceCase(title, text) {
  if (!needsCasing(title)) return title;
  const spelling = ordinarySpellings(text);
  const out = title.replace(/[\p{L}\p{N}]+/gu, (w) => spelling.get(foldText(w)) || w.toLowerCase());
  return out.replace(/\p{L}/u, (c) => c.toUpperCase());
}

// A title is left alone unless it is shouting (letters, none of them lower
// case) or Title Cased (most of its words capitalised, which needs enough words
// to be a pattern rather than a pair of proper nouns).
function needsCasing(title) {
  if (!/\p{Lu}/u.test(title)) return false;
  if (!/\p{Ll}/u.test(title)) return true;
  const words = title.match(/[\p{L}\p{N}]+/gu) || [];
  if (words.length < 3) return false;
  const capped = words.filter((w) => /^\p{Lu}/u.test(w)).length;
  return capped / words.length >= 0.6;
}

// How the page writes each word in ordinary writing. A line that is itself a
// heading says nothing about that — the same test that decides a title needs
// fixing decides a line is not evidence, which is the point: a page whose
// headings shout would otherwise teach that all its words are shouted. Within
// the lines that remain, a word seen in lower case anywhere is an ordinary word
// and that spelling wins; only a word never written in lower case — RAID, CPU,
// Docker — keeps its capitals.
function ordinarySpellings(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (needsCasing(line)) continue;
    for (const w of line.match(/[\p{L}\p{N}]+/gu) || []) {
      const key = foldText(w);
      const seen = out.get(key);
      if (seen === undefined || (/^\p{Lu}/u.test(seen) && !/^\p{Lu}/u.test(w))) out.set(key, w);
    }
  }
  return out;
}

export async function tocForPages(batch, sofar, { signal, model } = {}) {
  const allowed = new Set(batch.map((p) => p.number));
  const found = parseToc(
    await complete(buildTocPrompt(batch, sofar), { signal, model }),
    allowed
  );
  return placeEntries(found, batch);
}
