import { describe, it, expect } from 'vitest';
import {
  buildCardPrompt,
  parseCards,
  locateAnchor,
  pagesToGenerate,
  MIN_TEXT_CHARS,
} from '../src/cards.js';

// A line of words laid out left to right, 40px apart on one row.
function row(text, y = 0, x0 = 0) {
  return text.split(' ').map((t, i) => ({ t, x: x0 + i * 40, y, w: 34, h: 12 }));
}

const page = {
  id: 3,
  uuid: 'u3',
  order: 6,
  ocrStatus: 'done',
  text: 'La mitocondria produce ATP\nEl núcleo guarda el ADN',
  words: [...row('La mitocondria produce ATP', 0), ...row('El núcleo guarda el ADN', 30)],
};

describe('buildCardPrompt', () => {
  it('numbers the page the way the reader sees it', () => {
    const [, user] = buildCardPrompt(page);
    expect(user.content).toContain('Page 7');
    expect(user.content).toContain('La mitocondria');
  });
});

describe('parseCards', () => {
  it('digs the JSON out of a fenced, chatty reply', () => {
    const raw = 'Claro, aquí tienes:\n```json\n{"cards":[{"q":"¿Qué?","a":"ATP","anchor":"produce ATP"}]}\n```\nEspero que sirvan.';
    expect(parseCards(raw)).toEqual([{ q: '¿Qué?', a: 'ATP', anchor: 'produce ATP' }]);
  });

  it('accepts a bare array, which models return however you ask', () => {
    expect(parseCards('[{"q":"a","a":"b"}]')).toEqual([{ q: 'a', a: 'b', anchor: '' }]);
  });

  it('drops entries missing a question or an answer', () => {
    expect(parseCards('{"cards":[{"q":"a"},{"a":"b"},{"q":"a","a":"b"}]}')).toHaveLength(1);
  });

  it('drops a repeated question rather than showing it twice', () => {
    const raw = '{"cards":[{"q":"¿Qué es?","a":"uno"},{"q":"¿Que es?","a":"dos"}]}';
    expect(parseCards(raw)).toHaveLength(1);
  });

  it('returns nothing at all rather than throwing on junk', () => {
    expect(parseCards('lo siento, no puedo')).toEqual([]);
    expect(parseCards('')).toEqual([]);
    expect(parseCards('{"cards":[trunca')).toEqual([]);
  });
});

describe('locateAnchor', () => {
  it('boxes exactly the words that were quoted', () => {
    expect(locateAnchor(page, 'mitocondria produce ATP')).toEqual({
      x: 40,
      y: 0,
      w: 114, // from x=40 to the right edge of ATP at 120+34
      h: 12,
    });
  });

  // The model retypes what it read and Vision split the strokes its own way,
  // so the two sides never match character for character.
  it('still finds the passage when a word came back mistranscribed', () => {
    const box = locateAnchor(page, 'mitocondria produxe ATP');
    expect(box).toMatchObject({ x: 40, y: 0 });
  });

  it('ignores accents, like every other match in the app', () => {
    expect(locateAnchor(page, 'nucleo guarda')).toMatchObject({ y: 30 });
  });

  it('spans both lines when the quote crosses one', () => {
    const box = locateAnchor(page, 'produce ATP El núcleo');
    expect(box.y).toBe(0);
    expect(box.h).toBe(42); // reaches into the second row
  });

  // A rectangle over the wrong sentence is worse than no rectangle: the card
  // would be showing handwriting that does not answer it.
  it('gives up rather than boxing a passage that is not there', () => {
    expect(locateAnchor(page, 'la fotosíntesis ocurre en el cloroplasto')).toBeNull();
  });

  it('has nothing to say about a page transcribed without word boxes', () => {
    expect(locateAnchor({ words: [] }, 'mitocondria')).toBeNull();
    expect(locateAnchor(page, '')).toBeNull();
  });
});

describe('pagesToGenerate', () => {
  const long = 'x'.repeat(MIN_TEXT_CHARS);
  const pages = [
    { id: 1, ocrStatus: 'done', text: long },
    { id: 2, ocrStatus: 'done', text: 'apenas nada' },
    { id: 3, ocrStatus: 'pending', text: long },
    { id: 4, ocrStatus: 'done', text: long },
  ];

  it('takes only transcribed pages with enough on them', () => {
    expect(pagesToGenerate(pages, []).map((p) => p.id)).toEqual([1, 4]);
  });

  it('skips pages that already have cards, so a second run pays for less', () => {
    expect(pagesToGenerate(pages, [{ pageId: 1 }]).map((p) => p.id)).toEqual([4]);
  });
});
