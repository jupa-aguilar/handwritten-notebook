import { describe, it, expect } from 'vitest';
import { contextCharBudget, renderMarkdown } from '../src/chat.js';

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
