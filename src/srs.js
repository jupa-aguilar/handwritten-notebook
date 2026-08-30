// Spaced repetition scheduling: SM-2 with the two corrections every practical
// implementation ends up making. A forgotten card comes back in minutes rather
// than being sent to a full day (the whole point of failing it is to see it
// again in this session), and the ease factor has a floor, or a bad week
// leaves a card pinned at the minimum interval long after it was learned.
//
// Deliberately free of storage and DOM: the scheduler is the one part of the
// review loop that is pure arithmetic, so it is the part that can be tested.
// Everything here takes a card and returns a *new* one — callers persist it.

export const GRADES = ['again', 'hard', 'good', 'easy'];

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// A failed card returns inside the same sitting. Not zero: answering it again
// immediately is recognition, not recall.
const RELEARN_STEP = 10 * MINUTE;

const START_EASE = 2.5;
const MIN_EASE = 1.3; // SM-2's own floor; below it intervals stop growing
const MAX_EASE = 2.7;
// Two years is far past the point where the schedule still says anything
// useful, and it keeps `due` from drifting into dates the UI can't phrase.
const MAX_INTERVAL = 730;

const clampEase = (e) => Math.min(MAX_EASE, Math.max(MIN_EASE, e));
const clampInterval = (d) => Math.min(MAX_INTERVAL, d);

// The scheduling half of a card. Kept separate from its content so callers can
// spread it over whatever else the card carries (question, answer, page).
export function newSchedule(now = Date.now()) {
  return { ease: START_EASE, interval: 0, reps: 0, lapses: 0, due: now, reviewedAt: 0 };
}

// Days until the next sight of `card` if it were graded `grade` right now.
// Split out from review() because the buttons show it before you press them —
// knowing that "good" means three weeks is half of why the grades mean
// anything.
export function nextInterval(card, grade) {
  const ease = card.ease ?? START_EASE;
  const interval = card.interval || 0;
  const reps = card.reps || 0;
  const learning = reps === 0 || interval === 0;

  // What the ordinary answer is worth. The other two are defined against it,
  // because that is what they mean: "sooner than usual" and "later than
  // usual". Left to their own formulas they drifted into nonsense — on a new
  // card Hard and Good both said one day, and on the second review Easy came
  // back *sooner* than Good, since Good's fixed second step outran it.
  const good = learning
    ? 1
    : reps === 1
      ? interval < 1
        ? 3 // graduated through Hard, so a shorter second step than the usual 6
        : 6 // SM-2's fixed second step
      : clampInterval(interval * ease);

  switch (grade) {
    case 'again':
      return 0; // minutes, not days — see RELEARN_STEP
    case 'hard':
      // Still growing: a card you struggled through has been recalled, and
      // repeating today's interval tomorrow teaches nothing. Never as far as
      // Good, or the two buttons promise a difference they don't make.
      return learning
        ? 0.5
        : clampInterval(Math.min(Math.max(interval + 1, interval * 1.2), good * 0.9));
    case 'easy':
      // Always past Good. Pressing "that was easy" must not bring the card
      // back sooner than the answer that admits nothing.
      return learning ? 4 : clampInterval(Math.max(good * 1.3, good + 1));
    case 'good':
    default:
      return good;
  }
}

// Grade a card. Returns the card with fresh scheduling; the content fields
// ride along untouched.
export function review(card, grade, now = Date.now()) {
  if (!GRADES.includes(grade)) throw new Error(`unknown grade: ${grade}`);
  const ease = card.ease ?? START_EASE;
  const interval = nextInterval(card, grade);

  if (grade === 'again') {
    return {
      ...card,
      ease: clampEase(ease - 0.2),
      interval: 0,
      // Not reset to zero: the card re-graduates through the short steps, but
      // its history is what tells the UI this is a lapse and not a new card.
      reps: 0,
      lapses: (card.lapses || 0) + 1,
      due: now + RELEARN_STEP,
      reviewedAt: now,
    };
  }

  const delta = grade === 'hard' ? -0.15 : grade === 'easy' ? 0.15 : 0;
  return {
    ...card,
    ease: clampEase(ease + delta),
    interval,
    reps: (card.reps || 0) + 1,
    lapses: card.lapses || 0,
    due: now + Math.round(interval * DAY),
    reviewedAt: now,
  };
}

export function isDue(card, now = Date.now()) {
  return !card.suspended && (card.due || 0) <= now;
}

// The queue for one sitting: everything due, in a fresh order every time.
//
// This used to hand them over oldest first, which sounds like the careful
// choice and isn't. Cards are made a page at a time, so they graduate together
// and fall due together — in date order you answer four questions about one
// page in a row, and by the fourth the three before it have told you what the
// page is about. That is the context answering, not the reader. (It told on
// itself in the choice mode, where the decoys come from the same page: the
// same handful of answers kept coming back as options.)
//
// Its own shuffle rather than a shared one: the scheduler has no business
// importing the multiple-choice builder for six lines of Fisher-Yates, and
// this codebase has no bag-of-helpers module to put it in.
export function dueCards(cards, now = Date.now(), rng = Math.random) {
  const due = cards.filter((c) => isDue(c, now));
  for (let i = due.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [due[i], due[j]] = [due[j], due[i]];
  }
  return due;
}

// How a due count should read on a badge. Beyond three digits the number stops
// being information and starts being a reproach.
export function formatDueCount(n) {
  return n > 99 ? '99+' : String(n);
}

// The interval on a grade button. Days are the unit the scheduler thinks in,
// but nobody reads "0.007 d" or "45 d" as a length of time.
export function formatInterval(days) {
  if (!days) return '10 min';
  if (days < 1) return `${Math.round(days * 24)} h`;
  if (days < 30) return `${Math.round(days)} d`;
  if (days < 365) return `${Math.round(days / 30)} mes${Math.round(days / 30) === 1 ? '' : 'es'}`;
  const years = days / 365;
  return `${years < 10 ? years.toFixed(1) : Math.round(years)} a`;
}
