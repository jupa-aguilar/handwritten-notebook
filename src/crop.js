// Cutting a rectangle of a page image out for display — and, at the foot of
// this file, handing a whole page to a model.
//
// Shared by the review cards and the transcription proofreader, which want the
// same thing for the same reason: the user's own handwriting next to whatever
// a model claims about it, so the notebook is what they check against.

import { cropRect, hintRect, maskRect } from './cards.js';

// Returns an object URL the caller owns — revoke it when the image is replaced
// or the panel closes, or the blobs pile up for the life of the tab.
export async function cropPage(page, box) {
  return cut(page, box && cropRect(page, box));
}

// The exact rectangle the reader drew, unpadded and unsnapped — cropRect's
// word/line snapping is right for a box inferred from an anchor, wrong here:
// the user drew precisely what they meant.
export async function cropSelection(page, rect) {
  return cut(page, rect);
}

// The hint a card offers before it is turned over: the same passage with a line
// of context either side, and the answer itself painted out. Costs no model
// call — the box was measured when the card was made, and covering it is the
// whole trick.
//
// Null when there is no hint to give: see hintRect, which refuses a crop the
// mask would swallow.
export async function cropHint(page, box, { context } = {}) {
  return cut(page, hintRect(page, box, context), maskRect(page, box), 'cover');
}

// The same picture once the card is turned over: the block lifted off, and the
// words that answered it marked instead. Uncovering the passage without
// widening the crop back out was the bug — the reader was handed the answer
// with the sentence it lived in cut away from around it.
//
// Falls back to the tight framing when there is no context to show, and marks
// nothing there: a highlight over a crop that is only the answer says nothing.
export async function cropAnswer(page, box, { context } = {}) {
  const wide = hintRect(page, box, context);
  if (wide) return cut(page, wide, maskRect(page, box), 'mark');
  return cut(page, box && cropRect(page, box));
}

// Paper the answer is hidden behind. A flat grey rather than white: it has to
// read as something laid over the ink, not as a page that was left blank.
const MASK_FILL = '#c9c3b9';
// And the wash that replaces it. Laid down with 'multiply', which is what a
// highlighter does to paper: the darkest thing at each pixel survives, so the
// ink stays as legible as it was and only the paper around it takes the
// colour. An ordinary fill at any alpha washes the strokes out with it.
const MARK_FILL = '#ffd66b';

async function cut(page, rect, mark, mode = 'cover') {
  if (!page?.blob || !rect) return null;
  const bitmap = await createImageBitmap(page.blob);
  try {
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    const w = Math.min(bitmap.width - x, rect.w);
    const h = Math.min(bitmap.height - y, rect.h);
    if (w <= 0 || h <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w);
    canvas.height = Math.round(h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, x, y, w, h, 0, 0, canvas.width, canvas.height);

    if (mark) {
      // The crop is drawn at its natural size, so the box's page pixels are the
      // canvas's own — only the origin moves.
      ctx.fillStyle = mode === 'mark' ? MARK_FILL : MASK_FILL;
      if (mode === 'mark') ctx.globalCompositeOperation = 'multiply';
      ctx.fillRect(mark.x - x, mark.y - y, mark.w, mark.h);
      ctx.globalCompositeOperation = 'source-over';
    }

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
    return blob ? URL.createObjectURL(blob) : null;
  } finally {
    bitmap.close();
  }
}

// ---------- the whole page, for a model to read ----------

// How wide the page goes out to the proofreader. This is the quality/price
// dial of the whole feature, and it is the image and not the model: the check
// runs on the same gpt-5.6-luna as the chat, where the page is priced as input
// tokens and those scale with its area. Full-size scans are two to three
// thousand pixels across, which is far past what reading the words needs —
// 1600 keeps an ordinary handwritten line around thirty pixels tall, still
// comfortably legible, at roughly a third of the tokens. Going lower starts
// costing accuracy on the exact thing being judged (was that an 'a' or an 'o'),
// and a wrong correction proposed is worth more than the cents it saved.
const MODEL_MAX_SIDE = 1600;

// The page as a data: URL, scaled down, for an OpenAI-style image part. Null
// when there is no image to send — the caller falls back to the text-only
// check rather than failing.
export async function pageForModel(page, maxSide = MODEL_MAX_SIDE) {
  if (!page?.blob) return null;
  const bitmap = await createImageBitmap(page.blob);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // JPEG, not PNG: this is a photograph of paper, and PNG of a scan is
    // several times the bytes for nothing the model can use.
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    bitmap.close();
  }
}
