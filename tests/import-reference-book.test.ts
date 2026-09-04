import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildContext, rankParsers } from "@/lib/import/detect";
import type { ParsedFile } from "@/lib/import/types";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v3.9 — the BOOK and the REFERENCE for one broker, in one account.
 *
 * The Dhan Global Transaction Report is the book; the Dhan Realised P&L is the
 * reference. The Realised P&L parser predates the reference contract and still
 * emits per-scrip trades as well as the segment figures, so importing both
 * into one account books every position twice — and dedup cannot see it,
 * because a P&L row and a transaction row state the same trade differently and
 * therefore hash differently by construction.
 *
 * So the rule is decided at COMMIT, on the account's contents rather than on
 * the file: a reference source that also carries trades keeps its figures
 * always, and writes its trades only when the account holds no book trades
 * from that broker yet.
 *
 * One temp DB per FILE (AGENTS.md); the two orders therefore use two accounts.
 */

const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
const GTR = "dhan-gtr-2026-04-01_2026-09-03-a2.csv";
const REALISED = "dhan-realised-pnl-2026-04-01_2026-09-03-a2.xls";

let t: TempDb;
let commitMod: typeof import("@/lib/import/commit");

async function parseFixture(file: string): Promise<ParsedFile> {
  const ctx = buildContext(file, fs.readFileSync(path.join(DIR, file)));
  return rankParsers(ctx)[0].parse(ctx);
}

let gtr: ParsedFile;
let realised: ParsedFile;

const tradeCount = (accountId: number) =>
  (t.sqlite.prepare("SELECT count(*) AS n FROM trades WHERE account_id = ?").get(accountId) as { n: number }).n;
const refCount = (accountId: number) =>
  (t.sqlite.prepare("SELECT count(*) AS n FROM broker_reference WHERE account_id = ?").get(accountId) as { n: number }).n;

function newAccount(id: number, name: string) {
  t.db.insert(t.schema.accounts).values({ id, name }).run();
}

beforeAll(async () => {
  t = await openTempDb("import-reference-book", { seed: true });
  commitMod = await import("@/lib/import/commit");
  gtr = await parseFixture(GTR);
  realised = await parseFixture(REALISED);
}, 120_000);
afterAll(() => t?.cleanup());

describe("the fixtures state the defect", () => {
  it("the Realised P&L carries BOTH reference figures and trades", () => {
    expect(realised.sourceId).toBe("dhan-realised-pnl");
    expect(realised.reference?.length ?? 0).toBeGreaterThan(0);
    expect(realised.trades.length).toBeGreaterThan(0);
  });
  it("the GTR is a book: trades, no reference figures", () => {
    expect(gtr.sourceId).toBe("dhan-gtr");
    expect(gtr.trades.length).toBeGreaterThan(0);
    expect(gtr.reference?.length ?? 0).toBe(0);
  });
});

describe("book first, then the reference — the owner's own order", () => {
  const ACCOUNT = 501;
  let afterGtr = 0;

  it("the transaction report imports as the book", () => {
    newAccount(ACCOUNT, "book-then-reference");
    const res = commitMod.commitParsedFile(gtr, GTR, null, ACCOUNT);
    expect(res.added).toBeGreaterThan(0);
    afterGtr = tradeCount(ACCOUNT);
    expect(afterGtr).toBe(res.added);
  });

  it("the Realised P&L then stores its figures and imports NO trades", () => {
    const res = commitMod.commitParsedFile(realised, REALISED, null, ACCOUNT);
    expect(res.added, "the book already holds these positions from the transaction report").toBe(0);
    expect(tradeCount(ACCOUNT), "trade count is unchanged from the GTR alone").toBe(afterGtr);
    expect(res.referenceStored ?? 0).toBeGreaterThan(0);
    expect(refCount(ACCOUNT)).toBe(res.referenceStored);
  });

  it("and it SAYS so, naming the report that is the book", () => {
    const res = commitMod.commitParsedFile(realised, REALISED, null, ACCOUNT);
    expect(res.warnings?.join(" | ")).toMatch(
      /positions from the Realised P&L were not imported — your Dhan transaction report is the book; the file's figures were stored for Broker Truth\./,
    );
  });

  it("the preview knows it too, so the button can say \"Store N broker figures\"", () => {
    const p = commitMod.previewParsedFile(realised, null, ACCOUNT);
    expect(p.supersededByBook).toBe(true);
  });
});

describe("the reference alone in an empty account — v3.8 behaviour, plus a caveat", () => {
  const ACCOUNT = 502;

  it("imports the positions, because nothing else in this account holds them", () => {
    newAccount(ACCOUNT, "reference-only");
    const res = commitMod.commitParsedFile(realised, REALISED, null, ACCOUNT);
    expect(res.added).toBe(realised.trades.length);
    expect(tradeCount(ACCOUNT)).toBe(realised.trades.length);
    expect(res.referenceStored ?? 0).toBeGreaterThan(0);
  });

  it("and warns that a transaction report will supersede them", () => {
    newAccount(503, "reference-only-2");
    const p = commitMod.previewParsedFile(realised, null, 503);
    expect(p.supersededByBook).toBe(false);
    const res = commitMod.commitParsedFile(realised, REALISED, null, 503);
    expect(res.warnings?.join(" | ")).toMatch(
      /Imported as trades because no Dhan transaction report is in this account; import the transaction report to make it the book — these rows will then be superseded/,
    );
  });
});
