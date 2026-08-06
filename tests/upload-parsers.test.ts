import { describe, expect, it } from "vitest";
import { parseInstrumentsFile } from "@/lib/import/instruments-file";
import { parseNseCorporateActions, parsePurpose } from "@/lib/import/nse-corporate-actions";
import { extractAisJson } from "@/lib/import/ais-json";
import { categorizeAuditRow, groupAuditRows } from "@/lib/domain/audit-categories";
import { splitBonusMultiplier } from "@/lib/analytics/corporate-actions";

// ─── instruments: UDiFF bhavcopy ────────────────────────────────────────────

const UDIFF = `TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric
2026-08-05,2026-08-05,CM,NSE,STK,2885,INE002A01018,RELIANCE,EQ,Reliance Industries Limited,2840,2865,2830,2858.5
2026-08-05,2026-08-05,CM,NSE,STK,11536,INE467B01029,TCS,EQ,Tata Consultancy Services Limited,4100,4150,4080,4120
2026-08-05,2026-08-05,CM,NSE,OPTSTK,99999,INE002A01018,RELIANCE,,RELIANCE AUG FUT,100,110,90,105`;

describe("parseInstrumentsFile — bhavcopy", () => {
  it("extracts symbol + name + ISIN and skips derivative rows", () => {
    const r = parseInstrumentsFile(UDIFF);
    expect(r.format).toBe("bhavcopy");
    expect(r.count).toBe(2);
    expect(r.fields).toContain("isin");
    expect(r.fields).toContain("name");
    const rel = r.rows.find((x) => x.symbol === "RELIANCE")!;
    expect(rel.isin).toBe("INE002A01018");
    expect(rel.name).toMatch(/Reliance Industries/);
    expect(rel.lotSize).toBeNull(); // bhavcopy carries no lots — never invented
  });

  it("never reports a sector field — no NSE file publishes sectors", () => {
    const r = parseInstrumentsFile(UDIFF);
    expect((r.fields as string[])).not.toContain("sector");
  });
});

// ─── instruments: securities list (EQUITY_L.csv, padded headers) ────────────

const EQUITY_L = `SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE
RELIANCE,Reliance Industries Limited, EQ, 29-NOV-1995, 10, 1, INE002A01018, 10
SUZLON,Suzlon Energy Limited, EQ, 19-OCT-2005, 2, 1, INE040H01021, 2`;

describe("parseInstrumentsFile — securities list", () => {
  it("reads the padded-header EQUITY_L layout", () => {
    const r = parseInstrumentsFile(EQUITY_L);
    expect(r.format).toBe("securities-list");
    expect(r.count).toBe(2);
    expect(r.rows[1]).toMatchObject({ symbol: "SUZLON", isin: "INE040H01021" });
  });
});

// ─── instruments: F&O market lots ───────────────────────────────────────────

const LOTS = `UNDERLYING,SYMBOL,AUG-26,SEP-26,OCT-26
Derivatives on Individual Securities,SYMBOL,,,
NIFTY 50,NIFTY,75,75,75
Reliance Industries,RELIANCE,500,500,500
Tata Consultancy,TCS,175,175,175`;

describe("parseInstrumentsFile — F&O lots", () => {
  it("takes the nearest-month lot and skips section headings", () => {
    const r = parseInstrumentsFile(LOTS);
    expect(r.format).toBe("fo-lots");
    expect(r.fields).toEqual(["lotSize"]);
    expect(r.rows.find((x) => x.symbol === "RELIANCE")!.lotSize).toBe(500);
    expect(r.rows.find((x) => x.symbol === "NIFTY")!.lotSize).toBe(75);
    // the interleaved "SYMBOL" heading row must not become an instrument
    expect(r.rows.some((x) => x.symbol === "SYMBOL")).toBe(false);
  });

  it("rejects an unrelated CSV instead of guessing", () => {
    const r = parseInstrumentsFile("A,B,C\n1,2,3");
    expect(r.format).toBe("unknown");
    expect(r.count).toBe(0);
  });
});

// ─── NSE corporate actions ──────────────────────────────────────────────────

describe("parsePurpose", () => {
  it("bonus A:B means A new per B held — multiplier (B+A)/B", () => {
    const p = parsePurpose("BONUS 1:1")!;
    expect(p).toMatchObject({ type: "bonus", fromUnits: 1, toUnits: 1 });
    expect(splitBonusMultiplier("bonus", p.fromUnits!, p.toUnits!)).toBe(2);

    const q = parsePurpose("Bonus 2:1")!; // 2 new per 1 held → ×3
    expect(splitBonusMultiplier("bonus", q.fromUnits!, q.toUnits!)).toBe(3);
  });

  it("face-value split from Rs 10 to Rs 2 quintuples the quantity", () => {
    const p = parsePurpose("FACE VALUE SPLIT (SUB-DIVISION) - FROM RS 10/- PER SHARE TO RS 2/- PER SHARE")!;
    expect(p.type).toBe("split");
    expect(splitBonusMultiplier("split", p.fromUnits!, p.toUnits!)).toBe(5);
  });

  it("sums multi-part dividends and reads paise amounts", () => {
    expect(parsePurpose("INTERIM DIVIDEND - RS 8.50 PER SHARE")!.dividendPerShare).toBe(8.5);
    expect(parsePurpose("INTERIM DIVIDEND RS 2 AND SPECIAL DIVIDEND RS 3")!.dividendPerShare).toBe(5);
  });

  it("refuses what it cannot read — rights, buybacks, unreadable splits", () => {
    expect(parsePurpose("RIGHTS 1:5 @ PREMIUM RS 10")).toBeNull();
    expect(parsePurpose("BUYBACK OF EQUITY SHARES")).toBeNull();
    expect(parsePurpose("ANNUAL GENERAL MEETING")).toBeNull();
  });
});

const CFCA = `SYMBOL,SERIES,FACE VALUE,ISIN,COMPANY,PURPOSE,EX-DATE,RECORD DATE
TCS,EQ,1,INE467B01029,Tata Consultancy,INTERIM DIVIDEND - RS 10 PER SHARE,04-Jul-2026,05-Jul-2026
IRFC,EQ,10,INE053F01010,Indian Railway Finance,BONUS 1:1,15-Jul-2026,16-Jul-2026
IRFC,BE,10,INE053F01010,Indian Railway Finance,BONUS 1:1,15-Jul-2026,16-Jul-2026
XYZ,EQ,10,INE000A00000,Some Company,RIGHTS 1:4 @ RS 100,20-Jul-2026,21-Jul-2026`;

describe("parseNseCorporateActions", () => {
  it("parses the CF-CA layout, dedupes per-series repeats, keeps the purpose as note", () => {
    const r = parseNseCorporateActions(CFCA);
    expect(r.count).toBe(2); // TCS dividend + ONE IRFC bonus (series repeat deduped)
    const tcs = r.rows.find((x) => x.symbol === "TCS")!;
    expect(tcs).toMatchObject({ type: "dividend", exDate: "2026-07-04", dividendPerShare: 10 });
    expect(tcs.note).toMatch(/INTERIM DIVIDEND/);
    expect(r.skipped["RIGHTS"]).toBe(1); // counted, never guessed
  });
});

// ─── AIS JSON ───────────────────────────────────────────────────────────────

const AIS = JSON.stringify({
  ay: "2027-28",
  parts: [
    {
      infoDesc: "Dividend received",
      aggregateGross: 9000, // the aggregate ABOVE details — must NOT be emitted
      details: [
        { reportingEntity: "ADANI TOTAL GAS LIMITED", grossAmount: 9000, tdsDeducted: 900 },
      ],
    },
    {
      infoDesc: "Sale of securities and units of mutual fund (SFT-18)",
      infoValue: "12,50,000",
    },
    { infoDesc: "Interest from savings bank", infoSrc: "SBI", amount: 4210 },
  ],
});

describe("extractAisJson", () => {
  it("emits leaves, drops the aggregate above them, inherits FY from AY", () => {
    const r = extractAisJson(AIS);
    const div = r.rows.filter((x) => x.type === "dividend");
    expect(div).toHaveLength(1); // detail row only — aggregate dropped
    expect(div[0]).toMatchObject({ party: "ADANI TOTAL GAS LIMITED", fy: "2026-27", amount: 9000, tds: 900 });
  });

  it("reads Indian-grouped string amounts and classifies SFT-18 as sale", () => {
    const r = extractAisJson(AIS);
    const sale = r.rows.find((x) => x.type === "sale")!;
    expect(sale.amount).toBe(1250000);
  });

  it("rejects non-JSON with a pointed message about the PDF", () => {
    const r = extractAisJson("%PDF-1.7 …");
    expect(r.rows).toHaveLength(0);
    expect(r.unparsed[0]).toMatch(/JSON format, not PDF/);
  });
});

// ─── audit categories ───────────────────────────────────────────────────────

describe("categorizeAuditRow", () => {
  const cases: [string, Parameters<typeof categorizeAuditRow>[0]][] = [
    ["prices", { entity: "settings", action: "update", summary: "bhavcopy auto-MTM (nse-eq) — priced 1/4 equity", source: "bhavcopy" }],
    ["licence", { entity: "settings", action: "update", summary: "License activated — x@y.com (toolkit)", source: "ui" }],
    ["capital", { entity: "capital", action: "update", summary: "capital → equity 395000 / active 360000", source: "ui" }],
    ["journal", { entity: "trade", action: "update", summary: "NLC INDIA journal updated (playbook 1 · confident · 0 mistakes)", source: "ui" }],
    ["trades", { entity: "trade", action: "close", summary: "NLC INDIA closed @ 398 · net 61918.06", source: "ui" }],
    ["trades", { entity: "trade", action: "staged_enable", summary: "SG Finserv converted to a staged position", source: "ui" }],
    ["imports", { entity: "trade", action: "delete", summary: "3 trades deleted (batch #4 cascade)", source: "ui" }],
    ["config", { entity: "settings", action: "update", summary: "settings updated", source: "ui" }],
    ["journal", { entity: "settings", action: "create", summary: 'Playbook "Reversal" created', source: "ui" }],
  ];
  for (const [want, row] of cases) {
    it(`${row.summary!.slice(0, 42)} → ${want}`, () => {
      expect(categorizeAuditRow(row)).toBe(want);
    });
  }

  it("groups keep display order and never lose rows", () => {
    const rows = cases.map(([, r], i) => ({ ...r, id: i }));
    const g = groupAuditRows(rows);
    const total = [...g.values()].reduce((s, arr) => s + arr.length, 0);
    expect(total).toBe(rows.length);
  });
});
