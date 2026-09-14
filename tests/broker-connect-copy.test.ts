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
  PULL_FORCE_ROUTE_TAIL,
  collisionBadge,
  collisionDialogCopy,
  formatTs,
  pullGapLines,
  pullGapNotice,
  pullResultMessage,
  tokenExpiredMessage,
  unfetchedNotice,
  type UnfetchedSpan,
} from "@/components/import/broker-connect";
import { catchUpRange, toParsedFile, type DhanUnfetchedSpan } from "@/lib/import/api/dhan";
import { detectCrossSourceDuplicates, type ExistingRow, type IncomingRow } from "@/lib/import/cross-source";

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
 * P15 / P16 (v4.3.0 fix wave 2) — the card prints the SERVER's sentences.
 * Every span below is one lib/import/api/dhan.ts toParsedFile actually
 * produces, projected exactly as GET projects it ({from, to, reason, fact,
 * remedy}: lib/import/dhan-unfetched.ts UnfetchedSpanRow). The expected lines
 * are LITERALS — the pull warning's words, in its ISO dates, the ONE date
 * format both surfaces use. Re-pinned from the card's own "dd Mon yyyy"
 * re-derivation (D2), which hedged a truncated walk as "may be missing" (P16)
 * and misread a page-cap span at the clamped floor once its range-cap sibling
 * was cleared (P15). Measured before: "A Dhan pull stopped at its page limit:
 * fills between 13 Jun 2026 and 10 Sep 2026 may be missing. … Import a Dhan
 * tradebook for 14 Jun 2026 to 10 Sep 2026 to bring the rest in."
 */
describe("unfetchedNotice — the kept line for fills a pull never read", () => {
  const TODAY = "2026-09-11";
  const SEBI = /\b(recommend|suggest|should|consider|buy|sell)\b/i;
  /** GET's projection of a kept span (route.ts → outstandingUnfetched). */
  const asGet = (s: DhanUnfetchedSpan): UnfetchedSpan => ({ from: s.from, to: s.to, reason: s.reason, fact: s.fact, remedy: s.remedyText });
  /** The pull toParsedFile describes: the last stamp at 10:30 IST, a walk truncated or not. */
  const pulled = (lastPullAt: string, truncated: boolean) =>
    toParsedFile([], catchUpRange(lastPullAt, TODAY), { pages: truncated ? 50 : 1, truncated, oldest: null, newest: null }, lastPullAt);
  const spanOf = (p: ReturnType<typeof pulled>, reason: string) => {
    const s = p.unfetched.find((u) => u.reason === reason);
    expect(s, `the server produced no ${reason} span`).toBeDefined();
    expect(p.warnings, "the span's sentences are the warning the pull printed").toContain(s!.message);
    return s!;
  };

  it("range cap: the card line IS the pull's warning — the dates, why, the last pull's own day, and the day-after remedy", () => {
    const span = spanOf(pulled("2026-05-01T05:00:00.000Z", false), "range-cap");
    expect(unfetchedNotice(asGet(span))).toBe(
      "Not fetched: fills from 2026-05-01 to 2026-06-12. The last pull ran on 2026-05-01, and a pull reads at most 90 days of Dhan's trade history, so the pull on 2026-09-11 started at 2026-06-13. Fills on 2026-05-01 after 10:30 IST were not fetched; a tradebook for 2026-05-01 would repeat the fills already imported from it. To bring the rest in, import a Dhan tradebook for 2026-05-02 to 2026-06-12.",
    );
    expect(unfetchedNotice(asGet(span))).toBe(span.message);
  });

  it("P16: a page-cap line says the fills 'were not read' — plainly, never 'may be missing'", () => {
    const span = spanOf(pulled("2026-09-07T05:00:00.000Z", true), "page-cap");
    const line = unfetchedNotice(asGet(span));
    expect(line).toBe(
      "Truncated: the pull on 2026-09-11 stopped at the 50-page limit of Dhan's trade history and kept none of what it read, so fills from 2026-09-07 to 2026-09-10 were not read. The book for 2026-09-11 came from /v2/positions. Fills on 2026-09-07 after 10:30 IST were not fetched; a tradebook for 2026-09-07 would repeat the fills already imported from it. To bring the rest in, import a Dhan tradebook for 2026-09-08 to 2026-09-10.",
    );
    expect(line).toContain("were not read");
    expect(line).not.toContain("may be missing");
  });

  it("P15: a clamped + truncated pull's page-cap span ALONE (its range-cap sibling cleared) still names the floor day in its remedy", () => {
    const p = pulled("2026-06-01T05:00:00.000Z", true);
    spanOf(p, "range-cap");
    const page = spanOf(p, "page-cap");
    // The row as GET lists it after the user cleared the range-cap notice.
    const line = unfetchedNotice(asGet(page));
    expect(line).toBe(
      "Truncated: the pull on 2026-09-11 stopped at the 50-page limit of Dhan's trade history and kept none of what it read, so fills from 2026-06-13 to 2026-09-10 were not read. The book for 2026-09-11 came from /v2/positions. To bring those fills in, import a Dhan tradebook for 2026-06-13 to 2026-09-10.",
    );
    expect(line).not.toContain("would repeat the fills already imported");
  });

  it("D2: a one-day span names NO import — only that day's unfetched fills, and that a tradebook would repeat the rest", () => {
    const range = spanOf(pulled("2026-06-12T05:00:00.000Z", false), "range-cap");
    const page = spanOf(pulled("2026-09-10T05:00:00.000Z", true), "page-cap");
    expect(asGet(range).remedy).toBeNull();
    expect(asGet(page).remedy).toBeNull();
    expect(unfetchedNotice(asGet(range))).toBe(
      "Not fetched: fills from 2026-06-12 to 2026-06-12. The last pull ran on 2026-06-12, and a pull reads at most 90 days of Dhan's trade history, so the pull on 2026-09-11 started at 2026-06-13. Fills on 2026-06-12 after 10:30 IST were not fetched; a tradebook for 2026-06-12 would repeat the fills already imported from it.",
    );
    expect(unfetchedNotice(asGet(page))).toBe(
      "Truncated: the pull on 2026-09-11 stopped at the 50-page limit of Dhan's trade history and kept none of what it read, so fills from 2026-09-10 to 2026-09-10 were not read. The book for 2026-09-11 came from /v2/positions. Fills on 2026-09-10 after 10:30 IST were not fetched; a tradebook for 2026-09-10 would repeat the fills already imported from it.",
    );
    for (const s of [range, page]) expect(unfetchedNotice(asGet(s))).not.toMatch(/import a Dhan tradebook/i);
  });

  it("a span kept before the sentences were stored prints what GET sends for it — the audit row's own summary, no remedy", () => {
    const summary = "Not fetched: fills from 2026-05-01 to 2026-06-12. (the sentence the pull kept)";
    expect(unfetchedNotice({ from: "2026-05-01", to: "2026-06-12", reason: "range-cap", fact: summary, remedy: null })).toBe(summary);
  });

  /**
   * N6 (fix wave 2R): the line is printed on the card days after the pull that
   * kept it, so it names that pull's own IST day. Re-pinned above (P16, P15,
   * D2) from "Truncated: this pull stopped … Today's book came from
   * /v2/positions." to "Truncated: the pull on 2026-09-11 stopped … The book
   * for 2026-09-11 came from /v2/positions."
   */
  it("N6: a kept line names the pull's own day — never 'this pull' or 'today'", () => {
    const page = spanOf(pulled("2026-09-07T05:00:00.000Z", true), "page-cap");
    expect(unfetchedNotice(asGet(page))).toContain(`the pull on ${TODAY} stopped`);
    expect(unfetchedNotice(asGet(page))).toContain(`The book for ${TODAY} came from /v2/positions.`);
    for (const stamp of ["2026-05-01T05:00:00.000Z", "2026-06-01T05:00:00.000Z", "2026-09-07T05:00:00.000Z", "2026-09-10T05:00:00.000Z"]) {
      for (const s of pulled(stamp, true).unfetched) expect(unfetchedNotice(asGet(s))).not.toMatch(/\bthis pull\b|\btoday\b/i);
    }
  });

  it("carries no SEBI-forbidden verb", () => {
    for (const stamp of ["2026-05-01T05:00:00.000Z", "2026-06-01T05:00:00.000Z", "2026-09-07T05:00:00.000Z", "2026-09-10T05:00:00.000Z"]) {
      for (const truncated of [false, true]) {
        for (const s of pulled(stamp, truncated).unfetched) expect(unfetchedNotice(asGet(s))).not.toMatch(SEBI);
      }
    }
  });
});

/**
 * Seam D1 (v4.3.0 fix wave 2F). R2-IDENTITY's N2 made the pull route answer 409
 * with collisions of kind 'earlier-snapshot' and its own sentence ("restates a
 * position today's earlier pull already recorded … committing anyway adds this
 * pull's row beside the earlier one"). The dialog badged every such row
 * "partial overlap", said "Different sources state the same trade slightly
 * differently … can differ by a paisa", told the user to cancel "if this pull
 * is the same trades from another source", and never showed the route's
 * sentence. The report below is the REAL cross-source report the route wraps.
 */
describe("Seam D1 · the pull dialog's words for a collision with today's earlier pull", () => {
  const FILE = "angelone-api-2026-09-09.json";
  const SEBI = /\b(recommend|suggest|should|consider|buy|sell)\b/i;
  const stored = (over: Partial<ExistingRow> = {}): ExistingRow => ({
    id: 1, broker: "angelone", symbol: "LADDER", tradingsymbol: "LADDER-EQ", buyQty: 20, sellQty: 0, buyValue: 2010, sellValue: 0,
    buyDate: "2026-09-09", sellDate: null, sourceFile: FILE, dedupHash: "morning", ...over,
  });
  const incoming = (over: Partial<IncomingRow> = {}): IncomingRow => ({
    broker: "angelone", symbol: "LADDER", tradingsymbol: "LADDER-EQ", buyQty: 25, sellQty: 0, buyValue: 2520, sellValue: 0,
    buyDate: "2026-09-09", sellDate: null, dedupHash: "evening", snapshotIds: [1], ...over,
  });
  /** The 409 body's `message`, as app/api/import/broker/route.ts composes it. */
  const routeMessage = (m: string | null) => `${m}${PULL_FORCE_ROUTE_TAIL}`;
  const GENERIC_ONE =
    "Nothing has been committed. Different sources state the same trade slightly differently — a position aggregate and a fill-by-fill pull can differ by a paisa — so the exact duplicate check cannot vouch for this row.";

  it("the badge names today's earlier pull for 'earlier-snapshot'; the three older kinds keep their labels", () => {
    // THE assertion (red on revert: "partial overlap").
    expect(collisionBadge("earlier-snapshot")).toBe("today's earlier pull");
    expect(collisionBadge("same-quantity")).toBe("same quantity");
    expect(collisionBadge("same-value")).toBe("same value");
    expect(collisionBadge("partial-quantity")).toBe("partial overlap");
  });

  it("an earlier-snapshot-only 409: the route's sentence is shown, and no other-source text or footer", () => {
    const report = detectCrossSourceDuplicates([incoming()], [stored()], FILE);
    expect(report.collisions.map((c) => c.kind)).toEqual(["earlier-snapshot"]); // the N2 shape the route sends
    const copy = collisionDialogCopy({ collisions: report.collisions, message: routeMessage(report.message) });
    // THE assertions (red on revert: the generic "Different sources …" lead, no
    // server message, and the "same trades from another source" footer shown).
    expect(copy).toEqual({ description: "Nothing has been committed.", serverMessage: report.message, otherSourceFooter: false });
    expect(copy.serverMessage).toContain("1 row in this pull (LADDER) restates a position today's earlier pull already recorded");
    expect(copy.serverMessage).toContain("committing anyway adds this pull's row beside the earlier one.");
    // The route's old-client tail names a button the dialog does not have.
    expect(copy.serverMessage).not.toContain("click Pull & commit again");
  });

  it("a cross-file 409 keeps the other-source lead and footer, and shows the route's sentence too", () => {
    const report = detectCrossSourceDuplicates([incoming({ snapshotIds: undefined, buyQty: 20, buyValue: 2010 })], [stored({ sourceFile: "dhan-pnl.csv" })], FILE);
    expect(report.collisions.map((c) => c.kind)).toEqual(["same-quantity"]);
    const copy = collisionDialogCopy({ collisions: report.collisions, message: routeMessage(report.message) });
    expect(copy).toEqual({ description: GENERIC_ONE, serverMessage: report.message, otherSourceFooter: true });
    // Two rows read "these rows" (the JSX used to print "these this row" for one).
    expect(collisionDialogCopy({ collisions: [...report.collisions, ...report.collisions], message: null }).description).toMatch(
      /cannot vouch for these rows\.$/,
    );
  });

  it("a mixed 409 (earlier snapshot AND another file) keeps the other-source words — only an earlier-snapshot-ONLY one drops them", () => {
    const report = detectCrossSourceDuplicates(
      [incoming(), incoming({ symbol: "RELIANCE", tradingsymbol: "RELIANCE-EQ", snapshotIds: undefined, buyQty: 10, buyValue: 29000, dedupHash: "r" })],
      [stored(), stored({ id: 2, symbol: "RELIANCE", tradingsymbol: "RELIANCE-EQ", buyQty: 10, buyValue: 29000, sourceFile: "dhan-pnl.csv", dedupHash: "r0" })],
      FILE,
    );
    expect(report.collisions.map((c) => c.kind).sort()).toEqual(["earlier-snapshot", "same-quantity"]);
    const copy = collisionDialogCopy({ collisions: report.collisions, message: routeMessage(report.message) });
    expect(copy.otherSourceFooter).toBe(true);
    expect(copy.description).toContain("Different sources state the same trade slightly differently");
    expect(copy.serverMessage).toBe(report.message);
  });

  it("with no message the dialog shows none, and a message without the route's tail is shown verbatim", () => {
    const kinds = [{ kind: "earlier-snapshot" }];
    expect(collisionDialogCopy({ collisions: kinds })).toEqual({ description: "Nothing has been committed.", serverMessage: null, otherSourceFooter: false });
    expect(collisionDialogCopy({ collisions: kinds, message: "  " }).serverMessage).toBeNull();
    expect(collisionDialogCopy({ collisions: kinds, message: "A sentence." }).serverMessage).toBe("A sentence.");
  });

  it("the dialog's own words carry no SEBI-forbidden verb", () => {
    for (const kind of ["same-quantity", "same-value", "partial-quantity", "earlier-snapshot"]) {
      expect(collisionBadge(kind)).not.toMatch(SEBI);
      expect(collisionDialogCopy({ collisions: [{ kind }] }).description).not.toMatch(SEBI);
    }
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
    // P15: the span alone — the server's sentences carry everything, and no
    // sibling span is read to re-derive them (was `unfetchedNotice(s, c.unfetched)`).
    expect(block).toContain("unfetchedNotice(s)");
    expect(block).not.toContain("c.unfetched)");
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
