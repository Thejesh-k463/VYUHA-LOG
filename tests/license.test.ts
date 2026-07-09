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
