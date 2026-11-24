/** A code point, or -1 for one byte that is not part of a well-formed sequence (RFC 3629). */
export const MALFORMED = -1;

const cont = (b: number | undefined, lo = 0x80, hi = 0xbf): boolean => b !== undefined && b >= lo && b <= hi;

/**
 * Decodes by RFC 3629: each byte that is not part of a well-formed sequence is one MALFORMED on its own
 * (TextDecoder replaces by maximal subpart, which gives other advances).
 */
export function decodeUtf8(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i] as number;
    if (b < 0x80) {
      out.push(b);
      i += 1;
    } else if (b >= 0xc2 && b <= 0xdf && cont(bytes[i + 1])) {
      out.push(((b & 0x1f) << 6) | ((bytes[i + 1] as number) & 0x3f));
      i += 2;
    } else if (b >= 0xe0 && b <= 0xef) {
      const lo = b === 0xe0 ? 0xa0 : 0x80;
      const hi = b === 0xed ? 0x9f : 0xbf;
      if (cont(bytes[i + 1], lo, hi) && cont(bytes[i + 2])) {
        out.push(((b & 0x0f) << 12) | (((bytes[i + 1] as number) & 0x3f) << 6) | ((bytes[i + 2] as number) & 0x3f));
        i += 3;
      } else {
        out.push(MALFORMED);
        i += 1;
      }
    } else if (b >= 0xf0 && b <= 0xf4) {
      const lo = b === 0xf0 ? 0x90 : 0x80;
      const hi = b === 0xf4 ? 0x8f : 0xbf;
      if (cont(bytes[i + 1], lo, hi) && cont(bytes[i + 2]) && cont(bytes[i + 3])) {
        out.push(
          ((b & 0x07) << 18) |
            (((bytes[i + 1] as number) & 0x3f) << 12) |
            (((bytes[i + 2] as number) & 0x3f) << 6) |
            ((bytes[i + 3] as number) & 0x3f),
        );
        i += 4;
      } else {
        out.push(MALFORMED);
        i += 1;
      }
    } else {
      out.push(MALFORMED);
      i += 1;
    }
  }
  return out;
}

/** Encodes well-formed text (a lone surrogate, which JSON.stringify never leaves unescaped, becomes U+FFFD). */
export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    let cp = ch.codePointAt(0) as number;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}
