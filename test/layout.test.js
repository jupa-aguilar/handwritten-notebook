import { describe, it, expect } from 'vitest';
import { buildLayoutPrompt, parseLayout } from '../src/layout.js';
import { corridorsOf, guidedPlan } from '../src/guided.js';

// A table: five rows of three cells, the middle one wrapping to two lines.
// Two corridors, wherever the geometry puts them — the tests read that off
// the fixture rather than pinning numbers that a threshold could move.
function tablePage() {
  const words = [];
  const cols = [100, 700, 1750];
  const rows = [
    ['0', ['Solo franjas'], 'Ninguna'],
    ['1', ['Solo espejado'], 'Un disco'],
    ['3', ['Franjas muy finas', 'mas un disco'], 'Un disco'],
    ['5', ['Franjas por bloque', 'con la paridad'], 'Un disco'],
    ['6', ['Como el cinco'], 'Dos discos'],
  ];
  let y = 200;
  for (const row of rows) {
    const lines = Math.max(...row.map((c) => (Array.isArray(c) ? c.length : 1)));
    row.forEach((cell, ci) => {
      (Array.isArray(cell) ? cell : [cell]).forEach((line, li) => {
        line.split(' ').forEach((t, wi) => {
          words.push({ t, x: cols[ci] + wi * 170, y: y + li * 70, w: 150, h: 40 });
        });
      });
    });
    y += lines * 70 + 90;
  }
  return { width: 2400, height: 3000, words };
}

const page = tablePage();
const corridors = corridorsOf(page);
// Where the model would be told they are; the test asks about the same page
// it feeds in rather than about numbers copied out of one run.
const pct = corridors.map((c) => Math.round((c.x / page.width) * 100));

describe('corridorsOf', () => {
  it('finds the corridors and says how far each one runs', () => {
    expect(corridors).toHaveLength(2); // between the three cells of a row
    expect(corridors.every((c) => c.rows >= 3)).toBe(true);
    expect(pct[0]).toBeGreaterThan(5);
    expect(pct[1]).toBeGreaterThan(pct[0]);
  });

  it('finds none on a page of prose', () => {
    const words = [];
    for (let line = 0; line < 8; line++) {
      for (let i = 0; i < 9; i++) {
        words.push({ t: `w${i}`, x: 100 + i * 160, y: 100 + line * 90, w: 120, h: 55 });
      }
    }
    expect(corridorsOf({ width: 2400, height: 3000, words })).toEqual([]);
  });
});

describe('buildLayoutPrompt', () => {
  it('names the corridors by where they are, and sends the page first', () => {
    const prompt = buildLayoutPrompt(page, corridors, 'data:image/jpeg;base64,zz');
    const asked = prompt[1].content;
    expect(asked[0].type).toBe('image_url');
    expect(asked[1].text).toContain(`${pct[0]}%`);
    expect(asked[1].text).toContain(`${pct[1]}%`);
    expect(asked[1].text).toContain('rows');
  });

  it('asks in text alone when there is no image', () => {
    expect(typeof buildLayoutPrompt(page, corridors).content).toBe('undefined');
    expect(typeof buildLayoutPrompt(page, corridors)[1].content).toBe('string');
  });
});

describe('parseLayout', () => {
  const parse = (raw) => parseLayout(raw, page, corridors);

  it('maps the percentages back onto the corridors they name', () => {
    const out = parse(`{"kind":"table","columns":[${pct[0]},${pct[1]}]}`);
    expect(out.kind).toBe('table');
    expect(out.columns).toEqual(corridors.map((c) => c.x).sort((a, b) => a - b));
  });

  it('tolerates rounding, a fence and prose around the answer', () => {
    const out = parse(`Sure:\n\`\`\`json\n{"kind":"table","columns":[${pct[0] - 1},${pct[1] + 2}]}\n\`\`\`\n`);
    expect(out.columns).toHaveLength(2);
  });

  it('drops a corridor the page does not have', () => {
    const out = parse(`{"kind":"table","columns":[${pct[0]},${Math.round((pct[0] + pct[1]) / 2)}]}`);
    expect(out.columns).toEqual([corridors[0].x]);
  });

  it('keeps an empty verdict, which is the model saying no', () => {
    const out = parse('{"kind":"diagram","columns":[]}');
    expect(out).toEqual({ kind: 'diagram', columns: [], at: expect.any(Number) });
  });

  it('answers null when there is no answer to read', () => {
    expect(parse('the page is a table')).toBe(null);
    expect(parse('')).toBe(null);
  });

  it('calls an unknown kind prose rather than inventing one', () => {
    expect(parse(`{"kind":"esquema","columns":[${pct[0]}]}`).kind).toBe('prose');
  });
});

describe('a judged page', () => {
  it('is walked by the corridors the judgement kept', () => {
    const judged = { ...page, layout: { kind: 'table', columns: [corridors[1].x] } };
    const stage = { w: 852, h: 393 };
    const rows = (p) => new Set(guidedPlan(p, stage).steps.map((s) => s.line)).size;
    // One corridor instead of two: two cells to a row, not three.
    expect(rows(judged)).toBeLessThan(rows(page));
    expect(rows(judged)).toBeGreaterThan(0);
  });

  it('is left as lines when the judgement kept none', () => {
    const stage = { w: 852, h: 393 };
    const asLines = guidedPlan({ ...page, layout: { kind: 'diagram', columns: [] } }, stage);
    const rows = new Set(asLines.steps.map((s) => s.line)).size;
    // The geometry would have split this page; the verdict says otherwise and
    // is not a question the geometry gets to reopen.
    expect(rows).toBeLessThan(new Set(guidedPlan(page, stage).steps.map((s) => s.line)).size);
  });
});
