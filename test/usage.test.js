// The quota counters. Two things can go quietly wrong here and both cost
// money: the arithmetic that turns tokens into dollars, and the merge that
// adds devices together — a merge that overwrites instead of summing erases
// consumption that already happened.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDeviceId,
  thisMonth,
  getOwnOcr,
  bumpOcr,
  getOwnSpend,
  recordSpend,
  clearOwnSpend,
  resetOwnUsage,
  getTotals,
  ownContribution,
  applySharedUsage,
  withOwnContribution,
  thisMonth,
} from '../src/usage.js';

beforeEach(() => {
  localStorage.clear();
});

describe('device identity', () => {
  it('is stable once assigned', () => {
    const id = getDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getDeviceId()).toBe(id);
  });
});

describe('this device on its own', () => {
  it('counts transcribed pages', () => {
    expect(getOwnOcr().count).toBe(0);
    bumpOcr();
    bumpOcr();
    expect(getOwnOcr().count).toBe(2);
  });

  it('prices input, cached input and output at their different rates', () => {
    // 1M uncached input ($1) + 1M cached ($0.10) + 1M output ($6)
    recordSpend({
      prompt_tokens: 2_000_000,
      prompt_tokens_details: { cached_tokens: 1_000_000 },
      completion_tokens: 1_000_000,
    });
    const t = getTotals();
    expect(t.input).toBe(1_000_000);
    expect(t.cachedInput).toBe(1_000_000);
    expect(t.dollars).toBeCloseTo(7.1, 6);
  });

  it('accumulates across messages', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 100 };
    recordSpend(usage);
    recordSpend(usage);
    expect(getOwnSpend().messages).toBe(2);
    expect(getOwnSpend().input).toBe(2000);
  });

  // A cached count larger than the prompt would push input negative and
  // quietly refund money that was spent.
  it('never lets a malformed usage report go below zero', () => {
    recordSpend({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 999 },
      completion_tokens: 0,
    });
    expect(getOwnSpend().input).toBe(0);
  });

  it('ignores a reply that reported no usage', () => {
    expect(recordSpend(null)).toBe(false);
    expect(getOwnSpend().messages).toBe(0);
  });

  it('starts the page count over when the stored month is not this one', () => {
    bumpOcr();
    const ocr = JSON.parse(localStorage.getItem('notebook.usage'));
    localStorage.setItem('notebook.usage', JSON.stringify({ ...ocr, month: '2020-01' }));
    expect(getOwnOcr().count).toBe(0);
  });

  // The bill this one counts against is topped up, not renewed. A tally that
  // went back to zero on the 1st reported "the chat hasn't been used" over
  // money that was still owed.
  it('carries the chat total across the turn of the month', () => {
    recordSpend({ prompt_tokens: 5000, completion_tokens: 500 });
    const spend = JSON.parse(localStorage.getItem('notebook.chatSpend'));
    localStorage.setItem('notebook.chatSpend', JSON.stringify({ ...spend, since: 0 }));
    expect(getOwnSpend().messages).toBe(1);
    expect(getOwnSpend().input).toBe(5000);
  });

  // What the monthly tally left behind: figures with a month and no start.
  it('dates a record from before the change by the month it was counted in', () => {
    localStorage.setItem(
      'notebook.chatSpend',
      JSON.stringify({ month: '2026-08', input: 900, cachedInput: 0, output: 100, messages: 3 })
    );
    expect(getOwnSpend().messages).toBe(3);
    expect(getOwnSpend().since).toBe(new Date(2026, 7, 1).getTime());
  });

  it('dates the chat figures from the first message, not from the 1st', () => {
    expect(getTotals().since).toBe(0);
    recordSpend({ prompt_tokens: 10, completion_tokens: 1 });
    expect(getTotals().since).toBeGreaterThan(0);
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('notebook.usage', 'not json');
    localStorage.setItem('notebook.chatSpend', '{{{');
    expect(getTotals().ocr).toBe(0);
    expect(getTotals().dollars).toBe(0);
  });
});

describe('adding devices together', () => {
  const otherDevice = (over = {}) => ({
    month: thisMonth(),
    ocr: 100,
    input: 1000,
    cachedInput: 2000,
    output: 300,
    messages: 5,
    at: Date.now(),
    ...over,
  });

  it('shows this device plus the others', () => {
    bumpOcr();
    recordSpend({ prompt_tokens: 500, completion_tokens: 50 });
    applySharedUsage({ devices: { 'other-1': otherDevice() } });

    const t = getTotals();
    expect(t.ocr).toBe(1 + 100);
    expect(t.messages).toBe(1 + 5);
    expect(t.input).toBe(500 + 1000);
    expect(t.otherDevices).toBe(1);
  });

  it('adds up several other devices', () => {
    applySharedUsage({
      devices: { a: otherDevice({ ocr: 10 }), b: otherDevice({ ocr: 25 }) },
    });
    expect(getTotals().ocr).toBe(35);
    expect(getTotals().otherDevices).toBe(2);
  });

  // The whole point of the per-device map: this device must not count its own
  // contribution twice when it reads back the file it just wrote.
  it('does not double-count its own entry', () => {
    bumpOcr();
    bumpOcr();
    const shared = withOwnContribution(null);
    applySharedUsage(shared);
    expect(getTotals().ocr).toBe(2);
    expect(getTotals().otherDevices).toBe(0);
  });

  // The halves of an entry expire differently: the free tier renews on the
  // 1st, the OpenAI balance does not.
  it("ignores last month's pages but still counts last month's spend", () => {
    applySharedUsage({
      devices: {
        stale: otherDevice({ month: '2020-01', ocr: 999, messages: 4 }),
        live: otherDevice({ ocr: 7, messages: 1 }),
      },
    });
    expect(getTotals().ocr).toBe(7);
    expect(getTotals().messages).toBe(5);
    expect(getTotals().otherDevices).toBe(2);
  });

  it('copes with a missing or malformed shared file', () => {
    expect(() => applySharedUsage(null)).not.toThrow();
    expect(() => applySharedUsage({})).not.toThrow();
    expect(() => applySharedUsage({ devices: { x: null } })).not.toThrow();
    expect(getTotals().otherDevices).toBe(0);
  });
});

describe('what this device writes to the shared file', () => {
  it('reports its own figures under its own id', () => {
    bumpOcr();
    recordSpend({ prompt_tokens: 800, completion_tokens: 60 });
    const shared = withOwnContribution({ devices: { other: { month: thisMonth(), ocr: 3 } } });

    expect(shared.devices[getDeviceId()]).toMatchObject({ ocr: 1, messages: 1, input: 800 });
    expect(shared.version).toBe(1);
  });

  // Every other device's entry has to survive: writing only our own would be
  // the overwrite this design exists to avoid.
  it('leaves the other devices alone', () => {
    const shared = withOwnContribution({
      devices: { other: { month: thisMonth(), ocr: 42, input: 9 } },
    });
    expect(shared.devices.other).toEqual({ month: thisMonth(), ocr: 42, input: 9 });
  });

  it('drops devices that went quiet so the file cannot grow forever', () => {
    const shared = withOwnContribution({
      devices: {
        dormant: { month: '2020-01', ocr: 1 },
        live: { month: thisMonth(), ocr: 2 },
      },
    });
    expect(shared.devices.dormant).toBeUndefined();
    expect(shared.devices.live).toBeDefined();
  });

  // Pruning by the month would throw away a device's running chat total on the
  // 1st, which is the one thing that total exists to survive.
  it('keeps a device that reported recently even from another month', () => {
    const shared = withOwnContribution({
      devices: { away: { month: '2020-01', ocr: 1, messages: 8, at: Date.now() - 86_400_000 } },
    });
    expect(shared.devices.away).toBeDefined();
  });

  it('starts a file from nothing', () => {
    const shared = withOwnContribution(null);
    expect(Object.keys(shared.devices)).toEqual([getDeviceId()]);
  });

  it('round-trips: write, read back, and the total is unchanged', () => {
    bumpOcr();
    bumpOcr();
    bumpOcr();
    const before = getTotals().ocr;
    applySharedUsage(withOwnContribution(null));
    expect(getTotals().ocr).toBe(before);
  });
});

// Starting the total over on one device has to reach the others: it is one
// balance, and a device that kept counting would report a bill already paid.
describe('starting the chat total over', () => {
  const otherDevice = (over = {}) => ({
    month: thisMonth(),
    ocr: 0,
    input: 1000,
    cachedInput: 0,
    output: 100,
    messages: 5,
    at: Date.now(),
    ...over,
  });

  it('zeroes the chat figures and leaves the pages alone', () => {
    bumpOcr();
    recordSpend({ prompt_tokens: 5000, completion_tokens: 500 });
    applySharedUsage({ devices: { other: otherDevice() } });
    clearOwnSpend();
    expect(getTotals().messages).toBe(0);
    expect(getTotals().dollars).toBe(0);
    expect(getTotals().ocr).toBe(1);
  });

  it('carries the stamp into the shared file', () => {
    const at = clearOwnSpend();
    expect(withOwnContribution(null).spendResetAt).toBe(at);
  });

  it('takes on a reset made on another device', () => {
    recordSpend({ prompt_tokens: 5000, completion_tokens: 500 });
    const at = Date.now();
    applySharedUsage({ spendResetAt: at, devices: {} });
    expect(getOwnSpend().messages).toBe(0);
    expect(getOwnSpend().since).toBe(at);
  });

  it('stops counting entries written before the reset', () => {
    const at = Date.now();
    applySharedUsage({
      spendResetAt: at,
      devices: {
        settled: otherDevice({ at: at - 1000, messages: 9 }),
        fresh: otherDevice({ at: at + 1000, messages: 2 }),
      },
    });
    expect(getTotals().messages).toBe(2);
  });

  // The order that matters: adopting the reset after building the entry would
  // upload the settled figures under a fresh timestamp, and every other device
  // would count them all over again.
  it('zeroes this device before writing its entry', () => {
    recordSpend({ prompt_tokens: 5000, completion_tokens: 500 });
    const shared = withOwnContribution({ spendResetAt: Date.now(), devices: {} });
    expect(shared.devices[getDeviceId()].messages).toBe(0);
  });
});

describe('resetOwnUsage', () => {
  it('clears this device and its memory of the others', () => {
    bumpOcr();
    applySharedUsage({ devices: { other: { month: thisMonth(), ocr: 50 } } });
    expect(getTotals().ocr).toBe(51);
    resetOwnUsage();
    expect(getTotals().ocr).toBe(0);
    expect(getTotals().otherDevices).toBe(0);
  });
});

describe('ownContribution', () => {
  it('carries the month, so a stale entry can be spotted', () => {
    expect(ownContribution().month).toBe(thisMonth());
  });

  it('carries when its chat figures started, so they can be dated', () => {
    recordSpend({ prompt_tokens: 10, completion_tokens: 1 });
    expect(ownContribution().since).toBe(getOwnSpend().since);
  });
});

// The counters are scoped to a month, so where that month begins decides when
// a hundred pages of transcription appear to vanish.
describe('when the month turns over', () => {
  it('follows the reader\'s calendar, not UTC\'s', () => {
    // 21:42 on the last day of August, three hours west of UTC — where it is
    // already September the first. The counters say August and must keep
    // saying it for another three hours.
    const late = Date.parse('2026-08-31T21:42:00-03:00');
    const d = new Date(late);
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    expect(thisMonth(late)).toBe(local);
    // And the trap it fell into: UTC has already moved on.
    if (d.getTimezoneOffset() > 0) {
      expect(thisMonth(late)).not.toBe(new Date(late).toISOString().slice(0, 7));
    }
  });

  it('does turn over when the reader\'s own month does', () => {
    const before = Date.parse('2026-08-31T12:00:00Z');
    const after = Date.parse('2026-09-01T12:00:00Z');
    expect(thisMonth(before)).not.toBe(thisMonth(after));
  });
});
