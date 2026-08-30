import { describe, it, expect } from 'vitest';
import {
  newSchedule,
  review,
  nextInterval,
  isDue,
  dueCards,
  formatInterval,
  formatDueCount,
} from '../src/srs.js';

const DAY = 24 * 60 * 60 * 1000;
const at = (card, grade) => review(card, grade, card.due);

describe('newSchedule', () => {
  it('starts a card due immediately', () => {
    const s = newSchedule(1000);
    expect(s.due).toBe(1000);
    expect(s.reps).toBe(0);
    expect(s.interval).toBe(0);
  });
});

describe('review', () => {
  it('walks the SM-2 steps on repeated success', () => {
    let c = newSchedule(0);
    c = at(c, 'good');
    expect(c.interval).toBe(1);
    c = at(c, 'good');
    expect(c.interval).toBe(6);
    c = at(c, 'good');
    expect(c.interval).toBeCloseTo(15); // 6 × 2.5
    expect(c.due).toBe(c.reviewedAt + Math.round(15 * DAY));
  });

  it('brings a forgotten card back inside the session, not tomorrow', () => {
    let c = review(newSchedule(0), 'good', 0);
    c = review(c, 'good', c.due);
    const lapsed = review(c, 'again', c.due);
    expect(lapsed.due - c.due).toBe(10 * 60 * 1000);
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.ease).toBeLessThan(c.ease);
  });

  it('never lets the ease factor fall below the floor', () => {
    let c = newSchedule(0);
    for (let i = 0; i < 20; i++) c = review(c, 'again', c.due);
    expect(c.ease).toBe(1.3);
  });

  it('never lets ease run away on easy answers', () => {
    let c = newSchedule(0);
    for (let i = 0; i < 20; i++) c = review(c, 'easy', c.due);
    expect(c.ease).toBe(2.7);
  });

  // The four buttons only mean anything as an order. Left to their own
  // formulas they crossed: on a new card Hard and Good both said one day, and
  // on the second review Easy came back sooner than Good.
  it('always offers a longer wait than the button before it', () => {
    let c = newSchedule(0);
    const states = [{ ...c }];
    for (const g of ['good', 'good', 'good', 'hard', 'again', 'good', 'easy', 'hard']) {
      c = review(c, g, c.due);
      states.push({ ...c });
    }
    for (const s of states) {
      const hard = nextInterval(s, 'hard');
      const good = nextInterval(s, 'good');
      const easy = nextInterval(s, 'easy');
      expect(nextInterval(s, 'again')).toBeLessThan(hard);
      expect(hard).toBeLessThan(good);
      expect(good).toBeLessThan(easy);
    }
  });

  it('brings a new card back within the day when it was hard', () => {
    expect(formatInterval(nextInterval(newSchedule(0), 'hard'))).toBe('12 h');
  });

  // A hard answer is still a recall: repeating the same interval would mean
  // the card never leaves the pile.
  it('grows the interval even when the answer was hard', () => {
    let c = newSchedule(0);
    c = at(c, 'good');
    c = at(c, 'good');
    const hard = at(c, 'hard');
    expect(hard.interval).toBeGreaterThan(c.interval);
    expect(hard.interval).toBeLessThan(nextInterval(c, 'good'));
  });

  it('caps the interval at two years', () => {
    let c = newSchedule(0);
    for (let i = 0; i < 40; i++) c = review(c, 'easy', c.due);
    expect(c.interval).toBe(730);
  });

  it('leaves the card it was given untouched', () => {
    const c = newSchedule(0);
    review(c, 'good', 0);
    expect(c.reps).toBe(0);
  });

  it('carries the card content through unchanged', () => {
    const c = { ...newSchedule(0), q: '¿?', a: '!', box: { x: 1 } };
    expect(review(c, 'good', 0)).toMatchObject({ q: '¿?', a: '!', box: { x: 1 } });
  });

  it('rejects a grade it does not know', () => {
    expect(() => review(newSchedule(0), 'sort-of', 0)).toThrow();
  });
});

describe('the queue', () => {
  it('counts a card due only once its date has passed', () => {
    const c = review(newSchedule(0), 'good', 0);
    expect(isDue(c, c.due - 1)).toBe(false);
    expect(isDue(c, c.due)).toBe(true);
  });

  it('leaves suspended cards out', () => {
    expect(isDue({ due: 0, suspended: true }, 1)).toBe(false);
  });

  it('takes everything due and nothing that is not', () => {
    const cards = [{ due: 300 }, { due: 100 }, { due: 200 }, { due: 9e12 }];
    const out = dueCards(cards, 1000, () => 0);
    expect(out.map((c) => c.due).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('shuffles, so a page\'s cards do not arrive in a block', () => {
    // Cards are made a page at a time and fall due together; in date order the
    // first few would tell the reader what the rest are about.
    const cards = Array.from({ length: 8 }, (_, i) => ({ id: i, due: i }));
    const orders = new Set(
      [0, 0.3, 0.6, 0.9].map((r) => dueCards(cards, 1000, () => r).map((c) => c.id).join())
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it('keeps every card exactly once however it lands', () => {
    const cards = Array.from({ length: 8 }, (_, i) => ({ id: i, due: i }));
    for (const r of [0, 0.3, 0.6, 0.9]) {
      const out = dueCards(cards, 1000, () => r);
      expect(new Set(out.map((c) => c.id)).size).toBe(8);
    }
  });
});

describe('formatting', () => {
  it('phrases an interval in the unit a person would use', () => {
    expect(formatInterval(0)).toBe('10 min');
    expect(formatInterval(1)).toBe('1 d');
    expect(formatInterval(15)).toBe('15 d');
    expect(formatInterval(30)).toBe('1 mes');
    expect(formatInterval(90)).toBe('3 meses');
    expect(formatInterval(400)).toBe('1.1 a');
  });

  it('stops the badge counting past 99', () => {
    expect(formatDueCount(7)).toBe('7');
    expect(formatDueCount(140)).toBe('99+');
  });
});
