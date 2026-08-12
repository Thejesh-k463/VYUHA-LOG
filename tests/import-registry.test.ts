import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  brokersWithNativeParser,
  buildContext,
  detectParser,
  dropzoneHint,
  importSources,
  rankParsers,
} from "@/lib/import/detect";
import { BROKERS } from "@/lib/domain/constants";
import { detectBrokerFromText } from "@/lib/import/parsers/pdf";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

/**
 * THE BUG THIS FILE EXISTS TO PREVENT.
 *
 * The import dropzone used to carry two hand-written hint strings. The app read
 * five brokers' files while the tradebook hint named three, so a user looked at
 * the screen and reasonably concluded the feature only supported three brokers.
 * Nothing in the codebase connected the copy to the capability.
 */
describe("the dropzone copy is generated from the registry, never hand-written", () => {
  const client = read("components/import/import-client.tsx");

  it("the component calls dropzoneHint() instead of literal broker lists", () => {
    expect(client).toContain("dropzoneHint(");
  });

  it("no hard-coded broker-list hint survives in the component", () => {
    // The exact strings that drifted. Their return would be the regression.
    expect(client).not.toContain("Zerodha tradebook · Angel One tradebook · Upstox tradebook");
    expect(client).not.toContain("Dhan CSV · Groww XLSX · Zerodha Console");
  });

  it("every registered source appears in the hint for a tab it serves", () => {
    const both = `${dropzoneHint("transactions")} ${dropzoneHint("pnl")}`;
    for (const s of importSources()) {
      expect(both, `${s.sourceId} missing from dropzone hints`).toContain(s.hint);
    }
  });

  it("the generic fallback is offered on BOTH tabs and named last", () => {
    for (const tab of ["transactions", "pnl"] as const) {
      const hint = dropzoneHint(tab);
      expect(hint).toContain("any other broker");
      expect(hint.trim().endsWith("any other broker (map columns)")).toBe(true);
    }
  });
});

describe("every broker can get its trades in", () => {
  it("has a native parser, or is served by the generic mapper", () => {
    const native = new Set(brokersWithNativeParser());
    const generic = importSources().find((s) => s.sourceId === "generic-table");
    expect(generic, "the generic source is what makes this claim true").toBeDefined();
    // Not every broker needs a hand-written parser — but if one is missing, the
    // generic column mapper must exist to cover it, or the app genuinely
    // cannot import that broker.
    for (const b of BROKERS) {
      const covered = native.has(b) || generic !== undefined;
      expect(covered, `${b} has no import path at all`).toBe(true);
    }
  });

  it("names which brokers auto-detect, so the docs can never overstate it", () => {
    // A tripwire, not a wish: if a parser is added or removed this fails and
    // whoever changed it must update the README's broker-count claim too.
    // paytm joined 2026-08-12 (tradebook parser, from a verified real export).
    expect(brokersWithNativeParser().sort()).toEqual(
      ["angelone", "dhan", "groww", "paytm", "upstox", "zerodha"].sort(),
    );
  });
});

describe("the generic source never outranks a real parser", () => {
  const csv = (s: string) => buildContext("whatever.csv", Buffer.from(s, "utf8"));

  it("wins only when nothing else recognises the file", () => {
    const unknown = csv("Trade Date,Scrip,Txn,Qty,Rate\n01-04-2026,ACME,B,10,100\n");
    const top = detectParser(unknown);
    expect(top?.sourceId).toBe("generic-table");
  });

  it("loses to Zerodha on a Zerodha tradebook", () => {
    const zerodha = csv(
      "symbol,isin,trade_date,exchange,segment,series,trade_type,quantity,price,trade_id,order_id,order_execution_time\n" +
      "INFY,INE009A01021,2026-04-01,NSE,EQ,EQ,buy,10,1500,1,1,2026-04-01T09:20:00\n",
    );
    const ranked = rankParsers(zerodha);
    expect(ranked[0].sourceId).toBe("zerodha");
    const generic = ranked.find((r) => r.sourceId === "generic-table")!;
    expect(generic.confidence).toBeLessThan(ranked[0].confidence);
  });

  it("scores below the weakest score any hand-written detector can return", () => {
    const anyTable = csv("A,B\n1,2\n");
    const generic = rankParsers(anyTable).find((r) => r.sourceId === "generic-table")!;
    // Real detectors bottom out at 0.1 (a lone broker fingerprint word).
    expect(generic.confidence).toBeGreaterThan(0);
    expect(generic.confidence).toBeLessThan(0.1);
  });

  it("a broker-named parser will not claim a file that never names that broker", () => {
    // REGRESSION. detectFor() used to score on tradebook SHAPE alone, so any
    // CSV with a column called "Scrip" scored 0.2 as Angel One and won. A Kotak
    // Neo / Paytm / Sahi tradebook was therefore imported as Angel One trades,
    // priced with Angel One's charge rates. Shape is common to every broker;
    // only the name is evidence.
    const kotakish = csv(
      "Trade Date,Scrip,Buy/Sell,Quantity,Price\n01-04-2026,ACME,BUY,10,100\n",
    );
    const ranked = rankParsers(kotakish);
    for (const id of ["angelone", "upstox"]) {
      expect(ranked.find((r) => r.sourceId === id)!.confidence, `${id} claimed an unnamed file`).toBe(0);
    }
    expect(detectParser(kotakish)?.sourceId).toBe("generic-table");
  });

  it("HARDENED: symbol+isin shape and a 'tradebook' filename still claim nothing", () => {
    // The 2026-08-12 incident, distilled. detectZerodha used to award 0.35 for
    // the English word "tradebook" in a filename and 0.30 for symbol+isin —
    // either alone beat generic's 0.05. The old kotakish fixture stayed green
    // only because it happened to lack an `isin` column.
    const body =
      "Symbol,ISIN,Trade Date,Trade Type,Order ID,Quantity,Price,Realised P&L\n" +
      "ACME,INE000000000,01-04-2026,BUY,OD1,10,100,0\n";
    const shaped = buildContext("kotak_tradebook.csv", Buffer.from(body, "utf8"));
    const ranked = rankParsers(shaped);
    for (const id of ["zerodha", "angelone", "upstox", "groww-orders", "paytm-tradebook"]) {
      expect(ranked.find((r) => r.sourceId === id)!.confidence, `${id} claimed a shape-only file`).toBe(0);
    }
    expect(detectParser(shaped)?.sourceId).toBe("generic-table");
  });

  it("still recognises a real Angel One / Upstox file by name", () => {
    const body = "Trade Date,Symbol,Buy/Sell,Quantity,Price\n01-04-2026,INFY,BUY,10,1500\n";
    const angel = buildContext("angelone-tradebook.csv", Buffer.from(body, "utf8"));
    expect(detectParser(angel)?.sourceId).toBe("angelone");
    const upstox = buildContext("upstox-tradebook.csv", Buffer.from(body, "utf8"));
    expect(detectParser(upstox)?.sourceId).toBe("upstox");
  });

  it("declines PDFs — those belong to the PDF source", () => {
    const pdf = buildContext("note.pdf", Buffer.from("%PDF-1.4", "utf8"));
    const generic = rankParsers(pdf).find((r) => r.sourceId === "generic-table")!;
    expect(generic.confidence).toBe(0);
  });

  it("a file with no readable table is not claimed at all", () => {
    const junk = csv("just one line of prose with no second row");
    expect(rankParsers(junk).find((r) => r.sourceId === "generic-table")!.confidence).toBe(0);
  });
});

describe("PDF broker detection covers every broker, and admits when it cannot tell", () => {
  it("recognises all eight by name", () => {
    const samples: Record<string, string> = {
      dhan: "DhanHQ Securities Pvt Ltd",
      zerodha: "Zerodha Broking Limited",
      groww: "Groww Invest Tech",
      angelone: "Angel One Limited",
      upstox: "Upstox / RKSV Securities",
      kotakneo: "Kotak Securities — Neo",
      paytm: "Paytm Money Ltd",
      sahi: "Sahi (Aaritya Broking)",
    };
    for (const [broker, text] of Object.entries(samples)) {
      expect(detectBrokerFromText(text), text).toBe(broker);
    }
  });

  it("returns null rather than silently calling an unknown note 'Dhan'", () => {
    // The old code defaulted to dhan, so a Kotak contract note would have been
    // booked at Dhan's charge rates.
    expect(detectBrokerFromText("Some Other Broker Pvt Ltd\nContract Note")).toBeNull();
  });
});
