// RFC 6238 TOTP (PURE — node:crypto only, no DB, no React).
//
// Angel One's SmartAPI login is automatable precisely because its second
// factor is a standard TOTP: given the enrolled SECRET (the base32 string
// behind the QR code, not the 6-digit code it produces), the current code can
// be generated at pull time and the daily login needs no human. The secret is
// a PERMANENT second factor — which is why this feature exists only on top of
// the v2.99.80 vault, never beside plaintext storage.
//
// No dependency, deliberately: this repo's lockfile rules make `otplib` a
// liability, and RFC 6238 is ~40 lines of HMAC — SHA-1, 30-second steps,
// 6 digits, exactly what authenticator apps default to and what Angel One
// enrolls. The implementation is pinned to the RFC's own test vectors in
// tests/totp.test.ts, so "our 6 digits" and "the authenticator's 6 digits"
// cannot silently diverge.

import { createHmac } from "node:crypto";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 4648 base32 → bytes. Case-insensitive, tolerant of the padding and the
 * spaces/dashes enrollment screens format secrets with. Throws on characters
 * outside the alphabet — a mistyped secret must fail at SAVE time with a
 * message, not at 3:35pm as a broker rejection.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (clean.length === 0) throw new Error("The TOTP secret is empty.");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`The TOTP secret contains "${ch}" — not a base32 character. Paste the SECRET from enrollment, not the 6-digit code.`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** True when the string plausibly IS a base32 TOTP secret (validation at save). */
export function looksLikeTotpSecret(s: string): boolean {
  const clean = s.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  // A 6-8 digit string is the CODE, not the secret — the classic paste error.
  if (/^\d{4,8}$/.test(clean)) return false;
  return clean.length >= 16 && /^[A-Z2-7]+$/.test(clean);
}

export interface TotpOptions {
  /** Seconds per step. Every mainstream enrollment uses 30. */
  periodSeconds?: number;
  digits?: number;
  /** Unix time in SECONDS — injectable so tests pin the RFC vectors. */
  nowSeconds?: number;
}

/** The current TOTP code for a base32 secret (SHA-1, per RFC 6238 defaults). */
export function totp(secretBase32: string, opts: TotpOptions = {}): string {
  const period = opts.periodSeconds ?? 30;
  const digits = opts.digits ?? 6;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  const counter = Math.floor(now / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]) %
    10 ** digits;
  return String(code).padStart(digits, "0");
}
