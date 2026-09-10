import { describe, it, expect } from 'vitest';
import { guidedPlan, stepTransform, stepAt } from '../src/guided.js';

// A handwritten line: `n` words of 120px on a 55px-tall row, 40px apart.
function line(n, y, x0 = 100) {
  return Array.from({ length: n }, (_, i) => ({
    t: `w${i}`,
    x: x0 + i * 160,
    y,
    w: 120,
    h: 55,
  }));
}

// A page of `lines` rows of ten words each: ink 1700px wide on a 2000px scan.
function pageOf(lines, perLine = 10) {
  const words = [];
  for (let i = 0; i < lines; i++) words.push(...line(perLine, 100 + i * 90));
  return { width: 2000, height: 2800, words };
}

// A phone held sideways, in immersive mode — the case this exists for.
const stage = { w: 844, h: 390 };

describe('guidedPlan', () => {
  it('has nothing to walk without word boxes', () => {
    expect(guidedPlan({ words: [] }, stage)).toBe(null);
    expect(guidedPlan({}, stage)).toBe(null);
    expect(guidedPlan(pageOf(3), { w: 0, h: 0 })).toBe(null);
  });

  it('magnifies to the ink, not to the page', () => {
    const { scale } = guidedPlan(pageOf(5), stage);
    // A 55px line asked to stand 40px tall on screen.
    expect(scale).toBeCloseTo(40 / 55, 5);
    // …which is well past what fitting the whole page across would give.
    expect(scale).toBeGreaterThan(stage.w / 2000);
  });

  it('cuts a line that cannot be shown at once, and only then', () => {
    const plan = guidedPlan(pageOf(4), stage);
    // The window holds 1160px of page; the line's ink runs 1700.
    expect(plan.win).toBeCloseTo(844 / (40 / 55), 3);
    const perLine = plan.steps.filter((s) => s.line === 0).length;
    expect(perLine).toBe(2);
    expect(plan.steps).toHaveLength(8);

    const short = guidedPlan(pageOf(2, 3), stage);
    expect(short.steps).toHaveLength(2);
    expect(short.steps.every((s) => s.parts === 1)).toBe(true);
  });

  it('never opens a step in the middle of a word', () => {
    const page = pageOf(3);
    const plan = guidedPlan(page, stage);
    const lefts = new Set(page.words.map((w) => w.x));
    for (const step of plan.steps.filter((s) => s.part > 0)) {
      expect(lefts.has(step.ink.x)).toBe(true);
      // …and the window opens a margin before it, so the first letter can't
      // be shaved by the edge of the screen.
      expect(step.ink.x - step.x).toBeCloseTo(step.h * 0.4, 6);
    }
  });

  it('walks the page in reading order', () => {
    const plan = guidedPlan(pageOf(6), stage);
    for (let i = 1; i < plan.steps.length; i++) {
      const prev = plan.steps[i - 1];
      const step = plan.steps[i];
      expect(step.y > prev.y || (step.y === prev.y && step.x > prev.x)).toBe(true);
    }
  });

  it('marks only the words of its own piece', () => {
    const plan = guidedPlan(pageOf(2), stage);
    const first = plan.steps[0];
    const second = plan.steps[1];
    // The window overlaps the next piece; the band must not.
    expect(first.ink.x + first.ink.w).toBeLessThanOrEqual(second.ink.x);
    expect(first.x + first.w).toBeGreaterThan(second.ink.x);
  });

  it('shows every word of every line across the pieces of it', () => {
    const page = pageOf(4);
    const plan = guidedPlan(page, stage);
    for (const w of page.words) {
      const seen = plan.steps.some(
        (s) => w.x >= s.x && w.x + w.w <= s.x + s.w && w.y >= s.y - 1 && w.y <= s.y + s.h + 1
      );
      expect(seen, `${w.t} at ${w.x},${w.y}`).toBe(true);
    }
  });

  it('centres a line narrower than the window', () => {
    const plan = guidedPlan(pageOf(1, 2), stage);
    const [step] = plan.steps;
    const inkMid = 100 + (160 + 120) / 2; // first word's x .. second word's right
    expect(step.x + step.w / 2).toBeCloseTo(inkMid, 3);
    expect(step.ink).toEqual({ x: 100, w: 280 });
  });
});

describe('stepTransform', () => {
  it('puts the step at the left edge and the line above centre', () => {
    const plan = guidedPlan(pageOf(3), stage);
    const step = plan.steps[2];
    const { scale, tx, ty } = stepTransform(step, plan.scale, stage);
    expect(step.x * scale + tx).toBeCloseTo(0, 6);
    const lineMid = (step.y + step.h / 2) * scale + ty;
    expect(lineMid).toBeCloseTo(stage.h * 0.42, 6);
    expect(lineMid).toBeLessThan(stage.h / 2);
  });
});

describe('stepAt', () => {
  it('picks up from where the page was left', () => {
    const plan = guidedPlan(pageOf(8), stage);
    const target = plan.steps[9];
    const point = { x: target.ink.x, y: target.y + target.h / 2 };
    expect(stepAt(plan, point)).toBe(9);
  });

  it('chooses the line first and the piece of it second', () => {
    const plan = guidedPlan(pageOf(8), stage);
    // The right-hand end of the fourth line.
    const step = plan.steps[stepAt(plan, { x: 1600, y: 100 + 3 * 90 + 27 })];
    expect(step.line).toBe(3);
    expect(step.part).toBe(1);
  });

  it('survives the plan being rebuilt for a narrower screen', () => {
    const page = pageOf(8);
    const wide = guidedPlan(page, stage);
    const at = wide.steps[6];
    const tall = guidedPlan(page, { w: 390, h: 844 });
    const moved = tall.steps[stepAt(tall, { x: at.ink.x, y: at.y + at.h / 2 })];
    expect(moved.line).toBe(at.line);
    // The pieces are cut differently, but the reader is still on that line at
    // the word they had got to.
    expect(Math.abs(moved.ink.x - at.ink.x)).toBeLessThan(tall.win);
  });

  it('gives up magnification rather than cut the page into four', () => {
    const tall = guidedPlan(pageOf(4), { w: 390, h: 844 });
    expect(Math.max(...tall.steps.map((s) => s.parts))).toBeLessThanOrEqual(2);
    expect(tall.scale).toBeLessThan(40 / 55);
    // Landscape is wide enough to keep the size it asked for.
    expect(guidedPlan(pageOf(4), stage).scale).toBeCloseTo(40 / 55, 5);
  });

  it('is not dragged down by one line running into the margin', () => {
    const page = pageOf(8);
    page.words.push(...line(14, 100 + 8 * 90)); // a ninth line, far longer
    const plan = guidedPlan(page, { w: 390, h: 844 });
    const long = plan.steps.filter((s) => s.line === 8);
    expect(long.length).toBeGreaterThan(2); // the outlier pays for itself
    expect(plan.steps.filter((s) => s.line === 0)).toHaveLength(2); // the rest don't
  });
});


// A table like the one this was written for: a narrow column of levels, a
// wide description, and a right-hand column — with one description running to
// two lines, which is the case that breaks the naive answer.
function cellWords(text, x, y, wordW = 150) {
  return text.split(' ').map((t, i) => ({ t, x: x + i * (wordW + 20), y, w: wordW, h: 40 }));
}

function tablePage() {
  const words = [];
  const rows = [
    ['0', ['Solo franjas'], 'Ninguna'],
    ['1', ['Solo espejado'], 'Un disco'],
    ['3', ['Franjas muy finas mas paridad'], 'Un disco'],
    ['4', ['Franjas por bloque dedicado'], 'Un disco'],
    ['5', ['Franjas por bloque con paridad', 'distribuida entre todos discos'], 'Un disco'],
    ['6', ['Como el cinco con dos'], 'Dos discos'],
  ];
  let y = 200;
  for (const [level, body, right] of rows) {
    words.push(...cellWords(level, 60, y, 60));
    body.forEach((text, i) => words.push(...cellWords(text, 300, y + i * 70)));
    words.push(...cellWords(right, 1750, y, 140));
    y += body.length * 70 + 90; // rows are further apart than lines within one
  }
  return { width: 2400, height: 3000, words };
}

describe('a page with columns', () => {
  const page = tablePage();
  const plan = guidedPlan(page, stage);

  it('never puts two cells in one step', () => {
    const gutters = [[240, 300], [1650, 1750]]; // between the columns
    for (const s of plan.steps) {
      for (const [lo, hi] of gutters) {
        const crosses = s.ink.x < lo && s.ink.x + s.ink.w > hi;
        expect(crosses, `paso en ${s.ink.x}..${s.ink.x + s.ink.w}`).toBe(false);
      }
    }
  });

  it('reads across the row before moving down', () => {
    // The first three steps are the three cells of the first row.
    const [a, b, c] = plan.steps;
    expect(a.ink.x).toBeLessThan(b.ink.x);
    expect(b.ink.x).toBeLessThan(c.ink.x);
    expect(a.y).toBe(b.y);
    expect(b.y).toBe(c.y);
  });

  it('keeps a two-line cell whole, and reads it before the cell beside it', () => {
    // The row for level 5: its two lines must follow each other, with the
    // right-hand cell after both — not between them.
    const five = plan.steps.findIndex((s) => s.ink.x < 240 && s.y > 700);
    const after = plan.steps.slice(five + 1, five + 4);
    expect(after[0].ink.x).toBeGreaterThan(240); // the description's first line
    expect(after[1].ink.x).toBeGreaterThan(240); // …and its second
    expect(after[1].y).toBeGreaterThan(after[0].y);
    expect(after[2].ink.x).toBeGreaterThan(1650); // then the right-hand cell
  });

  it('is magnified by the widest cell, not by the widest row', () => {
    const asLines = guidedPlan({ ...page, words: page.words.map((w) => ({ ...w })) }, stage);
    expect(plan.scale).toBe(asLines.scale); // same page, same plan
    // A cell line is far shorter than the row it sits in, so the cap on
    // pieces per line binds much later.
    const rowWide = 1750 + 140 * 2 - 60;
    expect(plan.win).toBeLessThan(rowWide);
    expect(plan.scale).toBeGreaterThan((stage.w * 2) / rowWide);
  });

  it('leaves an ordinary page alone, margin scribbles included', () => {
    const prose = pageOf(6);
    prose.words.push({ t: '12/4', x: 20, y: 100, w: 60, h: 55 }); // a date in the margin
    prose.words.push({ t: 'ojo', x: 20, y: 280, w: 60, h: 55 });
    const p = guidedPlan(prose, stage);
    // Two words in the margin are not a column: the page still reads in lines.
    expect(p.steps.filter((s) => s.line === 0)).toHaveLength(2);
    expect(p.steps[0].ink.x).toBeLessThan(120);
  });
});


// Bands separated far enough to be rows, each with a word missing from the
// middle. Whether the holes line up is the whole question: a column runs down
// the page, a gap where a line happened to end does not.
function holedPage(skipAt) {
  const words = [];
  for (let band = 0; band < 5; band++) {
    const top = 200 + band * 400; // far apart: each is a row of its own
    const skip = skipAt(band);
    // Two lines to a row, close together, so the page has both kinds of gap
    // for the rule to tell apart. Evenly spaced lines come out as one band by
    // construction — which is what keeps prose safe, and why this fixture
    // needs a shape of its own.
    for (const y of [top, top + 85]) {
      for (let i = 0; i < 9; i++) {
        if (i === skip) continue;
        words.push({ t: `b${band}w${i}`, x: 100 + i * 160, y, w: 120, h: 55 });
      }
    }
  }
  return { width: 2400, height: 3000, words };
}

describe('one hole is not a column', () => {
  // Cells and pieces both make steps; what tells them apart is that two cells
  // are two rows, while two pieces of one line share theirs.
  const rowsIn = (plan) => new Set(plan.steps.map((s) => s.line)).size;
  const LINES = 10; // five rows of two lines

  it('splits when the holes line up down the page', () => {
    const plan = guidedPlan(holedPage(() => 4), stage);
    expect(rowsIn(plan)).toBe(LINES * 2); // every line cut in two cells
    const first = plan.steps.filter((s) => Math.round(s.y) === 200 && s.part === 0);
    expect(first.map((s) => s.ink.x)).toEqual([100, 100 + 5 * 160]);
  });

  it('leaves the page alone when they do not', () => {
    // Every row has a hole, each somewhere else: five accidents, not a column.
    const plan = guidedPlan(holedPage((b) => [1, 4, 7, 2, 5][b]), stage);
    expect(rowsIn(plan)).toBe(LINES);
  });

  it('wants more than two rows to believe in a column', () => {
    const plan = guidedPlan(holedPage((b) => (b < 2 ? 4 : [1, 7, 2][b - 2])), stage);
    expect(rowsIn(plan)).toBe(LINES);
  });
});
