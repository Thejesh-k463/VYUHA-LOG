// Offline license verification (monetization §4). NO server call — an Ed25519
// signature over the payload is checked against the vendor PUBLIC key baked in
// below. The PRIVATE key never ships: it lives with the vendor (license-private.pem,
// gitignored) and is only used by scripts/license-issue.mjs to mint keys after a sale.
//
// Key format:  VYUHA-<base64url(payload JSON)>.<base64url(signature)>
// Payload:     { "email": "buyer@x.com", "sku": "toolkit"|"app"|"indicators", "issued": "YYYY-MM-DD" }
//
// Threat model: stop honest sharing, not determined crackers — the key embeds the
// buyer's email and the UI shows "Licensed to <email>" (social friction). An offline
// app can always be patched; that is accepted (see docs/monetization/MONETIZATION_PLAN.md).
//
// ENFORCEMENT MODES — flip ONE constant when you start selling:
//   "banner" (current): everything works; Pro screens show an "unlicensed" banner.
//   "block":            Pro screens render the upsell panel instead of content.

import { verify as edVerify } from "node:crypto";

export type LicenseSku = "toolkit" | "app" | "indicators";
export type LicenseEnforcement = "banner" | "block";

export const LICENSE_ENFORCEMENT: LicenseEnforcement = "banner";

/** Vendor Ed25519 PUBLIC key (safe to ship). Regenerate via scripts/license-keygen.mjs. */
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEADGdKaFSdvVk9XZ+tusGpEFDhpMF0OWwa5PldZT5aTCI=
-----END PUBLIC KEY-----`;

export interface LicensePayload {
  email: string;
  sku: LicenseSku | string;
  issued: string; // ISO date
}

export interface LicenseCheck {
  valid: boolean;
  reason?: string; // set when invalid
  payload?: LicensePayload; // set when valid
}

const KEY_PREFIX = "VYUHA-";

/** Split a key into payload+signature bytes. Pure string handling — no crypto. */
export function parseLicenseKey(key: string): { payloadRaw: Buffer; signature: Buffer; payload: LicensePayload } | null {
  const trimmed = key.trim();
  if (!trimmed.startsWith(KEY_PREFIX)) return null;
  const body = trimmed.slice(KEY_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1) return null;
  try {
    const payloadRaw = Buffer.from(body.slice(0, dot), "base64url");
    const signature = Buffer.from(body.slice(dot + 1), "base64url");
    const payload = JSON.parse(payloadRaw.toString("utf8")) as LicensePayload;
    if (typeof payload?.email !== "string" || typeof payload?.sku !== "string" || typeof payload?.issued !== "string") return null;
    return { payloadRaw, signature, payload };
  } catch {
    return null;
  }
}

/** Verify a license key against a public key (defaults to the baked-in vendor key). */
export function verifyLicenseKey(key: string, publicKeyPem: string = LICENSE_PUBLIC_KEY_PEM): LicenseCheck {
  const parsed = parseLicenseKey(key);
  if (!parsed) return { valid: false, reason: "Malformed key — paste the full VYUHA-… key from your purchase email." };
  try {
    const ok = edVerify(null, parsed.payloadRaw, publicKeyPem, parsed.signature);
    if (!ok) return { valid: false, reason: "Signature check failed — the key was altered or issued for a different build." };
    return { valid: true, payload: parsed.payload };
  } catch {
    return { valid: false, reason: "Signature check failed — the key was altered or issued for a different build." };
  }
}

export const SKU_LABELS: Record<string, string> = {
  toolkit: "Trader's Toolkit (app + indicators)",
  app: "Vyuha app",
  indicators: "Indicators bundle",
};
