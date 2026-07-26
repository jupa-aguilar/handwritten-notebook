# My Notebook

A browser-only digital notebook. Upload scans/photos of your handwritten notebook
pages and read them like a real book — with a realistic 3D page-turn animation,
full-text search powered by handwriting transcription, and a chat panel that
answers questions about what you wrote.

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
- **Chat over your pages.** 💬 Chat answers questions using the transcriptions as
  context. Two ways to run it: with an **OpenAI API key** it uses `gpt-5.6-luna`
  ($1/$6 per million tokens in/out — well under a cent per message at the context
  size this app sends, but the transcribed pages do go to OpenAI); with no key it
  talks to a model you run yourself through
  [LM Studio](https://lmstudio.ai), which is free and private but only reachable
  from the machine running it.

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
4. *Optional, for 💬 Chat:* paste an
   [OpenAI API key](https://platform.openai.com/api-keys) into ⚙ as well —
   **give it a spending limit first**, since every message is billed. Leave it
   empty to use a local LM Studio model instead: in its **Developer** tab load a
   model, start the server and enable **CORS**.

## Using it

- **Turn pages:** click the page corners, use the ‹ › arrows, or the ← → keys.
- **Search all pages:** type in the search box — results list each matching page;
  click one to flip there.
- **Read a page's text:** click **📖 Text** to open the transcription panel beside
  the page, with matches highlighted.
- **Bookmark pages:** click **🔖** (or press **B**) to hang a ribbon on the page
  you're reading — it shows on the book, in the zoom viewer, and on the page's
  card in **🗂 Pages** (each card also has its own 🔖). The **▾** next to the
  toolbar 🔖 lists all bookmarks: click one to jump there, ✏️ to give it a short
  label (unlabeled ones show the page's opening words), ✕ to remove it.
  Bookmarks are part of the notebook, so they travel with 📤 Export / ⬆ Import
  and ☁ Sync.
- **Zoom in to read:** click **🔍 Zoom** (or press **Z**, or double-click the page)
  to open a full-screen viewer. Scroll/pinch or use **＋ − Fit** to zoom, drag to
  pan, **← →** to change page, **Esc** to close. Search hits are boxed here too.
- **Chat about the notebook:** click **💬 Chat** and ask in plain language — *"what
  did I write about X?"* — answered from the transcribed pages, with the model
  free to add its own general knowledge on top. The pages most relevant to your
  question are sent as context, capped in size, so a long notebook is trimmed
  rather than sent whole (the model is told when that happens). **🧠** turns the
  model's reasoning on for hard questions — better answers, slower and dearer;
  off by default. **🧹** clears the conversation, which also resets on reload:
  chats are never saved. The line under the header names the model in use, so you
  can tell at a glance whether a message costs money. On phones the button only
  appears when the chat can actually reach a model — with an OpenAI key, or with
  an LM Studio address pointing at another machine on your network.
- **Back up / move a notebook:** open **📚**, then **📤** on a notebook to download
  it as a `.notebook.json` file (images + transcripts + word boxes). Use **⬆ Import…**
  to restore it — handy before clearing browser data or to copy a notebook to
  another machine. Since everything lives in this browser's IndexedDB, this file is
  your only backup.
- **Sync across devices (optional):** the **☁ Sync** button keeps notebooks in
  sync through a hidden app folder in **your own Google Drive**. One-time setup in
  the [Cloud Console](https://console.cloud.google.com/apis/credentials) (same
  project as the Vision key): *Create credentials → OAuth client ID → Web
  application*, add the site's URL under **Authorized JavaScript origins** (plus
  `http://localhost:5173` for dev), then paste the client ID into ⚙ on every
  device and sign in. Sync runs on startup, after transcription finishes, and on
  demand. Reconciliation is last-write-wins per notebook (fine for one person);
  page images upload only once. The Mac app loads the hosted site so it shares
  the same origin — sync works there too, but signs in through the system
  browser (Google blocks sign-in inside embedded browsers). To keep it signed
  in permanently, add `http://127.0.0.1:17987` under **Authorized redirect
  URIs** and paste the client **secret** into ⚙ as well: the app then stores a
  refresh token (encrypted via the system keychain) and renews access
  silently — without the secret, sign-in expires after ~1 hour. Keep the OAuth
  consent screen's publishing status on **Production**; in *Testing*, Google
  expires refresh tokens after 7 days.

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

- The Electron app has its **own IndexedDB**
  (`~/Library/Application Support/handwritten-notebook`), separate from any
  browser. Move notebooks with 📤 Export / ⬆ Import, and re-enter the API keys
  in ⚙.
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
- API keys are exposed to anyone who can open this browser profile — fine for a
  personal machine; don't deploy this app publicly with shared keys. They live in
  each device's `localStorage` and do **not** travel with ☁ Sync, so every device
  needs its own. The Vision key is capped by its free tier; the OpenAI one isn't,
  which is why it wants a spending limit.
