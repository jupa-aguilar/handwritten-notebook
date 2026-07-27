// LaTeX → Unicode, for chat replies about maths-y notebook pages.
//
// Models answer notes on logic, circuits or algebra in LaTeX whether or not
// you ask them to, and raw "\(\land\)" in a chat bubble is worse than no
// formatting at all. Rendering it properly means KaTeX or MathJax — some
// 300KB for an app whose entire bundle is a third of that — so instead the
// common commands are mapped to the characters they stand for. That covers
// the operators, subscripts and set notation that actually turn up in
// handwritten notes; anything exotic degrades to readable plain text rather
// than to backslashes.

const SYMBOLS = {
  // logic — the ones that prompted this
  land: '∧', wedge: '∧', lor: '∨', vee: '∨', neg: '¬', lnot: '¬',
  oplus: '⊕', otimes: '⊗', top: '⊤', bot: '⊥', therefore: '∴',
  // relations
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
  approx: '≈', equiv: '≡', sim: '∼', propto: '∝', cong: '≅',
  // arrows
  to: '→', rightarrow: '→', Rightarrow: '⇒', longrightarrow: '⟶',
  leftarrow: '←', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔',
  mapsto: '↦',
  // sets
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃',
  supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄',
  // operators and misc
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗',
  sum: '∑', prod: '∏', int: '∫', partial: '∂', nabla: '∇',
  infty: '∞', sqrt: '√', angle: '∠', perp: '⊥', parallel: '∥',
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  prime: '′', degree: '°', circ: '∘',
  // greek, lower and upper
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
  varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι',
  kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ' };
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', T: 'ᵀ' };

const known = (name) => Object.prototype.hasOwnProperty.call(SYMBOLS, name);

// Replace named commands with their symbol.
//
// A space after a command name is LaTeX's terminator, not output — "a\oplus b"
// is a⊕b, not "a⊕ b". But swallowing it unconditionally turns "a \land b"
// into "a ∧b", which reads worse than the problem. So it is only eaten when
// the command was glued to whatever preceded it.
function replaceSymbols(s) {
  return s
    .replace(/(\S)\\([A-Za-z]+) /g, (m, before, name) =>
      known(name) ? before + SYMBOLS[name] : m
    )
    .replace(/\\([A-Za-z]+)/g, (m, name) => (known(name) ? SYMBOLS[name] : m));
}

// Only convert when every character has a mapping — a half-converted
// subscript ("x₁₀" vs "x_1b") reads worse than leaving it alone.
function toScript(text, table) {
  let out = '';
  for (const ch of text) {
    if (!(ch in table)) return null;
    out += table[ch];
  }
  return out;
}

function scripts(s) {
  // Braced first: x_{10} must beat x_1 followed by a stray 0.
  return s
    .replace(/([A-Za-z0-9)\]])_\{([^{}]+)\}/g, (m, base, sub) => {
      const conv = toScript(sub, SUB);
      return conv ? base + conv : `${base}_${sub}`;
    })
    .replace(/([A-Za-z0-9)\]])\^\{([^{}]+)\}/g, (m, base, sup) => {
      const conv = toScript(sup, SUP);
      return conv ? base + conv : `${base}^${sup}`;
    })
    .replace(/([A-Za-z0-9)\]])_([A-Za-z0-9])/g, (m, base, sub) => {
      const conv = toScript(sub, SUB);
      return conv ? base + conv : m;
    })
    .replace(/([A-Za-z0-9)\]])\^([A-Za-z0-9])/g, (m, base, sup) => {
      const conv = toScript(sup, SUP);
      return conv ? base + conv : m;
    });
}

// The body of a formula, once its delimiters are off.
function convertMath(body) {
  let s = body;
  // Structures that wrap an argument, innermost first.
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g, '$1')
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
      .replace(/\\sqrt\{([^{}]*)\}/g, '√($1)')
      .replace(/\\overline\{([^{}]*)\}/g, '‾$1')
      .replace(/\\bar\{([^{}]*)\}/g, '‾$1');
  }
  // Named symbols. Longest names win because the regex is greedy, so
  // \in cannot eat the start of \infty.
  s = replaceSymbols(s);
  s = scripts(s);
  // Spacing commands and escaped punctuation carry no meaning here.
  s = s
    .replace(/\\[,;:!> ]/g, ' ')
    .replace(/\\\\/g, ' ')
    .replace(/\\([{}$%&#_])/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

/**
 * Replace LaTeX spans in `text` with their Unicode rendering. Handles the
 * four delimiter styles models use — \(…\), \[…\], $…$ and $$…$$ — plus bare
 * commands that escaped their delimiters, which happens often enough in
 * streamed replies to be worth catching.
 */
export function latexToUnicode(text) {
  if (!text || (!text.includes('\\') && !text.includes('$'))) return text;
  let s = text;

  // Display maths becomes its own line rather than vanishing into a sentence.
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (m, body) => `\n${convertMath(body)}\n`);
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (m, body) => `\n${convertMath(body)}\n`);
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (m, body) => convertMath(body));
  // Single $…$: require a non-space next to each delimiter so prices ("$5 and
  // $6") aren't read as a formula.
  s = s.replace(/\$(?!\s)([^$\n]*[^$\s])\$/g, (m, body) => convertMath(body));

  // Leftovers: a model that wrote \land outside any delimiter still meant ∧.
  s = replaceSymbols(s);
  return s;
}
