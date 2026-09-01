// What this account has consumed: pages sent to Google Vision, and what the
// hosted chat has cost.
//
// The two are counted over different spans, because they are refilled
// differently. Vision's free tier renews on the 1st, so the page count is
// scoped to the month and a zero there is the truth. OpenAI's is a balance
// that is topped up, not renewed: nothing about it happens on the 1st, so the
// chat's figures run from the last top-up and only a press zeroes them.
// Expiring them by the calendar had the popover announcing "the chat hasn't
// been used" over money that was still owed.
//
// Both quotas are shared — the Vision free tier belongs to a Cloud project,
// the chat spend to an OpenAI account — so a per-device tally is not just
// incomplete, it misleads: a phone showing "0 pages" while the desktop has
// used 277 suggests there is a whole free tier left.
//
// So the counters add up across devices, through the same Drive folder as the
// notebooks. They can't be reconciled last-write-wins the way a notebook can:
// these are running totals, and a device that wrote its own over the shared
// one would erase everybody else's. Instead each device owns one entry and
// only ever writes that; the figure shown is the sum. (A grow-only counter —
// no locking, no conflicts, and a device that never syncs still counts its
// own use correctly.)

const DEVICE_KEY = 'notebook.deviceId';
const OCR_KEY = 'notebook.usage';
const SPEND_KEY = 'notebook.chatSpend';
const SPEND_RESET_KEY = 'notebook.chatSpendReset'; // when the chat total was last zeroed
const OTHERS_KEY = 'notebook.usageOthers'; // last known totals from other devices

// A device that hasn't reported in half a year isn't coming back, and its
// spend was billed long ago. Without a cutoff the shared file would grow a
// dead entry per browser profile, forever — and the month it used to be pruned
// by can't do that job now that a device's spend outlives its month.
const DORMANT_MS = 180 * 24 * 60 * 60 * 1000;

// Per million tokens, as published 2026-07. Cached input is what makes a
// stable system prompt worth having — see buildSystemPrompt in chat.js.
const PRICE_PER_MTOK = { input: 1.0, cachedInput: 0.1, output: 6.0 };

// The month the reader is having, not the one UTC is having. toISOString()
// was rolling these counters over at 21:00 on the last day of the month for
// anyone three hours west of it: the stored figures still said August, this
// said September, and every one of them read as expired — a hundred pages of
// transcription and a month of chat, apparently gone, three hours early.
//
// Same reasoning as dayKey() in stats.js, and the same fix.
export function thisMonth(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// The first instant of a stored `YYYY-MM`, in the reader's own calendar. Dates
// the figures written back when the spend expired monthly and so carried no
// start of its own.
function monthStart(month) {
  const [y, m] = String(month || '').split('-').map(Number);
  return y && m ? new Date(y, m - 1, 1).getTime() : 0;
}

// Identifies this browser profile in the shared tally. Not an identity: it
// only has to be stable here and different from everyone else's.
export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function readJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

// ---------- this device's own tally ----------

const emptyOcr = () => ({ month: thisMonth(), count: 0 });

export function getOwnOcr() {
  const u = readJson(OCR_KEY, null);
  return u && u.month === thisMonth() && typeof u.count === 'number' ? u : emptyOcr();
}

/**
 * The stored tally exactly as it is, month and all. getOwnOcr() hides an older
 * month behind a zero, which is right for counting and wrong for explaining:
 * "0 / 1000" on the first of the month reads as a figure that went missing.
 */
export function ownOcrRecord() {
  const u = readJson(OCR_KEY, null);
  return u && typeof u.count === 'number' ? u : null;
}

export function bumpOcr() {
  const u = getOwnOcr();
  u.count += 1;
  localStorage.setItem(OCR_KEY, JSON.stringify(u));
}

const emptySpend = (since = 0) => ({
  since,
  input: 0,
  cachedInput: 0,
  output: 0,
  messages: 0,
});

/** When this device's chat figures started counting; 0 if they never have. */
export function spendResetAt() {
  return Number(localStorage.getItem(SPEND_RESET_KEY)) || 0;
}

export function getOwnSpend() {
  const s = readJson(SPEND_KEY, null);
  if (!s || typeof s.input !== 'number') return emptySpend(spendResetAt());
  return {
    // Records written while the tally was monthly carry a `month` and no
    // start. That money was still spent, so keep the figures and date them
    // from the month they were counted in rather than dropping them.
    since: typeof s.since === 'number' ? s.since : monthStart(s.month),
    input: s.input,
    cachedInput: s.cachedInput || 0,
    output: s.output || 0,
    messages: s.messages || 0,
  };
}

/**
 * Start the chat total again — what you press after topping up the balance it
 * is measuring. Stamped rather than merely cleared, so that the other devices
 * can tell a reset from a device that simply hasn't spent anything: they zero
 * themselves on their next sync and stop counting entries older than the stamp.
 */
export function clearOwnSpend(at = Date.now()) {
  localStorage.setItem(SPEND_RESET_KEY, String(at));
  localStorage.setItem(SPEND_KEY, JSON.stringify(emptySpend(at)));
  const others = getOthers();
  localStorage.setItem(
    OTHERS_KEY,
    JSON.stringify({ ...others, since: 0, input: 0, cachedInput: 0, output: 0, messages: 0 })
  );
  return at;
}

// Take on a reset made on another device. Runs before this device reads the
// shared file *and* before it writes to it: writing first would put the
// settled figures back up under a fresh timestamp, and every other device
// would count the paid bill all over again.
function adoptSpendReset(shared) {
  const theirs = Number(shared?.spendResetAt) || 0;
  return theirs > spendResetAt() ? clearOwnSpend(theirs) : spendResetAt();
}

// `usage` as the API reports it. Cached prompt tokens are counted separately
// because they cost a tenth; they arrive nested in prompt_tokens_details.
export function recordSpend(usage) {
  if (!usage) return false;
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  const prompt = usage.prompt_tokens || 0;
  const s = getOwnSpend();
  if (!s.since) s.since = Date.now();
  s.input += Math.max(0, prompt - cached);
  s.cachedInput += cached;
  s.output += usage.completion_tokens || 0;
  s.messages += 1;
  localStorage.setItem(SPEND_KEY, JSON.stringify(s));
  return true;
}

export function resetOwnUsage() {
  localStorage.removeItem(OCR_KEY);
  localStorage.removeItem(SPEND_KEY);
  localStorage.removeItem(SPEND_RESET_KEY);
  localStorage.removeItem(OTHERS_KEY);
}

// ---------- the shared total ----------

const emptyOthers = () => ({
  month: thisMonth(),
  devices: 0,
  ocr: 0,
  since: 0,
  input: 0,
  cachedInput: 0,
  output: 0,
  messages: 0,
});

function getOthers() {
  const o = readJson(OTHERS_KEY, null);
  if (!o || typeof o.ocr !== 'number') return emptyOthers();
  // The page count belongs to the month it was recorded in; the spend does
  // not, so only half of this record expires.
  return { ...emptyOthers(), ...o, ocr: o.month === thisMonth() ? o.ocr : 0 };
}

/**
 * What to show: this device plus every other one that has synced, with the
 * cost worked out. `otherDevices` says how many machines are folded in, so
 * the UI can be honest about whether the figure is shared or local-only.
 */
export function getTotals() {
  const own = getOwnOcr();
  const spend = getOwnSpend();
  const others = getOthers();
  // The earliest start either side knows of: the chat figures are everything
  // since then, which is not the same as everything this month.
  const starts = [spend.since, others.since].filter(Boolean);
  const t = {
    ocr: own.count + others.ocr,
    since: starts.length ? Math.min(...starts) : 0,
    input: spend.input + others.input,
    cachedInput: spend.cachedInput + others.cachedInput,
    output: spend.output + others.output,
    messages: spend.messages + others.messages,
    otherDevices: others.devices,
  };
  t.dollars =
    (t.input * PRICE_PER_MTOK.input +
      t.cachedInput * PRICE_PER_MTOK.cachedInput +
      t.output * PRICE_PER_MTOK.output) /
    1e6;
  return t;
}

/** This device's entry, as it goes into the shared file. */
export function ownContribution() {
  const ocr = getOwnOcr();
  const spend = getOwnSpend();
  return {
    month: thisMonth(),
    ocr: ocr.count,
    input: spend.input,
    cachedInput: spend.cachedInput,
    output: spend.output,
    messages: spend.messages,
    since: spend.since,
    at: Date.now(),
  };
}

// When an entry was written. Entries from before the spend outlived its month
// carry no timestamp of their own, so fall back to the month they claim.
function entryAt(entry) {
  return typeof entry.at === 'number' ? entry.at : monthStart(entry.month);
}

/**
 * Fold the shared file into the local view. Takes the whole `{ devices: {} }`
 * map, drops this device's own entry (already counted), and stores the rest as
 * the "others" total. An entry's page count is only good for the month it was
 * written in; its spend is good until somebody starts the total over.
 */
export function applySharedUsage(shared) {
  const resetAt = adoptSpendReset(shared);
  const me = getDeviceId();
  const month = thisMonth();
  const totals = emptyOthers();
  for (const [id, entry] of Object.entries(shared?.devices || {})) {
    if (id === me || !entry) continue;
    const thisMonths = entry.month === month;
    // An entry older than the reset describes a bill already settled; it stops
    // counting until that device gets round to syncing a zeroed one.
    const spendCounts = entryAt(entry) >= resetAt;
    if (thisMonths) totals.ocr += entry.ocr || 0;
    if (spendCounts) {
      totals.input += entry.input || 0;
      totals.cachedInput += entry.cachedInput || 0;
      totals.output += entry.output || 0;
      totals.messages += entry.messages || 0;
      const since = typeof entry.since === 'number' ? entry.since : monthStart(entry.month);
      if (since && (!totals.since || since < totals.since)) totals.since = since;
    }
    if (thisMonths || spendCounts) totals.devices += 1;
  }
  localStorage.setItem(OTHERS_KEY, JSON.stringify(totals));
  return totals;
}

/** The shared file with this device's entry brought up to date. */
export function withOwnContribution(shared) {
  // Before the entry is built, not after: a reset arriving from another device
  // has to zero this one's figures or they go straight back up.
  const resetAt = adoptSpendReset(shared);
  const next = shared && typeof shared === 'object' ? { ...shared } : {};
  next.version = 1;
  if (resetAt) next.spendResetAt = resetAt;
  next.devices = { ...(next.devices || {}) };
  next.devices[getDeviceId()] = ownContribution();
  // Forget devices that went quiet months ago; the file would otherwise grow a
  // dead entry per browser profile, forever.
  const cutoff = Date.now() - DORMANT_MS;
  for (const [id, entry] of Object.entries(next.devices)) {
    if (!entry || entryAt(entry) < cutoff) delete next.devices[id];
  }
  return next;
}
