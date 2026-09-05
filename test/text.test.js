import { describe, it, expect } from 'vitest';
import {
  naturalCompare,
  escapeHtml,
  foldText,
  searchTokens,
  pageHasAllTokens,
  wordMatchesToken,
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

describe('pageHasAllTokens', () => {
  const page = { text: 'La canción de mañana por la tarde' };

  it('matches when every word appears, in any order', () => {
    expect(pageHasAllTokens(page, searchTokens('musica'))).toBe(false);
    expect(pageHasAllTokens(page, searchTokens('cancion manana'))).toBe(true);
    expect(pageHasAllTokens(page, searchTokens('manana cancion'))).toBe(true);
  });

  it('needs all of them, not just one', () => {
    expect(pageHasAllTokens(page, searchTokens('cancion ausente'))).toBe(false);
  });

  it('treats a page with no transcription as a non-match', () => {
    expect(pageHasAllTokens({}, searchTokens('anything'))).toBe(false);
    expect(pageHasAllTokens({ text: '' }, [])).toBe(true); // empty query matches all
  });

  it('is whole-word: a query word must not match inside a longer one', () => {
    const p = { text: 'Puede descargarse si nadie lo está usando, todos los módulos' };
    expect(pageHasAllTokens(p, searchTokens('los'))).toBe(true);
    // "dos" is a substring of "todos" and of "módulos" but appears as neither
    // of those words on its own — the page must not count as a hit for it.
    expect(pageHasAllTokens(p, searchTokens('dos'))).toBe(false);
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

describe('highlight', () => {
  it('marks the query wherever it appears', () => {
    expect(highlight('uno dos uno', 'uno')).toBe('<mark>uno</mark> dos <mark>uno</mark>');
  });

  it('marks accented text when the query has no accents', () => {
    expect(highlight('canción', 'cancion')).toBe('<mark>canción</mark>');
    expect(highlight('mañana', 'manana')).toBe('<mark>mañana</mark>');
  });

  it('is whole-word: it must not mark a query word inside a longer one', () => {
    expect(highlight('todos los módulos', 'dos')).toBe('todos los módulos');
    expect(highlight('todos los módulos', 'los')).toBe(
      'todos <mark>los</mark> módulos'
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

  it('prefers the longest match when queries overlap', () => {
    expect(highlight('abc', 'ab abc')).toBe('<mark>abc</mark>');
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
