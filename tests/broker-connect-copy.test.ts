import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { connectionModeLabel } from "@/components/import/broker-connect-gate";
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
  formatTs,
  pullGapNotice,
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
    // R3 (v4.2.1): the timestamp is the EXPLICIT IST stamp, fed straight from
    // the server's UTC ISO — never `toLocaleString()`, whose "5/9/2026,
    // 11:24:54 pm" states neither the date order nor the zone.
    expect(tokenExpiredMessage("Dhan", formatTs("2026-09-05T17:54:54Z"))).toBe(
      "The pasted access token for Dhan expired at 05 Sep 2026, 23:24 IST. Pulls will fail until you paste a fresh one — or connect once with PIN + TOTP where the broker offers it, and Vyuha mints its own.",
    );
    expect(tokenExpiredMessage("Dhan", formatTs("2026-09-05T17:54:54Z"))).toContain("05 Sep 2026, 23:24 IST");
    // A vyuha- kebab key with no per-value suffix: the seen set is one envelope.
    expect(TOKEN_EXPIRY_SEEN_KEY).toBe("vyuha-token-expiry-seen");
  });

  it("the unreadable-enrolment call to action says what to do, not just that it is broken", () => {
    expect(AUTH_REENROL_CTA).toBe("Remove the stored enrolment, then enrol again — pulls cannot use it as it is.");
  });
});

/**
 * R3 (v4.2.1) — the token-expiry timestamp. `new Date(t).toLocaleString()`
 * printed "5/9/2026, 11:24:54 pm" on the owner's machine: day-first or
 * month-first is unstated, the zone is unstated, and a token's death time is
 * exactly the fact a user must not have to guess at. One explicit IST stamp
 * now serves BOTH surfaces that say it — the pop-up sentence and the EXPIRED
 * chip in the connection header.
 */
describe("formatTs — one explicit IST stamp, no machine locale", () => {
  it("shapes a UTC ISO into `dd Mon yyyy, HH:MM IST`", () => {
    // 17:54:54Z + 5:30 = 23:24:54 IST on the same day.
    expect(formatTs("2026-09-05T17:54:54Z")).toBe("05 Sep 2026, 23:24 IST");
  });

  it("crosses the IST date boundary rather than printing the UTC day", () => {
    // 18:30Z is exactly midnight IST — the next day in India.
    expect(formatTs("2026-09-05T18:30:00Z")).toBe("06 Sep 2026, 00:00 IST");
    expect(formatTs("2026-01-01T18:35:00Z")).toBe("02 Jan 2026, 00:05 IST");
  });

  it("says the zone, uses a 24-hour clock, and never a locale-ambiguous numeric date", () => {
    const s = formatTs("2026-09-05T17:54:54Z");
    expect(s).toMatch(/ IST$/);
    expect(s).not.toMatch(/am|pm/i);
    // "5/9/2026" / "9/5/2026" — the shape that made the screenshot unreadable.
    expect(s).not.toMatch(/\d+\/\d+\/\d+/);
    // The month is a fixed three-letter abbreviation, not ICU's own short form
    // (en-IN says "Sept" for September, and that changed with CLDR 42).
    expect(s).toContain("Sep 2026");
    expect(s).not.toContain("Sept");
  });

  it("returns the input untouched when it is not a timestamp — never 'Invalid Date'", () => {
    expect(formatTs("")).toBe("");
    expect(formatTs("not-a-date")).toBe("not-a-date");
  });

  it("is the SAME stamp in the EXPIRED chip as in the pop-up sentence", () => {
    // The chip renders connectionModeLabel(conn, formatTs); the header
    // used to read "EXPIRED · pasted token · expires 5/9/2026, 11:24:54 pm".
    expect(
      connectionModeLabel({ authMode: "token", tokenExpiresAt: "2026-09-05T17:54:54Z" }, formatTs),
    ).toBe("pasted token · expires 05 Sep 2026, 23:24 IST");
  });
});

/**
 * R6 (v4.2.1) — the catch-up line. When the last pull is older than the
 * previous trading day the next pull fetches a RANGE, and the card says so in
 * one plain line. It states a fact ("pulls missed since …"), never advice.
 */
describe("pullGapNotice — the missed-pulls line", () => {
  const now = new Date("2026-09-09T05:00:00Z"); // Wed 10:30 IST

  it("names the day of the last pull, in the same dd Mon yyyy shape as the stamp", () => {
    expect(pullGapNotice("2026-09-04T10:00:00Z", now)).toBe(
      "Pulls missed since 04 Sep 2026 — the next pull fetches the gap.",
    );
  });

  it("is silent once the last pull is the previous trading day or later", () => {
    // Tue 8 Sep is the previous trading day of Wed 9 Sep — nothing missed.
    expect(pullGapNotice("2026-09-08T10:00:00Z", now)).toBeNull();
    expect(pullGapNotice("2026-09-09T04:00:00Z", now)).toBeNull();
  });

  it("says nothing at all when the connection has never been pulled", () => {
    expect(pullGapNotice(null, now)).toBeNull();
    expect(pullGapNotice(undefined, now)).toBeNull();
    expect(pullGapNotice("not-a-date", now)).toBeNull();
  });

  it("reads the IST day of the pull, not the UTC one", () => {
    // 2026-09-04T19:00Z is already 5 Sep in India.
    expect(pullGapNotice("2026-09-04T19:00:00Z", now)).toBe(
      "Pulls missed since 05 Sep 2026 — the next pull fetches the gap.",
    );
  });

  it("carries no SEBI-forbidden verb — it states a fact about pulls, not advice", () => {
    const line = pullGapNotice("2026-09-04T10:00:00Z", now)!;
    expect(line).not.toMatch(/\b(recommend|should|consider|buy|sell)\b/i);
  });
});

describe("the gap line is rendered from that one function", () => {
  it("the connect card renders pullGapNotice under the pull buttons — the copy is not re-typed in JSX", async () => {
    const src = await readFile(new URL("../components/import/broker-connect.tsx", import.meta.url), "utf8");
    // The sentence exists ONCE, inside the exported function.
    expect(src.match(/Pulls missed since/g)?.length).toBe(1);
    expect(src).toMatch(/pullGapNotice\(conn\?\.lastPullAt\)/);
    expect(src).toMatch(/data-testid="pull-gap"[\s\S]{0,200}?\{gapNotice\}/);
    // The old locale-ambiguous formatter must not come back. Comment lines are
    // dropped first — the header explains WHY it went, and naming it there is
    // not calling it.
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/toLocaleString\(/);
  });
});
