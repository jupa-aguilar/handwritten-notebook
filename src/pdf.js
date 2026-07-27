// Minimal PDF writer for scanned notebook pages.
//
// Hand-rolled for the same reason as zip.js: a PDF of JPEGs is a simple
// enough format that pulling in a library to emit one would cost more than
// writing it. It also buys the thing a library would fight us on — PDF can
// carry a JPEG verbatim via /DCTDecode, so pages are copied byte for byte
// with no re-encoding, no quality loss and no time spent compressing.
//
// Each page also gets an invisible text layer built from the OCR word boxes,
// which is what makes the result searchable and selectable in any reader
// while what you see is the original handwriting.

const A4 = { width: 595.28, height: 841.89 }; // points, 72 per inch

// PDF strings are bytes, not UTF-16. Text is written with WinAnsiEncoding,
// which covers Latin-1 — enough for Spanish — plus the punctuation Windows
// put in 0x80–0x9F. Anything outside it (CJK, emoji) has no representation
// in this encoding and is dropped from the text layer rather than emitted as
// mojibake; the page image still shows it.
const WIN1252_EXTRA = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function winAnsiBytes(text) {
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 0x0a || code === 0x0d) {
      out.push(0x20); // newlines have no meaning inside a text string
    } else if (code >= 0x20 && code <= 0x7e) {
      out.push(code);
    } else if (code >= 0xa0 && code <= 0xff) {
      out.push(code); // Latin-1 supplement: á é í ó ú ñ ü ¿ ¡ …
    } else if (WIN1252_EXTRA.has(code)) {
      out.push(WIN1252_EXTRA.get(code));
    }
    // else: unrepresentable, skip it
  }
  return out;
}

// A PDF literal string: parentheses and backslashes must be escaped or the
// parser loses its place.
function pdfString(text) {
  const bytes = [0x28]; // (
  for (const b of winAnsiBytes(text)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) bytes.push(0x5c);
    bytes.push(b);
  }
  bytes.push(0x29); // )
  return new Uint8Array(bytes);
}

// Latin-1 bytes for the structural parts of the file — all ASCII.
function ascii(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

const num = (n) => (Math.round(n * 100) / 100).toString();

// Where the image sits on the sheet: scaled to fit, centred, aspect kept.
function fitOnPage(imgWidth, imgHeight) {
  const scale = Math.min(A4.width / imgWidth, A4.height / imgHeight);
  const width = imgWidth * scale;
  const height = imgHeight * scale;
  return {
    scale,
    width,
    height,
    x: (A4.width - width) / 2,
    y: (A4.height - height) / 2,
  };
}

// The invisible text layer. Text render mode 3 draws nothing, but the glyphs
// are still there to be found and selected. Each word is placed at its OCR
// box, converted from image pixels (origin top-left, y down) to PDF user
// space (origin bottom-left, y up).
function textLayer(page, fit) {
  const words = Array.isArray(page.words) ? page.words : [];
  const parts = [ascii('BT\n3 Tr\n')];

  if (words.length) {
    for (const w of words) {
      if (!w.t || !(w.w > 0) || !(w.h > 0)) continue;
      const size = Math.max(1, w.h * fit.scale);
      const x = fit.x + w.x * fit.scale;
      const y = fit.y + fit.height - (w.y + w.h) * fit.scale;
      // Squeeze each word horizontally towards the width its box had, so
      // selecting text in a reader lands on roughly the right ink. Capped:
      // stretching a short word to fill a wide box makes it run into its
      // neighbour, and extractors decide word breaks by geometry — that is
      // how "La canción" comes back out as "Lacanción".
      const nominal = size * 0.5 * w.t.length; // Helvetica averages ~0.5em
      const wanted = nominal > 0 ? (w.w * fit.scale * 100) / nominal : 100;
      const stretch = Math.max(50, Math.min(150, wanted));
      parts.push(ascii(`/F1 ${num(size)} Tf\n${num(stretch)} Tz\n1 0 0 1 ${num(x)} ${num(y)} Tm\n`));
      // Trailing space: each word is placed by its own text matrix, so
      // without one an extractor runs them together — "Lacanción demañana" —
      // and searching for a phrase stops working.
      parts.push(pdfString(`${w.t} `));
      parts.push(ascii(' Tj\n'));
    }
  } else if ((page.text || '').trim()) {
    // Transcribed before word positions were saved: no boxes to place words
    // in, but the text can still ride along so the page is searchable. Laid
    // out as plain lines down the sheet.
    const lines = page.text.split('\n').filter((l) => l.trim());
    const size = 10;
    lines.forEach((line, i) => {
      const y = fit.y + fit.height - (i + 1) * size * 1.2;
      if (y < fit.y) return; // ran off the bottom
      parts.push(ascii(`/F1 ${num(size)} Tf\n100 Tz\n1 0 0 1 ${num(fit.x)} ${num(y)} Tm\n`));
      parts.push(pdfString(line));
      parts.push(ascii(' Tj\n'));
    });
  }

  parts.push(ascii('ET\n'));
  return parts;
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Build a PDF from already-JPEG pages.
 *
 * `pages`: [{ jpeg: Uint8Array, width, height, words?, text? }] — `jpeg` must
 * be baseline JPEG bytes, which is what the app stores; callers convert
 * anything else first (a PNG can't go in as /DCTDecode).
 *
 * Returns a Blob.
 */
export function buildPdf(pages) {
  // Object numbering: 1 catalog, 2 page tree, 3 font, then per page a page
  // object, its content stream and its image.
  const objects = []; // index 0 → object 1
  const pageObjNums = [];
  const FONT = 3;

  objects.push(null, null, null); // placeholders for 1..3

  for (const page of pages) {
    const pageNum = objects.length + 1;
    const contentNum = pageNum + 1;
    const imageNum = pageNum + 2;
    pageObjNums.push(pageNum);

    const fit = fitOnPage(page.width || 1, page.height || 1);
    // `cm` places and scales the image; the unit square is mapped onto it.
    const content = concat([
      ascii(
        `q\n${num(fit.width)} 0 0 ${num(fit.height)} ${num(fit.x)} ${num(fit.y)} cm\n/Im0 Do\nQ\n`
      ),
      ...textLayer(page, fit),
    ]);

    objects.push(
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(A4.width)} ${num(A4.height)}] ` +
          `/Resources << /XObject << /Im0 ${imageNum} 0 R >> /Font << /F1 ${FONT} 0 R >> >> ` +
          `/Contents ${contentNum} 0 R >>`
      )
    );
    objects.push(
      concat([ascii(`<< /Length ${content.length} >>\nstream\n`), content, ascii('\nendstream')])
    );
    objects.push(
      concat([
        ascii(
          `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
            `/Length ${page.jpeg.length} >>\nstream\n`
        ),
        page.jpeg,
        ascii('\nendstream'),
      ])
    );
  }

  objects[0] = ascii('<< /Type /Catalog /Pages 2 0 R >>');
  objects[1] = ascii(
    `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`
  );
  objects[2] = ascii(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  );

  // Assemble, recording each object's byte offset for the xref table.
  const chunks = [ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    const head = ascii(`${i + 1} 0 obj\n`);
    const tail = ascii('\nendobj\n');
    offsets.push(offset);
    chunks.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });

  // xref entries are fixed-width: exactly 20 bytes each, EOL included.
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(ascii(xref));

  return new Blob(chunks, { type: 'application/pdf' });
}
