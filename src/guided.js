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
// sentence breaks. So a page with columns is walked cell by cell instead:
// down the rows, left to right across each one, and line by line inside a
// cell.
//
// Columns are found as gutters no word crosses. Prose never has one — some
// line always runs through the middle of the page — which makes this test
// conservative by construction rather than by tuning.
const GUTTER = 0.035; // of the ink's width; below this it is a word space

// Rows cannot be found the same way. In the table this was written for, the
// gap between the two lines of one cell crosses the whole page, because the
// cells either side of it are empty at that height — separating rows by
// full-width gaps would split that cell in half, which is the same wrong cut
// moved somewhere else. What separates a row from a line is how big the gap
// is, not how wide.
//
// And "big" is measured against the ink, not against the page's other gaps:
// in a table most gaps *are* row separations, so their median is the thing
// being looked for and using it merged the whole page into one row. Two lines
// of one cell sit closer together than the ink is tall; two rows do not.
const ROW_GAP = 1; // × the height of a line's ink

// And a column has to be a column: a date or a marginal number sitting in the
// margin of an ordinary page would otherwise turn the whole page into a table.
const MIN_LANE_ROWS = 3;

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

// The page read as cells: rows of lines, ordered the way a table is read.
// Null when the page is one column, which is the ordinary case and the one
// the rest of this file already handles.
function cells(words, rows, ink) {
  const x0 = Math.min(...rows.map((r) => r.x0));
  const x1 = Math.max(...rows.map((r) => r.x1));
  const columns = lanes(
    words.map((w) => ({ lo: w.x, hi: w.x + w.w })),
    (x1 - x0) * GUTTER
  );
  if (columns.length < 2) return null;

  const bands = lanes(
    words.map((w) => ({ lo: w.y, hi: w.y + w.h })),
    Math.max(ink, 1) * ROW_GAP
  );

  // Each cell's own lines, in reading order: down the bands, across the
  // columns, down the lines within one cell.
  const out = [];
  for (const band of bands) {
    for (const col of columns) {
      const inside = words.filter(
        (w) =>
          w.y + w.h / 2 >= band.lo && w.y + w.h / 2 <= band.hi &&
          w.x + w.w / 2 >= col.lo && w.x + w.w / 2 <= col.hi
      );
      if (inside.length) out.push(...textRows(inside));
    }
  }
  const perLane = columns.map(
    (col) => out.filter((r) => r.x0 + (r.x1 - r.x0) / 2 >= col.lo && r.x0 + (r.x1 - r.x0) / 2 <= col.hi).length
  );
  if (Math.min(...perLane) < MIN_LANE_ROWS) return null;
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
  // on every other page they are the page's lines, unchanged.
  const rows = cells(page.words, lines, ink) || lines;

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
