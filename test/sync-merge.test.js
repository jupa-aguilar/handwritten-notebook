// applyRemoteNotebook is the one piece of this app that cannot be checked by
// hand: reproducing it in the browser needs two devices, disagreeing clocks
// and concurrent edits. It is also the piece where a bug loses the user's
// pages silently. Hence these tests.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  freshDb,
  rawPut,
  rawAll,
  manifest,
  manifestPage,
  localPage,
  resolveBlob,
} from './helpers.js';

let db;

// Give this device a notebook that has already synced once, so the merge has
// two sides to reconcile.
async function givenLocalNotebook({ updatedAt = 1000, pages = [] } = {}) {
  await rawPut('notebooks', [
    { id: 1, uuid: 'nb-1', name: 'Local name', createdAt: 1, updatedAt },
  ]);
  await rawPut(
    'pages',
    pages.map((p, i) => ({ id: i + 1, ...p }))
  );
}

beforeEach(async () => {
  db = await freshDb();
});

describe('a notebook the device has never seen', () => {
  it('is created with all of its pages', async () => {
    const res = await db.applyRemoteNotebook(
      manifest({
        pages: [
          manifestPage({ uuid: 'pg-1', order: 0, text: 'one' }),
          manifestPage({ uuid: 'pg-2', order: 1, text: 'two' }),
        ],
      }),
      resolveBlob,
      {}
    );

    expect(res.merged).toBe(false);
    expect(await db.listNotebooks()).toHaveLength(1);
    const pages = await db.getPages(res.id);
    expect(pages.map((p) => p.text)).toEqual(['one', 'two']);
    expect(await pages[0].blob.text()).toBe('downloaded:pg-1');
  });

  it('carries the manifest name and order', async () => {
    const res = await db.applyRemoteNotebook(
      manifest({ name: 'From Drive', order: 3 }),
      resolveBlob,
      {}
    );
    const nb = await db.getNotebook(res.id);
    expect(nb.name).toBe('From Drive');
    expect(nb.order).toBe(3);
  });
});

describe('a page both sides have', () => {
  it('takes the remote copy when the remote edited it last', async () => {
    await givenLocalNotebook({ pages: [localPage({ modifiedAt: 500 })] });

    const res = await db.applyRemoteNotebook(
      manifest({ pages: [manifestPage({ modifiedAt: 900, text: 'newer remote' })] }),
      resolveBlob,
      { lastSyncAt: 400 }
    );

    const [page] = await db.getPages(res.id);
    expect(page.text).toBe('newer remote');
    expect(res.merged).toBe(false);
  });

  it('keeps the local copy — and asks to be pushed back — when this device edited it last', async () => {
    await givenLocalNotebook({ pages: [localPage({ modifiedAt: 2000, text: 'newer local' })] });

    const res = await db.applyRemoteNotebook(
      manifest({ pages: [manifestPage({ modifiedAt: 900, text: 'older remote' })] }),
      resolveBlob,
      { lastSyncAt: 400 }
    );

    const [page] = await db.getPages(res.id);
    expect(page.text).toBe('newer local');
    expect(res.merged).toBe(true);
  });

  it('falls back to the notebook timestamp for manifests written before per-page times', async () => {
    await givenLocalNotebook({ pages: [localPage({ modifiedAt: 500 })] });
    const mf = manifest({ updatedAt: 900, pages: [manifestPage({ text: 'remote' })] });
    delete mf.pages[0].modifiedAt;

    const res = await db.applyRemoteNotebook(mf, resolveBlob, { lastSyncAt: 400 });

    const [page] = await db.getPages(res.id);
    expect(page.text).toBe('remote'); // 900 > 500, so the remote wins
    expect(page.modifiedAt).toBe(900);
  });

  it('applies bookmarks and word boxes from the remote', async () => {
    await givenLocalNotebook({ pages: [localPage({ modifiedAt: 500 })] });

    const res = await db.applyRemoteNotebook(
      manifest({
        pages: [
          manifestPage({
            modifiedAt: 900,
            bookmarked: true,
            bookmarkLabel: 'Chorus',
            words: [{ t: 'hi', x: 1, y: 2, w: 3, h: 4 }],
          }),
        ],
      }),
      resolveBlob,
      { lastSyncAt: 400 }
    );

    const [page] = await db.getPages(res.id);
    expect(page.bookmarked).toBe(true);
    expect(page.bookmarkLabel).toBe('Chorus');
    expect(page.words).toHaveLength(1);
  });
});

describe('a page only this device has', () => {
  it('survives when it was added after the last sync', async () => {
    await givenLocalNotebook({
      pages: [localPage({ uuid: 'pg-new', createdAt: 900, modifiedAt: 900 })],
    });

    const res = await db.applyRemoteNotebook(
      manifest({ pages: [] }),
      resolveBlob,
      { lastSyncAt: 500 } // the page is newer than the last sync
    );

    expect((await db.getPages(res.id)).map((p) => p.uuid)).toEqual(['pg-new']);
    expect(res.merged).toBe(true);
  });

  it('is deleted when it predates the last sync — the remote dropped it on purpose', async () => {
    await givenLocalNotebook({
      pages: [localPage({ uuid: 'pg-old', createdAt: 100, modifiedAt: 100 })],
    });

    const res = await db.applyRemoteNotebook(
      manifest({ pages: [] }),
      resolveBlob,
      { lastSyncAt: 500 } // the page is older: its absence means "deleted"
    );

    expect(await db.getPages(res.id)).toEqual([]);
  });

  it('without a recorded sync, falls back to comparing against the manifest', async () => {
    await givenLocalNotebook({
      pages: [
        localPage({ uuid: 'pg-a', createdAt: 2000 }), // created after the manifest
        localPage({ uuid: 'pg-b', createdAt: 10 }), // predates it
      ],
    });

    const res = await db.applyRemoteNotebook(
      manifest({ updatedAt: 1000, pages: [] }),
      resolveBlob,
      { lastSyncAt: 0 } // first sync after upgrading: no state yet
    );

    expect((await db.getPages(res.id)).map((p) => p.uuid)).toEqual(['pg-a']);
    expect(res.merged).toBe(true);
  });
});

describe('a page only the remote has', () => {
  it('is downloaded and added', async () => {
    await givenLocalNotebook({ pages: [] });

    const res = await db.applyRemoteNotebook(
      manifest({ pages: [manifestPage({ uuid: 'pg-remote' })] }),
      resolveBlob,
      { lastSyncAt: 500 }
    );

    const pages = await db.getPages(res.id);
    expect(pages.map((p) => p.uuid)).toEqual(['pg-remote']);
    expect(await pages[0].blob.text()).toBe('downloaded:pg-remote');
  });

  // This is the invariant the whole tombstone mechanism exists for.
  it('stays deleted when this device has a tombstone for it', async () => {
    await givenLocalNotebook({ pages: [] });

    const res = await db.applyRemoteNotebook(
      manifest({ pages: [manifestPage({ uuid: 'pg-deleted-here' })] }),
      resolveBlob,
      { lastSyncAt: 500, pageTombstones: { 'pg-deleted-here': Date.now() } }
    );

    expect(await db.getPages(res.id)).toEqual([]);
    // merged === true is what makes the caller push the deletion back to Drive.
    expect(res.merged).toBe(true);
  });

  it('comes back if the tombstone is missing — the failure mode this storage change fixed', async () => {
    await givenLocalNotebook({ pages: [] });

    const res = await db.applyRemoteNotebook(
      manifest({ pages: [manifestPage({ uuid: 'pg-deleted-here' })] }),
      resolveBlob,
      { lastSyncAt: 500, pageTombstones: {} } // tombstones lost
    );

    expect(await db.getPages(res.id)).toHaveLength(1);
  });
});

describe('the notebook record itself', () => {
  it('keeps the local name when this device renamed it more recently', async () => {
    await givenLocalNotebook({ updatedAt: 2000 });

    const res = await db.applyRemoteNotebook(
      manifest({ name: 'Remote name', updatedAt: 1000 }),
      resolveBlob,
      { lastSyncAt: 900 }
    );

    expect((await db.getNotebook(res.id)).name).toBe('Local name');
    expect(res.merged).toBe(true);
  });

  it('takes the remote name when the remote is newer', async () => {
    await givenLocalNotebook({ updatedAt: 500 });

    const res = await db.applyRemoteNotebook(
      manifest({ name: 'Remote name', updatedAt: 1000 }),
      resolveBlob,
      { lastSyncAt: 400 }
    );

    expect((await db.getNotebook(res.id)).name).toBe('Remote name');
  });

  it('bumps updatedAt when anything local survived, so the push-back wins next time', async () => {
    await givenLocalNotebook({
      updatedAt: 1000,
      pages: [localPage({ uuid: 'pg-new', createdAt: 900, modifiedAt: 900 })],
    });

    const res = await db.applyRemoteNotebook(
      manifest({ updatedAt: 1000, pages: [] }),
      resolveBlob,
      { lastSyncAt: 500 }
    );

    expect(res.merged).toBe(true);
    expect(res.updatedAt).toBeGreaterThan(1000);
    expect((await db.getNotebook(res.id)).updatedAt).toBe(res.updatedAt);
  });

  it('never downloads an image it already has', async () => {
    await givenLocalNotebook({ pages: [localPage({ uuid: 'pg-1', modifiedAt: 100 })] });
    let downloads = 0;
    const counting = async (pm) => {
      downloads++;
      return resolveBlob(pm);
    };

    await db.applyRemoteNotebook(
      manifest({ pages: [manifestPage({ uuid: 'pg-1', modifiedAt: 900 })] }),
      counting,
      { lastSyncAt: 50 }
    );

    expect(downloads).toBe(0);
    // The local blob is untouched even though the text was updated.
    expect(await (await rawAll('pages'))[0].blob.text()).toBe('local');
  });
});

// The failure that made a phone on mobile data unable to finish a sync: one
// image that wouldn't come down threw out of applyRemoteNotebook, out of
// pullNotebook and out of syncNow, leaving the notebook half-copied and every
// notebook queued behind it — cards included — untouched.
describe('a page whose image will not come down', () => {
  const failOn = (badUuid) => async (pm) => {
    if (pm.uuid === badUuid) throw new Error('Drive download failed (503)');
    return resolveBlob(pm);
  };

  it('does not stop the pages around it from arriving', async () => {
    const mf = manifest({
      pages: [
        manifestPage({ uuid: 'pg-1', order: 0 }),
        manifestPage({ uuid: 'pg-2', order: 1 }),
        manifestPage({ uuid: 'pg-3', order: 2 }),
      ],
    });
    const res = await db.applyRemoteNotebook(mf, failOn('pg-2'));
    const stored = (await rawAll('pages')).map((p) => p.uuid).sort();
    expect(stored).toEqual(['pg-1', 'pg-3']);
    expect(res.missing).toEqual(['pg-2']);
  });

  it('reports the gap so the caller can refuse to call the sync done', async () => {
    const mf = manifest({ pages: [manifestPage({ uuid: 'pg-1' })] });
    const res = await db.applyRemoteNotebook(mf, failOn('pg-1'));
    // Nothing landed, and the caller is told — which is what stops it
    // recording a synced state and never fetching the page again.
    expect(await rawAll('pages')).toHaveLength(0);
    expect(res.missing).toEqual(['pg-1']);
  });

  it('says nothing is missing when every image arrives', async () => {
    const mf = manifest({ pages: [manifestPage({ uuid: 'pg-1' })] });
    expect((await db.applyRemoteNotebook(mf, resolveBlob)).missing).toEqual([]);
  });

  it('never asks for an image of a page this device already holds', async () => {
    // The page is shared, so no download is needed and a broken Drive cannot
    // affect it — the reason the desktop never notices its own missing images.
    await givenLocalNotebook({
      updatedAt: 1000,
      pages: [localPage({ uuid: 'pg-1', notebookId: 1, modifiedAt: 2000 })],
    });
    const mf = manifest({
      updatedAt: 3000,
      pages: [manifestPage({ uuid: 'pg-1', modifiedAt: 500 })],
    });
    const res = await db.applyRemoteNotebook(mf, failOn('pg-1'), { lastSyncAt: 900 });
    expect(res.missing).toEqual([]);
  });
});
