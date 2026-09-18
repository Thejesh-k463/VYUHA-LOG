/**
 * Synchronous reads of a PDF's BYTES, for detection.
 *
 * `detect` is synchronous and `pdf-parse` is not, so a contract-note detector
 * cannot ask for the page text while the registry is ranking. Two things CAN
 * be read synchronously, and between them they carry every broker fingerprint
 * verified so far (docs/BROKER_FORMATS.md):
 *
 *   - the raw bytes (`latin1`, one character per byte): document metadata and
 *     the digital-signature dictionary are stored uncompressed — Dhan's legal
 *     name sits in the metadata, Groww's in the signer `/Name`;
 *   - the page CONTENT streams, which are FlateDecode-compressed. Upstox's
 *     note draws its text with standard Type1 fonts, so its legal name is
 *     plain `(...) Tj` text once a content stream is inflated.
 *
 * Only non-image streams are inflated, each one bounded, the whole scan
 * bounded, and any stream that does not inflate is skipped rather than
 * thrown: a detector that throws takes the whole ranking down with it.
 * ZERO DB and ZERO React imports.
 */
import { inflateSync } from "node:zlib";

/** The file as one character per byte, for substring fingerprints. */
export function pdfLatin1(buffer: Buffer): string {
  return buffer.toString("latin1");
}

const STREAM_START = /(?<!end)stream\r?\n/g;
/** Per-stream and whole-file ceilings on inflated bytes. */
const MAX_STREAM_OUT = 2_000_000;
const MAX_TOTAL_OUT = 6_000_000;

/**
 * Every FlateDecode, non-image stream of the file, inflated and joined.
 * Bounded; never throws. Returns "" for anything that is not a PDF.
 */
export function pdfInflatedText(buffer: Buffer): string {
  const s = pdfLatin1(buffer);
  if (!s.startsWith("%PDF")) return "";
  const out: string[] = [];
  let total = 0;
  STREAM_START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STREAM_START.exec(s)) && total < MAX_TOTAL_OUT) {
    const start = m.index + m[0].length;
    // The stream's own dictionary: from the object header back from here.
    const objAt = s.lastIndexOf(" obj", m.index);
    const dict = s.slice(objAt >= 0 ? objAt : Math.max(0, m.index - 800), m.index);
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    STREAM_START.lastIndex = end;
    if (!/\/FlateDecode/.test(dict) || /\/Subtype\s*\/Image/.test(dict)) continue;
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    const stop = len ? Math.min(start + Number(len[1]), end) : end;
    try {
      const text = inflateSync(buffer.subarray(start, stop), { maxOutputLength: MAX_STREAM_OUT }).toString("latin1");
      out.push(text);
      total += text.length;
    } catch {
      // A stream that does not inflate (a truncated one, or a filter chain
      // this does not read) is skipped — never a thrown detector.
    }
  }
  return out.join("\n");
}
