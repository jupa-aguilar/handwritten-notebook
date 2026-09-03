// Archiving is one omission away from destroying a notebook on every device:
// it is `deleteNotebook` *without* the tombstone. If that omission ever stops
// holding, the next sync reads a tombstone the user never asked for and sweeps
// the Drive copy — the only copy left, since the local rows are already gone.
// So the invariant gets a test of its own rather than living in a comment.
import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, rawPut, rawAll, localPage } from './helpers.js';

let db;

async function givenNotebook() {
  await rawPut('notebooks', [
    { id: 1, uuid: 'nb-1', name: 'Notes', createdAt: 1, updatedAt: 1000 },
  ]);
  await rawPut('pages', [localPage({ id: 1, uuid: 'pg-1' })]);
  await rawPut('cards', [
    { id: 1, uuid: 'card-1', notebookId: 1, pageId: 1, pageUuid: 'pg-1', q: '¿?', a: '!' },
  ]);
}

beforeEach(async () => {
  db = await freshDb();
  await givenNotebook();
});

describe('dropNotebookLocally', () => {
  it('removes the notebook, its pages and its cards from this device', async () => {
    await db.dropNotebookLocally('nb-1');
    expect(await rawAll('notebooks')).toEqual([]);
    expect(await rawAll('pages')).toEqual([]);
    expect(await rawAll('cards')).toEqual([]);
  });

  it('records no notebook tombstone — the Drive copy is the whole point', async () => {
    await db.dropNotebookLocally('nb-1');
    expect(await db.getNotebookTombstones()).toEqual({});
  });

  it('leaves page tombstones alone, so restoring cannot be read as a deletion', async () => {
    await db.dropNotebookLocally('nb-1');
    // deletePage records one per page; dropping the notebook must not, or the
    // pull that restores it would skip every page it just fetched.
    expect(await db.getPageTombstones()).toEqual({});
  });

  it('is a no-op for a uuid this device does not hold', async () => {
    await db.dropNotebookLocally('nb-missing');
    expect(await rawAll('notebooks')).toHaveLength(1);
  });
});

describe('the archived cache', () => {
  it('lists what was written, newest archive first', async () => {
    await db.setArchivedCache([
      { uuid: 'a', name: 'Old', pages: 3, archivedAt: 100 },
      { uuid: 'b', name: 'New', pages: 1, archivedAt: 900 },
    ]);
    expect((await db.listArchived()).map((a) => a.uuid)).toEqual(['b', 'a']);
  });

  // meta.json is the complete answer, so a rewrite has to be a replacement:
  // merging would keep showing a notebook another device already restored.
  it('replaces the previous list rather than merging into it', async () => {
    await db.setArchivedCache([{ uuid: 'a', name: 'One', pages: 1, archivedAt: 100 }]);
    await db.setArchivedCache([{ uuid: 'b', name: 'Two', pages: 2, archivedAt: 200 }]);
    expect((await db.listArchived()).map((a) => a.uuid)).toEqual(['b']);
  });

  it('empties when nothing is archived any more', async () => {
    await db.setArchivedCache([{ uuid: 'a', name: 'One', pages: 1, archivedAt: 100 }]);
    await db.setArchivedCache([]);
    expect(await db.listArchived()).toEqual([]);
  });
});
