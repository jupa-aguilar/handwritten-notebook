// Minimal ZIP writer (store-only).
//
// Several pages must leave as ONE download: browsers only honour the first
// programmatic download per user gesture, so N separate clicks silently drop
// all but one file. The images are JPEGs, so storing beats deflating anyway.
//
// Hand-rolled binary formats are exactly what unit tests are for — see
// test/zip.test.js, which parses the output back and follows every offset.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, bytes }] → Blob. Store-only, UTF-8 names, 32-bit sizes.
export function buildZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, bytes } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // flags: UTF-8 names
    local.setUint16(8, 0, true); // method: store
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true); // compressed size
    local.setUint32(22, bytes.length, true); // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra field length
    central.push({ nameBytes, crc, size: bytes.length, offset });
    chunks.push(new Uint8Array(local.buffer), nameBytes, bytes);
    offset += 30 + nameBytes.length + bytes.length;
  }
  const cdStart = offset;
  for (const e of central) {
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); // central directory signature
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true); // version needed
    cd.setUint16(8, 0x0800, true); // flags: UTF-8 names
    cd.setUint16(10, 0, true); // method: store
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, e.crc, true);
    cd.setUint32(20, e.size, true);
    cd.setUint32(24, e.size, true);
    cd.setUint16(28, e.nameBytes.length, true);
    cd.setUint32(42, e.offset, true); // local header offset
    chunks.push(new Uint8Array(cd.buffer), e.nameBytes);
    offset += 46 + e.nameBytes.length;
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); // end-of-central-directory signature
  eocd.setUint16(8, central.length, true); // entries on this disk
  eocd.setUint16(10, central.length, true); // entries total
  eocd.setUint32(12, offset - cdStart, true); // central directory size
  eocd.setUint32(16, cdStart, true); // central directory offset
  chunks.push(new Uint8Array(eocd.buffer));
  return new Blob(chunks, { type: 'application/zip' });
}
