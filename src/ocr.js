// Handwriting transcription, called directly from the browser.
// Active provider: Google Cloud Vision (DOCUMENT_TEXT_DETECTION) — purpose-built
// for handwritten/printed text, free for the first 1,000 pages/month.
// The user's API key never leaves their machine except to go to Google.

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

/*
// --- Previous provider: Claude vision (kept for reference) ---
// To use this instead, `npm install @anthropic-ai/sdk`, import it, and point
// transcribeImage at this function. Cost is higher (~$0.02–0.05/page) but it
// handles very messy/cursive handwriting better.
import Anthropic from '@anthropic-ai/sdk';

const CLAUDE_MODEL = 'claude-opus-4-8';
const CLAUDE_PROMPT = `You are transcribing one scanned page from a handwritten
notebook. Transcribe ALL text exactly as written, preserving line breaks and
reading order. Output only the transcribed text. Use [?] for illegible words.`;

export async function transcribeWithClaude({ base64, mediaType, apiKey }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const resp = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: CLAUDE_PROMPT },
        ],
      },
    ],
  });
  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
*/
