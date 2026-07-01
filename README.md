# My Notebook

A browser-only digital notebook. Upload scans/photos of your handwritten notebook
pages and read them like a real book — with a realistic 3D page-turn animation,
plus full-text search powered by handwriting transcription.

## How it works

- **Fully local.** It's a static web app. Your images and their transcribed text
  are stored in your browser via **IndexedDB** — nothing is uploaded to any server
  you run.
- **Handwriting search.** Each page is transcribed once by **Google Cloud Vision**
  (`DOCUMENT_TEXT_DETECTION`), called directly from the browser. Your API key is
  kept in `localStorage` and is sent only to Google. The first 1,000 pages/month
  are free. After a page is transcribed, search works instantly and offline.
  (A Claude-vision provider is kept commented in `src/ocr.js` as an alternative
  for very messy handwriting.)
- **Page-turn animation** uses [StPageFlip](https://nodlik.github.io/StPageFlip/)
  for a real 3D page curl.

## Setup

```bash
npm install
npm run dev      # open the printed localhost URL
```

Then:

1. Click **⚙** and paste your Google Cloud Vision API key. In the
   [Google Cloud Console](https://console.cloud.google.com/): enable the
   **Cloud Vision API**, then create a key under *APIs & Services → Credentials*.
2. Click **＋ Add pages** (or drag images onto the book) to upload your scans.
   Pages are ordered by filename, so name them like `page-01.jpg`, `page-02.jpg`.
3. Pages appear immediately; transcription runs in the background (status shown in
   the toolbar).

## Using it

- **Turn pages:** click the page corners, use the ‹ › arrows, or the ← → keys.
- **Search all pages:** type in the search box — results list each matching page;
  click one to flip there.
- **Read a page's text:** click **📖 Text** to open the transcription panel beside
  the page, with matches highlighted.
- **Zoom in to read:** click **🔍 Zoom** (or press **Z**, or double-click the page)
  to open a full-screen viewer. Scroll/pinch or use **＋ − Fit** to zoom, drag to
  pan, **← →** to change page, **Esc** to close. Search hits are boxed here too.
- **Back up / move a notebook:** open **📚**, then **📤** on a notebook to download
  it as a `.notebook.json` file (images + transcripts + word boxes). Use **⬆ Import…**
  to restore it — handy before clearing browser data or to copy a notebook to
  another machine. Since everything lives in this browser's IndexedDB, this file is
  your only backup.

## Build for offline use

```bash
npm run build    # outputs static files to dist/
npm run preview  # serve the production build locally
```

The `dist/` folder is a plain static site — open it from any static host or local
server.

## Mac app (Electron)

```bash
npm run app       # build + launch the Electron app directly
npm run app:dist  # build a distributable: release/My Notebook-<version>-arm64.dmg
npm run app:dev   # Electron against the vite dev server (run `npm run dev` first)
```

Open the DMG and drag **My Notebook** to Applications. Notes:

- The Electron app has its **own IndexedDB** (`~/Library/Application Support/My
  Notebook`), separate from any browser. Move notebooks with 📤 Export / ⬆ Import,
  and re-enter the API key in ⚙.
- The app is unsigned (no Apple Developer certificate): it runs fine locally, but
  on another Mac you'd need right-click → Open to pass Gatekeeper.
- The icon is generated from `build/icon.svg` (rasterized with `qlmanage`, packed
  with `iconutil` into `build/icon.icns`, which electron-builder picks up).

## Notes

- Search matches the **transcribed text**. Matching words are listed in the text
  panel and also **boxed directly on the page image**, using the word positions
  Google Vision returns. (Pages transcribed before this feature have no saved word
  positions — re-run **🔄 Re-transcribe** on the notebook to get on-image boxes.)
- Reset everything by running `resetNotebook()` in the browser console.
- The API key is exposed to anyone who can open this browser profile — fine for a
  personal machine; don't deploy this app publicly with a shared key.
