import "server-only";
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

async function fetchBhavcopy(isoDate: string): Promise<string | null> {
  const url = `${NSE_ARCHIVE}/sec_bhavdata_full_${toDdmmyyyy(isoDate)}.csv`;
  try {
    const res = await fetch(url, {
      headers: {
        // NSE 403s default fetch UAs; present as a normal browser.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/csv,*/*",
        Referer: "https://www.nseindia.com/",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    // A holiday date can serve an HTML error page — sanity-check the shape.
    return text.includes("SYMBOL") ? text : null;
  } catch {
    return null; // offline / blocked / timeout → caller walks back or skips
  }
}

/** Breach scan over open positions using the freshest MTM map (T3.9). */
export function scanBreaches(): Breach[] {
  const open = db.select().from(tradesTable).where(eq(tradesTable.isOpen, true)).all();
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
  let text: string | null = null;
  for (let i = 0; i < 3 && !text; i++) {
    text = await fetchBhavcopy(target);
    if (!text) {
      if (settings.lastAutoMtmDate === previousTradingDay(target)) {
        return none(`No bhavcopy for ${target} yet (holiday or not published) — already current through ${settings.lastAutoMtmDate}.`);
      }
      if (i < 2) target = previousTradingDay(target);
    }
  }
  if (!text) return none("NSE bhavcopy unreachable (offline, blocked, or holiday run) — skipped silently; manual MTM still works.");

  const result: BhavcopyMtmResult = applyBhavcopyMtm(text);
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
