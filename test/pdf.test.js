// A hand-rolled binary format again, so the tests read the file back rather
// than trusting it: byte offsets in the xref table have to be exact or the
// document won't open, and the JPEG has to survive verbatim.
import { describe, it, expect } from 'vitest';
import { buildPdf } from '../src/pdf.js';

// Not a real image — nothing here decodes it — but a distinctive byte run
// that must come out of the file unchanged.
const fakeJpeg = (seed = 1) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, seed, 0x10, 0x20, 0x30, 0xff, 0xd9]);

const page = (over = {}) => ({
  jpeg: fakeJpeg(),
  width: 1200,
  height: 1600,
  words: [],
  text: '',
  ...over,
});

async function read(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Latin-1 round-trip: keeps binary bytes addressable as characters so the
  // structure can be matched with plain string operations.
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return { bytes, text };
}

describe('buildPdf', () => {
  it('writes a well-formed file', async () => {
    const { text } = await read(buildPdf([page()]));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages');
  });

  // If startxref or any entry is off by a byte, readers reject the document.
  it('points startxref and every entry at the real byte offsets', async () => {
    const { text } = await read(buildPdf([page(), page()]));

    const startxref = Number(text.match(/startxref\n(\d+)/)[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    const table = text.slice(startxref);
    const entries = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((offset, i) => {
      expect(text.slice(offset)).toMatch(new RegExp(`^${i + 1} 0 obj`));
    });
  });

  it('declares as many objects as it wrote', async () => {
    const { text } = await read(buildPdf([page(), page()]));
    const size = Number(text.match(/\/Size (\d+)/)[1]);
    const objectCount = [...text.matchAll(/^\d+ 0 obj$/gm)].length;
    expect(size).toBe(objectCount + 1); // +1 for the free object 0
  });

  it('one sheet per page, all A4', async () => {
    const { text } = await read(buildPdf([page(), page(), page()]));
    expect(text.match(/\/Type \/Page[^s]/g)).toHaveLength(3);
    expect(text).toContain('/Count 3');
    expect(text.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g)).toHaveLength(3);
  });

  it('embeds the JPEG verbatim, not re-encoded', async () => {
    const jpeg = fakeJpeg(0x42);
    const { bytes, text } = await read(buildPdf([page({ jpeg })]));
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain(`/Length ${jpeg.length}`);
    // Find the run of bytes and compare it back
    const at = text.indexOf(String.fromCharCode(...jpeg));
    expect(at).toBeGreaterThan(0);
    expect([...bytes.slice(at, at + jpeg.length)]).toEqual([...jpeg]);
  });

  it('scales the image to the sheet, keeping its aspect ratio', async () => {
    const { text } = await read(buildPdf([page({ width: 1000, height: 2000 })]));
    // Portrait, taller than A4's ratio: height fills the sheet, width follows.
    const [, w, h] = text.match(/q\n([\d.]+) 0 0 ([\d.]+) /);
    expect(Number(h)).toBeCloseTo(841.89, 1);
    expect(Number(w) / Number(h)).toBeCloseTo(0.5, 2);
  });

  describe('invisible text layer', () => {
    const withWords = page({
      words: [{ t: 'canción', x: 100, y: 200, w: 300, h: 40 }],
      text: 'canción',
    });

    it('marks the text invisible', async () => {
      const { text } = await read(buildPdf([withWords]));
      expect(text).toContain('3 Tr'); // render mode 3 = draw nothing
    });

    it('carries the word through', async () => {
      const { text } = await read(buildPdf([withWords]));
      expect(text).toContain('(canci\xf3n ) Tj'); // ó as WinAnsi 0xF3, trailing space
    });

    it('escapes characters that would break the string', async () => {
      const { text } = await read(
        buildPdf([page({ words: [{ t: 'a(b)c\\d', x: 0, y: 0, w: 50, h: 10 }] })])
      );
      expect(text).toContain('(a\\(b\\)c\\\\d ) Tj');
    });

    it('drops characters WinAnsi cannot represent rather than mangling them', async () => {
      const { text } = await read(
        buildPdf([page({ words: [{ t: 'a漢b', x: 0, y: 0, w: 50, h: 10 }] })])
      );
      expect(text).toContain('(ab ) Tj');
    });

    it('falls back to whole lines when a page has no word boxes', async () => {
      const { text } = await read(
        buildPdf([page({ words: [], text: 'primera línea\nsegunda línea' })])
      );
      expect(text).toContain('(primera l\xednea) Tj'); // í as WinAnsi 0xED
      expect(text).toContain('(segunda l\xednea) Tj');
    });

    it('emits no text at all for a page with neither words nor text', async () => {
      const { text } = await read(buildPdf([page()]));
      expect(text).not.toContain(' Tj');
    });

    it('skips word boxes with no size', async () => {
      const { text } = await read(
        buildPdf([page({ words: [{ t: 'x', x: 0, y: 0, w: 0, h: 0 }] })])
      );
      expect(text).not.toContain(' Tj');
    });
  });

  it('handles an empty selection', async () => {
    const { text } = await read(buildPdf([]));
    expect(text).toContain('/Count 0');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('is a pdf blob', () => {
    expect(buildPdf([page()]).type).toBe('application/pdf');
  });
});
