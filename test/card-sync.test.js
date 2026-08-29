// applyRemoteCards has the same problem applyRemoteNotebook does: reproducing
// it by hand needs two devices and a review sitting on each. It also has the
// same failure mode — a bug here silently loses a schedule the user built over
// weeks, or resurrects cards they deleted.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  freshDb,
  loadDb,
  resetStorage,
  rawPut,
  rawAll,
  localPage,
  seedSchemaV5,
} from './helpers.js';

let db;

// One notebook, one page, both already synced — the shape every case needs.
async function givenNotebook() {
  await rawPut('notebooks', [
    { id: 1, uuid: 'nb-1', name: 'Notes', createdAt: 1, updatedAt: 1000 },
  ]);
  await rawPut('pages', [localPage({ id: 1, uuid: 'pg-1' })]);
}

function localCard(overrides = {}) {
  return {
    id: 1,
    uuid: 'card-1',
    notebookId: 1,
    pageId: 1,
    pageUuid: 'pg-1',
    q: '¿?',
    a: '!',
    anchor: 'algo',
    box: { x: 1, y: 2, w: 3, h: 4 },
    ease: 2.5,
    interval: 0,
    reps: 0,
    lapses: 0,
    due: 500,
    reviewedAt: 0,
    suspended: false,
    createdAt: 500,
    modifiedAt: 500,
    ...overrides,
  };
}

// A card as it appears in the Drive file: page identified by uuid, no local id.
function wireCard(overrides = {}) {
  const { id, notebookId, pageId, ...rest } = localCard(overrides);
  return rest;
}

beforeEach(async () => {
  db = await freshDb();
  await givenNotebook();
});

describe('cards this device has never seen', () => {
  it('arrive with their schedule intact', async () => {
    const res = await db.applyRemoteCards(1, [
      wireCard({ uuid: 'card-9', reps: 4, interval: 21, due: 9e12, ease: 2.35 }),
    ]);
    const [stored] = await rawAll('cards');
    expect(stored).toMatchObject({
      uuid: 'card-9',
      notebookId: 1,
      pageId: 1,
      reps: 4,
      interval: 21,
      ease: 2.35,
    });
    expect(res.changed).toBe(false); // nothing of ours is missing up there
  });

  it('wait on Drive while their page is missing here', async () => {
    await db.applyRemoteCards(1, [wireCard({ uuid: 'card-9', pageUuid: 'pg-elsewhere' })]);
    expect(await rawAll('cards')).toHaveLength(0);
  });
});

describe('a card both devices have', () => {
  it('takes the newer grade, whichever side made it', async () => {
    await rawPut('cards', [localCard({ modifiedAt: 500, reps: 1, interval: 1 })]);
    await db.applyRemoteCards(1, [wireCard({ modifiedAt: 900, reps: 3, interval: 15 })]);
    const [stored] = await rawAll('cards');
    expect(stored).toMatchObject({ reps: 3, interval: 15, id: 1 });
  });

  it('keeps the local grade when it is the newer one, and says so', async () => {
    await rawPut('cards', [localCard({ modifiedAt: 2000, reps: 5, interval: 40 })]);
    const res = await db.applyRemoteCards(1, [wireCard({ modifiedAt: 900, reps: 3 })]);
    const [stored] = await rawAll('cards');
    expect(stored.reps).toBe(5);
    expect(res.changed).toBe(true); // so the run pushes ours back up
    expect(res.cards[0]).toMatchObject({ uuid: 'card-1', reps: 5 });
  });
});

describe('cards only one side has', () => {
  it('publishes a card made here that the file lacks', async () => {
    await rawPut('cards', [localCard({ uuid: 'card-new' })]);
    const res = await db.applyRemoteCards(1, []);
    expect(res.changed).toBe(true);
    expect(res.cards.map((c) => c.uuid)).toEqual(['card-new']);
  });

  // The whole reason deletions travel inside the file: this device never saw
  // the delete, so without the tombstone it would push the card back up.
  it('drops a card the file says was deleted elsewhere', async () => {
    await rawPut('cards', [localCard()]);
    const deletedAt = Date.now() - 60_000;
    const res = await db.applyRemoteCards(1, [], { 'card-1': deletedAt });
    expect(await rawAll('cards')).toHaveLength(0);
    expect(res.cards).toHaveLength(0);
    // And it remembers, so a third device's stale copy meets the same fate.
    expect(res.tombstones['card-1']).toBe(deletedAt);
  });

  // Tombstones are pruned at sixty days, like the ones for pages: past that
  // every device has long since synced, and keeping them means carrying a
  // record of every card ever deleted forever.
  it('lets a deletion older than the tombstone TTL expire', async () => {
    await rawPut('cards', [localCard()]);
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
    const res = await db.applyRemoteCards(1, [], { 'card-1': ancient });
    expect(res.tombstones['card-1']).toBeUndefined();
    expect(await rawAll('cards')).toHaveLength(1);
  });

  it('deletes here, and takes the card out of the file', async () => {
    await rawPut('cards', [localCard()]);
    await db.deleteCard(1);
    const res = await db.applyRemoteCards(1, [wireCard()]);
    expect(await rawAll('cards')).toHaveLength(0);
    expect(res.cards).toHaveLength(0);
    expect(res.changed).toBe(true);
  });

  it('carries a local deletion the file does not know about yet', async () => {
    await rawPut('cards', [localCard()]);
    await db.deleteCard(1);
    const res = await db.applyRemoteCards(1, []);
    expect(res.changed).toBe(true);
    expect(res.tombstones['card-1']).toBeGreaterThan(0);
  });
});

describe('the file this device writes back', () => {
  it('identifies pages by uuid, not by the local id', async () => {
    await rawPut('cards', [localCard()]);
    const res = await db.applyRemoteCards(1, []);
    expect(res.cards[0].pageUuid).toBe('pg-1');
    expect(res.cards[0].pageId).toBeUndefined();
    expect(res.cards[0].id).toBeUndefined();
  });

  it('names the page as it stands now, not as the card remembers it', async () => {
    // The page was re-scanned here, which mints a fresh uuid.
    await rawPut('pages', [localPage({ id: 1, uuid: 'pg-rescanned' })]);
    await rawPut('cards', [localCard({ pageUuid: 'pg-1' })]);
    const res = await db.applyRemoteCards(1, []);
    expect(res.cards[0].pageUuid).toBe('pg-rescanned');
  });

  it('leaves the other notebook cards alone', async () => {
    await rawPut('notebooks', [
      { id: 2, uuid: 'nb-2', name: 'Other', createdAt: 1, updatedAt: 1 },
    ]);
    await rawPut('cards', [localCard(), localCard({ id: 2, uuid: 'card-2', notebookId: 2 })]);
    const res = await db.applyRemoteCards(1, []);
    expect(res.cards.map((c) => c.uuid)).toEqual(['card-1']);
  });
});

describe('local writes', () => {
  it('stamps modifiedAt on every grade, which is what the merge compares', async () => {
    await rawPut('cards', [localCard({ modifiedAt: 500 })]);
    const [before] = await rawAll('cards');
    await db.putCard({ ...before, reps: 1 });
    const [after] = await rawAll('cards');
    expect(after.modifiedAt).toBeGreaterThan(500);
  });

  it('tombstones every card a cleared page had', async () => {
    await rawPut('cards', [localCard(), localCard({ id: 2, uuid: 'card-2' })]);
    expect(await db.deleteCardsForPage(1)).toBe(2);
    const tombs = await db.getCardTombstones();
    expect(Object.keys(tombs).sort()).toEqual(['card-1', 'card-2']);
  });

  it('tombstones the cards of a deleted page, so no pull revives them', async () => {
    await rawPut('cards', [localCard()]);
    await db.deletePage(1);
    expect(await rawAll('cards')).toHaveLength(0);
    expect(await db.getCardTombstones()).toHaveProperty('card-1');
  });
});

// The upgrade that let cards sync at all. It runs against a real user's deck,
// so getting it wrong means losing a schedule built over weeks.
describe('the v5 → v6 upgrade', () => {
  it('gives every existing card an identity other devices can use', async () => {
    resetStorage();
    await seedSchemaV5({
      notebooks: [{ id: 1, uuid: 'nb-1', name: 'Notes', createdAt: 1, updatedAt: 1000 }],
      pages: [localPage({ id: 1, uuid: 'pg-1' })],
      cards: [
        { id: 1, notebookId: 1, pageId: 1, pageUuid: 'pg-1', q: 'a', a: 'b', reps: 3, createdAt: 500 },
        { id: 2, notebookId: 1, pageId: 1, pageUuid: 'pg-1', q: 'c', a: 'd', reps: 0, createdAt: 600 },
      ],
    });
    const upgraded = await loadDb();
    const cards = await upgraded.listCards(1);
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.uuid)).size).toBe(2);
    for (const c of cards) {
      expect(c.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.modifiedAt).toBeGreaterThan(0);
    }
    // And the schedule they carried is untouched.
    expect(cards.find((c) => c.q === 'a').reps).toBe(3);

    // Which is enough for them to take part in a merge straight away.
    const res = await upgraded.applyRemoteCards(1, []);
    expect(res.changed).toBe(true);
    expect(res.cards.map((c) => c.uuid).sort()).toEqual(cards.map((c) => c.uuid).sort());
  });
});

// The day tallies ride in the same file as the cards, and they are running
// totals: the merge that is right for a card (newer wins) would throw a whole
// device's week away here. So one row per device, and only ever your own is
// rewritten — the property these cases exist to hold down.
describe('the review-day tallies', () => {
  const row = (day, device, a, m = [0, 0, 0]) => ({
    notebookId: 1,
    device,
    day,
    answered: a,
    missed: m,
  });

  it("keeps another device's days and never writes over them", async () => {
    const { applyRemoteHistory } = await loadDb();
    const { getDeviceId } = await import('../src/usage.js');
    const me = getDeviceId();
    await rawPut('reviewDays', [row('2026-08-05', me, [2, 0, 0])]);

    const { history } = await applyRemoteHistory(1, {
      other: { '2026-08-05': { a: [0, 3, 0], m: [0, 1, 0] } },
    });

    expect(history[me]['2026-08-05'].a).toEqual([2, 0, 0]);
    expect(history.other['2026-08-05'].a).toEqual([0, 3, 0]);
    // And the other device's row is now readable here, so the chart adds up.
    const stored = await rawAll('reviewDays');
    expect(stored).toHaveLength(2);
  });

  it('ignores what the file claims about this device, which is the stale copy', async () => {
    const { applyRemoteHistory } = await loadDb();
    const { getDeviceId } = await import('../src/usage.js');
    const me = getDeviceId();
    await rawPut('reviewDays', [row('2026-08-05', me, [5, 0, 0])]);

    const { history } = await applyRemoteHistory(1, {
      [me]: { '2026-08-05': { a: [1, 0, 0], m: [0, 0, 0] } },
    });

    expect(history[me]['2026-08-05'].a).toEqual([5, 0, 0]);
  });

  it('asks for an upload when this device reviewed and the file has not heard', async () => {
    const { applyRemoteHistory } = await loadDb();
    await rawPut('reviewDays', [row('2026-08-05', (await import('../src/usage.js')).getDeviceId(), [1, 0, 0])]);
    expect((await applyRemoteHistory(1, {})).changed).toBe(true);
  });

  it('spends no upload when the file already carries what we have', async () => {
    const { applyRemoteHistory } = await loadDb();
    const { getDeviceId } = await import('../src/usage.js');
    const me = getDeviceId();
    await rawPut('reviewDays', [row('2026-08-05', me, [1, 2, 0], [1, 0, 0])]);
    const remote = { [me]: { '2026-08-05': { a: [1, 2, 0], m: [1, 0, 0] } } };
    expect((await applyRemoteHistory(1, remote)).changed).toBe(false);
  });

  it('drops rows too old to be answering anybody\'s question', async () => {
    const { applyRemoteHistory } = await loadDb();
    const { getDeviceId } = await import('../src/usage.js');
    const me = getDeviceId();
    const now = new Date(2026, 7, 5).getTime();
    await rawPut('reviewDays', [row('2020-01-01', me, [9, 0, 0]), row('2026-08-01', me, [1, 0, 0])]);

    const { history } = await applyRemoteHistory(1, {}, now);
    expect(Object.keys(history[me])).toEqual(['2026-08-01']);
    expect(await rawAll('reviewDays')).toHaveLength(1);
  });
});
