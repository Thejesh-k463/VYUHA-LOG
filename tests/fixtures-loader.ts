import fs from "node:fs";
import path from "node:path";
import { parseDhanCsv } from "@/lib/import/parsers/dhan-csv";
import { parseGrowwXlsx } from "@/lib/import/parsers/groww-xlsx";
import type { NormalizedTrade } from "@/lib/engine/types";

const FIX = path.join(process.cwd(), "tests", "fixtures");

export interface DhanReco {
  netPnl: number;
  brokerage: number;
  grossPnl: number;
  totalCharges: number;
}

export function loadDhan(): { trades: NormalizedTrade[]; reco: DhanReco } {
  const text = fs.readFileSync(path.join(FIX, "dhan-pnl.csv"), "utf-8");
  const pf = parseDhanCsv({ filename: "dhan-pnl.csv", text });
  return { trades: pf.trades, reco: pf.reported as unknown as DhanReco };
}

export interface GrowwReco {
  realisedPnl: number;
  unrealisedPnl: number;
  exchangeTxn: number;
  sebi: number;
  stt: number;
  stamp: number;
  ipft: number;
  brokerage: number;
  cdslDp: number;
  growwDp: number;
  mtfPledge: number;
  mtfUnpledge: number;
  mtfInterest: number;
  gst: number;
  total: number;
}

export function loadGroww(): { trades: NormalizedTrade[]; reco: GrowwReco } {
  const buffer = fs.readFileSync(path.join(FIX, "groww-pnl.xlsx"));
  const pf = parseGrowwXlsx({ filename: "groww-pnl.xlsx", buffer });
  return { trades: pf.trades, reco: pf.reported as unknown as GrowwReco };
}

export const fixturePath = (f: string) => path.join(FIX, f);
