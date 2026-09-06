// Handwriting transcription, called directly from the browser. Two readings of
// the same page, and the difference between them is the whole shape of this
// file:
//
//   - Google Cloud Vision (DOCUMENT_TEXT_DETECTION) — purpose-built for
//     handwriting, free for the first 1,000 pages/month, and the only one that
//     returns a rectangle per word. Every page starts here.
//   - The chat's own model, reading the scan (see the second half). Better at
//     structure and notation, costs a request, and returns no coordinates.
//
// The user's API key never leaves their machine except to go to the provider.

import { complete } from './chat.js';

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

export async function transcribeImage({ base64, apiKey }) {
  const resp = await fetch(`${VISION_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          image: { content: base64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          // Optional: bias toward specific languages, e.g. ['es', 'en'].
          // imageContext: { languageHints: ['es', 'en'] },
        },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Vision API ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = await resp.json();
  const result = data.responses?.[0];
  if (result?.error) {
    throw new Error(result.error.message || 'Vision API error');
  }
  const annotation = result?.fullTextAnnotation;
  return {
    text: (annotation?.text || '').trim(),
    words: extractWords(annotation),
  };
}

// Flatten Vision's page→block→paragraph→word tree into a flat list of word
// boxes, in pixel coordinates of the image we sent (which is the same image we
// store, so the boxes line up with page.width/page.height). Used to highlight
// search hits directly on the page image.
function extractWords(annotation) {
  const words = [];
  for (const page of annotation?.pages || []) {
    for (const block of page.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const word of para.words || []) {
          const t = (word.symbols || []).map((s) => s.text).join('');
          const verts = word.boundingBox?.vertices;
          if (!t || !verts || verts.length < 4) continue;
          const xs = verts.map((v) => v.x || 0);
          const ys = verts.map((v) => v.y || 0);
          const x = Math.min(...xs);
          const y = Math.min(...ys);
          const w = Math.max(...xs) - x;
          const h = Math.max(...ys) - y;
          if (w <= 0 || h <= 0) continue;
          words.push({ t, x, y, w, h });
        }
      }
    }
  }
  return words;
}

// ---------- the other reading: a model looks at the page ----------
//
// Vision stays the way a page is first transcribed: it is cheap, it is fast,
// and it is the only one of the two that returns word boxes. What it cannot do
// is structure. It hands back words and rectangles, so a table's rows, a column
// of workings or a deliberate line break survive only as far as its reading
// heuristic happens to carry them — and when that goes wrong the transcript
// reads like prose that was never on the page. A model looking at the same scan
// gets those right, and gets notation right too, because it knows what it is
// reading. It returns no coordinates at all.
//
// Hence a second reading, offered one page at a time rather than run over a
// notebook: the text comes from the model and the boxes are whatever
// realignWords (text.js) can carry across from Vision's reading of the same
// page. Nothing here can create a box — only Vision measures ink.
//
// This replaces the commented-out Claude-vision transcriber that used to sit
// here as a sketch of exactly this idea.

const REREAD_SYSTEM = `You are transcribing one scanned page of a student's handwritten notebook.

Write out everything on the page, exactly as it is written.

Rules:
- Preserve the reading order and the line breaks: a line ends where the page ends it, columns read down and then across, and a note in the margin stays where it sits instead of being folded into the body.
- Write a table as one line per row with the cells separated by " | ", header row included. A table is the one thing a flat paragraph cannot represent, and it is the main reason you are being asked.
- Never pad with spaces to line anything up — not a table, not a heading that sits to the right, not a column. This text is shown in a proportional face, so padding aligns nothing on screen and only writes runs of spaces into the page for good. Say where something is with a line of its own, or with " | ", and let the spacing be ordinary.
- Transcribe what is there. Never correct the writer's spelling, grammar or arithmetic, never rephrase, never add a heading or a remark of your own, never translate.
- Write maths and logic as plain text with Unicode symbols — ∧ ∨ ¬ ⊕ ≤ ≥ ≠ → ∀ ∃ ∈ ∑ √ π, subscripts like x₁, superscripts like x². Never LaTeX: no \\( \\), no $…$, no \\frac. This text is displayed as plain text, so LaTeX would reach the reader as backslashes.
- Use [?] for a word you genuinely cannot read. Do not guess it from context.
- Output the transcription and nothing else: no preamble, no commentary, no code fence.`;

// Pure, so the prompt is testable without a model. `image` is a data: URL from
// crop.js's pageForModel.
export function buildRereadPrompt(page, image) {
  return [
    { role: 'system', content: REREAD_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: image } },
        { type: 'text', text: `Page ${(page?.order ?? 0) + 1}.` },
      ],
    },
  ];
}

// A model told not to use a code fence sometimes uses one anyway, and a fence is
// never part of the page. Nothing else is stripped: this is a transcription, and
// a rule for cutting off what looks like a preamble would one day cut off a real
// first line.
export function parseRereadText(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  return (fenced ? fenced[1] : text).trim();
}

export async function rereadPage(page, { signal, model, image } = {}) {
  // Without the page there is nothing to read: unlike the proofreader, which
  // can fall back to reasoning about the text, a transcription with no image is
  // just the model inventing one.
  if (!image) throw new Error('No page image to read.');
  return parseRereadText(await complete(buildRereadPrompt(page, image), { signal, model }));
}
