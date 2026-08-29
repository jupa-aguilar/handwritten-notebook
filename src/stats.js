// What the review loop leaves behind: how often each card is answered, at which
// rung of the hint ladder, and how that shifts over weeks.
//
// The interesting number here is not the accuracy — a scheduler that works
// keeps that near flat by design, showing you the cards you are about to
// forget. It is the *rung*: the same deck answered with less and less help is
// what learning actually looks like from outside, and it is the one thing a
// plain SRS never records.
//
// Deliberately free of storage and DOM, like srs.js and for the same reason:
// the arithmetic is the part worth testing, and it can only be tested if
// nothing here knows where the numbers came from.

// The rungs of the ladder in review.js: answered cold, after the written hint,
// after seeing the line it was written on.
export const RUNGS = 3;

// Again is the only miss. Hard is "that cost me", not "I didn't have it" —
// which is what it means to the scheduler, and what `lapses` has always
// counted.
const isMiss = (grade) => grade === 'again';

const triple = (v) => {
  const out = [0, 0, 0];
  for (let i = 0; i < RUNGS; i++) out[i] = Number(v?.[i]) || 0;
  return out;
};

export const emptyStats = () => ({ answered: [0, 0, 0], missed: [0, 0, 0] });

export const normaliseStats = (s) => ({
  answered: triple(s?.answered),
  missed: triple(s?.missed),
});

export const sum = (t) => (t || []).reduce((a, b) => a + (Number(b) || 0), 0);

// One answer, recorded against the rung it was given at. Returns fresh stats;
// the caller persists them, as everything else in this loop does.
export function recordAnswer(stats, grade, step = 0) {
  const next = normaliseStats(stats);
  const rung = Math.min(RUNGS - 1, Math.max(0, Math.trunc(Number(step) || 0)));
  next.answered[rung] += 1;
  if (isMiss(grade)) next.missed[rung] += 1;
  return next;
}

// ---------- the day rows ----------

// Local date, not UTC: the day a review belongs to is the day the reader was
// having, and near midnight the two disagree by one.
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 'YYYY-MM-DD' truncated to the unit asked for. The keys sort lexically in
// time order at every unit, which is the whole reason for the format.
export function bucketKey(day, unit = 'day') {
  if (unit === 'year') return day.slice(0, 4);
  if (unit === 'month') return day.slice(0, 7);
  return day;
}

// Rows arrive one per device per day — the shared tally keeps them apart so
// nobody overwrites anybody — and adding them up is exactly what the reader
// wants to see, so the sum happens here.
export function bucket(rows, unit = 'day') {
  const out = new Map();
  for (const row of rows || []) {
    if (!row?.day) continue;
    const key = bucketKey(row.day, unit);
    const at = out.get(key) || { key, answered: [0, 0, 0], missed: [0, 0, 0] };
    const a = triple(row.answered);
    const m = triple(row.missed);
    for (let i = 0; i < RUNGS; i++) {
      at.answered[i] += a[i];
      at.missed[i] += m[i];
    }
    out.set(key, at);
  }
  return out;
}

// The last `count` buckets ending today, **including the ones with nothing in
// them**. A day you did not study is a gap in the chart, not a zero score, and
// leaving it out entirely would quietly close the gap up and draw a run of
// consecutive days that never happened.
export function series(rows, unit = 'day', count = 30, now = Date.now()) {
  const filled = bucket(rows, unit);
  const out = [];
  const d = new Date(now);
  for (let i = count - 1; i >= 0; i--) {
    const at = new Date(d);
    if (unit === 'day') at.setDate(d.getDate() - i);
    else if (unit === 'month') at.setMonth(d.getMonth() - i, 1);
    else at.setFullYear(d.getFullYear() - i, 0, 1);
    const key = bucketKey(dayKey(at.getTime()), unit);
    out.push(filled.get(key) || { key, answered: [0, 0, 0], missed: [0, 0, 0] });
  }
  return out;
}

// Everything the header needs from a set of rows or buckets.
export function summarise(rows) {
  const answered = [0, 0, 0];
  const missed = [0, 0, 0];
  for (const row of rows || []) {
    const a = triple(row.answered);
    const m = triple(row.missed);
    for (let i = 0; i < RUNGS; i++) {
      answered[i] += a[i];
      missed[i] += m[i];
    }
  }
  const total = sum(answered);
  const misses = sum(missed);
  return {
    answered,
    missed,
    total,
    right: total - misses,
    // Null rather than 0 or 100 on an empty deck: there is no accuracy yet,
    // and either number would be a claim about nothing.
    accuracy: total ? (total - misses) / total : null,
    unaided: total ? answered[0] / total : null,
  };
}

// ---------- which cards are fighting the reader ----------

// Below this a card has not been asked enough for its record to mean anything:
// one bad morning would otherwise put it top of the list.
export const MIN_ATTEMPTS = 3;

// How much trouble a card is, and the evidence for saying so. Null when there
// is nothing to say — most of the deck, most of the time.
//
// Two sources, deliberately not blended into one number that hides which is
// which: a card answered since the tallies existed is judged on them, and one
// from before is judged on `lapses`, which is the count of outright failures
// it has carried all along. Callers show the evidence for that reason.
export function struggle(card) {
  const s = normaliseStats(card?.stats);
  const attempts = sum(s.answered);

  if (attempts >= MIN_ATTEMPTS) {
    const misses = sum(s.missed);
    const hinted = s.answered[1] + s.answered[2];
    // Needing the line is more trouble than needing the written nudge, which
    // is more trouble than needing nothing. Half-weighted against the miss
    // rate: leaning on a hint is a smaller thing than failing outright.
    const leaning = (s.answered[1] + s.answered[2] * 2) / attempts;
    const score = misses / attempts + leaning * 0.5;
    // Never missed and never needed help: there is no trouble here to report,
    // and a card at zero has no business in a list of cards fighting you.
    if (score === 0) return null;
    return { tracked: true, score, attempts, misses, hinted, unaided: s.answered[0] };
  }

  const lapses = card?.lapses || 0;
  if (lapses < 2) return null;
  return { tracked: false, score: lapses / (lapses + 2), attempts, misses: lapses, hinted: 0, unaided: 0 };
}

export function worstCards(cards, limit = 10) {
  return (cards || [])
    .map((card) => ({ card, record: struggle(card) }))
    .filter((row) => row.record)
    .sort((a, b) => b.record.score - a.record.score)
    .slice(0, limit);
}

// A card's record in words, because a score on its own is a number nobody can
// argue with. Says plainly which of the two sources it rests on.
export function describeRecord(record) {
  if (!record) return '';
  if (!record.tracked) {
    return `${record.misses} lapses before this was tracked in detail`;
  }
  const parts = [
    `asked ${record.attempts} time${record.attempts === 1 ? '' : 's'}`,
    `missed ${record.misses}`,
  ];
  if (record.hinted) {
    parts.push(
      record.unaided
        ? `${record.hinted} answered with help`
        : 'never answered without help'
    );
  }
  return parts.join(' · ');
}
