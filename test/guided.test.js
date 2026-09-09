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
