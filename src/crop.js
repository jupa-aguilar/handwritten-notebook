// Cutting a rectangle of a page image out for display.
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
