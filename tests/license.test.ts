import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { parseLicenseKey, verifyLicenseKey } from "@/lib/license";

// Ephemeral vendor keypair for tests — mirrors scripts/license-{keygen,issue}.mjs exactly.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function issue(email: string, sku = "toolkit", issued = "2026-07-01"): string {
  const payload = Buffer.from(JSON.stringify({ email, sku, issued }), "utf8");
  const signature = sign(null, payload, privateKey);
  return `VYUHA-${payload.toString("base64url")}.${signature.toString("base64url")}`;
}

describe("parseLicenseKey", () => {
  it("round-trips a well-formed key", () => {
    const p = parseLicenseKey(issue("a@b.com"));
    expect(p).not.toBeNull();
    expect(p!.payload).toEqual({ email: "a@b.com", sku: "toolkit", issued: "2026-07-01" });
  });

  it("rejects wrong prefix, missing dot, and garbage payloads", () => {
    expect(parseLicenseKey("NOPE-abc.def")).toBeNull();
    expect(parseLicenseKey("VYUHA-nodothere")).toBeNull();
    expect(parseLicenseKey("VYUHA-.sig")).toBeNull();
    expect(parseLicenseKey(`VYUHA-${Buffer.from("not json").toString("base64url")}.AAAA`)).toBeNull();
    expect(parseLicenseKey(`VYUHA-${Buffer.from(JSON.stringify({ nope: 1 })).toString("base64url")}.AAAA`)).toBeNull();
  });

  it("tolerates surrounding whitespace (paste-friendly)", () => {
    expect(parseLicenseKey(`  ${issue("a@b.com")}\n`)).not.toBeNull();
  });
});

describe("verifyLicenseKey", () => {
  it("accepts a genuine key against the matching public key", () => {
    const check = verifyLicenseKey(issue("buyer@x.com", "app"), PUB_PEM);
    expect(check.valid).toBe(true);
    expect(check.payload!.email).toBe("buyer@x.com");
    expect(check.payload!.sku).toBe("app");
  });

  it("rejects a tampered payload (email swapped after signing)", () => {
    const key = issue("buyer@x.com");
    const [head, sig] = key.slice("VYUHA-".length).split(".");
    void head;
    const forged = Buffer.from(JSON.stringify({ email: "thief@x.com", sku: "toolkit", issued: "2026-07-01" })).toString("base64url");
    const check = verifyLicenseKey(`VYUHA-${forged}.${sig}`, PUB_PEM);
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/Signature/);
  });

  it("rejects a key signed by a DIFFERENT private key", () => {
    const other = generateKeyPairSync("ed25519");
    const payload = Buffer.from(JSON.stringify({ email: "a@b.com", sku: "toolkit", issued: "2026-07-01" }));
    const sig = sign(null, payload, other.privateKey);
    const check = verifyLicenseKey(`VYUHA-${payload.toString("base64url")}.${sig.toString("base64url")}`, PUB_PEM);
    expect(check.valid).toBe(false);
  });

  it("rejects malformed input with a paste-friendly reason", () => {
    const check = verifyLicenseKey("hello world", PUB_PEM);
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/Malformed/);
  });
});

// ---------------------------------------------------------------------------
// Monetization v2 — entitlement layer (expiry + trial)
// ---------------------------------------------------------------------------
import { evaluateEntitlement, isKeyExpired, trialDaysLeft, TRIAL_DAYS } from "@/lib/license";

function issueWithExpiry(email: string, expires: string): string {
  const payload = Buffer.from(JSON.stringify({ email, sku: "app", issued: "2026-01-01", expires }), "utf8");
  const signature = sign(null, payload, privateKey);
  return `VYUHA-${payload.toString("base64url")}.${signature.toString("base64url")}`;
}

const T = (iso: string) => new Date(iso + "T12:00:00");

describe("isKeyExpired / expiry-aware keys", () => {
  it("lifetime keys (no expires) never expire; annual keys expire after the date", () => {
    expect(isKeyExpired({ email: "a@b.com", sku: "app", issued: "2026-01-01" }, T("2036-01-01"))).toBe(false);
    const p = { email: "a@b.com", sku: "app", issued: "2026-01-01", expires: "2027-01-01" };
    expect(isKeyExpired(p, T("2026-12-31"))).toBe(false);
    expect(isKeyExpired(p, T("2027-01-01"))).toBe(false); // expiry day itself still valid
    expect(isKeyExpired(p, T("2027-01-02"))).toBe(true);
  });

  it("expires field is covered by the signature (tampering breaks the key)", () => {
    const key = issueWithExpiry("a@b.com", "2026-02-01");
    const sig = key.split(".")[1];
    const stretched = Buffer.from(JSON.stringify({ email: "a@b.com", sku: "app", issued: "2026-01-01", expires: "2099-01-01" })).toString("base64url");
    expect(verifyLicenseKey(`VYUHA-${stretched}.${sig}`, PUB_PEM).valid).toBe(false);
  });
});

describe("trialDaysLeft", () => {
  it("full at start, counts down, clamps at 0, and handles null/garbage", () => {
    expect(trialDaysLeft("2026-07-01T00:00:00.000Z", T("2026-07-01"))).toBe(TRIAL_DAYS);
    expect(trialDaysLeft("2026-07-01T00:00:00.000Z", T("2026-07-10"))).toBe(5);
    expect(trialDaysLeft("2026-07-01T00:00:00.000Z", T("2026-09-01"))).toBe(0);
    expect(trialDaysLeft(null, T("2026-07-01"))).toBe(0);
    expect(trialDaysLeft("not a date", T("2026-07-01"))).toBe(0);
  });
});

describe("evaluateEntitlement", () => {
  const freshTrial = "2026-07-01T00:00:00.000Z";

  it("valid lifetime key → licensed regardless of trial", () => {
    const e = evaluateEntitlement(issue("buyer@x.com"), null, T("2026-07-01"), PUB_PEM);
    expect(e.state).toBe("licensed");
    expect(e.pro).toBe(true);
  });

  it("no key: trial while days remain, unlicensed after", () => {
    const during = evaluateEntitlement(null, freshTrial, T("2026-07-05"), PUB_PEM);
    expect(during.state).toBe("trial");
    expect(during.pro).toBe(true);
    expect(during.trialDaysLeft).toBeGreaterThan(0);
    const after = evaluateEntitlement(null, freshTrial, T("2026-08-01"), PUB_PEM);
    expect(after.state).toBe("unlicensed");
    expect(after.pro).toBe(false);
  });

  it("expired annual key → expired-key, pro only while grace trial remains", () => {
    const key = issueWithExpiry("annual@x.com", "2026-06-30");
    const withTrial = evaluateEntitlement(key, freshTrial, T("2026-07-05"), PUB_PEM);
    expect(withTrial.state).toBe("expired-key");
    expect(withTrial.pro).toBe(true);
    expect(withTrial.payload!.email).toBe("annual@x.com");
    const trialOver = evaluateEntitlement(key, freshTrial, T("2026-09-01"), PUB_PEM);
    expect(trialOver.state).toBe("expired-key");
    expect(trialOver.pro).toBe(false);
  });

  it("invalid/tampered key falls back to trial state with the failure reason", () => {
    const e = evaluateEntitlement("VYUHA-garbage.key", freshTrial, T("2026-07-05"), PUB_PEM);
    expect(e.state).toBe("trial");
    expect(e.pro).toBe(true);
    expect(e.reason).toBeTruthy();
  });
});
