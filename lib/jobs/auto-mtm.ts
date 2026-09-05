import "server-only";
import { inflateRawSync } from "node:zlib";
import { db } from "@/lib/db";
import { settings as settingsTable, trades as tradesTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { applyBhavcopyMtm, type BhavcopyMtmResult } from "@/lib/import/mtm-bhavcopy";
import { latestBhavcopyDate, previousTradingDay, toDdmmyyyy } from "@/lib/domain/trading-day";
import { getMtmMap } from "@/lib/queries/mtm";
import { detectBreaches, type AlertPositionInput, type Breach } from "@/lib/risk/alerts";

// T3.8 — opt-in EOD auto-MTM. The user's toggle in Settings is the ONLY thing
// that allows a network fetch; everything fails silently offline (offline-first
// app, NSE blocks aggressively). Runs at most once per bhavcopy date.
//
// User-control contract:
//   - disabled by default; nothing fetches until the user turns it on
//   - overwrites MTM ONLY for symbols present in the file (manual marks for
//     unmatched symbols stay untouched) — stated in the Settings caution copy
//   - every run lands in the audit log via applyBhavcopyMtm

export interface AutoMtmOutcome {
  ran: boolean;
  reason: string; // why it ran / didn't — surfaced in the UI status line
  date: string | null; // bhavcopy date applied
  priced: number;
  equityHeld: number;
  breaches: Breach[]; // SL/TSL/target breaches detected on the fresh marks (T3.9)
}

const NSE_ARCHIVE = "https://nsearchives.nseindia.com/products/content";
/** UDiFF lives on the SAME host, under a different path. No new host — see
 *  docs/client/PRIVACY.md item 2 and tests/egress-guard.test.ts. */
const NSE_UDIFF = "https://nsearchives.nseindia.com/content/cm";

/** Browser-shaped headers: NSE 403s default fetch UAs. */
const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/csv,*/*",
  Referer: "https://www.nseindia.com/",
} as const;

const FETCH_TIMEOUT_MS = 15_000;

/** Which of the two files answered. Surfaced so a run can be audited. */
export type BhavcopySource = "udiff" | "legacy";

export interface BhavcopyFetch {
  text: string;
  source: BhavcopySource;
  url: string;
}

/**
 * Extract the single CSV member of an NSE `.csv.zip`, with `node:zlib` only.
 *
 * NSE's UDiFF archive is one deflated member, no encryption, no data
 * descriptor (verified 2026-09-06 against BhavCopy_NSE_CM_0_0_0_20260904_F_0000
 * .csv.zip: local header at offset 0, method 8, csize 204,132 → 629,901 bytes).
 * A dependency for that would be a `package-lock.json` rewrite, which AGENTS.md
 * forbids casually, so the ~20 lines live here. Anything unexpected returns
 * `null` and the caller falls back to the legacy CSV rather than throwing.
 */
export function unzipSingleCsv(buf: Buffer): string | null {
  try {
    if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) return null;
    const flags = buf.readUInt16LE(6);
    if (flags & 0x1) return null; // encrypted
    const method = buf.readUInt16LE(8);
    const csize = buf.readUInt32LE(18);
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    const start = 30 + nameLen + extraLen;
    // csize 0 means the sizes are in a trailing data descriptor; inflate stops
    // at the end of the deflate stream either way, so hand it the remainder.
    const body = csize > 0 ? buf.subarray(start, start + csize) : buf.subarray(start);
    if (method === 0) return body.toString("utf8");
    if (method !== 8) return null;
    return inflateRawSync(body).toString("utf8");
  } catch {
    return null; // truncated, encrypted, or not a zip at all
  }
}

async function getBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: { ...NSE_HEADERS }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null; // offline / blocked / timeout → caller walks back or skips
  }
}

/** Does this look like a cash bhavcopy rather than a holiday HTML error page? */
function looksLikeBhavcopy(text: string): boolean {
  return text.includes("SYMBOL") || text.includes("TckrSymb");
}

/**
 * One session's bhavcopy — UDiFF FIRST, legacy `sec_bhavdata_full` second
 * (research answer Q48).
 *
 * UDiFF is NSE's current publication and the legacy full file is the one NSE
 * has been signalling it will retire; taking UDiFF first means the app keeps
 * working the day the old path stops answering, and the fallback means nothing
 * breaks today if UDiFF 404s for a session. The legacy file is also the only
 * one carrying DELIV_QTY, which is why `parseBhavcopy` keeps that column when
 * the fallback is what answered.
 */
export async function fetchBhavcopyForDate(isoDate: string): Promise<BhavcopyFetch | null> {
  const udiffUrl = `${NSE_UDIFF}/BhavCopy_NSE_CM_0_0_0_${isoDate.replace(/-/g, "")}_F_0000.csv.zip`;
  const zip = await getBytes(udiffUrl);
  if (zip) {
    const csv = unzipSingleCsv(zip);
    if (csv && looksLikeBhavcopy(csv)) return { text: csv, source: "udiff", url: udiffUrl };
  }
  const legacyUrl = `${NSE_ARCHIVE}/sec_bhavdata_full_${toDdmmyyyy(isoDate)}.csv`;
  const bytes = await getBytes(legacyUrl);
  if (!bytes) return null;
  const text = bytes.toString("utf8");
  return looksLikeBhavcopy(text) ? { text, source: "legacy", url: legacyUrl } : null;
}

/** Breach scan over open positions using the freshest MTM map (T3.9).
 *  Projected to the 12 columns `AlertPositionInput` reads — same WHERE, same
 *  rows in the same order (perf sweep 2026-08-29: 33 ms → 6 ms at 3.5k open). */
export function scanBreaches(): Breach[] {
  const open = db
    .select({
      id: tradesTable.id,
      symbol: tradesTable.symbol,
      tradingsymbol: tradesTable.tradingsymbol,
      buyQty: tradesTable.buyQty,
      sellQty: tradesTable.sellQty,
      avgBuyPrice: tradesTable.avgBuyPrice,
      avgSellPrice: tradesTable.avgSellPrice,
      closingPrice: tradesTable.closingPrice,
      slPlanned: tradesTable.slPlanned,
      trailingSl: tradesTable.trailingSl,
      targetPlanned: tradesTable.targetPlanned,
      riskAmount: tradesTable.riskAmount,
    })
    .from(tradesTable)
    .where(eq(tradesTable.isOpen, true))
    .all();
  const mtm = getMtmMap();
  const inputs: AlertPositionInput[] = open.map((t) => {
    const isShort = t.sellQty > t.buyQty;
    return {
      id: t.id,
      symbol: t.symbol,
      side: isShort ? "short" : "long",
      qty: Math.abs(t.buyQty - t.sellQty) || (isShort ? t.sellQty : t.buyQty),
      entry: isShort ? t.avgSellPrice : t.avgBuyPrice,
      mtm: mtm.get(t.symbol.toUpperCase()) ?? mtm.get(t.tradingsymbol.toUpperCase()) ?? t.closingPrice ?? 0,
      slPlanned: t.slPlanned,
      trailingSl: t.trailingSl,
      targetPlanned: t.targetPlanned,
      riskAmount: t.riskAmount,
    };
  });
  return detectBreaches(inputs);
}

export async function runAutoMtm(now = new Date()): Promise<AutoMtmOutcome> {
  const settings = db.select().from(settingsTable).limit(1).all()[0];
  const none = (reason: string): AutoMtmOutcome => ({ ran: false, reason, date: null, priced: 0, equityHeld: 0, breaches: [] });
  if (!settings) return none("No settings row.");
  if (!settings.autoMtmEnabled) return none("Auto-MTM is off — enable it in Settings if you want EOD closes fetched automatically.");

  let target = latestBhavcopyDate(now);
  if (settings.lastAutoMtmDate === target) {
    return { ...none(`Already applied the ${target} bhavcopy.`), date: target };
  }

  // Holidays aren't knowable offline — walk back past a missing file (max 3).
  let got: BhavcopyFetch | null = null;
  for (let i = 0; i < 3 && !got; i++) {
    got = await fetchBhavcopyForDate(target);
    if (!got) {
      if (settings.lastAutoMtmDate === previousTradingDay(target)) {
        return none(`No bhavcopy for ${target} yet (holiday or not published) — already current through ${settings.lastAutoMtmDate}.`);
      }
      if (i < 2) target = previousTradingDay(target);
    }
  }
  if (!got) return none("NSE bhavcopy unreachable (offline, blocked, or holiday run) — skipped silently; manual MTM still works.");

  const result: BhavcopyMtmResult = applyBhavcopyMtm(got.text);
  if (!result.ok) return none(`Bhavcopy fetched but not applied: ${result.message}`);

  db.update(settingsTable)
    .set({ lastAutoMtmDate: result.date ?? target })
    .where(eq(settingsTable.id, settings.id))
    .run();

  return {
    ran: true,
    reason: result.message,
    date: result.date ?? target,
    priced: result.priced,
    equityHeld: result.equityHeld,
    breaches: scanBreaches(),
  };
}
