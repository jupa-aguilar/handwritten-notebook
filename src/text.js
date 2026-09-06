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

// Strip everything but letters and digits, so an OCR word carrying whatever
// punctuation Vision grouped onto it ("núcleo." "«mundo»") still matches the
// bare token a citation was given.
function bareWord(s) {
  return s.replace(/[^\p{L}\p{N}]+/gu, '');
}

// Whether one OCR-detected word *is* a citation token, whole-word rather than
// substring. Citation is the one caller left that wants this: a quote from a
// model reading an OCR transcript should survive one mistranscribed word, so
// it's matched any-of/whole-word rather than as a literal phrase (see
// wordsMatchingPhrase below for the search box's own, substring version of
// this same question).
export function wordMatchesToken(word, token) {
  return bareWord(foldText(word)) === token;
}

// Index of the query phrase in `text`, or -1. Runs against foldText(text) —
// 1:1 per character with the original (foldText's own invariant), which is
// what lets this index double as an index into `text` itself for slicing a
// snippet out of it. `\s+` stands in for the whitespace searchTokens split
// the query on, so a query typed with single spaces still finds a phrase the
// source wrapped onto two real lines. This is the one place that does the
// whitespace-tolerant search — pageHasPhrase and the search results' snippet
// both call it rather than re-implementing it, so they can't disagree.
export function phraseIndex(text, query) {
  const words = searchTokens(query);
  if (!words.length) return -1;
  const re = new RegExp(words.map(accentPattern).join('\\s+'), 'iu');
  const m = re.exec(foldText(text));
  return m ? m.index : -1;
}

// A page is a search hit when the literal phrase appears on it — real
// PDF-style substring search, tolerant only of case, accents and whitespace
// runs, like a Cmd+F. "cancion manana" no longer credits a page that only
// ever puts those two words in unrelated sentences; the words have to run
// together, in order, the way they were typed.
export function pageHasPhrase(page, query) {
  if (!searchTokens(query).length) return true; // empty query matches every page
  return phraseIndex(page.text || '', query) >= 0;
}

// Which of a page's OCR words fall inside a genuine occurrence of the
// (possibly multi-word) query phrase — a sliding window over page.words,
// already in reading order. Every word in the window must *contain*
// (substring, not equality) the matching query word, so a single-word query
// degenerates to "does this OCR word contain the query" — no punctuation
// stripped from either side, which is what lets "A.4" match the single OCR
// word Vision transcribed it as. Boxes every occurrence, not just the first:
// a phrase can genuinely appear more than once on a page, and a PDF-style
// search highlights every one.
//
// Scope limit, accepted rather than chased: a query that starts or ends
// *inside* one OCR word shared with the next query word at a boundary Vision
// didn't segment on isn't found. An honest miss beats a wrong box — the same
// call made for review-card anchoring.
export function wordsMatchingPhrase(words, query) {
  const qWords = searchTokens(query);
  if (!qWords.length || !words?.length) return [];
  const hit = new Set();
  for (let i = 0; i + qWords.length <= words.length; i++) {
    let ok = true;
    for (let k = 0; k < qWords.length; k++) {
      if (!foldText(words[i + k].t).includes(qWords[k])) {
        ok = false;
        break;
      }
    }
    if (ok) for (let k = 0; k < qWords.length; k++) hit.add(i + k);
  }
  return [...hit].sort((a, b) => a - b).map((i) => words[i]);
}

// The word boxes that survive a transcription edited by hand.
//
// The boxes carry their own copy of each word and every mark drawn on the page
// image is drawn from them, so a transcript rewritten without them would leave
// the new words findable in the text and unmarked on the scan — or worse,
// marked on whatever ink now sits where they used to be.
//
// This works in characters, not words, and that is the whole trick. Vision cuts
// its word list differently from the text it returns beside it — the same page
// gives boxes "a" ")" "sucesos" ":" "A" ":" where page.text has "a)" "sucesos:"
// "A:", and it is not a rule you can restate: on one line it splits the full
// stop off, on the next it keeps "A." whole. Measured on a real page that is
// 159 boxes against 138 words, so anything that pairs them word by word reads
// every line as rewritten. What *is* exact is that the boxes' own words run
// together are the transcription with its whitespace taken out — both were cut
// from the same page — so counting characters places every box precisely,
// without a guess anywhere.
//
// A box is kept when every character of its word came through the edit intact
// and still sits together, and dropped otherwise: a box is a claim about where
// a word is written, and half a word that survived is not that word. So the
// word you retype loses its mark on the image until the page is read again,
// and nothing else on the page is disturbed. Splitting one word into two or
// joining two into one keeps both boxes, and should: whitespace was never in
// them, and the ink did not move.
export function realignWords(words, newText) {
  const olds = words || [];
  if (!olds.length) return [];
  const texts = olds.map((w) => String(w.t || ''));
  const oldRun = texts.join('');
  const newRun = String(newText || '').replace(/\s+/gu, '');
  if (!oldRun || !newRun) return [];

  // Folded, so an accent the edit put back still counts as the same character
  // — foldText is 1:1 per character, which is what lets these indexes address
  // the unfolded string underneath.
  const a = foldText(oldRun);
  const b = foldText(newRun);

  // Where each old character ended up, or -1 for one the edit took away.
  const landed = new Int32Array(a.length).fill(-1);

  // An edit leaves most of a page alone, so only the part that actually
  // differs needs aligning. Trimming the shared head and tail first is what
  // makes this affordable — and it is not an optimisation, it is the fix for a
  // real failure: sized for handwriting, the cap below used to be reached by an
  // ordinary typeset page (2,316 characters squared is 5.4M), and every box on
  // it was dropped for the sake of one corrected word.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    landed[head] = head;
    head++;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    landed[a.length - 1 - tail] = b.length - 1 - tail;
    tail++;
  }

  const n = a.length - head - tail;
  const m = b.length - head - tail;
  // What is left is a genuine quadratic on text the user can type, so it still
  // needs a ceiling. Past it the middle is simply left unaligned: the head and
  // tail keep their boxes, which is the same answer this gives for any run it
  // cannot follow, and a great deal better than abandoning the page.
  if (n > 0 && m > 0 && n * m <= 16_000_000) {
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] =
          a[head + i] === b[head + j]
            ? lcs[i + 1][j + 1] + 1
            : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (a[head + i] === b[head + j]) landed[head + i++] = head + j++;
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
      else j++;
    }
  }

  const out = [];
  let at = 0;
  for (let k = 0; k < olds.length; k++) {
    const start = at;
    at += texts[k].length;
    if (!texts[k].length) continue;
    let whole = landed[start] !== -1;
    for (let i = start + 1; whole && i < at; i++) {
      if (landed[i] !== landed[i - 1] + 1) whole = false;
    }
    // The word comes back from the new text rather than the old, so a box whose
    // only change was an accent being restored carries the accent.
    if (whole) out.push({ ...olds[k], t: newRun.slice(landed[start], landed[start] + texts[k].length) });
  }
  return out;
}

// A hand-drawn rectangle's own words, in the same image-pixel space as
// page.words. Judged by each word's centre point, not overlap: a box that
// only grazes a word's edge probably wasn't meant to catch it.
export function wordsInRect(words, rect) {
  if (!rect || rect.w <= 0 || rect.h <= 0) return [];
  return (words || []).filter((w) => {
    const cx = w.x + w.w / 2;
    const cy = w.y + w.h / 2;
    return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
  });
}

// One line of text from a run of OCR words already in reading order
// (extractWords in ocr.js flattens page→block→paragraph→word in order) —
// this never re-sorts, so a caller passing words from elsewhere doesn't get
// a silent surprise.
export function wordsToText(words) {
  return (words || []).map((w) => w.t).join(' ').trim();
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
  const words = searchTokens(query);
  if (words.length === 0) return safe;
  // One phrase pattern, not one alternative per word: a query is a literal,
  // whitespace-tolerant substring match now, not "any of these words,
  // whole-word only" — the same real PDF-style search as pageHasPhrase. \s+
  // between query words tolerates a line break in the source. No
  // word-boundary lookaround any more — "dos" marks inside "todos" on
  // purpose. There's only one pattern, so "longest match wins" no longer
  // applies — that was about choosing between independent alternatives.
  const pattern = words.map(accentPattern).join('\\s+');
  return safe.replace(new RegExp(pattern, 'giu'), '<mark>$&</mark>');
}
