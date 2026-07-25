// A hand-rolled binary format nobody reads by eye: these tests parse the
// archive back out and follow every offset, which is the only way to know the
// bytes are right short of unzipping them.
import { describe, it, expect } from 'vitest';
import { crc32, buildZip } from '../src/zip.js';

const bytes = (s) => new TextEncoder().encode(s);

// Walk the archive the way an unzip tool does: end-of-central-directory
// first, then the central directory, then each local header it points at.
async function parseZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer);
  const eocd = buf.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);

  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdStart = view.getUint32(eocd + 16, true);
  expect(cdStart + cdSize).toBe(eocd); // the directory ends where the EOCD begins

  const dec = new TextDecoder();
  const entries = [];
  let at = cdStart;
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = dec.decode(buf.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen;

    // Follow the pointer into the file data and read it back.
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    expect(view.getUint16(offset + 8, true)).toBe(0); // stored, not deflated
    expect(view.getUint16(offset + 6, true) & 0x0800).toBeTruthy(); // UTF-8 flag
    const localNameLen = view.getUint16(offset + 26, true);
    const dataAt = offset + 30 + localNameLen + view.getUint16(offset + 28, true);
    entries.push({
      name,
      crc,
      size,
      localName: dec.decode(buf.subarray(offset + 30, offset + 30 + localNameLen)),
      data: buf.subarray(dataAt, dataAt + size),
    });
  }
  expect(at).toBe(eocd);
  return entries;
}

describe('crc32', () => {
  it('matches the standard check vectors', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(bytes('a'))).toBe(0xe8b7be43);
  });

  it('stays an unsigned 32-bit value', () => {
    const c = crc32(bytes('The quick brown fox jumps over the lazy dog'));
    expect(c).toBe(0x414fa339);
    expect(c).toBeGreaterThanOrEqual(0);
  });
});

describe('buildZip', () => {
  it('round-trips every entry, byte for byte', async () => {
    const entries = [
      { name: 'first.jpg', bytes: bytes('the first payload') },
      { name: 'second.jpg', bytes: bytes('another payload entirely') },
    ];

    const parsed = await parseZip(buildZip(entries));

    expect(parsed).toHaveLength(2);
    parsed.forEach((got, i) => {
      expect(got.name).toBe(entries[i].name);
      expect(got.localName).toBe(entries[i].name);
      expect(got.size).toBe(entries[i].bytes.length);
      expect([...got.data]).toEqual([...entries[i].bytes]);
      expect(got.crc).toBe(crc32(entries[i].bytes));
    });
  });

  it('counts name lengths in UTF-8 bytes, not characters', async () => {
    // "Cuaderno de canción - p01.jpg" is longer in bytes than in chars; if the
    // header used chars, every offset after it would land mid-data.
    const entries = [
      { name: 'canción ñ.jpg', bytes: bytes('payload one') },
      { name: 'después.jpg', bytes: bytes('payload two') },
    ];

    const parsed = await parseZip(buildZip(entries));

    expect(parsed.map((e) => e.name)).toEqual(['canción ñ.jpg', 'después.jpg']);
    expect([...parsed[1].data]).toEqual([...entries[1].bytes]);
  });

  it('handles an empty payload', async () => {
    const parsed = await parseZip(buildZip([{ name: 'empty.jpg', bytes: new Uint8Array(0) }]));
    expect(parsed[0].size).toBe(0);
    expect(parsed[0].crc).toBe(0);
  });

  it('produces a valid empty archive', async () => {
    const blob = buildZip([]);
    expect(blob.size).toBe(22); // EOCD only
    expect(await parseZip(blob)).toEqual([]);
  });

  it('is a zip blob', () => {
    expect(buildZip([]).type).toBe('application/zip');
  });
});
