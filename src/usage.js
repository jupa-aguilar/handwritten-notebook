// What this account has consumed this month: pages sent to Google Vision, and
// what the hosted chat has cost.
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
const OTHERS_KEY = 'notebook.usageOthers'; // last known totals from other devices

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

const emptySpend = () => ({
  month: thisMonth(),
  input: 0,
  cachedInput: 0,
  output: 0,
  messages: 0,
});

export function getOwnSpend() {
  const s = readJson(SPEND_KEY, null);
  return s && s.month === thisMonth() && typeof s.input === 'number' ? s : emptySpend();
}

// `usage` as the API reports it. Cached prompt tokens are counted separately
// because they cost a tenth; they arrive nested in prompt_tokens_details.
export function recordSpend(usage) {
  if (!usage) return false;
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  const prompt = usage.prompt_tokens || 0;
  const s = getOwnSpend();
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
  localStorage.removeItem(OTHERS_KEY);
}

// ---------- the shared total ----------

const emptyOthers = () => ({
  month: thisMonth(),
  devices: 0,
  ocr: 0,
  input: 0,
  cachedInput: 0,
  output: 0,
  messages: 0,
});

function getOthers() {
  const o = readJson(OTHERS_KEY, null);
  return o && o.month === thisMonth() && typeof o.ocr === 'number' ? o : emptyOthers();
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
  const t = {
    ocr: own.count + others.ocr,
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
    at: Date.now(),
  };
}

/**
 * Fold the shared file into the local view. Takes the whole `{ devices: {} }`
 * map, drops this device's own entry (already counted) and anything left over
 * from a previous month, and stores the rest as the "others" total.
 */
export function applySharedUsage(shared) {
  const me = getDeviceId();
  const month = thisMonth();
  const totals = emptyOthers();
  for (const [id, entry] of Object.entries(shared?.devices || {})) {
    if (id === me || !entry || entry.month !== month) continue;
    totals.devices += 1;
    totals.ocr += entry.ocr || 0;
    totals.input += entry.input || 0;
    totals.cachedInput += entry.cachedInput || 0;
    totals.output += entry.output || 0;
    totals.messages += entry.messages || 0;
  }
  localStorage.setItem(OTHERS_KEY, JSON.stringify(totals));
  return totals;
}

/** The shared file with this device's entry brought up to date. */
export function withOwnContribution(shared) {
  const next = shared && typeof shared === 'object' ? { ...shared } : {};
  next.version = 1;
  next.devices = { ...(next.devices || {}) };
  next.devices[getDeviceId()] = ownContribution();
  // Forget devices that haven't reported since last month; the file would
  // otherwise grow a dead entry per browser profile, forever.
  const month = thisMonth();
  for (const [id, entry] of Object.entries(next.devices)) {
    if (entry?.month !== month) delete next.devices[id];
  }
  return next;
}
