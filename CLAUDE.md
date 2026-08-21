# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"My Notebook" — a browser-only digital notebook for scanned handwritten pages: 3D page-turn
reading (StPageFlip), handwriting OCR via Google Cloud Vision, full-text search with word
boxes drawn on the page image, optional Google Drive sync, and a chat panel over the
transcribed pages. Vanilla JS + Vite, no framework, no TypeScript.

Every external service is bring-your-own-credentials, kept in `localStorage` and called
straight from the browser: the Vision key, the Drive OAuth client, and the chat's OpenAI key.
The chat is the one where a leaked key means open-ended spend — the settings copy tells the
user to set a limit on it.

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

`srs.js` and the pure half of `cards.js` (the prompt, the JSON parsing, the anchoring) are
covered by `test/srs.test.js` and `test/cards.test.js`; the panel that drives them is not.
`test/card-sync.test.js` covers `applyRemoteCards` and the v5→v6 upgrade — the same reasoning
as `sync-merge.test.js`: two devices and a disagreeing clock can't be reproduced by hand, and
a bug there loses a schedule silently. The Drive transport around it (`syncCards`) still can't
be tested without an account; it was verified by stubbing `fetch` for googleapis.com in the
page and running the real sync button against an in-memory appDataFolder.

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
| `src/main.js` (~3.3k lines) | The whole UI controller: flipbook render, search + highlight overlays, OCR queue, zoom viewer, pages overview, notebook manager, export/import, keyboard wiring. All app state is module-level (`pages`, `currentPage`, `currentNotebookId`). |
| `src/text.js` | Accent folding, query tokenising, the all-words match rule and the highlighter — shared by the search box, the transcript panel, the on-image word boxes and the chat's page ranking, so all four agree on what "a word" is. |
| `src/zip.js` | Store-only ZIP writer for multi-page downloads (browsers honour only the first programmatic download per gesture, so several pages must leave as one file). |
| `src/db.js` | IndexedDB (`idb`), schema v6: `notebooks`, `pages`, `chats`, `cards`, plus the sync bookkeeping (`pageTombstones`, `notebookTombstones`, `cardTombstones`, `syncState`). Owns the migrations and both sync merges (`applyRemoteNotebook`, `applyRemoteCards`). |
| `src/ocr.js` | Google Cloud Vision `DOCUMENT_TEXT_DETECTION` called straight from the browser; flattens the page→block→paragraph→word tree into `{ t, x, y, w, h }` boxes in image pixels. A Claude-vision provider is kept commented out as an alternative. |
| `src/sync.js` | Google Drive `appDataFolder` sync: `meta.json`, `nb-<uuid>.json` manifests, `pg-<uuid>` images. Auth via GIS in the browser, via the Electron loopback flow in the app. |
| `src/srs.js` | The scheduler: SM-2 with a short relearning step and an ease floor. Pure arithmetic, no storage and no DOM — which is why it is the part with tests. |
| `src/cards.js` | Turns one transcribed page into review cards. Asks the chat's backend for `{q, a, anchor}` JSON, then locates the *anchor* in that page's word boxes to get the rectangle the answer was written in. |
| `src/proof.js` | Assisted proofreading of a page's transcription: the prompt, the JSON, locating a fix in the text and in the word boxes, and applying it. Pure but for the model call. |
| `src/proofpanel.js` | The proofreading panel: the run over one page or the notebook, and the one-at-a-time verdict. |
| `src/crop.js` | Cuts a rectangle of a page image out as an object URL — shared by the review cards and the proofreader, which both show handwriting beside a model's claim about it. |
| `src/review.js` | The review panel: deck summary, the generation run (with its own abort), the sitting itself, and cropping the answer's rectangle out of the page image. |
| `src/chat.js` | Chat panel. Two backends behind one wire protocol (OpenAI-style Chat Completions + SSE): OpenAI's hosted `gpt-5.6-luna` when an API key is set, otherwise whatever model LM Studio has loaded locally. Owns its own conversation state per notebook; `main.js` only supplies `getContext()`. |
| `electron/main.cjs` + `preload.cjs` | Mac shell. Loads the hosted PWA, falls back to `dist/`. Runs the system-browser OAuth loopback on `127.0.0.1:17987` and stores a refresh token encrypted via `safeStorage`. |

### Identity: `id` vs `uuid`

Every page and notebook has a numeric autoincrement `id` (local only, used by all DOM
`data-id` attributes) **and** a `uuid` (stable across devices, the only thing sync and
export/import understand). New records must get `crypto.randomUUID()`; `ensureSyncIds()`
backfills pre-sync records.

### Review cards

A card is one question drawn from one page plus the box on that page where its answer is
written, so the answer side shows the user's own handwriting rather than a paraphrase of it.
That box comes from the model quoting a literal fragment of the page (`anchor`), which
`locateAnchor` matches against the page's OCR word boxes as a bag of words in a sliding
window — never as a literal substring, because both sides are approximations of the same ink.
Below half the words matching it returns `null` and the card shows text only: a rectangle
over the wrong sentence is worse than no rectangle.

Cards follow a page's **local `id`**, not its uuid, so re-scanning a page (`swapPageImage`,
which mints a fresh uuid) doesn't throw away what you learned from it. A re-scan repoints its
cards at the new uuid and drops their boxes — those coordinates measured a picture that no
longer exists — and `reanchorCards` gives them back once the new transcription lands.

Cards sync in a **file of their own** (`cd-<notebook-uuid>.json`), never in the notebook
manifest: grading forty cards in a sitting would otherwise re-upload every page's text and
word boxes forty times. Hence `onChanged: scheduleSync` rather than the mutation ritual —
a grade must *not* call `touchNotebook`. The merge is per card by `modifiedAt`, and the file
carries its own tombstones, because a device that never saw a deletion would push the card
straight back up. `putCard` is the only place `modifiedAt` is set, for the same reason
`putPage` owns the page one.

`chat.js` owns the only code that knows how to reach a model: `resolveChatModel()` +
`complete()`, exported so a generation run resolves the model once and every page's request
goes through the same key and the same spend counter.

### Proofreading a transcription

Vision's mistakes are invisible: the transcript reads like something, so nothing looks wrong
until a search comes up empty or the chat answers from a word the user never wrote. `proof.js`
has a model read the page's own text back and point at words that can't be what the line
means — never at the writer's grammar, style or spelling, which are theirs.

Two rules keep it from doing damage. **Nothing is applied without an explicit press**, with the
line cropped from the page shown beside the proposal. And **an ambiguous fix is refused**:
`locateCorrection` returns null rather than guess which of two identical words was meant,
because a fix applied to the wrong one is an error the user never had.

A correction updates `page.text` *and* the matching `page.words[].t` — search draws its
highlights from the boxes, so fixing only the text would leave the corrected word findable but
unmarked on the image. Word-for-word only: a fix that splits or joins words has no honest
mapping onto boxes measured in ink, so those change the text alone. Applying one is a content
change, so it takes the full mutation ritual below.

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
- The phone frame must not move: `overflow: hidden` on **both** `html` and `body`,
  `overscroll-behavior: none`, `position: fixed` on the body, and `touch-action` on the bars
  that aren't scrollable. Each closes a different hole in WebKit. The viewport meta pins the
  scale (`maximum-scale=1, user-scalable=no`) because that is the *only* thing that stops iOS
  zooming the frame — verified on the device: `touch-action` doesn't govern the pinch, and
  preventDefault on `gesturestart` runs while the page zooms anyway. iOS then remembers that
  scale across launches and nothing in script can reset it, which is why a single accidental
  pinch used to leave the app permanently askew.
- `vite.config.js` sets `base: './'` so one build works from GitHub Pages, `file://` and the
  Electron shell.
- The code comments explain *why* (browser quirks, sync invariants), not what — match that
  register when editing.
