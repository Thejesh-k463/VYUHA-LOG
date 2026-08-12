import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  validateRevocationList,
  canonicalListBytes,
  isNewerList,
  revocationStateFor,
  DEFAULT_REVOCATION_MESSAGE,
  type RevocationList,
} from "@/lib/revocation-format";

/**
 * The signed revocation list (v2.99.91) — the half of revocation that reaches
 * an install without an update.
 *
 * The properties worth pinning are the ones a mistake would be expensive:
 *
 *   1. grace WARNS and does not lock — a revocation published in error must be
 *      recoverable, and the user must never discover it as a dead screen;
 *   2. an older list cannot undo a newer one (replay);
 *   3. the canonical bytes are stable, because the publisher and the verifier
 *      sign/check independently and a key-order drift breaks every signature
 *      silently;
 *   4. a forged or altered list verifies against nothing.
 */

const KEY = "A1B2-C3D4-E5";
const OTHER = "9999-8888-77";

const list = (over: Partial<RevocationList> = {}): RevocationList => ({
  vyuhaRevocations: true,
  v: 1,
  issuedAt: "2026-08-12T00:00:00.000Z",
  entries: [{ keyId: KEY, effectiveFrom: "2026-08-26", message: "Refunded — contact support." }],
  ...over,
});

describe("grace: warn first, lock later", () => {
  it("warns with a day count while inside the window, and does NOT revoke", () => {
    const s = revocationStateFor(KEY, list(), new Date("2026-08-16T10:00:00Z"));
    expect(s.status).toBe("warning");
    if (s.status === "warning") {
      expect(s.daysLeft).toBe(11);
      expect(s.effectiveFrom).toBe("2026-08-26");
      expect(s.message).toMatch(/Refunded/);
    }
  });

  it("revokes once the effective date has passed", () => {
    const s = revocationStateFor(KEY, list(), new Date("2026-08-27T00:00:01Z"));
    expect(s.status).toBe("revoked");
  });

  it("counts the effective day itself as still inside grace", () => {
    // Locking at 00:00 on the stated date would take a day the user was told
    // they had. The window closes at the END of effectiveFrom.
    expect(revocationStateFor(KEY, list(), new Date("2026-08-26T18:00:00Z")).status).toBe("warning");
  });

  it("an entry with no effectiveFrom locks immediately", () => {
    const l = list({ entries: [{ keyId: KEY }] });
    const s = revocationStateFor(KEY, l, new Date("2020-01-01"));
    expect(s.status).toBe("revoked");
    if (s.status === "revoked") expect(s.message).toBe(DEFAULT_REVOCATION_MESSAGE);
  });

  it("leaves every other key alone", () => {
    expect(revocationStateFor(OTHER, list(), new Date("2027-01-01")).status).toBe("active");
    expect(revocationStateFor(null, list()).status).toBe("active");
    expect(revocationStateFor(KEY, null).status).toBe("active");
  });

  it("matches key ids case-insensitively", () => {
    expect(revocationStateFor(KEY.toLowerCase(), list(), new Date("2026-08-16")).status).toBe("warning");
  });

  it("a malformed effectiveFrom locks rather than granting unlimited grace", () => {
    // Fail CLOSED on a malformed date: the alternative is a typo in the
    // published list silently granting a permanent reprieve.
    const l = list({ entries: [{ keyId: KEY, effectiveFrom: "not-a-date" }] });
    expect(revocationStateFor(KEY, l, new Date("2026-08-16")).status).toBe("revoked");
  });
});

describe("anti-rollback", () => {
  it("accepts a newer list and refuses an older one", () => {
    expect(isNewerList("2026-08-12T00:00:00Z", null)).toBe(true);
    expect(isNewerList("2026-08-13T00:00:00Z", "2026-08-12T00:00:00Z")).toBe(true);
    expect(isNewerList("2026-08-11T00:00:00Z", "2026-08-12T00:00:00Z")).toBe(false);
    // Same list re-read on the next launch is not "newer" — the caller treats
    // that as steady state, not as grounds to re-accept.
    expect(isNewerList("2026-08-12T00:00:00Z", "2026-08-12T00:00:00Z")).toBe(false);
  });

  it("an unparseable issue date can never displace a good one", () => {
    expect(isNewerList("garbage", "2026-08-12T00:00:00Z")).toBe(false);
  });
});

describe("the envelope", () => {
  it("rejects everything that is not a signed Vyuha list", () => {
    expect(validateRevocationList(null).ok).toBe(false);
    expect(validateRevocationList({ list: list() }).ok).toBe(false); // unsigned
    expect(validateRevocationList({ list: { ...list(), vyuhaRevocations: false }, signature: "x" }).ok).toBe(false);
    expect(validateRevocationList({ list: { ...list(), v: 99 }, signature: "x" }).ok).toBe(false);
    expect(validateRevocationList({ list: { ...list(), issuedAt: "nope" }, signature: "x" }).ok).toBe(false);
    expect(validateRevocationList({ list: { ...list(), entries: [{ nope: 1 }] }, signature: "x" }).ok).toBe(false);
    expect(validateRevocationList({ list: list(), signature: "sig" }).ok).toBe(true);
  });

  it("an EMPTY list is valid — publishing one revokes nobody", () => {
    expect(validateRevocationList({ list: list({ entries: [] }), signature: "s" }).ok).toBe(true);
    expect(revocationStateFor(KEY, list({ entries: [] })).status).toBe("active");
  });
});

describe("canonical bytes and signature", () => {
  it("are stable regardless of key order in the source object", () => {
    // The publisher builds the object one way and the verifier another; if
    // these ever diverge every signature fails and the feature dies silently.
    const a = canonicalListBytes(list());
    const reordered = { entries: list().entries, issuedAt: list().issuedAt, v: 1, vyuhaRevocations: true } as RevocationList;
    expect(canonicalListBytes(reordered)).toBe(a);
  });

  it("omit optional fields rather than emitting undefined", () => {
    const bytes = canonicalListBytes(list({ entries: [{ keyId: KEY }] }));
    expect(bytes).not.toContain("effectiveFrom");
    expect(bytes).not.toContain("undefined");
  });

  it("a real Ed25519 signature over the canonical bytes verifies, and any edit breaks it", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const l = list();
    const sig = sign(null, Buffer.from(canonicalListBytes(l), "utf8"), privateKey);

    const { verify } = await import("node:crypto");
    expect(verify(null, Buffer.from(canonicalListBytes(l), "utf8"), publicKey, sig)).toBe(true);

    // Adding a victim to a signed list — the attack this signature exists for.
    const tampered = list({ entries: [...l.entries, { keyId: OTHER }] });
    expect(verify(null, Buffer.from(canonicalListBytes(tampered), "utf8"), publicKey, sig)).toBe(false);

    // Moving the grace date out — the attack a revoked user would attempt.
    const extended = list({ entries: [{ keyId: KEY, effectiveFrom: "2099-01-01", message: "Refunded — contact support." }] });
    expect(verify(null, Buffer.from(canonicalListBytes(extended), "utf8"), publicKey, sig)).toBe(false);
  });
});
