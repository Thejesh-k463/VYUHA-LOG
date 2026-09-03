import { describe, expect, it } from "vitest";
import {
  AUTH_REENROL_CTA,
  DHAN_TOTP_CONSENT,
  DHAN_TOTP_CONSENT_VERSION,
  KEY_KEPT_PLACEHOLDER,
  KITE_DAILY_LOGIN_NOTE,
  PICK_ACCOUNT_FIRST,
  PICK_ACCOUNT_PLACEHOLDER,
  TOKEN_EXPIRED_TITLE,
  TOKEN_EXPIRY_SEEN_KEY,
  tokenExpiredMessage,
} from "@/components/import/broker-connect";

/**
 * Consent / explainer copy pins (v3.6.0 WS3). Both live as ONE exported const
 * in the component (the openalgo-disclosure rule: risk copy written twice
 * drifts). Pinned VERBATIM: consent copy that changes silently is consent to
 * something the user never read — a change here must be a deliberate edit of
 * this test in the same commit.
 */
describe("Dhan PIN+TOTP consent copy", () => {
  it("is pinned verbatim — storing a permanent second factor is said plainly, before save", () => {
    expect(DHAN_TOTP_CONSENT).toBe(
      "Storing your Dhan PIN and TOTP secret makes Vyuha a second factor for your Dhan account: anyone with this machine and its vault key could mint access tokens as you. Both are encrypted at rest with a key bound to this machine. The PIN travels only to Dhan's own auth endpoint; the TOTP secret never leaves this machine — only the 6-digit code derived from it does. Vyuha only ever reads trades with them — this code path cannot place orders — but the TOTP secret is a permanent credential, not a daily token: disconnect here (or re-enroll TOTP at Dhan) to revoke it.",
    );
  });

  it("names the specific risks, not vibes", () => {
    expect(DHAN_TOTP_CONSENT).toMatch(/second factor/i);
    expect(DHAN_TOTP_CONSENT).toMatch(/permanent credential/i);
    expect(DHAN_TOTP_CONSENT).toMatch(/cannot place orders/i);
    // It must never overpromise: no "unhackable", no "perfectly safe".
    expect(DHAN_TOTP_CONSENT).not.toMatch(/completely safe|unhackable|zero risk/i);
  });

  it("is precise about what travels: the PIN goes to Dhan, the SECRET never leaves — only the derived code", () => {
    // The old copy said "Both … are sent nowhere except Dhan's own auth
    // endpoint" — wrong about the TOTP secret, which never leaves the machine;
    // only the 6-digit code computed from it does (lib/totp.ts, computed at
    // pull time, dhanAuthUrl carries `totp=<code>`, never the secret).
    expect(DHAN_TOTP_CONSENT).toMatch(/The PIN travels only to Dhan's own auth endpoint/);
    expect(DHAN_TOTP_CONSENT).toMatch(/the TOTP secret never leaves this machine/);
    expect(DHAN_TOTP_CONSENT).toMatch(/only the 6-digit code derived from it does/);
    // The imprecise claim must not creep back.
    expect(DHAN_TOTP_CONSENT).not.toMatch(/Both .* are sent nowhere/);
  });

  it("the consent is versioned, so a stored acknowledgement names WHAT was acknowledged", () => {
    // Stored into auth_json as `totpAckVersion` by the save route; the route's
    // own DHAN_TOTP_ACK_VERSION is pinned equal in broker-auth-gate.test.ts.
    expect(DHAN_TOTP_CONSENT_VERSION).toBe(1);
  });
});

describe("Zerodha daily-login explainer copy", () => {
  it("is pinned verbatim — honest that this is daily and NOT unattended", () => {
    expect(KITE_DAILY_LOGIN_NOTE).toBe(
      "Zerodha requires a fresh login every trading day — sessions are invalidated around 6 AM IST by regulation, so no setup can make this unattended. With your API secret saved, pull day is one browser click and one paste: open your Kite Connect login URL, sign in, paste the request_token from the redirect, and Vyuha does the official token exchange.",
    );
  });

  it("states the regulatory expiry and never claims unattended sync", () => {
    expect(KITE_DAILY_LOGIN_NOTE).toMatch(/6 AM IST/);
    expect(KITE_DAILY_LOGIN_NOTE).toMatch(/no setup can make this unattended/i);
  });
});

/**
 * v3.8 Wave 3 (owner rulings 2026-09-04): the sentences the relaxed save
 * gate, the All-accounts picker and the expired-token pop-up put in front of
 * the user. Pinned verbatim for the same reason as the consent copy above.
 */
describe("Wave 3 connect-card copy", () => {
  it("the kept-key placeholder is a sentence, never a value shape", () => {
    expect(KEY_KEPT_PLACEHOLDER).toBe("saved — leave blank to keep");
    // No digit run that could read as a Client ID.
    expect(KEY_KEPT_PLACEHOLDER).not.toMatch(/\d{4,}/);
  });

  it("the All-accounts picker waits for an explicit pick and says so on the button", () => {
    expect(PICK_ACCOUNT_PLACEHOLDER).toBe("Pick an account…");
    expect(PICK_ACCOUNT_FIRST).toBe("Pick an account first");
  });

  it("the expired-token pop-up names the broker, the time, and both ways out", () => {
    expect(TOKEN_EXPIRED_TITLE).toBe("A pasted broker token has expired");
    expect(tokenExpiredMessage("Dhan", "04/09/2026, 06:00:00")).toBe(
      "The pasted access token for Dhan expired at 04/09/2026, 06:00:00. Pulls will fail until you paste a fresh one — or connect once with PIN + TOTP where the broker offers it, and Vyuha mints its own.",
    );
    // A vyuha- kebab key with no per-value suffix: the seen set is one envelope.
    expect(TOKEN_EXPIRY_SEEN_KEY).toBe("vyuha-token-expiry-seen");
  });

  it("the unreadable-enrolment call to action says what to do, not just that it is broken", () => {
    expect(AUTH_REENROL_CTA).toBe("Remove the stored enrolment, then enrol again — pulls cannot use it as it is.");
  });
});
