/**
 * export.js — depth-map export encoders (16-bit grayscale PNG & TIFF).
 *
 * The canvas API is 8-bit only, so both formats are encoded by hand from the
 * normalized Float32Array depth data (values 0..1 → 0..65535).
 *
 * Classic script: exposes window.DepthMapExport.
 */

window.DepthMapExport = (function () {
  'use strict';

  /** Convert normalized depth (0..1) to a Uint16Array (0..65535). */
  function toUint16(depth) {
    const out = new Uint16Array(depth.length);
    for (let i = 0; i < depth.length; i++) {
      let v = depth[i];
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      out[i] = Math.round(v * 65535);
    }
    return out;
  }

  // ── CRC-32 (PNG chunks) ─────────────────────────────────────────────
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, end) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ── Adler-32 (zlib) ─────────────────────────────────────────────────
  function adler32(bytes) {
    let a = 1, b = 0;
    for (let i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  /**
   * Wrap raw bytes in a valid zlib stream using uncompressed (stored)
   * DEFLATE blocks. Universally decodable; no compression dependency.
   */
  function zlibStore(raw) {
    const MAX = 65535;
    const nBlocks = Math.ceil(raw.length / MAX) || 1;
    const out = new Uint8Array(2 + raw.length + nBlocks * 5 + 4);
    let p = 0;
    out[p++] = 0x78; // CMF: deflate, 32K window
    out[p++] = 0x01; // FLG (checksum-valid, no dict)
    for (let i = 0; i < nBlocks; i++) {
      const off = i * MAX;
      const len = Math.min(MAX, raw.length - off);
      out[p++] = i === nBlocks - 1 ? 1 : 0;         // BFINAL
      out[p++] = len & 0xff; out[p++] = len >>> 8;  // LEN
      out[p++] = ~len & 0xff; out[p++] = (~len >>> 8) & 0xff; // NLEN
      out.set(raw.subarray(off, off + len), p);
      p += len;
    }
    const ad = adler32(raw);
    out[p++] = (ad >>> 24) & 0xff; out[p++] = (ad >>> 16) & 0xff;
    out[p++] = (ad >>> 8) & 0xff; out[p++] = ad & 0xff;
    return out;
  }

  /** Build one PNG chunk: length + type + data + CRC. */
  function pngChunk(type, data) {
    const chunk = new Uint8Array(12 + data.length);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    dv.setUint32(8 + data.length, crc32(chunk, 4, 8 + data.length));
    return chunk;
  }

  /**
   * Encode a 16-bit grayscale PNG.
   * @param {Float32Array} depth normalized 0..1, size*size values
   * @param {number} size
   * @returns {Blob}
   */
  function encodePNG16(depth, width, height) {
    if (height == null) height = width; // square fallback
    const px = toUint16(depth);

    // Raw scanlines: filter byte 0 + big-endian 16-bit samples.
    const raw = new Uint8Array(height * (1 + width * 2));
    let p = 0;
    for (let y = 0; y < height; y++) {
      raw[p++] = 0; // filter: None
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const v = px[row + x];
        raw[p++] = v >>> 8;
        raw[p++] = v & 0xff;
      }
    }

    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);  // width
    dv.setUint32(4, height); // height
    ihdr[8] = 16;           // bit depth
    ihdr[9] = 0;            // color type: grayscale
    // compression 0, filter 0, interlace 0 (already zero)

    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parts = [
      sig,
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlibStore(raw)),
      pngChunk('IEND', new Uint8Array(0)),
    ];
    return new Blob(parts, { type: 'image/png' });
  }

  /**
   * Encode a 16-bit grayscale uncompressed TIFF (little-endian).
   * @param {Float32Array} depth normalized 0..1, size*size values
   * @param {number} size
   * @returns {Blob}
   */
  function encodeTIFF16(depth, width, height) {
    if (height == null) height = width; // square fallback
    const px = toUint16(depth);
    const imageBytes = px.length * 2;

    const NUM_TAGS = 11;
    const headerSize = 8;
    const ifdSize = 2 + NUM_TAGS * 12 + 4;
    const extraSize = 16;               // two RATIONALs (X/Y resolution)
    const ifdOffset = headerSize;
    const extraOffset = ifdOffset + ifdSize;
    const dataOffset = extraOffset + extraSize;

    const buf = new ArrayBuffer(dataOffset + imageBytes);
    const dv = new DataView(buf);
    const bytes = new Uint8Array(buf);

    // Header
    dv.setUint16(0, 0x4949, true);      // 'II' little-endian
    dv.setUint16(2, 42, true);
    dv.setUint32(4, ifdOffset, true);

    // IFD
    let p = ifdOffset;
    dv.setUint16(p, NUM_TAGS, true); p += 2;
    const tag = (id, type, count, value) => {
      dv.setUint16(p, id, true);
      dv.setUint16(p + 2, type, true);
      dv.setUint32(p + 4, count, true);
      dv.setUint32(p + 8, value, true);
      p += 12;
    };
    tag(256, 3, 1, width);              // ImageWidth (SHORT)
    tag(257, 3, 1, height);             // ImageLength
    tag(258, 3, 1, 16);                 // BitsPerSample
    tag(259, 3, 1, 1);                  // Compression: none
    tag(262, 3, 1, 1);                  // Photometric: BlackIsZero
    tag(273, 4, 1, dataOffset);         // StripOffsets
    tag(277, 3, 1, 1);                  // SamplesPerPixel
    tag(278, 3, 1, height);             // RowsPerStrip (single strip)
    tag(279, 4, 1, imageBytes);         // StripByteCounts
    tag(282, 5, 1, extraOffset);        // XResolution → RATIONAL
    tag(283, 5, 1, extraOffset + 8);    // YResolution → RATIONAL
    dv.setUint32(p, 0, true);           // next IFD: none

    // RATIONAL values: 72/1 dpi
    dv.setUint32(extraOffset, 72, true);
    dv.setUint32(extraOffset + 4, 1, true);
    dv.setUint32(extraOffset + 8, 72, true);
    dv.setUint32(extraOffset + 12, 1, true);

    // Pixel data (little-endian 16-bit)
    let q = dataOffset;
    for (let i = 0; i < px.length; i++) {
      bytes[q++] = px[i] & 0xff;
      bytes[q++] = px[i] >>> 8;
    }

    return new Blob([buf], { type: 'image/tiff' });
  }

  /** Trigger a browser download of a Blob. */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { encodePNG16, encodeTIFF16, downloadBlob };
})();
