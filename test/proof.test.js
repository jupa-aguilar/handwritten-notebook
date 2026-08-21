// The proofreader edits the user's transcription in place, so a bug here
// doesn't just fail to help — it damages the thing it was asked to improve.
import { describe, it, expect } from 'vitest';
import {
  buildProofPrompt,
  parseCorrections,
  locateCorrection,
  wordsForCorrection,
  boxForCorrection,
  applyCorrection,
  pagesToProof,
  MIN_TEXT_CHARS,
} from '../src/proof.js';

// A line of words laid out left to right; two lines, 60px apart.
function line(text, y, x0 = 0) {
  let x = x0;
  return text.split(' ').map((t) => {
    const w = { t, x, y, w: t.length * 14, h: 40 };
    x += w.w + 12;
    return w;
  });
}

const page = {
  order: 3,
  ocrStatus: 'done',
  text: 'La rebolución industrial empezó en Inglaterra\nel vapor movió las fábricas',
  words: [
    ...line('La rebolución industrial empezó en Inglaterra', 100),
    ...line('el vapor movió las fábricas', 160),
  ],
};

const fix = {
  before: 'rebolución',
  after: 'revolución',
  context: 'La rebolución industrial empezó en Inglaterra',
  why: 'no es palabra',
};

describe('buildProofPrompt', () => {
  it('numbers the page the way the reader sees it, and sends its text', () => {
    const [system, user] = buildProofPrompt(page);
    expect(user.content).toContain('Page 4');
    expect(user.content).toContain('rebolución');
    // The instruction that keeps it from "improving" the user's own writing.
    expect(system.content).toMatch(/never correct the writer's grammar/i);
  });
});

describe('parseCorrections', () => {
  it('digs the JSON out of a fenced, chatty reply', () => {
    const raw = 'Aquí van:\n```json\n{"fixes":[{"before":"rebolución","after":"revolución","context":"La rebolución","why":"no es palabra"}]}\n```';
    expect(parseCorrections(raw)).toEqual([
      { before: 'rebolución', after: 'revolución', context: 'La rebolución', why: 'no es palabra' },
    ]);
  });

  it('drops a fix that changes nothing', () => {
    expect(parseCorrections('{"fixes":[{"before":"vapor","after":"vapor"}]}')).toEqual([]);
  });

  it('drops the same fix proposed twice', () => {
    const raw = '{"fixes":[{"before":"a","after":"b"},{"before":"a","after":"b"}]}';
    expect(parseCorrections(raw)).toHaveLength(1);
  });

  it('returns nothing rather than throwing on junk', () => {
    expect(parseCorrections('no encontré errores')).toEqual([]);
    expect(parseCorrections('')).toEqual([]);
  });
});

describe('locateCorrection', () => {
  it('finds the fix in the page text', () => {
    const at = locateCorrection(page, fix);
    expect(page.text.slice(at.index, at.index + at.length)).toBe('rebolución');
  });

  it('ignores accents and case, like every other match in the app', () => {
    const at = locateCorrection(page, { before: 'FABRICAS', context: '' });
    expect(page.text.slice(at.index, at.index + at.length)).toBe('fábricas');
  });

  // Applying a fix to the wrong occurrence would introduce an error the user
  // never had, so an ambiguous one is refused outright.
  it('refuses a word that appears twice with no context to tell them apart', () => {
    const twice = { ...page, text: 'el vapor y el vapor', words: [] };
    expect(locateCorrection(twice, { before: 'vapor', after: 'vapour' })).toBeNull();
  });

  it('uses the context line to pick the right occurrence', () => {
    const twice = {
      ...page,
      text: 'el vapor movió las fábricas\nel vapor era caro',
      words: [],
    };
    const at = locateCorrection(twice, { before: 'vapor', after: 'vapour', context: 'el vapor era caro' });
    expect(at.index).toBe(twice.text.indexOf('vapor', 20));
  });

  it('has nothing to say when the word is not there at all', () => {
    expect(locateCorrection(page, { before: 'ferrocarril', after: 'x' })).toBeNull();
  });
});

describe('the ink behind the fix', () => {
  it('finds the word boxes the error was written in', () => {
    expect(wordsForCorrection(page, fix).map((i) => page.words[i].t)).toEqual(['rebolución']);
  });

  it('matches a word Vision left a comma stuck to', () => {
    const withComma = { ...page, words: [{ t: 'rebolución,', x: 0, y: 100, w: 100, h: 40 }] };
    expect(wordsForCorrection(withComma, fix)).toEqual([0]);
  });

  // A word on its own is not enough to judge a misreading: you need the line.
  it('boxes the whole line the error sits on', () => {
    const box = boxForCorrection(page, fix);
    const firstLine = page.words.filter((w) => w.y === 100);
    expect(box.x).toBe(Math.min(...firstLine.map((w) => w.x)));
    expect(box.x + box.w).toBe(Math.max(...firstLine.map((w) => w.x + w.w)));
    expect(box.h).toBe(40); // one line, not both
  });

  it('has no box for a page transcribed without word positions', () => {
    expect(boxForCorrection({ ...page, words: [] }, fix)).toBeNull();
  });
});

describe('applyCorrection', () => {
  it('fixes the text and the word box together', () => {
    const { text, words } = applyCorrection(page, fix);
    expect(text).toContain('La revolución industrial');
    expect(words.find((w) => w.t === 'revolución')).toBeTruthy();
    expect(words.find((w) => w.t === 'rebolución')).toBeUndefined();
  });

  it('leaves the page it was given untouched', () => {
    applyCorrection(page, fix);
    expect(page.text).toContain('rebolución');
    expect(page.words.some((w) => w.t === 'rebolución')).toBe(true);
  });

  it('keeps the geometry of every other word', () => {
    const { words } = applyCorrection(page, fix);
    for (const [i, w] of words.entries()) {
      expect([w.x, w.y, w.w, w.h]).toEqual([
        page.words[i].x,
        page.words[i].y,
        page.words[i].w,
        page.words[i].h,
      ]);
    }
  });

  // Splitting or joining words has no honest mapping onto boxes measured in
  // ink, so the text is fixed and the boxes are left alone.
  it('fixes the text only when the fix splits a word in two', () => {
    const split = { before: 'lasfábricas', after: 'las fábricas' };
    const joined = {
      ...page,
      text: 'el vapor movió lasfábricas',
      words: line('el vapor movió lasfábricas', 100),
    };
    const out = applyCorrection(joined, split);
    expect(out.text).toBe('el vapor movió las fábricas');
    expect(out.words).toEqual(joined.words);
  });

  it('refuses to place a fix it cannot find', () => {
    expect(applyCorrection(page, { before: 'ferrocarril', after: 'x' })).toBeNull();
  });
});

describe('pagesToProof', () => {
  it('takes transcribed pages with enough text to be worth a request', () => {
    const long = 'x'.repeat(MIN_TEXT_CHARS);
    const pages = [
      { id: 1, ocrStatus: 'done', text: long },
      { id: 2, ocrStatus: 'done', text: 'nada' },
      { id: 3, ocrStatus: 'pending', text: long },
    ];
    expect(pagesToProof(pages).map((p) => p.id)).toEqual([1]);
  });
});
