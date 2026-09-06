import { describe, it, expect } from 'vitest';
import {
  naturalCompare,
  escapeHtml,
  foldText,
  searchTokens,
  pageHasPhrase,
  phraseIndex,
  wordMatchesToken,
  wordsMatchingPhrase,
  realignWords,
  wordsInRect,
  wordsToText,
  highlight,
} from '../src/text.js';

describe('foldText', () => {
  it('folds case and strips accents both ways', () => {
    expect(foldText('CANCIÓN')).toBe('cancion');
    expect(foldText('cancion')).toBe('cancion');
    expect(foldText('Mañana')).toBe('manana');
    expect(foldText('crème brûlée')).toBe('creme brulee');
  });

  // refreshSearch finds a snippet by indexing into the folded text and then
  // slicing the *original* — which only works while folding is 1:1 per char.
  it('preserves length, so indexes still line up with the original text', () => {
    for (const s of ['canción', 'ñandú', 'Ábaco Éxito Índigo Óptimo Único', 'plain ascii']) {
      expect(foldText(s)).toHaveLength(s.length);
    }
  });

  it('leaves text without accents untouched apart from case', () => {
    expect(foldText('Hello, World! 123')).toBe('hello, world! 123');
  });
});

describe('searchTokens', () => {
  it('splits on whitespace and folds each word', () => {
    expect(searchTokens('Música  Mañana')).toEqual(['musica', 'manana']);
  });

  it('is empty for a blank query', () => {
    expect(searchTokens('')).toEqual([]);
    expect(searchTokens('   ')).toEqual([]);
  });
});

describe('pageHasPhrase', () => {
  const page = { text: 'La canción de mañana por la tarde' };

  it('matches the literal phrase, not independent words in any order', () => {
    expect(pageHasPhrase(page, 'musica')).toBe(false);
    expect(pageHasPhrase(page, 'cancion manana')).toBe(false); // "de" sits between them
    expect(pageHasPhrase(page, 'manana cancion')).toBe(false); // wrong order
    expect(pageHasPhrase(page, 'cancion de manana')).toBe(true); // the actual phrase
  });

  it('is false when the phrase is not present at all', () => {
    expect(pageHasPhrase(page, 'cancion ausente')).toBe(false);
  });

  it('treats a page with no transcription as a non-match; an empty query matches all', () => {
    expect(pageHasPhrase({}, 'anything')).toBe(false);
    expect(pageHasPhrase({ text: '' }, '')).toBe(true);
  });

  // This used to be whole-word only, on purpose, at the user's own earlier
  // request. Reversed on purpose too, back to real substring search: "dos"
  // matching inside "todos" is what a literal PDF-style search does.
  it('matches inside a longer word too — literal substring, not whole-word', () => {
    const p = { text: 'Puede descargarse si nadie lo está usando, todos los módulos' };
    expect(pageHasPhrase(p, 'los')).toBe(true);
    expect(pageHasPhrase(p, 'dos')).toBe(true); // "todos".includes("dos")
  });

  it('finds "A.4" as a literal substring — the bug this whole change fixes', () => {
    const p = { text: 'A.4 Algoritmos de planificación' };
    expect(pageHasPhrase(p, 'A.4')).toBe(true);
    expect(pageHasPhrase(p, 'G.3')).toBe(false);
  });

  it('tolerates a phrase the source text wraps onto two lines', () => {
    expect(pageHasPhrase({ text: 'hola\nmundo' }, 'hola mundo')).toBe(true);
  });
});

describe('phraseIndex', () => {
  it('finds the index of a phrase that wraps across a line break in the source', () => {
    expect(phraseIndex('hola\nmundo', 'hola mundo')).toBe(0);
  });

  it('returns -1 when the phrase is absent', () => {
    expect(phraseIndex('hola mundo', 'adios')).toBe(-1);
  });

  // foldText is 1:1 per character, which is what lets this index slice the
  // *original*, unfolded text correctly.
  it('lines up with the original text for slicing', () => {
    const text = 'Mañana: A.4 Algoritmos';
    const at = phraseIndex(text, 'a.4');
    expect(text.slice(at, at + 3)).toBe('A.4');
  });
});

describe('wordMatchesToken', () => {
  it('matches a word exactly, not as a substring of a longer word', () => {
    expect(wordMatchesToken('dos', 'dos')).toBe(true);
    expect(wordMatchesToken('todos', 'dos')).toBe(false);
    expect(wordMatchesToken('módulos', 'dos')).toBe(false);
  });

  it('folds accents and case', () => {
    expect(wordMatchesToken('CANCIÓN', 'cancion')).toBe(true);
  });

  it('ignores punctuation Vision attached to the word', () => {
    expect(wordMatchesToken('núcleo.', 'nucleo')).toBe(true);
    expect(wordMatchesToken('«mundo»', 'mundo')).toBe(true);
  });
});

describe('wordsMatchingPhrase', () => {
  it('does plain substring-per-word matching for a single-word query', () => {
    const words = [{ t: 'todos' }, { t: 'módulos' }, { t: 'dos' }];
    // "módulos" doesn't contain "dos" as a contiguous substring (d-u-l-o-s).
    expect(wordsMatchingPhrase(words, 'dos')).toEqual([words[0], words[2]]);
  });

  it('boxes the OCR word Vision kept punctuation on — the "A.4" fix', () => {
    const words = [{ t: 'A.4' }, { t: 'Algoritmos' }];
    expect(wordsMatchingPhrase(words, 'a.4')).toEqual([words[0]]);
  });

  it('boxes a contiguous run of OCR words for a multi-word query', () => {
    const words = [{ t: 'la' }, { t: 'canción' }, { t: 'de' }, { t: 'mañana' }];
    expect(wordsMatchingPhrase(words, 'cancion de manana')).toEqual([
      words[1],
      words[2],
      words[3],
    ]);
  });

  it('finds every genuine occurrence, not just the first', () => {
    const words = [{ t: 'los' }, { t: 'módulos' }, { t: 'los' }];
    expect(wordsMatchingPhrase(words, 'los')).toEqual(words); // all three contain "los"
  });
});

describe('realignWords', () => {
  const boxed = (...ts) => ts.map((t, i) => ({ t, x: i * 10, y: 0, w: 8, h: 10 }));

  it('leaves every box alone when the text comes back unchanged', () => {
    const words = boxed('la', 'canción', 'de', 'mañana');
    expect(realignWords(words, 'la canción de mañana')).toEqual(words);
  });

  // The commonest edit there is: one misread word typed over. Its own box goes
  // — those letters are no longer what is written there — and every other box
  // on the page is left exactly where it was.
  it('drops only the box of the word that was retyped', () => {
    const words = boxed('la', 'cancien', 'de', 'mañana');
    const out = realignWords(words, 'la canción de mañana');
    expect(out.map((w) => w.t)).toEqual(['la', 'de', 'mañana']);
    expect(out.map((w) => w.x)).toEqual([0, 20, 30]);
  });

  it('takes an accent the edit put back, even though folding matched without it', () => {
    const out = realignWords(boxed('cancion'), 'canción');
    expect(out).toEqual([{ ...boxed('cancion')[0], t: 'canción' }]);
  });

  it('gives an inserted word no box rather than borrowing a neighbour’s', () => {
    const words = boxed('la', 'de', 'mañana');
    const out = realignWords(words, 'la canción de mañana');
    // "canción" was never on the page, so nothing can say where it is.
    expect(out.map((w) => w.t)).toEqual(['la', 'de', 'mañana']);
    expect(out).toEqual(words);
  });

  it('drops the box of a word the edit deleted', () => {
    const words = boxed('la', 'canción', 'de', 'mañana');
    const out = realignWords(words, 'la de mañana');
    expect(out.map((w) => w.t)).toEqual(['la', 'de', 'mañana']);
    expect(out.map((w) => w.x)).toEqual([0, 20, 30]); // the surviving rectangles
  });

  // Whitespace was never in the boxes, so putting some in doesn't move any ink:
  // the rectangle over "lasleyes" still covers exactly the words now written
  // "las leyes", and search matches on substrings, so it still lights up.
  it('keeps a box whose word the edit only split in two', () => {
    const out = realignWords(boxed('de', 'lasleyes', 'tres'), 'de las leyes tres');
    expect(out.map((w) => w.t)).toEqual(['de', 'lasleyes', 'tres']);
  });

  // The mismatch this whole function is built around: Vision cuts "sucesos:"
  // into two boxes while page.text keeps it as one word. Counting characters
  // instead of words is what lets both of them survive an edit elsewhere.
  it('survives Vision splitting punctuation into boxes of its own', () => {
    const words = boxed('Analicemos', 'los', 'sucesos', ':', 'Suceso', 'A', ':');
    const out = realignWords(words, 'Analicemos los sucesos: Suceso B:');
    // Everything up to the retyped "A" is untouched, punctuation boxes included.
    expect(out.map((w) => w.t)).toEqual(['Analicemos', 'los', 'sucesos', ':', 'Suceso', ':']);
  });

  it('is empty when there were no boxes, or nothing left to box', () => {
    expect(realignWords([], 'hola mundo')).toEqual([]);
    expect(realignWords(undefined, 'hola mundo')).toEqual([]);
    expect(realignWords(boxed('hola'), '')).toEqual([]);
    expect(realignWords(boxed('hola'), '   ')).toEqual([]);
  });

  it('handles a rewrite that keeps nothing at all', () => {
    expect(realignWords(boxed('uno', 'dos'), 'algo enteramente distinto aquí')).toEqual([]);
  });

  // The bug this cost: the quadratic table was capped for handwriting, and a
  // page of ordinary typeset text (2,316 characters, squared = 5.4M) went past
  // it — so correcting one word silently dropped every box on the page, and the
  // framing tool then reported it as never transcribed. Aligning only the part
  // that differs is what keeps a long page affordable.
  it('keeps a long page’s boxes when one word in the middle is corrected', () => {
    const filler = (tag, count) =>
      Array.from({ length: count }, (_, i) => `${tag}palabra${i}`);
    const ts = [...filler('a', 300), 'rebolucion', ...filler('b', 300)];
    const words = ts.map((t, i) => ({ t, x: i * 10, y: 0, w: 8, h: 10 }));
    // Comfortably past the old 4M ceiling: ~4,700 characters a side.
    expect(words.map((w) => w.t).join('').length ** 2).toBeGreaterThan(4_000_000);

    const out = realignWords(words, ts.map((t) => (t === 'rebolucion' ? 'revolucion' : t)).join(' '));
    expect(out).toHaveLength(600); // every box but the corrected word's
    expect(out.map((w) => w.t)).not.toContain('rebolucion');
    expect(out[0]).toEqual(words[0]); // untouched, geometry and all
    expect(out.at(-1)).toEqual(words.at(-1));
  });

  it('still keeps the untouched head and tail when the middle is too big to align', () => {
    // 5,000 characters of difference either side would be 25M cells, past the
    // ceiling — the shared ends must survive it rather than the page being
    // abandoned.
    const head = Array.from({ length: 20 }, (_, i) => `cabeza${i}`);
    const tail = Array.from({ length: 20 }, (_, i) => `cola${i}`);
    const big = (seed) => Array.from({ length: 700 }, (_, i) => `${seed}${i}xxxxxxx`);
    const words = [...head, ...big('vieja'), ...tail].map((t, i) => ({ t, x: i, y: 0, w: 8, h: 10 }));
    const out = realignWords(words, [...head, ...big('nueva'), ...tail].join(' '));
    expect(out.length).toBeGreaterThanOrEqual(head.length + tail.length);
    expect(out.map((w) => w.t)).toContain('cabeza0');
    expect(out.map((w) => w.t)).toContain('cola19');
  });
});

describe('wordsInRect', () => {
  const words = [
    { t: 'uno', x: 0, y: 0, w: 30, h: 10 },
    { t: 'dos', x: 40, y: 0, w: 30, h: 10 },
    { t: 'tres', x: 0, y: 20, w: 30, h: 10 },
  ];

  it('keeps a word whose centre falls inside the rectangle', () => {
    expect(wordsInRect(words, { x: 0, y: 0, w: 80, h: 15 })).toEqual([words[0], words[1]]);
  });

  it('is empty when the rectangle holds no word centre', () => {
    expect(wordsInRect(words, { x: 200, y: 200, w: 10, h: 10 })).toEqual([]);
  });

  it('is empty on a page with no words at all', () => {
    expect(wordsInRect([], { x: 0, y: 0, w: 1000, h: 1000 })).toEqual([]);
    expect(wordsInRect(undefined, { x: 0, y: 0, w: 1000, h: 1000 })).toEqual([]);
  });

  // The rule is the centre point, not overlap — a rectangle that only grazes
  // a word's corner must not count it.
  it('does not count a word the rectangle only clips', () => {
    // "tres" spans x 0-30, y 20-30 (centre at 15,25).
    expect(wordsInRect(words, { x: 0, y: 20, w: 10, h: 10 })).toEqual([]);
  });

  it('preserves the words argument order (callers pass reading order)', () => {
    const out = wordsInRect(words, { x: 0, y: 0, w: 1000, h: 1000 });
    expect(out.map((w) => w.t)).toEqual(['uno', 'dos', 'tres']);
  });
});

describe('wordsToText', () => {
  it('joins matched words with single spaces', () => {
    expect(wordsToText([{ t: 'uno' }, { t: 'dos' }])).toBe('uno dos');
  });

  it('is empty for no words', () => {
    expect(wordsToText([])).toBe('');
    expect(wordsToText(undefined)).toBe('');
  });
});

describe('highlight', () => {
  it('marks the query wherever it appears', () => {
    expect(highlight('uno dos uno', 'uno')).toBe('<mark>uno</mark> dos <mark>uno</mark>');
  });

  it('marks accented text when the query has no accents', () => {
    expect(highlight('canción', 'cancion')).toBe('<mark>canción</mark>');
    expect(highlight('mañana', 'manana')).toBe('<mark>mañana</mark>');
  });

  it('is substring: it marks a query word inside a longer one too', () => {
    expect(highlight('todos los módulos', 'dos')).toBe('to<mark>dos</mark> los módulos');
    expect(highlight('todos los módulos', 'los')).toBe(
      'todos <mark>los</mark> módu<mark>los</mark>' // "módulos" ends in "los" too
    );
  });

  it('escapes the text before marking, so page content can never inject HTML', () => {
    const out = highlight('<script>alert(1)</script>', 'script');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;');
    expect(out).toContain('<mark>script</mark>');
  });

  it('returns escaped text untouched when the query is empty', () => {
    expect(highlight('a < b & c', '')).toBe('a &lt; b &amp; c');
  });

  it('matches a multi-word query as one phrase, not independent alternatives', () => {
    expect(highlight('abc', 'ab abc')).toBe('abc'); // no whitespace in "abc" to satisfy "ab abc"
    expect(highlight('ab abc', 'ab abc')).toBe('<mark>ab abc</mark>');
  });

  it('treats regex metacharacters in the query as literals', () => {
    expect(() => highlight('anything', '( [ * +')).not.toThrow();
    expect(highlight('cost: 2+2', '2+2')).toBe('cost: <mark>2+2</mark>');
    expect(highlight('a.b axb', 'a.b')).toBe('<mark>a.b</mark> axb');
  });
});

describe('escapeHtml', () => {
  it('escapes every character that could start markup', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('naturalCompare', () => {
  it('orders page-02 before page-10, unlike a plain string sort', () => {
    const names = ['page-10.jpg', 'page-2.jpg', 'page-1.jpg'];
    expect([...names].sort(naturalCompare)).toEqual([
      'page-1.jpg',
      'page-2.jpg',
      'page-10.jpg',
    ]);
  });

  it('ignores case and accents', () => {
    expect(naturalCompare('Ábaco', 'abaco')).toBe(0);
  });
});
