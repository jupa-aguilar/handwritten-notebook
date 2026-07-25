// Text helpers shared by the search box, the transcript panel, the on-image
// word boxes and the chat's page ranking. They all have to agree on what "a
// word" is and on how accents fold, so they live in one place — and being
// free of DOM and storage, they're the part of the app that can be unit
// tested (test/text.test.js).

export function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Lowercase and strip diacritics so search is accent-insensitive: "cancion"
// finds "canción" and vice versa. NFD splits each letter from its combining
// marks and dropping the marks leaves one char per source letter, so indexes
// into the folded string still line up with the original text.
export function foldText(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Accented variants each base letter should also match when highlighting.
const ACCENT_VARIANTS = {
  a: 'aáàâäãå',
  c: 'cç',
  e: 'eéèêë',
  i: 'iíìîï',
  n: 'nñ',
  o: 'oóòôöõ',
  u: 'uúùûü',
  y: 'yýÿ',
};

// Split a query into folded search words. Whitespace-separated; empty when
// the query is blank. Shared by the page filter, the highlighter and the
// word-box overlays so all three agree on what "a word" is.
export function searchTokens(query) {
  return foldText(query).split(/\s+/).filter(Boolean);
}

// A page is a search hit when its text contains every query word. Used both
// to filter the results list and to gate the word-box overlays, so a box
// never appears on a page the search reports as a non-match.
export function pageHasAllTokens(page, tokens) {
  const hay = foldText(page.text || '');
  return tokens.every((t) => hay.includes(t));
}

// Regex fragment matching one folded token, with each base letter widened to
// also match its accented forms (so the original accented text gets marked).
function accentPattern(token) {
  return [...token]
    .map((ch) =>
      ACCENT_VARIANTS[ch]
        ? `[${ACCENT_VARIANTS[ch]}]`
        : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('');
}

export function highlight(text, query) {
  const safe = escapeHtml(text);
  const tokens = searchTokens(query);
  if (tokens.length === 0) return safe;
  // Mark every query word wherever it appears. Longest first so "abc" wins
  // over "ab" when both are searched and overlap.
  const pattern = [...tokens]
    .sort((a, b) => b.length - a.length)
    .map(accentPattern)
    .join('|');
  return safe.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
}
