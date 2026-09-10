// Guided reading: a page walked one piece of a line at a time.
//
// What this answers is landscape on a phone. A portrait scan fitted to an
// 844×390 stage comes out 278px wide — a third of the glass — so the reader
// zooms until the writing is legible, which is past the point where the page
// is wider than the screen, and from there every line costs a drag right and
// a drag back. The drag back is the half nobody would choose to make.
//
// So the panning is done in advance: the page is cut into the windows a
// reader would have dragged to — one per line, or one per piece of a line too
// long to stand at a readable size — and tapping walks them in reading order.
//
// The magnification is decided once per page and every step shares it: a
// window that grew or shrank from line to line would be the same fight with
// the zoom this is meant to end. Everything here is geometry over the OCR
// word boxes, with no DOM in it, which is why test/guided.test.js can hold it
// to its promises.

import { textRows } from './text.js';

// How tall a line's ink should stand on screen, in CSS pixels. This is the
// whole dial: it fixes the magnification, and through it how many pieces a
// line is cut into. 40 puts an ordinary handwritten line at about twice the
// size fitting the page's full width would give it.
const INK_PX = 40;

// …but not at the price of chopping the page's lines into more pieces than
// this. In portrait the glass is 390px wide, and holding the ink at 40px
// there would cut every line into four — a tap every five words, which is a
// worse deal than the panning this replaces. Where the two disagree the line
// wins and the writing comes out smaller than asked for.
//
// Measured against the page's long lines rather than its longest: one line
// that runs out into the margin would otherwise shrink the whole page to pay
// for itself. So a stray line still takes three taps, and the ordinary ones
// take two.
const MAX_PARTS = 2;
const LONG_LINE = 0.9; // which line counts as "long": the 90th percentile

// A step's window opens a little before its first word, so a line never
// starts flush against the edge of the glass — handwriting leans and loops
// past where a word box says it ends, and a first letter clipped by a pixel
// is read as a different letter. Measured in line heights, since that is what
// the overhang scales with. Whatever of the previous word this lets back on
// screen falls outside the band, where it reads as already read.
const LEAD = 0.4; // of a line's height

// ---------- pages that are not one column of prose ----------

// A table breaks the assumption this file is built on: that a row of pixels
// is a line of text. Read as lines, "5 | Franjas por bloque con la paridad"
// is one step — a cut across two cells, and a sentence broken where no
// sentence breaks. So the parts of a page laid out in columns are walked cell
// by cell: down the rows, left to right across each one, line by line inside
// a cell.
//
// Three measurements from the page this was written for, which is half prose
// and half table, decide the shape of all of it.

// A gap this wide is not a word space. Measured against the ink's height,
// which is what word spacing scales with — a fraction of the page's width
// came out *below* the word spacing on a page holding few words, and turned
// every word into a column of its own.
const GUTTER = 1.2; // × the height of a line's ink

// What separates a row from a second line of the same cell is how big the
// gap is — measured against the low quarter of the page's own line gaps. Not
// the median: in a table most gaps *are* row separations, so the median is
// the very thing being looked for. Not the ink either: handwriting leaves
// more air between lines than its letters are tall, and every line became a
// band of its own.
const ROW_GAP = 1.6;
const LINE_GAP = 0.25; // which gap counts as a line gap: the lower quartile

// And one hole is not a column. Handwriting is full of them — on the pages
// this was measured against, up to a tenth of the word spaces are wider than
// the gutter test: line ends, indents, the air around a worked example. A
// column is a vertical thing, so it has to run through several bands before
// it is believed. In the table it was written for, four corridors run through
// ten bands each; the widest accidental gap on a page of prose runs through
// one.
const MIN_BANDS = 3;

// And one corridor is not a grid. Measured over sixty pages that this found
// columns in: every page it read better has two corridors or more — a table
// has four, a drawn flow of boxes three — while the ones it read worse have
// exactly one, a single gap that recurs by chance. A page with one corridor
// is left as lines, which costs the odd two-column list (read as one line, no
// worse than it was) and buys back the diagram whose boxes were interleaved
// and the heading that was cut in half.
const MIN_COLUMNS = 2;

// Maximal spans of ink along one axis, split wherever the gap exceeds `gap`.
function lanes(spans, gap) {
  const sorted = [...spans].sort((a, b) => a.lo - b.lo);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.lo - last.hi <= gap) last.hi = Math.max(last.hi, s.hi);
    else out.push({ lo: s.lo, hi: s.hi });
  }
  return out;
}

// The page read as cells, or null when nothing on it is laid out in columns —
// the ordinary case, and the one the rest of this file already handles.
//
// The columns are looked for inside each band rather than down the whole
// page, which is not how this was written the first time: the heading above
// the table ("C.3 Los niveles") reaches past the first column and closes that
// gutter for every row beneath it. A title, a caption, fourteen lines of
// prose above the table — any of them would have done the same. Per band, the
// heading is just a band that happens to have one column in it.
// Rows of ink, by the rule above, over whatever words are given. `at` says
// which gap to call a line gap: the lower quartile over a whole page, where
// prose has to survive the guess, and the smallest one inside a band already
// known to have columns, where everything is a table and the smallest gap is
// the leading of a wrapped cell.
function bandsOf(words, ink, at = LINE_GAP) {
  const rows = textRows(words);
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(Math.max(0, rows[i].y0 - rows[i - 1].y1));
  gaps.sort((a, b) => a - b);
  const line = gaps.length ? gaps[Math.floor((gaps.length - 1) * at)] : ink;
  return lanes(
    words.map((w) => ({ lo: w.y, hi: w.y + w.h })),
    Math.max(line, ink * 0.5) * ROW_GAP
  );
}

// The bands, their lanes, and the corridors that recur through enough of them
// to be worth believing in. Shared by the walk below and by corridorsOf, which
// is what layout.js shows a model.
function analyse(words, ink) {
  const gutter = Math.max(ink, 1) * GUTTER;
  const within = (b) =>
    words.filter((w) => {
      const cy = w.y + w.h / 2;
      return cy >= b.lo && cy <= b.hi;
    });

  // A table whose cells rarely wrap hides its rows: nearly every gap on the
  // page is a row separation, so the quarter that is supposed to pick out a
  // line gap picks a row gap instead and the whole table comes back as one
  // band. Asking again inside a band that has columns answers it, because in
  // there the smallest gap is a cell's own leading — a measure too eager to
  // use on a page of prose, where it would cut a paragraph into a band per
  // line, and safe here.
  const bands = [];
  for (const band of bandsOf(words, ink)) {
    const ws = within(band);
    const columns = lanes(ws.map((w) => ({ lo: w.x, hi: w.x + w.w })), gutter).length > 1;
    const sub = columns ? bandsOf(ws, ink, 0) : [band];
    bands.push(...(sub.length > 1 ? sub : [band]));
  }
  // Too few bands for a corridor to prove itself in; the walk still needs the
  // bands, so this answers with no corridors rather than with nothing.
  const enough = bands.length >= MIN_BANDS;

  const inBands = bands.map(within);
  const perBand = inBands.map((ws) => lanes(ws.map((w) => ({ lo: w.x, hi: w.x + w.w })), gutter));

  // Every gap between one band's lanes is a candidate corridor; the ones that
  // overlap down the page are the same corridor seen from several rows.
  const candidates = [];
  perBand.forEach((cols, b) => {
    for (let i = 1; i < cols.length; i++) candidates.push({ lo: cols[i - 1].hi, hi: cols[i].lo, b });
  });
  candidates.sort((a, b) => a.lo - b.lo);
  const grid = [];
  for (const c of candidates) {
    const last = grid[grid.length - 1];
    if (last && c.lo < last.hi && c.hi > last.lo) {
      last.lo = Math.max(last.lo, c.lo);
      last.hi = Math.min(last.hi, c.hi);
      last.bands.add(c.b);
    } else grid.push({ lo: c.lo, hi: c.hi, bands: new Set([c.b]) });
  }
  return {
    inBands,
    perBand,
    corridors: enough ? grid.filter((g) => g.bands.size >= MIN_BANDS) : [],
  };
}

// The corridors a page has, in its own pixels, with how many rows each one
// runs through. What they *mean* is not decided here — see layout.js.
export function corridorsOf(page) {
  const lines = textRows(page?.words);
  if (!lines.length) return [];
  const heights = lines.map((r) => r.y1 - r.y0).sort((a, b) => a - b);
  const ink = heights[Math.floor(heights.length / 2)];
  if (!(ink > 0)) return [];
  return analyse(page.words, ink).corridors.map((c) => ({
    x: Math.round((c.lo + c.hi) / 2),
    width: Math.round(c.hi - c.lo),
    rows: c.bands.size,
  }));
}

// The page read as cells, or null when it is not laid out in columns.
//
// `accepted` is a judgement already made about this page's corridors (their x
// positions, from layout.js). Given one, it is obeyed exactly — including an
// empty one, which says this page has no columns and is not a question the
// geometry gets to reopen. Without one, a corridor has to be part of a grid.
function cells(words, ink, accepted) {
  const { inBands, perBand, corridors } = analyse(words, ink);
  const columns = accepted
    ? accepted.map((x) => ({ lo: x - 1, hi: x + 1 }))
    : corridors.length >= MIN_COLUMNS
      ? corridors
      : [];
  if (!columns.length) return null;

  // A band splits only where its own gap has a column running through it, so
  // a heading that reaches across one is not cut by it, and a page that is
  // prose above and a table below keeps its prose whole.
  const out = [];
  perBand.forEach((cols, b) => {
    const cuts = [];
    for (let i = 1; i < cols.length; i++) {
      const lo = cols[i - 1].hi;
      const hi = cols[i].lo;
      if (columns.some((g) => g.lo < hi && g.hi > lo)) cuts.push((lo + hi) / 2);
    }
    const edges = [-Infinity, ...cuts, Infinity];
    for (let i = 1; i < edges.length; i++) {
      const inCell = inBands[b].filter((w) => {
        const cx = w.x + w.w / 2;
        return cx > edges[i - 1] && cx <= edges[i];
      });
      if (inCell.length) out.push(...textRows(inCell));
    }
  });
  return out;
}

export function guidedPlan(page, stage, { inkPx = INK_PX } = {}) {
  const lines = textRows(page?.words);
  if (!lines.length || !(stage?.w > 0) || !(stage?.h > 0)) return null;

  // The median line, not the mean: a page's tallest "line" is regularly a
  // stray accent or a box drawn round a result, and either would shrink
  // everything else to pay for it.
  const heights = lines.map((r) => r.y1 - r.y0).sort((a, b) => a - b);
  const ink = heights[Math.floor(heights.length / 2)];
  if (!(ink > 0)) return null;

  // On a table these are the cells' own lines, in the order a table is read;
  // on every other page they are the page's lines, unchanged. A page whose
  // corridors have been judged (layout.js) carries the verdict with it.
  const judged = Array.isArray(page.layout?.columns) ? page.layout.columns : null;
  const rows = cells(page.words, ink, judged) || lines;

  const widths = rows.map((r) => r.x1 - r.x0).sort((a, b) => a - b);
  const width = widths[Math.floor((widths.length - 1) * LONG_LINE)];
  const scale = Math.min(inkPx / ink, (stage.w * MAX_PARTS) / (width || stage.w));
  const win = stage.w / scale; // how much of the page the stage holds across

  const steps = [];
  for (const [line, row] of rows.entries()) {
    const parts = pieces(row, win);
    for (const [part, words] of parts.entries()) {
      const x0 = words[0].x;
      const x1 = words[words.length - 1].x + words[words.length - 1].w;
      // A piece that is the whole line sits centred; one cut out of a longer
      // line opens at its own first word, since what matters there is that
      // the reading edge is the same on every step.
      const height = row.y1 - row.y0;
      const lead = parts.length === 1 ? (win - (x1 - x0)) / 2 : height * LEAD;
      steps.push({
        x: x0 - lead,
        y: row.y0,
        w: win,
        h: height,
        // What this step is asking to be read, as opposed to what happens to
        // fit on screen beside it: the band is drawn here and nowhere else.
        ink: { x: x0, w: x1 - x0 },
        line,
        part,
        parts: parts.length,
      });
    }
  }
  return { scale, win, steps };
}

// One line divided into the fewest pieces that will each fit the window, cut
// at the gaps between words — never through one, which is the difference
// between a step and a bad crop.
function pieces(row, win) {
  const width = row.x1 - row.x0;
  if (width <= win) return [row.words];

  const parts = Math.ceil(width / win);
  const out = [];
  let rest = row.words;
  for (let k = 1; k < parts && rest.length > 1; k++) {
    const target = row.x0 + (width * k) / parts;
    // The cut is a word's left edge — the one nearest the ideal boundary,
    // and never the first word left, so no piece comes out empty.
    let at = 1;
    for (let i = 1; i < rest.length; i++) {
      if (Math.abs(rest[i].x - target) < Math.abs(rest[at].x - target)) at = i;
    }
    out.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  out.push(rest);
  return out;
}

// The transform that puts one step on the stage: the line's own vertical
// centre placed a little above the stage's, since what has already been read
// is worth less room than what is coming. Returned rather than applied, so
// the viewer stays the only thing that touches the DOM.
export function stepTransform(step, scale, stage) {
  const cx = step.x;
  const cy = step.y + step.h / 2;
  return {
    scale,
    tx: -cx * scale,
    ty: stage.h * 0.42 - cy * scale,
  };
}

// Which step to start on when guided reading is switched on.
//
// With the whole page on screen, nothing has been chosen: the middle of a
// page you can see all of is not where you were reading, and starting there
// — which is what asking "what is nearest the centre of the view" answered —
// drops the reader into the middle of a paragraph with no way to predict it.
// So it starts at the top.
//
// Zoomed in, the part on screen *is* the choice: the reader pinched or
// double-tapped their way to it. Then it starts at the head of the line
// nearest that, never halfway along one.
export function startStep(plan, view, stage) {
  if (!plan?.steps.length) return 0;
  if (!(view?.scale > view?.fit * 1.05)) return 0;
  const at = stepAt(plan, {
    x: (stage.w / 2 - view.tx) / view.scale,
    y: (stage.h / 2 - view.ty) / view.scale,
  });
  return at - plan.steps[at].part;
}

// Which step is nearest a point on the page, so guided reading can be picked
// up where the reader already was — when it is switched on mid-page, and
// again after a rotation, where every window moves and the step that was on
// screen no longer exists.
export function stepAt(plan, point) {
  if (!plan?.steps.length || !point) return 0;
  let best = 0;
  let bestD = Infinity;
  for (const [i, s] of plan.steps.entries()) {
    // Down the page first, along it only to choose between the pieces of one
    // line — a step half a page away must never win on x.
    const d =
      Math.abs(s.y + s.h / 2 - point.y) * 1000 + Math.abs(s.ink.x + s.ink.w / 2 - point.x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
