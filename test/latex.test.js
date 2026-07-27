import { describe, it, expect } from 'vitest';
import { latexToUnicode } from '../src/latex.js';

describe('latexToUnicode', () => {
  // Straight from a real reply about digital-logic notes, which is what
  // prompted this: the reader saw the backslashes.
  describe('the reply that started it', () => {
    it('converts inline logic operators', () => {
      expect(latexToUnicode('AND \\((\\land)\\)')).toBe('AND (∧)');
      expect(latexToUnicode('OR \\((\\lor)\\)')).toBe('OR (∨)');
      expect(latexToUnicode('NOT \\((\\neg)\\)')).toBe('NOT (¬)');
    });

    it('converts a half-adder', () => {
      expect(latexToUnicode('suma: \\(S=a\\oplus b\\)')).toBe('suma: S=a⊕b');
      expect(latexToUnicode('acarreo: \\(C=a\\land b\\)')).toBe('acarreo: C=a∧b');
    });

    it('converts the display formula, subscripts and all', () => {
      const out = latexToUnicode(
        '\\[\nF_1(x_1,\\ldots,x_n),\\ldots,F_m(x_1,\\ldots,x_n)\n\\]'
      );
      expect(out).toContain('F₁(x₁,…,xₙ)');
      expect(out).toContain('Fₘ(x₁,…,xₙ)');
      expect(out).not.toContain('\\');
    });

    it('converts the values in a sentence', () => {
      expect(latexToUnicode('para \\(a=1\\) y \\(b=1\\)')).toBe('para a=1 y b=1');
    });
  });

  describe('delimiters', () => {
    it('handles all four styles', () => {
      expect(latexToUnicode('\\(x\\)')).toBe('x');
      expect(latexToUnicode('$x$')).toBe('x');
      expect(latexToUnicode('\\[x\\]')).toBe('\nx\n');
      expect(latexToUnicode('$$x$$')).toBe('\nx\n');
    });

    it('puts display maths on its own line', () => {
      expect(latexToUnicode('antes \\[a+b\\] después')).toBe('antes \na+b\n después');
    });

    // "$5 and $6" is not a formula, and reading it as one would eat the text
    // between two unrelated prices.
    it('leaves currency alone', () => {
      expect(latexToUnicode('cuesta $5 y $6 en total')).toBe('cuesta $5 y $6 en total');
      expect(latexToUnicode('entre $10 y $20')).toBe('entre $10 y $20');
    });

    it('still converts commands that lost their delimiters', () => {
      expect(latexToUnicode('a \\land b')).toBe('a ∧ b');
    });
  });

  describe('symbols', () => {
    it('covers relations, arrows and sets', () => {
      expect(latexToUnicode('\\(a \\leq b \\neq c\\)')).toBe('a ≤ b ≠ c');
      expect(latexToUnicode('\\(a \\Rightarrow b\\)')).toBe('a ⇒ b');
      expect(latexToUnicode('\\(x \\in A \\cup B\\)')).toBe('x ∈ A ∪ B');
    });

    it('covers greek', () => {
      expect(latexToUnicode('\\(\\alpha + \\beta = \\Omega\\)')).toBe('α + β = Ω');
    });

    // \in is a prefix of \infty; a careless replace turns "∈fty" out.
    it('does not let a short command eat a longer one', () => {
      expect(latexToUnicode('\\(\\infty\\)')).toBe('∞');
    });

    it('leaves unknown commands readable rather than mangled', () => {
      expect(latexToUnicode('\\(\\notacommand x\\)')).toContain('\\notacommand');
    });
  });

  describe('structures', () => {
    it('unwraps fractions and roots', () => {
      expect(latexToUnicode('\\(\\frac{a}{b}\\)')).toBe('(a)/(b)');
      expect(latexToUnicode('\\(\\sqrt{2}\\)')).toBe('√(2)');
    });

    it('unwraps text wrappers', () => {
      expect(latexToUnicode('\\(\\text{si } x > 0\\)')).toBe('si x > 0');
    });

    it('handles braced subscripts and superscripts', () => {
      expect(latexToUnicode('\\(x_{10}\\)')).toBe('x₁₀');
      expect(latexToUnicode('\\(x^{2}\\)')).toBe('x²');
      expect(latexToUnicode('\\(2^n\\)')).toBe('2ⁿ');
    });

    // Half a subscript is worse than none: "x_ab" would become "xₐb".
    it('leaves a subscript alone when it cannot convert all of it', () => {
      expect(latexToUnicode('\\(x_{qz}\\)')).toBe('x_qz');
    });
  });

  describe('leaving prose alone', () => {
    it('returns text with no maths untouched', () => {
      const prose = 'Hablas de circuitos combinatorios en (p. 70-77).';
      expect(latexToUnicode(prose)).toBe(prose);
    });

    it('handles empty and missing input', () => {
      expect(latexToUnicode('')).toBe('');
      expect(latexToUnicode(null)).toBe(null);
    });

    it('does not disturb a windows path or a stray backslash', () => {
      expect(latexToUnicode('C:\\Users\\jaguilar')).toBe('C:\\Users\\jaguilar');
    });
  });
});
