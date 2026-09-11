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
  pullGapLines,
  pullGapNotice,
  pullResultMessage,
  tokenExpiredMessage,
  unfetchedNotice,
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
 * R6 (v4.2.1) — the catch-up line. A pull fetches a RANGE whenever the last one
 * ran before today (`catchUpRange`, lib/import/api/dhan.ts); this line appears
 * only when that gap is longer than a routine one — the last pull older than
 * the previous trading day — and says so in one plain line. It states a fact
 * ("pulls missed since …"), never advice.
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
    expect(pullGapNotice("2026-05-01T05:00:00Z", now, "2026-06-11")!).not.toMatch(/\b(recommend|should|consider|buy|sell)\b/i);
  });

  /**
   * C-6 (fix wave C). "The next pull fetches the gap" was false for a gap over
   * DHAN_MAX_PULL_RANGE_DAYS: the pull is clamped. The server now states where
   * the next pull will start (`catchUpFrom`, from the same catchUpRange), and
   * when that is after the last pull's day the line says what is left out.
   */
  it("C-6: a gap the next pull cannot cover says where the pull starts and that the rest is not fetched", () => {
    expect(pullGapNotice("2026-05-01T05:00:00Z", now, "2026-06-11")).toBe(
      "Pulls missed since 01 May 2026 — the next pull fetches from 11 Jun 2026; fills before that are not fetched.",
    );
    // A start ON the last pull's day is no clamp: the ordinary sentence, verbatim.
    expect(pullGapNotice("2026-09-04T10:00:00Z", now, "2026-09-04")).toBe(
      "Pulls missed since 04 Sep 2026 — the next pull fetches the gap.",
    );
    expect(pullGapNotice("2026-09-04T10:00:00Z", now, null)).toBe(
      "Pulls missed since 04 Sep 2026 — the next pull fetches the gap.",
    );
  });
});

/**
 * R47 — the All-accounts view with two Dhan connections. The card derived the
 * gap line from `brokerConns[0]` alone (the lowest account id) and printed it
 * with no account name, so account 2's ten-day gap was never said while
 * account 1 was current — and when account 1 was the stale one, the line did
 * not say WHICH book. One line per row with a gap now, named by account under
 * the same rule the kept "not fetched" notices use (aggregate || 2+ rows).
 */
describe("pullGapLines — one gap line per Dhan connection (R47)", () => {
  const now = new Date("2026-09-09T05:00:00Z"); // Wed 10:30 IST
  const current = { accountId: 1, accountName: "Main", lastPullAt: now.toISOString(), catchUpFrom: null };
  const stale = { accountId: 2, accountName: "Second", lastPullAt: "2026-08-30T05:00:00Z", catchUpFrom: null };

  it("All-accounts, two rows: the lowest account is current, the other ten days back — the stale one speaks, by name", () => {
    const lines = pullGapLines([current, stale], true, now);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith("Second: ")).toBe(true);
    expect(lines[0]).toContain("Pulls missed since");
    expect(lines[0]).toBe(`Second: ${pullGapNotice(stale.lastPullAt, now)}`);
  });

  it("every stale row gets its own line, in the order handed in", () => {
    const older = { ...current, lastPullAt: "2026-09-01T05:00:00Z" };
    expect(pullGapLines([older, stale], true, now)).toEqual([
      `Main: ${pullGapNotice(older.lastPullAt, now)}`,
      `Second: ${pullGapNotice(stale.lastPullAt, now)}`,
    ]);
  });

  it("each row's own catchUpFrom rides along, so a clamped gap is said per account", () => {
    const clamped = { ...stale, lastPullAt: "2026-05-01T05:00:00Z", catchUpFrom: "2026-06-11" };
    expect(pullGapLines([current, clamped], true, now)).toEqual([
      `Second: ${pullGapNotice(clamped.lastPullAt, now, "2026-06-11")}`,
    ]);
  });

  it("one row in one account: the sentence verbatim, no name (nothing to tell apart)", () => {
    expect(pullGapLines([stale], false, now)).toEqual([pullGapNotice(stale.lastPullAt, now)]);
  });

  it("names the account whenever the view is aggregate, or there are two rows — and falls back to 'Account <id>'", () => {
    expect(pullGapLines([stale], true, now)[0].startsWith("Second: ")).toBe(true);
    expect(pullGapLines([current, { ...stale, accountName: null }], false, now)).toEqual([
      `Account 2: ${pullGapNotice(stale.lastPullAt, now)}`,
    ]);
  });

  it("says nothing when no row has a gap, or there are no rows", () => {
    expect(pullGapLines([current], true, now)).toEqual([]);
    expect(pullGapLines([], true, now)).toEqual([]);
  });
});

/**
 * C-5 (fix wave C). The commit's own sentences (`result.warnings`,
 * lib/import/commit.ts) were in the pull response and nothing read them. The
 * message is composed by ONE exported function now, pinned here on synthetic
 * input and in tests/fix-wave-c-import.test.ts on the route's real response.
 * Auto-close is SWITCHED OFF for 4.3.0 (owner ruling 2026-09-11, 06-ANSWERS
 * "v4.3.0 release-level-audit rulings", row 1): there is no close plan, and
 * the preview line is v4.2.0's, character for character.
 */
describe("pullResultMessage — what the card prints after a pull", () => {
  // A sentence commit.ts really writes (a contract-note commit), not a made-up one.
  const NOTE = "2 contract-note fills aggregated into 1 contract-day: applied 1, already had times 0, unmatched 0.";

  it("commit: the counts, then the COMMIT's own sentences, then the pull's warnings", () => {
    expect(
      pullResultMessage("commit", { result: { added: 0, skipped: 0, warnings: [NOTE] }, warnings: ["W1."] }),
    ).toBe(`Committed — 0 added, 0 duplicates skipped. ${NOTE} W1.`);
  });

  it("commit with nothing to add from the commit is the sentence it always was", () => {
    expect(pullResultMessage("commit", { result: { added: 3, skipped: 1 }, warnings: [] })).toBe(
      "Committed — 3 added, 1 duplicates skipped.",
    );
    expect(pullResultMessage("commit", { result: { added: 3, skipped: 1 }, warnings: ["W1."] })).toBe(
      "Committed — 3 added, 1 duplicates skipped. W1.",
    );
  });

  it("preview: the row count, then the warnings — v4.2.0's line, with no close plan", () => {
    expect(pullResultMessage("preview", { preview: { rows: [{}] }, warnings: ["W1."] })).toBe(
      "Preview: 1 normalized trade. W1.",
    );
    expect(pullResultMessage("preview", { preview: { rows: [{}, {}] }, warnings: ["W1."] })).toBe(
      "Preview: 2 normalized trades. W1.",
    );
    expect(pullResultMessage("preview", { preview: { rows: [{}] } })).toBe("Preview: 1 normalized trade.");
  });
});

/**
 * C-6 — the kept notice. After a clamped (or page-capped) Dhan commit the
 * span lives in the audit trail and the card shows it until the user clears
 * it. The sentence names the dates and the remedy; it states a fact.
 *
 * D2 (v4.3.0 fix wave 1 follow-up, 2026-09-11) — F-L1-3a's card half. A kept
 * span's `from` is the LAST PULL's own IST day, whose fills up to that pull are
 * already in the journal, so the tradebook remedy starts the day AFTER it: the
 * wording lib/import/api/dhan.ts toParsedFile and lib/jobs/auto-pull.ts
 * unfetchedDetail already use. A one-day span names no import at all.
 */
describe("unfetchedNotice — the kept line for fills a pull never read", () => {
  const RANGE = { from: "2026-05-01", to: "2026-06-10", reason: "range-cap" };
  const PAGE = { from: "2026-06-11", to: "2026-09-09", reason: "page-cap" };
  const SEBI = /\b(recommend|suggest|should|consider|buy|sell)\b/i;

  it("range cap: the dates, why, the last pull's own day as a fact, and a remedy from the day after it — verbatim", () => {
    expect(unfetchedNotice(RANGE)).toBe(
      "Not fetched from Dhan: fills from 01 May 2026 to 10 Jun 2026 — they are older than the window a pull reads. Fills on 01 May 2026 after the last pull were not fetched; a tradebook for 01 May 2026 would repeat the fills already imported from it. Import a Dhan tradebook for 02 May 2026 to 10 Jun 2026 to bring the rest in.",
    );
  });

  it("page cap: the window that may be short, the last pull's own day as a fact, the same day-after remedy — verbatim", () => {
    expect(unfetchedNotice(PAGE)).toBe(
      "A Dhan pull stopped at its page limit: fills between 11 Jun 2026 and 09 Sep 2026 may be missing. Fills on 11 Jun 2026 after the last pull were not fetched; a tradebook for 11 Jun 2026 would repeat the fills already imported from it. Import a Dhan tradebook for 12 Jun 2026 to 09 Sep 2026 to bring the rest in.",
    );
  });

  it("D2: a one-day span names NO import — only that day's unfetched fills, and that a tradebook would repeat the rest", () => {
    const range = unfetchedNotice({ from: "2026-06-12", to: "2026-06-12", reason: "range-cap" });
    expect(range).toBe(
      "Not fetched from Dhan: fills on 12 Jun 2026 after the last pull. A tradebook for 12 Jun 2026 would repeat the fills already imported from it.",
    );
    const page = unfetchedNotice({ from: "2026-09-10", to: "2026-09-10", reason: "page-cap" });
    expect(page).toBe(
      "A Dhan pull stopped at its page limit: fills on 10 Sep 2026 after the last pull may be missing. A tradebook for 10 Sep 2026 would repeat the fills already imported from it.",
    );
    for (const line of [range, page]) expect(line).not.toMatch(/import a Dhan tradebook/i);
  });

  it("D2: no remedy names the span's first day — it starts the day after, across a month end too", () => {
    expect(unfetchedNotice(RANGE)).not.toContain("Import a Dhan tradebook for 01 May 2026");
    expect(unfetchedNotice(PAGE)).not.toContain("Import a Dhan tradebook for 11 Jun 2026");
    expect(unfetchedNotice({ from: "2026-05-31", to: "2026-06-10", reason: "range-cap" })).toContain(
      "Import a Dhan tradebook for 01 Jun 2026 to 10 Jun 2026 to bring the rest in.",
    );
  });

  it("a page-cap span starting the day after its row's range-cap span began at the clamped floor, a day no pull ran — the remedy names it", () => {
    // dhan.ts toParsedFile: a clamped AND truncated walk keeps both spans; the
    // page-cap one starts at the window's floor, and the server's remedy is
    // that whole span ("To bring those fills in, import a Dhan tradebook for …").
    const row = [RANGE, PAGE];
    expect(unfetchedNotice(PAGE, row)).toBe(
      "A Dhan pull stopped at its page limit: fills between 11 Jun 2026 and 09 Sep 2026 may be missing. Import a Dhan tradebook for 11 Jun 2026 to 09 Sep 2026 to bring those fills in.",
    );
    // The range-cap span in that row keeps its own rule…
    expect(unfetchedNotice(RANGE, row)).toBe(unfetchedNotice(RANGE));
    // …and a range-cap span that does not end the day before changes nothing.
    expect(unfetchedNotice(PAGE, [{ ...RANGE, to: "2026-06-09" }, PAGE])).toBe(unfetchedNotice(PAGE));
  });

  it("carries no SEBI-forbidden verb", () => {
    for (const reason of ["range-cap", "page-cap"]) {
      for (const to of ["2026-06-10", "2026-05-01"]) {
        expect(unfetchedNotice({ from: "2026-05-01", to, reason })).not.toMatch(SEBI);
      }
    }
    expect(unfetchedNotice(PAGE, [RANGE, PAGE])).not.toMatch(SEBI);
  });
});

describe("the card reads those functions — the copy is not re-typed in JSX", () => {
  const load = async () => {
    const src = await readFile(new URL("../components/import/broker-connect.tsx", import.meta.url), "utf8");
    return src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  };

  it("pull() prints pullResultMessage for BOTH modes, and the commit sentence is written once", async () => {
    const code = await load();
    expect(code).toContain("setMsg({ ok: true, text: pullResultMessage(mode, data) });");
    expect(code.match(/Committed — /g)).toHaveLength(1);
    expect(code.match(/Preview: \$\{/g)).toHaveLength(1);
  });

  it("the kept notices render unfetchedNotice with an explicit Clear control, on the Dhan tab only", async () => {
    const code = await load();
    expect(code).toMatch(/const unfetchedRows = active === "dhan" \?/);
    const at = code.indexOf('data-testid="pull-unfetched"');
    expect(at, "no kept-notice block").toBeGreaterThan(-1);
    const block = code.slice(at, at + 1200);
    // D2: the row's own spans ride along, so a page-cap span at the clamped
    // floor is read as the floor, not as the last pull's day.
    expect(block).toContain("unfetchedNotice(s, c.unfetched)");
    expect(block).toMatch(/onClick=\{\(\) => clearUnfetched\(c, s\)\}/);
  });

  it("the clear is a route-handler write: fetch, then refresh and router.refresh() — never a server action", async () => {
    const code = await load();
    const a = code.indexOf("async function clearUnfetched(");
    const b = code.indexOf("function switchBroker(", a);
    expect(a).toBeGreaterThan(-1);
    const fn = code.slice(a, b);
    expect(fn).toContain('action: "clear-unfetched"');
    expect(fn).toContain("await refresh();");
    expect(fn).toContain("router.refresh();");
    expect(code).not.toMatch(/["']use server["']/);
  });
});

describe("the gap line is rendered from that one function", () => {
  it("the connect card renders pullGapNotice under the pull buttons — the copy is not re-typed in JSX", async () => {
    const src = await readFile(new URL("../components/import/broker-connect.tsx", import.meta.url), "utf8");
    // The sentence exists ONCE, inside the exported function.
    expect(src.match(/Pulls missed since/g)?.length).toBe(1);
    // C-6: each row's own catchUpFrom rides along, so a clamped gap is said.
    // R47: per ROW — pullGapLines calls pullGapNotice once per connection.
    expect(src).toMatch(/pullGapNotice\(c\.lastPullAt, now, c\.catchUpFrom\)/);
    expect(src).toMatch(/data-testid="pull-gap"[\s\S]{0,300}?gapLines\.map\(/);
    // The old locale-ambiguous formatter must not come back. Comment lines are
    // dropped first — the header explains WHY it went, and naming it there is
    // not calling it.
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/toLocaleString\(/);
  });

  /**
   * D-1 (2026-09-10) — DHAN ONLY. The line promises that "the next pull fetches
   * the gap", and only Dhan's puller widens a pull to a range
   * (`catchUpRange`, lib/import/api/dhan.ts). On Zerodha, Angel One, Upstox and
   * OpenAlgo tabs it stated a catch-up that does not happen. The session ruling
   * was to gate the render on the active tab, not to reword the sentence — so
   * the sentence itself is still pinned verbatim above.
   */
  it("renders only on the Dhan tab — every other broker fetches its own window", async () => {
    const src = await readFile(new URL("../components/import/broker-connect.tsx", import.meta.url), "utf8");
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

    // The list the `pull-gap` block renders is empty off the Dhan tab, so the
    // block cannot render there at all.
    expect(code).toMatch(/const gapLines = active === "dhan" \? pullGapLines\(brokerConns, aggregate\) : \[\];/);
    // …and it is still the ONE derivation the render reads.
    expect(code.match(/pullGapLines\(brokerConns/g)).toHaveLength(1);
    expect(code).toMatch(/\{gapLines\.length > 0 && \(/);
    // Never re-derived unconditionally beside it.
    expect(code).not.toMatch(/const gapLines = pullGapLines\(/);
    // R47: never again from the single lowest-account row.
    expect(code).not.toMatch(/pullGapNotice\(conn/);
  });
});
