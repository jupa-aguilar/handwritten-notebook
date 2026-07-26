import { describe, it, expect, beforeEach } from 'vitest';
import {
  contextCharBudget,
  renderMarkdown,
  chatWorksWithoutLocalServer,
  buildSystemPrompt,
  getChatSpend,
  recordSpend,
  resetChatSpend,
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

describe('chat spend', () => {
  beforeEach(() => {
    resetChatSpend();
  });

  it('starts empty', () => {
    const s = getChatSpend();
    expect(s.messages).toBe(0);
    expect(s.dollars).toBe(0);
  });

  it('prices input, cached input and output at their different rates', () => {
    // 1M uncached input ($1) + 1M cached ($0.10) + 1M output ($6)
    recordSpend({
      prompt_tokens: 2_000_000,
      prompt_tokens_details: { cached_tokens: 1_000_000 },
      completion_tokens: 1_000_000,
    });
    const s = getChatSpend();
    expect(s.input).toBe(1_000_000);
    expect(s.cachedInput).toBe(1_000_000);
    expect(s.output).toBe(1_000_000);
    expect(s.dollars).toBeCloseTo(7.1, 6);
  });

  it('accumulates across messages', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 100 };
    recordSpend(usage);
    recordSpend(usage);
    const s = getChatSpend();
    expect(s.messages).toBe(2);
    expect(s.input).toBe(2000);
  });

  it('treats a reply with no cache details as fully uncached', () => {
    recordSpend({ prompt_tokens: 1000, completion_tokens: 0 });
    const s = getChatSpend();
    expect(s.input).toBe(1000);
    expect(s.cachedInput).toBe(0);
  });

  // A cached count larger than the prompt would otherwise push input negative
  // and quietly refund money that was spent.
  it('never lets a malformed usage report drive the count below zero', () => {
    recordSpend({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 999 },
      completion_tokens: 0,
    });
    expect(getChatSpend().input).toBe(0);
  });

  it('ignores a reply that reported no usage at all', () => {
    recordSpend(null);
    expect(getChatSpend().messages).toBe(0);
  });

  it('resets when the stored month is not the current one', () => {
    recordSpend({ prompt_tokens: 5000, completion_tokens: 500 });
    const stored = JSON.parse(localStorage.getItem('notebook.chatSpend'));
    localStorage.setItem(
      'notebook.chatSpend',
      JSON.stringify({ ...stored, month: '2020-01' })
    );
    expect(getChatSpend().messages).toBe(0);
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('notebook.chatSpend', 'not json');
    expect(getChatSpend().dollars).toBe(0);
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
