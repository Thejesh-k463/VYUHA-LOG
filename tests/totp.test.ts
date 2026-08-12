import { describe, expect, it } from "vitest";
import { base32Decode, looksLikeTotpSecret, totp } from "@/lib/totp";

/**
 * Pinned to RFC 6238's Appendix B test vectors (SHA-1 rows), so this
 * implementation and every authenticator app agree by construction. The RFC
 * secret is ASCII "12345678901234567890", which is
 * GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ in base32.
 */

const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("RFC 6238 vectors (SHA-1)", () => {
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, expected] of vectors) {
    it(`T=${t} → ${expected}`, () => {
      expect(totp(RFC_SECRET_B32, { digits: 8, nowSeconds: t })).toBe(expected);
    });
  }

  it("6-digit codes are the last six of the 8-digit dynamic value", () => {
    expect(totp(RFC_SECRET_B32, { digits: 6, nowSeconds: 59 })).toBe("287082");
  });

  it("the whole 30-second window yields one code", () => {
    expect(totp(RFC_SECRET_B32, { nowSeconds: 30 })).toBe(totp(RFC_SECRET_B32, { nowSeconds: 59 }));
    expect(totp(RFC_SECRET_B32, { nowSeconds: 60 })).not.toBe(totp(RFC_SECRET_B32, { nowSeconds: 59 }));
  });
});

describe("base32", () => {
  it("decodes the RFC secret to the RFC bytes", () => {
    expect(base32Decode(RFC_SECRET_B32).toString("ascii")).toBe("12345678901234567890");
  });

  it("tolerates the formatting enrollment screens use", () => {
    expect(base32Decode("gezd gnbv-gy3t qojq GEZD GNBV GY3T QOJQ====").toString("ascii")).toBe("12345678901234567890");
  });

  it("names a bad character instead of producing a silently wrong code", () => {
    expect(() => base32Decode("GEZD1NBV")).toThrow(/base32/i); // '1' is not in the alphabet
  });
});

describe("save-time validation", () => {
  it("rejects the classic mistake — pasting the 6-digit CODE as the secret", () => {
    expect(looksLikeTotpSecret("492817")).toBe(false);
  });
  it("accepts a real enrollment secret in any formatting", () => {
    expect(looksLikeTotpSecret(RFC_SECRET_B32)).toBe(true);
    expect(looksLikeTotpSecret("gezd gnbv gy3t qojq")).toBe(true);
  });
  it("rejects strings that are not base32 at all", () => {
    expect(looksLikeTotpSecret("hunter2!")).toBe(false);
    expect(looksLikeTotpSecret("short")).toBe(false);
  });
});
