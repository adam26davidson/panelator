import { inflateSync } from "node:zlib";

/** Decodes an 8-bit RGB, non-interlaced PNG to its raw RGB bytes, rows top to bottom. */
export function decodePng(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (pos < png.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) throw new Error("PNG is not 8-bit RGB and non-interlaced");
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] as number;
      const a = i >= 3 ? (rgb[y * stride + i - 3] as number) : 0;
      const b = y > 0 ? (rgb[(y - 1) * stride + i] as number) : 0;
      const c = y > 0 && i >= 3 ? (rgb[(y - 1) * stride + i - 3] as number) : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      rgb[y * stride + i] = v & 255;
    }
  }
  return { width, height, rgb };
}
