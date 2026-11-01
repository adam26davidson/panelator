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

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** Inserts a tEXt chunk after IHDR. */
export function addTextChunk(png: Buffer, keyword: string, text: string): Buffer {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  const text_ = chunk("tEXt", Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]));
  return Buffer.concat([png.subarray(0, ihdrEnd), text_, png.subarray(ihdrEnd)]);
}

/** The tEXt chunks of a PNG, by keyword. */
export function readTextChunks(png: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 8; at + 12 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    if (type === "tEXt") {
      const data = png.subarray(at + 8, at + 8 + length);
      const zero = data.indexOf(0);
      out[data.toString("latin1", 0, zero)] = data.toString("latin1", zero + 1);
    }
    at += 12 + length;
  }
  return out;
}

/** The pixel size from IHDR. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
