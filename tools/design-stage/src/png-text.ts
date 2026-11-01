const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function checkSignature(png: Buffer): void {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
}

/** Returns a copy of `png` with a tEXt chunk `keyword`/`text` inserted after IHDR. */
export function writePngText(png: Buffer, keyword: string, text: string): Buffer {
  checkSignature(png);
  const data = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]);
  const type = Buffer.from("tEXt", "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, ihdrEnd), length, type, data, crc, png.subarray(ihdrEnd)]);
}

/** The tEXt chunks of `png` as keyword to text. */
export function readPngText(png: Buffer): Map<string, string> {
  checkSignature(png);
  const out = new Map<string, string>();
  let pos = 8;
  while (pos + 12 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    if (type === "tEXt") {
      const data = png.subarray(pos + 8, pos + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) out.set(data.toString("latin1", 0, nul), data.toString("latin1", nul + 1));
    }
    if (type === "IEND") break;
    pos += 12 + len;
  }
  return out;
}
