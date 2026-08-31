import { describe, it, expect, beforeEach } from 'vitest';
import {
  contextCharBudget,
  renderMarkdown,
  chatWorksWithoutLocalServer,
  buildSystemPrompt,
  focusNote,
  passageNote,
  explainNote,
  PASSAGE_LIMIT,
  setOpenAiKey,
  setChatServerUrl,
} from '../src/chat.js';

const pagesOf = (...texts) => texts.map((text) => ({ text }));

const msgs = (...lengths) => lengths.map((n) => ({ role: 'user', content: 'x'.repeat(n) }));

describe('contextCharBudget', () => {
  it('caps at the ceiling when the model has room to spare', () => {
    expect(contextCharBudget(200_000, [])).toBe(14_000);
  });

  it('shrinks to fit a small context window', () => {
    // (4096 - 800 reply - 400 boilerplate) * 3.5 chars/token
    expect(contextCharBudget(4096, [])).toBe(Math.floor(2896 * 3.5));
  });

  // Worth pinning down: the ceiling, not the window, is what binds on any
  // model loaded with more than ~5.2k tokens of context.
  it('is capped by the ceiling well before a typical window runs out', () => {
    expect(contextCharBudget(8192, [])).toBe(14_000);
  });

  it('subtracts the conversation history being sent', () => {
    const withHistory = contextCharBudget(4096, msgs(3500, 3500));
    expect(withHistory).toBeLessThan(contextCharBudget(4096, []));
    // 7000 chars ≈ 2000 tokens off the budget
    expect(withHistory).toBe(Math.floor((2896 - 2000) * 3.5));
  });

  it('assumes a conservative window when the server reports none', () => {
    expect(contextCharBudget(null, [])).toBe(contextCharBudget(4096, []));
    expect(contextCharBudget(0, [])).toBe(contextCharBudget(4096, []));
  });

  it('never goes negative when the reserves exceed the window', () => {
    expect(contextCharBudget(500, [])).toBe(0);
    expect(contextCharBudget(4096, msgs(100_000))).toBe(0);
  });

  // The hosted model has a 1M window, so the local 14K ceiling would throw
  // away most of a notebook — and with it the chance of a cache hit.
  it('lifts the ceiling for the hosted backend', () => {
    expect(contextCharBudget(1_050_000, [], true)).toBe(120_000);
    expect(contextCharBudget(1_050_000, [], false)).toBe(14_000);
  });

  it('still respects a small window even when hosted', () => {
    expect(contextCharBudget(4096, [], true)).toBe(contextCharBudget(4096, [], false));
  });
});

describe('buildSystemPrompt', () => {
  const notebook = pagesOf(
    'La canción de mañana',
    'Notas sobre PCIe y ancho de banda',
    'Una receta de pan'
  );

  // The hosted backend bills cached input at a tenth of the price, but only
  // for a byte-identical prefix. If a question ever leaks into the prompt of a
  // notebook that fits, every message silently pays full price again.
  it('is identical for different questions when the whole notebook fits', () => {
    const a = buildSystemPrompt('Cuaderno', notebook, '¿qué dice de PCIe?', 100000);
    const b = buildSystemPrompt('Cuaderno', notebook, 'háblame del pan', 100000);
    const c = buildSystemPrompt('Cuaderno', notebook, '', 100000);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('includes every transcribed page, in page order', () => {
    const prompt = buildSystemPrompt('Cuaderno', notebook, 'pan', 100000);
    expect(prompt).toContain('--- Page 1 ---');
    expect(prompt).toContain('--- Page 3 ---');
    expect(prompt.indexOf('--- Page 1 ---')).toBeLessThan(prompt.indexOf('--- Page 2 ---'));
    expect(prompt).not.toMatch(/Only \d+ of the transcribed pages fit/);
  });

  it('falls back to relevance — and to varying prompts — once it overflows', () => {
    const tight = 60; // room for roughly one page
    const aboutPcie = buildSystemPrompt('Cuaderno', notebook, 'PCIe', tight);
    const aboutBread = buildSystemPrompt('Cuaderno', notebook, 'receta de pan', tight);
    expect(aboutPcie).toContain('PCIe');
    expect(aboutBread).toContain('receta de pan');
    expect(aboutPcie).not.toBe(aboutBread);
  });

  it('tells the model when pages were left out, so it does not deny they exist', () => {
    const prompt = buildSystemPrompt('Cuaderno', notebook, 'PCIe', 60);
    expect(prompt).toMatch(/chosen for relevance/);
    expect(prompt).toMatch(/may be on a page not shown/);
  });

  it('counts pages without transcriptions but does not send them', () => {
    const mixed = [{ text: 'transcrita' }, { text: '' }, {}];
    const prompt = buildSystemPrompt('Cuaderno', mixed, 'x', 100000);
    expect(prompt).toContain('The notebook has 3 page(s); 1 of them are transcribed.');
    expect(prompt.match(/--- Page/g)).toHaveLength(1);
  });

  // Same cache bargain as above, now against the page the reader has open:
  // marking it in the dump, or reordering the dump around it, would re-bill the
  // whole notebook at full price on every page turn. The position travels in
  // the tail instead (focusNote).
  it('is identical whatever page is on screen when the whole notebook fits', () => {
    const none = buildSystemPrompt('Cuaderno', notebook, 'pan', 100000);
    const first = buildSystemPrompt('Cuaderno', notebook, 'pan', 100000, [0]);
    const spread = buildSystemPrompt('Cuaderno', notebook, 'pan', 100000, [1, 2]);
    expect(first).toBe(none);
    expect(spread).toBe(none);
  });

  it('keeps the page on screen when the notebook overflows', () => {
    const tight = 60; // room for roughly one page
    // Nothing on page 1 matches the question, so relevance alone would drop it.
    const prompt = buildSystemPrompt('Cuaderno', notebook, 'PCIe', tight, [0]);
    expect(prompt).toContain('canción de mañana');
    expect(prompt).not.toContain('Notas sobre PCIe');
  });
});

// The reading position rides in the tail of the outgoing message, so it is
// this string — not the system prompt — that has to name the pages correctly.
describe('focusNote', () => {
  const notebook = pagesOf('primera', 'segunda', 'tercera');

  it('is empty without a reading position', () => {
    expect(focusNote(notebook, [])).toBe('');
    expect(focusNote(notebook)).toBe('');
  });

  it('names both sheets of a spread, 1-based like the app', () => {
    const note = focusNote(notebook, [1, 2]);
    expect(note).toContain('pages 2 and 3');
    expect(note).toContain('those pages');
    expect(focusNote(notebook, [0])).toContain('page 1');
  });

  it('ignores pages that no longer exist', () => {
    expect(focusNote(notebook, [2, 3])).toContain('page 3');
    expect(focusNote(notebook, [7])).toBe('');
  });

  // An untranscribed page is on screen but unreadable — left unsaid, that is an
  // invitation to invent what it says.
  it('flags a page it cannot read instead of letting the model guess', () => {
    const note = focusNote([{ text: 'primera' }, { text: '' }], [0, 1]);
    expect(note).toContain('No transcription yet for page 2');
  });
});

// This gates whether phones get the chat at all, and the failure mode is
// silent either way: too strict and the button never appears, too loose and
// it appears pointing at a server the phone can't reach.
describe('chatWorksWithoutLocalServer', () => {
  beforeEach(() => {
    setOpenAiKey('');
    setChatServerUrl('');
  });

  it('is true with a hosted key, whatever the local address says', () => {
    setOpenAiKey('sk-test');
    expect(chatWorksWithoutLocalServer()).toBe(true);
    setChatServerUrl('http://localhost:1234');
    expect(chatWorksWithoutLocalServer()).toBe(true);
  });

  it('is false for the default address — on a phone that is the phone', () => {
    expect(chatWorksWithoutLocalServer()).toBe(false);
  });

  it('is false for every spelling of this machine', () => {
    for (const url of [
      'http://localhost:1234',
      'http://LOCALHOST:1234',
      'https://localhost',
      'http://127.0.0.1:1234',
      'http://[::1]:1234',
    ]) {
      setChatServerUrl(url);
      expect(chatWorksWithoutLocalServer(), url).toBe(false);
    }
  });

  it('is true for an address on the network', () => {
    for (const url of ['http://192.168.1.40:1234', 'http://studio.local:1234']) {
      setChatServerUrl(url);
      expect(chatWorksWithoutLocalServer(), url).toBe(true);
    }
  });

  // "localhostel.example.com" is not this machine — the boundary matters.
  it('does not mistake a hostname that merely starts with localhost', () => {
    setChatServerUrl('http://localhost-server.example.com:1234');
    expect(chatWorksWithoutLocalServer()).toBe(true);
  });
});

// Citations become links to the page. Too eager and stray numbers turn into
// links that go somewhere wrong; too strict and the feature quietly does
// nothing, since it depends on how the model chose to phrase itself.
describe('page citations', () => {
  const render = (md) => renderMarkdown(md, 10); // a 10-page notebook

  const linkedPages = (html) =>
    [...html.matchAll(/data-page="(\d+)"/g)].map((m) => Number(m[1]));

  it('links the form the system prompt asks for', () => {
    expect(linkedPages(render('Lo dice en (p. 3).'))).toEqual([2]); // 0-based
  });

  it('links the Spanish forms a model actually writes', () => {
    expect(linkedPages(render('Está en la página 4.'))).toEqual([3]);
    expect(linkedPages(render('Ver pág. 5'))).toEqual([4]);
    expect(linkedPages(render('En las páginas 2 y 6'))).toEqual([1, 5]);
  });

  it('links every page in a range or list', () => {
    expect(linkedPages(render('(p. 3-5)'))).toEqual([2, 4]);
    expect(linkedPages(render('pages 1, 4, 9'))).toEqual([0, 3, 8]);
  });

  it('keeps the number the model wrote as the label', () => {
    expect(render('(p. 7)')).toContain('>7</button>');
  });

  it('leaves the surrounding words alone', () => {
    expect(render('(p. 3)')).toContain('p. ');
  });

  it('does not link a page the notebook does not have', () => {
    expect(linkedPages(render('(p. 99)'))).toEqual([]);
    expect(render('(p. 99)')).toContain('99');
    expect(linkedPages(render('(p. 0)'))).toEqual([]);
  });

  it('links nothing when the notebook is empty', () => {
    expect(linkedPages(renderMarkdown('(p. 3)', 0))).toEqual([]);
  });

  it('ignores numbers that are not page citations', () => {
    expect(linkedPages(render('Costó 3 euros en 2026.'))).toEqual([]);
    expect(linkedPages(render('El capítulo 4 es largo.'))).toEqual([]);
  });

  it('leaves citations inside code spans as text', () => {
    expect(linkedPages(render('Escribe `(p. 3)` literalmente'))).toEqual([]);
  });

  it('leaves citations inside fenced code alone', () => {
    expect(linkedPages(render('```\nver (p. 3)\n```'))).toEqual([]);
  });

  it('works inside lists and headings', () => {
    expect(linkedPages(render('- Ver (p. 2)'))).toEqual([1]);
    expect(linkedPages(render('## Resumen de (p. 8)'))).toEqual([7]);
  });

  it('still escapes HTML around a citation', () => {
    const html = render('<img src=x> en (p. 2)');
    expect(html).toContain('&lt;img');
    expect(linkedPages(html)).toEqual([1]);
  });
});

// The words a citation carries are what the reading view boxes on the scan,
// so what ends up in data-terms decides whether the reader lands on the right
// lines or on a page lit up at random.
describe('cited passages', () => {
  const render = (md) => renderMarkdown(md, 10);
  const terms = (html) => [...html.matchAll(/data-terms="([^"]*)"/g)].map((m) => m[1]);

  it('carries the quoted passage', () => {
    expect(terms(render('Lo explica en (p. 3: "las tres leyes de Newton")'))).toEqual([
      'las tres leyes de Newton',
    ]);
  });

  it('keeps the quote visible in the sentence', () => {
    expect(render('(p. 3: "las tres leyes")')).toContain('las tres leyes');
  });

  it('accepts the curly quotes a model may type instead', () => {
    expect(terms(render('(p. 3: “las tres leyes”)'))).toEqual(['las tres leyes']);
  });

  it('falls back to the line when no passage is quoted', () => {
    // Old conversations have no quotes at all, so a citation has to make do
    // with the sentence around it — minus the words that point at nothing.
    const out = terms(render('El teorema de Bayes aparece en (p. 4).'))[0];
    expect(out).toContain('teorema');
    expect(out).toContain('bayes');
    expect(out).not.toContain('el ');
  });

  it('keeps escaped markup out of the fallback terms', () => {
    // The text is HTML-escaped by this point, so a quote elsewhere in the line
    // arrives as &quot; — read naively that becomes the "word" quot, boxed on
    // the page as if it were something the reader should look for.
    const out = terms(render('Las leyes de (p. 2: "Newton") y la fuerza en (p. 3).'))[1];
    expect(out).not.toContain('quot');
    expect(out).toContain('newton');
  });

  it('gives every page of a range the same passage', () => {
    expect(terms(render('(p. 3-4: "la segunda ley")'))).toEqual([
      'la segunda ley',
      'la segunda ley',
    ]);
  });

  it('cannot break out of the attribute', () => {
    // The quote pattern excludes " and &, so nothing that reaches the
    // attribute can close it early.
    const html = render('(p. 2: "a\\" onmouseover=alert(1) x=\\"")');
    expect(html).not.toMatch(/data-terms="[^"]*"[^>]*onmouseover/);
  });
});

describe('renderMarkdown', () => {
  it('escapes HTML before doing anything else', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('renders headings, bold, italics and inline code', () => {
    expect(renderMarkdown('## Title')).toBe('<div class="md-h">Title</div>');
    expect(renderMarkdown('a **bold** and *soft*')).toBe(
      '<p>a <strong>bold</strong> and <em>soft</em></p>'
    );
    expect(renderMarkdown('use `npm run dev`')).toBe(
      '<p>use <code>npm run dev</code></p>'
    );
  });

  it('joins the lines of one paragraph with breaks', () => {
    expect(renderMarkdown('one\ntwo')).toBe('<p>one<br>two</p>');
  });

  it('separates paragraphs on a blank line', () => {
    expect(renderMarkdown('one\n\ntwo')).toBe('<p>one</p><p>two</p>');
  });

  it('renders bullet and numbered lists', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('closes a list when the text moves on', () => {
    expect(renderMarkdown('- a\n\nafter')).toBe('<ul><li>a</li></ul><p>after</p>');
  });

  it('renders fenced code without touching its contents', () => {
    expect(renderMarkdown('```\nlet a = 1 < 2;\n```')).toBe(
      '<pre><code>let a = 1 &lt; 2;</code></pre>'
    );
  });

  // Replies are re-rendered on every streamed token, so half a fence is the
  // normal state, not an edge case.
  it('closes a fence that is still open mid-stream', () => {
    expect(renderMarkdown('```\nhalf a code bl')).toBe(
      '<pre><code>half a code bl</code></pre>'
    );
  });

  it('is empty for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });
});

describe('passageNote', () => {
  it('carries the marked text and says it is the app talking', () => {
    const note = passageNote('El sistema operativo traduce esas direcciones.');
    expect(note).toContain('"El sistema operativo traduce esas direcciones."');
    // Marked as the app's aside, or the model reads it as part of the question.
    expect(note).toContain('from the app');
    expect(note).toContain('not part of the question');
  });

  it('has nothing to say about nothing', () => {
    expect(passageNote('')).toBe('');
    expect(passageNote('   \n  ')).toBe('');
    expect(passageNote(undefined)).toBe('');
  });

  it('cuts a selection too long to ride on top of the notebook', () => {
    const long = 'palabra '.repeat(500);
    const note = passageNote(long);
    expect(note.length).toBeLessThan(PASSAGE_LIMIT + 500);
    // And says so, rather than quietly answering about the first half.
    expect(note).toContain('truncated');
  });

  it('leaves a passage that fits alone', () => {
    expect(passageNote('corto')).not.toContain('truncated');
  });

  it('flattens the line breaks a selection drags in', () => {
    expect(passageNote('una\nlínea\n\ny otra')).toContain('"una línea y otra"');
  });
});

// The first version of Explain this came back with page citations, five
// headings and no analogy — none of it asked for. The instruction was riding
// in the tail of a user message, under a system prompt that sets the persona,
// the citation format and the tone, and it lost to all three.
describe('explainNote', () => {
  it('relieves the defaults it would otherwise be fighting', () => {
    const note = explainNote('EL PROMPT');
    expect(note).toContain('Do not cite pages');
    expect(note).toContain('(p. 3)');
    expect(note).toContain('outside');
    expect(note).toContain('No headings and no lists');
  });

  it('carries the request itself, in the reader\'s words', () => {
    expect(explainNote('EL PROMPT')).toContain('EL PROMPT');
  });

  it('says the relief is for this reply only', () => {
    expect(explainNote('x')).toContain('For this reply only');
  });
});

describe('passageNote while explaining', () => {
  it('stops forbidding what the analogy needs', () => {
    // An everyday analogy is by definition from outside the passage; asking
    // for one while forbidding it is why the first answers had none.
    const asking = passageNote('un pasaje');
    const explaining = passageNote('un pasaje', { explaining: true });
    expect(asking).toContain('rather than filling the gap from elsewhere');
    expect(explaining).not.toContain('rather than filling the gap from elsewhere');
    expect(explaining).toContain('go outside it freely');
  });

  it('still delivers the passage either way', () => {
    expect(passageNote('un pasaje', { explaining: true })).toContain('"un pasaje"');
  });
});
