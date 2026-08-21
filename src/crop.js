// Cutting a rectangle of a page image out for display.
//
// Shared by the review cards and the transcription proofreader, which want the
// same thing for the same reason: the user's own handwriting next to whatever
// a model claims about it, so the notebook is what they check against.

import { cropRect } from './cards.js';

// Returns an object URL the caller owns — revoke it when the image is replaced
// or the panel closes, or the blobs pile up for the life of the tab.
export async function cropPage(page, box) {
  if (!page?.blob || !box) return null;
  const bitmap = await createImageBitmap(page.blob);
  try {
    const cut = cropRect(page, box);
    const x = Math.max(0, cut.x);
    const y = Math.max(0, cut.y);
    const w = Math.min(bitmap.width - x, cut.w);
    const h = Math.min(bitmap.height - y, cut.h);
    if (w <= 0 || h <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w);
    canvas.height = Math.round(h);
    canvas.getContext('2d').drawImage(bitmap, x, y, w, h, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
    return blob ? URL.createObjectURL(blob) : null;
  } finally {
    bitmap.close();
  }
}
