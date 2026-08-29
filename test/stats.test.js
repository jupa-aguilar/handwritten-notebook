import { describe, it, expect } from 'vitest';
import {
  recordAnswer,
  emptyStats,
  dayKey,
  bucket,
  series,
  summarise,
  struggle,
  worstCards,
  describeRecord,
  MIN_ATTEMPTS,
} from '../src/stats.js';

describe('recordAnswer', () => {
  it('counts the answer against the rung it was given at', () => {
    let s = recordAnswer(emptyStats(), 'good', 0);
    s = recordAnswer(s, 'good', 2);
    expect(s.answered).toEqual([1, 0, 1]);
    expect(s.missed).toEqual([0, 0, 0]);
  });

  it('treats Again as the only miss', () => {
    let s = emptyStats();
    for (const g of ['hard', 'good', 'easy']) s = recordAnswer(s, g, 0);
    s = recordAnswer(s, 'again', 0);
    expect(s.answered[0]).toBe(4);
    expect(s.missed[0]).toBe(1);
  });

  it('survives a card that has never been counted before', () => {
    expect(recordAnswer(undefined, 'good', 1).answered).toEqual([0, 1, 0]);
  });

  it('folds a rung it does not have back onto the last one', () => {
    expect(recordAnswer(emptyStats(), 'good', 9).answered).toEqual([0, 0, 1]);
  });
});

describe('dayKey', () => {
  it('names the day the reader was having, not the UTC one', () => {
    // 23:30 local on the 5th is still the 5th, whatever UTC thinks.
    const local = new Date(2026, 7, 5, 23, 30).getTime();
    expect(dayKey(local)).toBe('2026-08-05');
  });
});

describe('bucket', () => {
  const rows = [
    { day: '2026-08-05', device: 'a', answered: [1, 0, 0], missed: [0, 0, 0] },
    { day: '2026-08-05', device: 'b', answered: [0, 2, 0], missed: [0, 1, 0] },
    { day: '2026-09-01', device: 'a', answered: [0, 0, 3], missed: [0, 0, 0] },
  ];

  it('adds up the devices that reviewed on the same day', () => {
    expect(bucket(rows, 'day').get('2026-08-05').answered).toEqual([1, 2, 0]);
  });

  it('rolls days into months and months into years', () => {
    expect(bucket(rows, 'month').get('2026-08').answered).toEqual([1, 2, 0]);
    expect(bucket(rows, 'year').get('2026').answered).toEqual([1, 2, 3]);
  });
});

describe('series', () => {
  it('keeps a slot for a day nothing was reviewed', () => {
    const now = new Date(2026, 7, 10, 12).getTime();
    const out = series(
      [{ day: '2026-08-10', answered: [2, 0, 0], missed: [0, 0, 0] }],
      'day',
      3,
      now
    );
    expect(out.map((d) => d.key)).toEqual(['2026-08-08', '2026-08-09', '2026-08-10']);
    // The two quiet days are present and empty, so the chart can't close the
    // gap up and draw a run that never happened.
    expect(out[0].answered).toEqual([0, 0, 0]);
    expect(out[2].answered).toEqual([2, 0, 0]);
  });
});

describe('summarise', () => {
  it('has no accuracy to report on an empty record', () => {
    expect(summarise([]).accuracy).toBeNull();
    expect(summarise([]).unaided).toBeNull();
  });

  it('counts everything but Again as right', () => {
    const s = summarise([{ answered: [3, 1, 0], missed: [1, 0, 0] }]);
    expect(s.total).toBe(4);
    expect(s.right).toBe(3);
    expect(s.accuracy).toBeCloseTo(0.75);
    expect(s.unaided).toBeCloseTo(0.75);
  });
});

describe('struggle', () => {
  it('says nothing about a card with too few answers to judge', () => {
    const card = { stats: { answered: [MIN_ATTEMPTS - 1, 0, 0], missed: [1, 0, 0] } };
    expect(struggle(card)).toBeNull();
  });

  it('ranks needing the line as more trouble than needing nothing', () => {
    const easy = { stats: { answered: [4, 0, 0], missed: [1, 0, 0] } };
    const hard = { stats: { answered: [0, 0, 4], missed: [1, 0, 0] } };
    expect(struggle(hard).score).toBeGreaterThan(struggle(easy).score);
  });

  it('falls back to the lapses a card carried before any of this was tracked', () => {
    const old = { lapses: 4 };
    const record = struggle(old);
    expect(record.tracked).toBe(false);
    expect(record.misses).toBe(4);
    // One lapse is not a record, it is a bad morning.
    expect(struggle({ lapses: 1 })).toBeNull();
  });

  it('leaves a card nobody has struggled with out of the list entirely', () => {
    const fine = { stats: { answered: [5, 0, 0], missed: [0, 0, 0] } };
    expect(worstCards([fine, { lapses: 0 }])).toEqual([]);
  });

  it('puts the worst first', () => {
    const cards = [
      { id: 1, stats: { answered: [5, 0, 0], missed: [1, 0, 0] } },
      { id: 2, stats: { answered: [0, 1, 4], missed: [3, 0, 0] } },
    ];
    expect(worstCards(cards).map((r) => r.card.id)).toEqual([2, 1]);
  });
});

describe('describeRecord', () => {
  it('says which of the two sources it is speaking from', () => {
    expect(describeRecord(struggle({ lapses: 3 }))).toContain('before this was tracked');
    const tracked = struggle({ stats: { answered: [0, 1, 3], missed: [2, 0, 0] } });
    expect(describeRecord(tracked)).toContain('asked 4 times');
    expect(describeRecord(tracked)).toContain('never answered without help');
  });
});
