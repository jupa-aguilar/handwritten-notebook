// Turning one card and its deck into a multiple-choice question.
//
// The decoys are other answers the reader wrote, never anything invented. That
// costs nothing, works on a deck that already exists, and — the part that
// matters — cannot put a plausible falsehood next to somebody's own notes and
// have them study it.
//
// Recognition is a weaker thing to practise than recall, which is why this is a
// mode somebody switches on rather than the way the deck normally works. It
// earns its place as a way in: a deck you fail every card of is a deck you stop
// opening.
//
// Pure, like srs.js and stats.js and for the same reason.

import { foldText } from './text.js';

export const CHOICE_COUNT = 4;

const words = (s) =>
  foldText(s || '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// Is `small` a run of whole words inside `big`?
function within(small, big) {
  if (!small.length || small.length > big.length) return false;
  for (let i = 0; i + small.length <= big.length; i++) {
    if (small.every((w, j) => w === big[i + j])) return true;
  }
  return false;
}

// Two answers close enough that offering both would be a trick. Containment
// either way, not just equality: two cards from one page often answer with the
// same phrase inside a longer one, and an "incorrect" option that happens to be
// true is worse than having no options at all.
//
// Compared as whole words, never as raw substrings. On letters alone "Sí" is
// inside "sintetiza", so every short answer would be thrown out against any
// long one — which on a deck of mixed lengths is most of the good decoys.
function tooClose(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return true;
  return within(x, y) || within(y, x);
}

// Fisher-Yates, with the source of randomness passed in so tests can hold it
// still. Otherwise the correct answer's position is the one thing about this
// function that could not be checked.
function shuffled(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * `{ options, correct }` — the answers to offer and which index is right — or
 * null when no honest question can be built, in which case the caller should
 * fall back to asking for the answer outright.
 */
export function buildChoices(card, deck, { count = CHOICE_COUNT, rng = Math.random } = {}) {
  const answer = (card?.a || '').trim();
  if (!answer) return null;

  const pool = [];
  for (const other of deck || []) {
    if (other === card || (card?.id != null && other?.id === card.id)) continue;
    const text = (other?.a || '').trim();
    if (!text || tooClose(text, answer)) continue;
    pool.push({ text, card: other });
  }

  // Same page first: those answers are about the same material, so they are
  // believable without being true, which is the whole job of a decoy. Then the
  // same topic, then anywhere in the notebook.
  //
  // And within that, the closest in length. On a deck where some answers are a
  // single term and others a whole line, three short decoys around a long
  // answer give it away by its shape, before a word has been read.
  const rank = (o) =>
    o.card.pageId != null && o.card.pageId === card.pageId
      ? 0
      : o.card.topic && o.card.topic === card.topic
        ? 1
        : 2;
  pool.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Math.abs(a.text.length - answer.length) - Math.abs(b.text.length - answer.length)
  );

  const decoys = [];
  for (const candidate of pool) {
    if (decoys.length >= count - 1) break;
    // Two decoys saying the same thing waste an option and read as a mistake.
    if (decoys.some((d) => tooClose(d, candidate.text))) continue;
    decoys.push(candidate.text);
  }
  if (decoys.length < count - 1) return null;

  const options = shuffled([answer, ...decoys], rng);
  return { options, correct: options.indexOf(answer) };
}
