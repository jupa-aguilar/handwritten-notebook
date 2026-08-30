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

// Words worth matching on. Short ones are the scaffolding every sentence has
// — de, la, que — and matching on those would make everything look relevant.
const TERMS_FROM = 4;
const terms = (s) => new Set(words(s).filter((w) => w.length >= TERMS_FROM));

// How much a candidate answer has to do with what is being asked. Coming off
// the same page is not enough, and that was the flaw the first version had:
// "CPU y RAM de varios servidores" sits on the same page as "¿qué diferencia
// hay entre replicación y backup?" and answers nothing like it, so the right
// option stood out without being read. What makes a decoy work is speaking
// about the same thing as the question.
function relevance(text, card) {
  const asked = terms(`${card?.q || ''} ${card?.a || ''}`);
  if (!asked.size) return 0;
  let shared = 0;
  for (const w of terms(text)) if (asked.has(w)) shared++;
  return shared;
}

// How many of a card's own written decoys to keep before filling from the
// deck. All of them, when it has them: they were written for this question.
export function storedDecoys(card) {
  return (card?.decoys || []).map((d) => String(d || '').trim()).filter(Boolean);
}

/**
 * `{ options, correct, weak }` — the answers to offer, which index is right,
 * and whether the decoys had to be scraped together from unrelated answers —
 * or null when no honest question can be built, in which case the caller
 * should fall back to asking for the answer outright.
 */
export function buildChoices(card, deck, { count = CHOICE_COUNT, rng = Math.random } = {}) {
  const answer = (card?.a || '').trim();
  if (!answer) return null;

  const pool = [];
  // Decoys written for this question come first and are never called weak.
  for (const text of storedDecoys(card)) {
    if (!tooClose(text, answer)) pool.push({ text, relevance: Infinity, rank: -1, card });
  }
  for (const other of deck || []) {
    if (other === card || (card?.id != null && other?.id === card.id)) continue;
    const text = (other?.a || '').trim();
    if (!text || tooClose(text, answer)) continue;
    pool.push({
      text,
      relevance: relevance(text, card),
      // Same page next: those answers are about the same material. Then the
      // same topic, then anywhere in the notebook.
      rank:
        other.pageId != null && other.pageId === card.pageId
          ? 0
          : other.topic && other.topic === card.topic
            ? 1
            : 2,
      card: other,
    });
  }

  // Relevance outranks the page, because a decoy from elsewhere that talks
  // about the question beats one from the same page that doesn't. Length
  // breaks the ties: on a deck where some answers are a term and others a
  // whole line, three short decoys around a long answer give it away by its
  // shape before a word is read.
  pool.sort(
    (a, b) =>
      b.relevance - a.relevance ||
      a.rank - b.rank ||
      Math.abs(a.text.length - answer.length) - Math.abs(b.text.length - answer.length)
  );

  const decoys = [];
  let weak = false;
  for (const candidate of pool) {
    if (decoys.length >= count - 1) break;
    // Two decoys saying the same thing waste an option and read as a mistake.
    if (decoys.some((d) => tooClose(d, candidate.text))) continue;
    if (!candidate.relevance) weak = true;
    decoys.push(candidate.text);
  }
  if (decoys.length < count - 1) return null;

  const options = shuffled([answer, ...decoys], rng);
  return { options, correct: options.indexOf(answer), weak };
}

// Cards the notebook cannot furnish a believable question for: no options at
// all, or options with nothing to do with what is asked. These are the ones
// worth spending a model call on.
export function cardsNeedingDecoys(deck) {
  return (deck || []).filter((card) => {
    if (storedDecoys(card).length >= CHOICE_COUNT - 1) return false;
    const built = buildChoices(card, deck, { rng: () => 0 });
    return !built || built.weak;
  });
}
