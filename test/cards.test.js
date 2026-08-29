import { describe, it, expect } from 'vitest';
import {
  buildCardPrompt,
  parseCards,
  parseTopic,
  usableHint,
  cardsToTopUp,
  parseTopUp,
  applyTopUp,
  locateAnchor,
  hintRect,
  cropRect,
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
    expect(parseCards(raw)).toEqual([
      { q: '¿Qué?', a: 'ATP', hint: '', insight: '', anchor: 'produce ATP' },
    ]);
  });

  it('accepts a bare array, which models return however you ask', () => {
    expect(parseCards('[{"q":"a","a":"b"}]')).toEqual([
      { q: 'a', a: 'b', hint: '', insight: '', anchor: '' },
    ]);
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

describe('parseCards, the hint and the takeaway', () => {
  it('keeps both when they say something the answer does not', () => {
    const raw = '{"cards":[{"q":"¿Qué produce?","a":"ATP","hint":"La moneda de la célula","insight":"Por eso muere sin oxígeno."}]}';
    const [card] = parseCards(raw);
    expect(card.hint).toBe('La moneda de la célula');
    expect(card.insight).toBe('Por eso muere sin oxígeno.');
  });

  it('throws away a hint that hands over the answer', () => {
    const raw = '{"cards":[{"q":"¿Qué produce?","a":"ATP","hint":"Produce ATP en la mitocondria"}]}';
    expect(parseCards(raw)[0].hint).toBe('');
  });

  it('throws away a takeaway that only says the answer again', () => {
    const raw = '{"cards":[{"q":"¿Qué produce?","a":"ATP","insight":"atp"}]}';
    expect(parseCards(raw)[0].insight).toBe('');
  });

  it('leaves them empty on cards that carry neither', () => {
    const [card] = parseCards('{"cards":[{"q":"a","a":"b"}]}');
    expect(card.hint).toBe('');
    expect(card.insight).toBe('');
  });
});

describe('usableHint', () => {
  it('refuses a hint the answer is buried in, accents and case aside', () => {
    expect(usableHint('Piensa en la RESPIRACIÓN celular', 'respiracion celular')).toBe('');
  });

  it('keeps one that only circles the answer', () => {
    expect(usableHint('Lo que la célula gasta para todo', 'ATP')).toBe(
      'Lo que la célula gasta para todo'
    );
  });
});

describe('topping up existing cards', () => {
  const deck = [
    { id: 1, q: '¿Qué produce?', a: 'ATP' },
    { id: 2, q: '¿Cuántas membranas?', a: 'Dos', hint: 'ya la tiene', insight: 'y esto' },
    { id: 3, q: '¿Qué ADN?', a: 'Circular', hint: 'solo la pista' },
  ];

  it('picks only the cards missing one of the two', () => {
    expect(cardsToTopUp(deck).map((c) => c.id)).toEqual([1, 3]);
  });

  it('matches by question, not by the order the model replied in', () => {
    const parsed = [
      { q: '¿Qué ADN?', hint: 'no es el del núcleo', insight: 'heredado por vía materna.' },
      { q: '¿Qué produce?', hint: 'la moneda de la célula', insight: 'de ahí su nombre.' },
    ];
    const out = applyTopUp(deck, parsed);
    expect(out.map((c) => c.id)).toEqual([1, 3]);
    expect(out.find((c) => c.id === 1).hint).toBe('la moneda de la célula');
    // Its own hint was already there; only the missing half is written.
    expect(out.find((c) => c.id === 3).hint).toBe('solo la pista');
    expect(out.find((c) => c.id === 3).insight).toBe('heredado por vía materna.');
  });

  it('ignores a question the deck never asked', () => {
    expect(applyTopUp(deck, [{ q: 'inventada', hint: 'x', insight: 'y' }])).toEqual([]);
  });

  it('still refuses a hint that hands over the answer', () => {
    const out = applyTopUp(deck, [{ q: '¿Qué produce?', hint: 'es el ATP', insight: 'algo.' }]);
    expect(out[0].hint).toBe('');
    expect(out[0].insight).toBe('algo.');
  });

  it('reads the reply through the same battered-JSON parser', () => {
    const raw = 'Vale:\n```json\n{"cards":[{"q":"a","hint":"b","insight":"c"}]}\n```';
    expect(parseTopUp(raw)).toEqual([{ q: 'a', hint: 'b', insight: 'c' }]);
  });
});

describe('parseTopic', () => {
  it('reads the topic out of the same reply as the cards', () => {
    const raw = '{"topic":"Mitocondria","cards":[{"q":"a","a":"b"}]}';
    expect(parseTopic(raw)).toBe('Mitocondria');
  });

  it('has none to offer when the model answered with a bare array', () => {
    expect(parseTopic('[{"q":"a","a":"b"}]')).toBe('');
  });

  it('has none on junk, rather than throwing', () => {
    expect(parseTopic('lo siento, no puedo')).toBe('');
    expect(parseTopic('')).toBe('');
  });
});

describe('hintRect', () => {
  // Three lines, so a box on the middle one has a neighbour either side.
  const three = {
    words: [
      ...row('uno dos tres cuatro', 0),
      ...row('cinco seis siete ocho', 30),
      ...row('nueve diez once doce', 60),
    ],
  };

  it('takes in the lines above and below the answer', () => {
    const box = { x: 40, y: 30, w: 34, h: 12 };
    const rect = hintRect(three, box);
    // All three lines are in it: up to the first (clamped at the image edge)
    // and past the bottom of the last, at y 60 + 12.
    expect(rect.y).toBe(0);
    expect(rect.y + rect.h).toBeGreaterThan(72);
  });

  it('gives up when the mask would cover everything shown', () => {
    const one = { words: row('uno dos tres', 0) };
    expect(hintRect(one, { x: 0, y: 0, w: 114, h: 12 })).toBeNull();
  });

  it('gives up on a page that was never transcribed', () => {
    expect(hintRect({ words: [] }, { x: 0, y: 0, w: 10, h: 10 })).toBeNull();
    expect(hintRect(three, null)).toBeNull();
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

// A page written in two columns, the way Vision reads it: straight across the
// gutter, so words that sit on opposite sides of the page are neighbours in
// `words`.
const twoColumns = {
  width: 1000,
  height: 400,
  words: [
    { t: 'TABLA', x: 40, y: 100, w: 90, h: 30 },
    { t: 'EN', x: 140, y: 100, w: 40, h: 30 },
    { t: 'DISCO', x: 190, y: 100, w: 90, h: 30 },
    { t: 'acelera', x: 600, y: 100, w: 110, h: 30 },
    { t: 'busquedas', x: 720, y: 100, w: 150, h: 30 },
    { t: 'fila', x: 40, y: 160, w: 60, h: 30 },
    { t: '1', x: 110, y: 160, w: 20, h: 30 },
    { t: 'por', x: 600, y: 160, w: 50, h: 30 },
    { t: 'un', x: 660, y: 160, w: 40, h: 30 },
    { t: 'campo', x: 710, y: 160, w: 100, h: 30 },
  ],
};

describe('locateAnchor across columns', () => {
  // Taking the whole matched window would have spanned the gutter and boxed
  // the table on the left along with the sentence on the right.
  it('boxes only the words that matched, not the run between them', () => {
    const box = locateAnchor(twoColumns, 'acelera busquedas por un campo');
    expect(box.x).toBe(600);
    expect(box.x + box.w).toBe(870);
  });
});

describe('cropRect', () => {
  const page = {
    width: 1000,
    height: 400,
    words: [
      { t: 'arriba', x: 100, y: 40, w: 120, h: 30 }, // the line above
      { t: 'Almacen', x: 100, y: 100, w: 140, h: 30 },
      { t: 'organizado', x: 250, y: 100, w: 160, h: 30 },
      { t: 'y', x: 100, y: 160, w: 20, h: 30 }, // the line below
      { t: 'guarda', x: 130, y: 160, w: 110, h: 30 },
    ],
  };

  it('never leaves a line half shown', () => {
    const cut = cropRect(page, { x: 100, y: 100, w: 310, h: 30 });
    for (const w of page.words) {
      const inside = Math.min(cut.y + cut.h, w.y + w.h) - Math.max(cut.y, w.y);
      expect(inside <= 0 || inside === w.h).toBe(true);
    }
  });

  it('never leaves a word half shown', () => {
    const cut = cropRect(page, { x: 250, y: 100, w: 160, h: 30 });
    for (const w of page.words.filter((w) => w.y === 100)) {
      const inside = Math.min(cut.x + cut.w, w.x + w.w) - Math.max(cut.x, w.x);
      expect(inside <= 0 || inside === w.w).toBe(true);
    }
  });

  it('keeps the passage itself even when the padding barely reaches it', () => {
    const box = { x: 100, y: 100, w: 310, h: 30 };
    const cut = cropRect(page, box);
    expect(cut.x).toBeLessThanOrEqual(box.x);
    expect(cut.y).toBeLessThanOrEqual(box.y);
    expect(cut.x + cut.w).toBeGreaterThanOrEqual(box.x + box.w);
    expect(cut.y + cut.h).toBeGreaterThanOrEqual(box.y + box.h);
  });

  it('stays inside the image', () => {
    const cut = cropRect(page, { x: 0, y: 0, w: 100, h: 30 });
    expect(cut.x).toBeGreaterThanOrEqual(0);
    expect(cut.y).toBeGreaterThanOrEqual(0);
    expect(cut.x + cut.w).toBeLessThanOrEqual(page.width);
  });

  // The padding is a line's worth, not the box's worth — otherwise a two-line
  // passage generates enough margin to take a third line in with it.
  it('does not swallow the next line when the passage spans two', () => {
    const twoLines = {
      width: 1000,
      height: 400,
      words: [
        { t: 'acelera', x: 100, y: 100, w: 140, h: 46 },
        { t: 'busquedas', x: 250, y: 100, w: 180, h: 46 },
        { t: 'por', x: 100, y: 166, w: 60, h: 46 },
        { t: 'campo', x: 170, y: 166, w: 120, h: 46 },
        { t: 'funciona', x: 100, y: 232, w: 150, h: 46 },
      ],
    };
    const cut = cropRect(twoLines, { x: 100, y: 100, w: 330, h: 112 });
    expect(cut.y + cut.h).toBeLessThan(232);
  });

  it('has nothing to crop without a box', () => {
    expect(cropRect(page, null)).toBeNull();
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
