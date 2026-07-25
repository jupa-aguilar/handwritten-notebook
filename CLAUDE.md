# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"My Notebook" — a browser-only digital notebook for scanned handwritten pages: 3D page-turn
reading (StPageFlip), handwriting OCR via Google Cloud Vision, full-text search with word
boxes drawn on the page image, optional Google Drive sync, and a chat panel backed by a local
LM Studio model. Vanilla JS + Vite, no framework, no TypeScript.

## Commands

```bash
npm run dev        # vite dev server (http://localhost:5173)
npm test           # vitest, one pass
npm run test:watch # vitest in watch mode
npm run build      # static site → dist/
npm run preview    # serve the production build
npm run app        # build + launch the Electron shell
npm run app:dev    # Electron against the dev server (run `npm run dev` first)
npm run app:dist   # DMG → release/My Notebook-<version>-arm64.dmg
```

Run one file with `npx vitest run test/sync-merge.test.js`, one case with `-t "substring"`.

## Testing

`test/` covers the logic that is pure or storage-bound; `vitest.config.js` is separate from
`vite.config.js` so the PWA plugin stays out of test runs. The environment is `node`, not
jsdom — nothing under test touches the DOM, which is the point of what lives in `text.js`,
`zip.js` and `db.js`. `test/setup.js` supplies the two browser APIs those modules do need:
`fake-indexeddb` and a `localStorage` stub.

`db.js` opens the database when it is imported, so tests that need a clean slate go through
`freshDb()` in `test/helpers.js` (new `IDBFactory` + `vi.resetModules()`); migration tests use
`resetStorage()` / `seedSchemaV2()` / `loadDb()` to plant a pre-v3 database first.

The rest — anything touching the DOM, StPageFlip or the Electron IPC — is still verified by
hand: see `.claude/skills/verify` (the `/verify` skill). Note that `confirm()`/`alert()` block
the Chrome extension, so patch `window.confirm` before clicking anything that deletes.

CI runs `npm test` before building, so a red test blocks the deploy.

## Deploying

Pushing to `main` auto-deploys the site to GitHub Pages (`.github/workflows/deploy.yml`).
The Mac app loads that **hosted** URL (`APP_URL` in `electron/main.cjs`) rather than its own
bundle, so a Pages deploy also updates the installed Mac app — `npm run app:dist` +
reinstalling the DMG is only needed when `electron/*.cjs` changes. Ask before pushing.

## Architecture

`index.html` holds the entire DOM (toolbar, book area, panels, viewer, modals) with stable
element ids; JS never creates the layout, only fills and toggles it. Everything is wired in
`main.js` via `$('#id')` lookups against those ids, so renaming an id in the HTML breaks the
wiring silently.

| File | Role |
|---|---|
| `src/main.js` (~2.4k lines) | The whole UI controller: flipbook render, search + highlight overlays, OCR queue, zoom viewer, pages overview, notebook manager, export/import, keyboard wiring. All app state is module-level (`pages`, `currentPage`, `currentNotebookId`). |
| `src/text.js` | Accent folding, query tokenising, the all-words match rule and the highlighter — shared by the search box, the transcript panel, the on-image word boxes and the chat's page ranking, so all four agree on what "a word" is. |
| `src/zip.js` | Store-only ZIP writer for multi-page downloads (browsers honour only the first programmatic download per gesture, so several pages must leave as one file). |
| `src/db.js` | IndexedDB (`idb`), schema v3: `notebooks`, `pages`, plus the sync bookkeeping (`pageTombstones`, `notebookTombstones`, `syncState`). Owns the migrations and the sync merge logic (`applyRemoteNotebook`). |
| `src/ocr.js` | Google Cloud Vision `DOCUMENT_TEXT_DETECTION` called straight from the browser; flattens the page→block→paragraph→word tree into `{ t, x, y, w, h }` boxes in image pixels. A Claude-vision provider is kept commented out as an alternative. |
| `src/sync.js` | Google Drive `appDataFolder` sync: `meta.json`, `nb-<uuid>.json` manifests, `pg-<uuid>` images. Auth via GIS in the browser, via the Electron loopback flow in the app. |
| `src/chat.js` | Chat panel talking to LM Studio's OpenAI-compatible server. Owns its own conversation state per notebook; `main.js` only supplies `getContext()`. |
| `electron/main.cjs` + `preload.cjs` | Mac shell. Loads the hosted PWA, falls back to `dist/`. Runs the system-browser OAuth loopback on `127.0.0.1:17987` and stores a refresh token encrypted via `safeStorage`. |

### Identity: `id` vs `uuid`

Every page and notebook has a numeric autoincrement `id` (local only, used by all DOM
`data-id` attributes) **and** a `uuid` (stable across devices, the only thing sync and
export/import understand). New records must get `crypto.randomUUID()`; `ensureSyncIds()`
backfills pre-sync records.

### The mutation ritual

Any user-visible change to a notebook's content must do all three, or sync silently loses it:

```js
await putPage(page);              // or addPage/deletePage/reorderPages — bumps page.modifiedAt
await touchNotebook(notebookId);  // bumps notebook.updatedAt (last-write-wins signal)
scheduleSync();                   // debounced ~30s push
```

`putPage` is the *only* place `modifiedAt` is set, which is why sync-applied remote pages are
written with raw `db.put` instead. Deletions additionally need a tombstone so a later pull
can't resurrect them: `deletePage` records one automatically; deleting a notebook requires an
explicit `recordTombstone(uuid)` from `sync.js` before `deleteNotebook`.

### Sync model (read `sync.js` header + `applyRemoteNotebook` together)

Page images on Drive are **immutable and uploaded once per uuid** — that's why replacing a
page's image mints a fresh `uuid` + `createdAt` and tombstones the old one (`swapPageImage`).
Reconciliation compares each side against the `syncState` record (what this device saw after
its last sync) rather than against each other, since device clocks disagree. When both sides
changed, the pull merges page by page and pushes the union back (`merged === true`).

All of that bookkeeping lives in IndexedDB, deliberately: it used to sit in localStorage,
whose independent lifetime meant a cleared profile could drop the tombstones while keeping
the notebooks — and the next pull would resurrect every deleted page. Keep it there, and keep
`deletePage`'s tombstone in the same transaction as the delete. `sync.js` holds no local
state beyond the OAuth credentials.

### StPageFlip gotchas

- Import the ESM build directly (`page-flip/dist/js/page-flip.module.js`); the package `main`
  is a UMD bundle that breaks under Vite.
- `destroy()` removes the `#book` element from the DOM, so `renderBook()` recreates it.
- Images must be fully decoded before construction or the book renders blank.
- It only refits on a window `resize` event: after anything that changes the book's available
  width (opening/closing `#panel` or `#chat`, fullscreen), dispatch a synthetic
  `new Event('resize')`.
- Search/bookmark overlays are absolutely positioned against `pageFlip.getRender().getRect()`
  and are cleared during a flip; a `ResizeObserver` on `.book-area` repositions them.

### Conventions

- `localStorage` (namespace `notebook.*`) holds only what is cheap to lose: credentials,
  UI preferences, last-read positions, the OCR usage counter. Notebook content **and**
  anything sync relies on to not lose data go in IndexedDB.
- `window.prompt()` does not exist in Electron: renames and bookmark labels swap the row for
  an inline `<input>` instead. `confirm()`/`alert()` do work.
- Search is accent- and case-insensitive via `foldText()`, and a page matches when it contains
  *every* query word, not the literal phrase. Folding must stay 1:1 per character (NFD + strip
  combining marks): `refreshSearch` indexes into the folded text and then slices the original
  to build its snippet, so a fold that changed length would corrupt it.
- Phones (`IS_MOBILE`) skip the flipbook entirely and read in the zoom viewer.
- `vite.config.js` sets `base: './'` so one build works from GitHub Pages, `file://` and the
  Electron shell.
- The code comments explain *why* (browser quirks, sync invariants), not what — match that
  register when editing.
