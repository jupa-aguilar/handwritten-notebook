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
