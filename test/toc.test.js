import { describe, it, expect } from 'vitest';
import { buildTocPrompt, parseToc, batchPages } from '../src/toc.js';

const batch = [
  { number: 37, text: 'I.4 Disco: por qué cambia el hardware\nAgrandar el disco es trivial.' },
  { number: 38, text: 'J.1 Una idea distinta con el mismo nombre\nLa máquina virtual de Java…' },
];

describe('buildTocPrompt', () => {
  it('sends each page under the number the reader sees', () => {
    const [, user] = buildTocPrompt(batch);
    expect(user.content).toContain('--- Page 37 ---');
    expect(user.content).toContain('--- Page 38 ---');
    expect(user.content).toContain('Agrandar el disco es trivial.');
  });

  // Levels are decided per batch, so without the tail of what came before,
  // every batch starts a fresh hierarchy at 1 and the list reads as flat.
  it('carries what earlier batches already found, so the levels line up', () => {
    const [, user] = buildTocPrompt(batch, [
      { level: 1, title: 'I. Memoria y disco', page: 30 },
      { level: 2, title: 'I.3 Memoria', page: 34 },
    ]);
    expect(user.content).toContain('Found so far');
    expect(user.content).toContain('I. Memoria y disco (p. 30)');
    expect(user.content).toContain('I.3 Memoria (p. 34)');
  });

  it('says nothing about earlier entries on the first batch', () => {
    expect(buildTocPrompt(batch)[1].content).not.toContain('Found so far');
  });

  it('asks for a verbatim anchor, and for a name where the page has no heading', () => {
    const system = buildTocPrompt(batch)[0].content;
    expect(system).toMatch(/copied VERBATIM/);
    expect(system).toMatch(/name the section yourself/i);
    expect(system).toMatch(/handwritten notes usually do not/i);
    expect(system).toMatch(/An empty list is the right answer/i);
  });
});

describe('parseToc', () => {
  const one = '{"entries":[{"level":2,"title":"J.1 Una idea distinta","page":38,"anchor":"Una idea distinta"}]}';

  it('digs the entries out of a fenced, chatty reply', () => {
    const got = parseToc('Claro:\n```json\n' + one + '\n```');
    expect(got).toEqual([
      { level: 2, title: 'J.1 Una idea distinta', page: 38, anchor: 'Una idea distinta' },
    ]);
  });

  it('accepts a bare array too', () => {
    expect(parseToc('[{"level":1,"title":"I. Disco","page":37}]')).toEqual([
      { level: 1, title: 'I. Disco', page: 37, anchor: '' },
    ]);
  });

  it('is empty for junk, an empty list, or nothing at all', () => {
    for (const raw of ['', null, 'no encontré secciones', '{"entries":[]}']) {
      expect(parseToc(raw)).toEqual([]);
    }
  });

  it('drops an entry with no title or no usable page', () => {
    const raw = '{"entries":[{"level":1,"title":"","page":37},{"level":1,"title":"Sin página"},{"level":1,"title":"Bien","page":37}]}';
    expect(parseToc(raw).map((e) => e.title)).toEqual(['Bien']);
  });

  // A page the batch never showed is the model reading a number off the page
  // rather than answering about what it was given, and an entry that jumps to
  // the wrong page is worse than one that is missing.
  it('drops a page the batch did not cover', () => {
    const raw = '{"entries":[{"level":1,"title":"Aquí","page":37},{"level":1,"title":"Allá","page":99}]}';
    expect(parseToc(raw, new Set([37, 38])).map((e) => e.title)).toEqual(['Aquí']);
  });

  it('clamps the level into 1–3 and defaults a missing one', () => {
    const raw = '{"entries":[{"title":"a","page":1,"level":0},{"title":"b","page":1,"level":9},{"title":"c","page":1}]}';
    expect(parseToc(raw).map((e) => e.level)).toEqual([1, 3, 1]);
  });

  it('keeps one entry per title per page', () => {
    const raw = '{"entries":[{"title":"Disco","page":37},{"title":"disco","page":37},{"title":"Disco","page":38}]}';
    expect(parseToc(raw)).toHaveLength(2);
  });

  it('returns them in page order whatever order they arrived in', () => {
    const raw = '{"entries":[{"title":"b","page":38},{"title":"a","page":37}]}';
    expect(parseToc(raw).map((e) => e.page)).toEqual([37, 38]);
  });
});

describe('batchPages', () => {
  const pages = Array.from({ length: 10 }, (_, i) => ({ number: i + 1, text: 'x'.repeat(1000) }));

  it('covers every page exactly once, in order', () => {
    const seen = batchPages(pages, 3000).flat().map((p) => p.number);
    expect(seen).toEqual(pages.map((p) => p.number));
  });

  it('fills a batch up to the budget and no further', () => {
    // 1040 chars a page against 3000: two per batch, never three.
    expect(batchPages(pages, 3000).every((b) => b.length <= 2)).toBe(true);
  });

  it('never drops a page that is bigger than the whole budget on its own', () => {
    const huge = [{ number: 1, text: 'x'.repeat(50000) }, { number: 2, text: 'y' }];
    expect(batchPages(huge, 1000).flat().map((p) => p.number)).toEqual([1, 2]);
  });

  it('is empty for no pages', () => {
    expect(batchPages([], 1000)).toEqual([]);
  });
});
