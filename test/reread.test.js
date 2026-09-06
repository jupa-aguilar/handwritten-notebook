import { describe, it, expect } from 'vitest';
import { buildRereadPrompt, parseRereadText } from '../src/ocr.js';

const page = {
  order: 6,
  text: 'Suceso A: la probabilidad de que haga buen tiempo\nSuceso B: la probabilidad de tener un accidente',
};
const IMAGE = 'data:image/jpeg;base64,AAAA';

describe('buildRereadPrompt', () => {
  it('sends the page as an image, ahead of which page it is', () => {
    const [, user] = buildRereadPrompt(page, IMAGE);
    expect(user.content[0]).toEqual({ type: 'image_url', image_url: { url: IMAGE } });
    expect(user.content[1]).toEqual({ type: 'text', text: 'Page 7.' });
  });

  // The sharpest test of the whole design. A re-read exists to escape Vision's
  // reading — including the flattened table that prompted it — and a model
  // shown that reading copies it instead of looking. proof.js's own header
  // says the same thing from the other side: with the page in hand, a model
  // argues from whatever text it can also see. If someone later adds the
  // transcription "for context", this fails and the comment says why.
  it('does not send the transcription it is meant to replace', () => {
    const whole = JSON.stringify(buildRereadPrompt(page, IMAGE));
    expect(whole).not.toContain('Suceso A');
    expect(whole).not.toContain('probabilidad');
  });

  it('asks for the layout, and names a table format so pages do not each get their own', () => {
    const system = buildRereadPrompt(page, IMAGE)[0].content;
    expect(system).toMatch(/line breaks/i);
    expect(system).toMatch(/reading order/i);
    expect(system).toMatch(/table as one line per row/i);
    expect(system).toContain('" | "');
  });

  it('forbids improving the writing, and forbids LaTeX like every other prompt here', () => {
    const system = buildRereadPrompt(page, IMAGE)[0].content;
    expect(system).toMatch(/never correct the writer's spelling, grammar or arithmetic/i);
    expect(system).toMatch(/never translate/i);
    expect(system).toMatch(/never latex/i);
    expect(system).toMatch(/\[\?\]/); // a gap, not a guess
  });
});

describe('parseRereadText', () => {
  it('keeps an ordinary reply exactly as written', () => {
    expect(parseRereadText('Línea uno\nLínea dos')).toBe('Línea uno\nLínea dos');
  });

  it('strips a code fence the model was told not to use', () => {
    expect(parseRereadText('```\nLínea uno\nLínea dos\n```')).toBe('Línea uno\nLínea dos');
    expect(parseRereadText('```text\nhola\n```')).toBe('hola');
  });

  // The table is the reason this feature exists; the pipes must survive intact.
  it('leaves a pipe table alone', () => {
    const table = 'Modelo | Precio\nLuna | 1\nSol | 6';
    expect(parseRereadText(table)).toBe(table);
  });

  it('is empty for an empty or blank answer, so nothing proposes deleting a page', () => {
    expect(parseRereadText('')).toBe('');
    expect(parseRereadText('   \n  ')).toBe('');
    expect(parseRereadText(null)).toBe('');
    expect(parseRereadText(undefined)).toBe('');
  });

  // No prose-stripping on purpose: a rule for cutting off what looks like a
  // preamble is one bad match away from eating a real first line, and the
  // reader sees the whole text in the editor before anything is written.
  it('does not try to guess a preamble away', () => {
    expect(parseRereadText('Ejercicio 13\na) Analicemos')).toBe('Ejercicio 13\na) Analicemos');
  });
});
