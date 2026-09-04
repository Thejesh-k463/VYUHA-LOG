/**
 * Dhan contract note (PDF) — fill times and instrument types for trades the
 * book already holds.
 *
 * A contract note CANNOT be redacted by `scripts/fixtures/redact-broker-export.mjs`
 * (it reads workbooks and CSVs), and a real note is nothing but identity plus
 * numbers. So the layout is pinned two ways: a synthetic-text unit test of the
 * line parser, committed here, and assertions against the owner's real notes
 * read IN PLACE — skipped on any machine that does not have them, and never
 * printing anything that identifies the account.
 */
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectDhanContractNote,
  parseAnnexure,
  parseContractDescription,
  bookName,
  parseDhanContractNote,
  parseEquityIsins,
  parseNoteCharges,
  parseNoteDate,
  readContractNoteText,
} from "@/lib/import/parsers/dhan-contract-note";
import { detectPdf } from "@/lib/import/parsers/pdf";
import { parseInstrumentName } from "@/lib/engine/classify";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import {
  OWNER_DHAN_CONTRACT_NOTE,
  ownerFutContractNote,
  ownerContext,
  ownerFiles,
} from "./helpers/owner-broker-files";

// Invented figures in the REAL line layout (one line per fill, as pdf-parse
// renders the trade annexure).
const SYNTHETIC = [
  "Client code: TEST00000A Contract Date : 15-04-2026 Page 1 of 2",
  "Trade Annexure Contract no: 1234567",
  "Order Number Order Time Trade No. Trade",
  "NCL-NSE-Equity-M",
  "1000000026400701 10:56:35 3053324 10:56:35 ACME-ACME LIMITED B 11 534.7500 534.7500 5,882.25",
  "1000000026400999 11:02:01 3053999 11:02:04 ACME-ACME LIMITED S 11 536.0000 536.0000 5,896.00",
  "NSEFO",
  "2600000137985337 12:26:49 444398 12:26:49 FUTSTK ACME 28Apr2026 - NSE B 3,000 205.7200 205.7200 617,160.00",
  "2500000032915612 09:46:52 148848 09:46:52 OPTIDX NIFTY 21Apr2026 24200 CE - NSE B 5,005 248.2351 248.2351 1,242,596.50",
  "Description NCLCM NCLFO Total",
  "Taxable Value Of Supply (Brokerage) 460.00 DR 700.00 DR 1,160.00 DR",
  "Taxable Value Of Supply (NSE Transaction Charges) 356.74 DR 1,102.63 DR 1,459.37 DR",
  "Taxable Value Of Supply (SEBI Fees) 11.62 DR 4.27 DR 15.89 DR",
  "IGST* RATE:18% on Taxable Value of Supply 149.11 DR 325.24 DR 474.35 DR",
  "Stamp Duty (Rs.) 305.00 DR 58.00 DR 363.00 DR",
  "Securities Transactions Tax (Rs.) 3,869.00 DR 2,591.00 DR 6,460.00 DR",
].join("\n");

/** The same note, plus the settlement-summary line that states the ISIN. */
const SYNTHETIC_WITH_SUMMARY = [
  "Client code: TEST00000A Contract Date : 15-04-2026 Page 1 of 2",
  "ISIN Symbol Buy Qty Buy WAP Buy Brok Net Buy Rate Buy Amount",
  "INE676A01027 ACME 2,000 534.6737 0.0200 534.6937 1,069,387.35 2,000 532.2837 0.0200 532.2637 1,064,527.40 0 -4,859.95",
  SYNTHETIC,
].join("\n");

describe("the annexure line parser", () => {
  const fills = parseAnnexure(SYNTHETIC);

  it("reads one fill per printed line, with both times", () => {
    expect(fills).toHaveLength(4);
    expect(fills[0]).toMatchObject({
      orderTime: "10:56:35", tradeTime: "10:56:35", tradeNo: "3053324",
      symbol: "ACME", side: "buy", qty: 11, price: 534.75, instrumentType: "equity", exchange: "NSE",
    });
    // Order time and trade time are DIFFERENT fields, not one read twice.
    expect(fills[1]).toMatchObject({ orderTime: "11:02:01", tradeTime: "11:02:04", side: "sell" });
  });

  it("maps the exchange's own contract prefix to the instrument type", () => {
    expect(fills[2]).toMatchObject({ symbol: "ACME", instrumentType: "future", expiry: "2026-04-28", qty: 3000, exchange: "NSE" });
    expect(fills[3]).toMatchObject({ symbol: "NIFTY", instrumentType: "option", expiry: "2026-04-21", qty: 5005 });
  });

  it("takes the equity exchange from the segment marker above the block", () => {
    expect(fills[0]!.exchange).toBe("NSE");
  });

  it("reads a description on its own — including the strike, the option type and the company name", () => {
    expect(parseContractDescription("OPTSTK ADANIPOWER 28Apr2026 190 CE - NSE"))
      .toEqual({ symbol: "ADANIPOWER", name: null, expiry: "2026-04-28", strike: 190, optionType: "CE", instrumentType: "option", exchange: "NSE" });
    expect(parseContractDescription("FUTIDX NIFTY 28Apr2026 - NSE"))
      .toEqual({ symbol: "NIFTY", name: null, expiry: "2026-04-28", strike: null, optionType: null, instrumentType: "future", exchange: "NSE" });
    expect(parseContractDescription("SHAILY-SHAILY ENG PLASTICS LTD"))
      .toEqual({ symbol: "SHAILY", name: "SHAILY ENG PLASTICS LTD", expiry: null, strike: null, optionType: null, instrumentType: "equity", exchange: null });
  });

  it("ignores the wrapped derivative SUMMARY table above the annexure", () => {
    // Those lines state WAP AFTER BROKERAGE and wrap mid-description; reading
    // them would invent a second, differently-priced copy of every position.
    const wrapped = "OPTIDX NIFTY 21Apr2026 24200 CE -\nNSE B 5,005 248.2351 0.0360 248.2711 -1,242,596.50";
    expect(parseAnnexure(wrapped)).toEqual([]);
  });
});

describe("the note's own figures", () => {
  it("reads the contract date, day-first, refusing the ambiguous order", () => {
    expect(parseNoteDate(SYNTHETIC)).toBe("2026-04-15");
    expect(parseNoteDate("Contract Date : 07-13-2026")).toBeNull();
    expect(parseNoteDate("Trade Date: 18-08-2026")).toBe("2026-08-18");
  });

  it("takes the TOTAL column of each charge line and stores costs positive", () => {
    const refs = parseNoteCharges(SYNTHETIC, "2026-04-15");
    const by = Object.fromEntries(refs.map((r) => [r.key, r.figures.amount]));
    expect(by).toEqual({ brokerage: 1160, exchangeTxn: 1459.37, sebi: 15.89, gst: 474.35, stamp: 363, stt: 6460 });
    expect(refs.every((r) => r.scope === "charge" && r.asOf === "2026-04-15")).toBe(true);
  });
});

describe("enrichment, not trades", () => {
  const parsed = readContractNoteText(SYNTHETIC);

  it("emits one enrich row per fill, carrying the trade time", () => {
    expect(parsed.enrich).toHaveLength(4);
    expect(parsed.enrich[0]).toMatchObject({ symbol: "ACME", date: "2026-04-15", side: "buy", qty: 11, time: "10:56:35", instrumentType: "equity", exchange: "NSE" });
  });

  it("applies nothing when the note states no date", () => {
    const undated = readContractNoteText(SYNTHETIC.replace("Contract Date : 15-04-2026", "Contract Date : —"));
    expect(undated.enrich).toEqual([]);
    expect(undated.warnings.join(" ")).toMatch(/no readable contract date/);
  });
});

describe("detection outranks the generic PDF source", () => {
  const noteBytes = (extra = "Raise Securities Pvt. Ltd") =>
    Buffer.from(`%PDF-1.7\n/Title (CONTRACT NOTE)\n/Author (${extra})\n`, "latin1");

  it("scores strictly above pdf's flat 0.9, and 1.0 when named", () => {
    expect(detectPdf({ filename: "note.pdf" })).toBe(0.9);
    expect(detectDhanContractNote({ filename: "note.pdf", buffer: noteBytes() })).toBe(0.95);
    expect(detectDhanContractNote({ filename: "dhan-note.pdf", buffer: noteBytes() })).toBe(1);
  });

  it("refuses a PDF that names no Dhan entity — that one belongs to `pdf`", () => {
    const other = Buffer.from("%PDF-1.7\n/Title (CONTRACT NOTE)\n/Author (Some Other Broker Ltd)\n", "latin1");
    expect(detectDhanContractNote({ filename: "IBXX_Contract_Note.pdf", buffer: other })).toBe(0);
  });

  it("refuses a Dhan PDF that is not a contract note", () => {
    const stmt = Buffer.from("%PDF-1.7\n/Title (Holding Statement)\n/Author (Raise Securities)\n", "latin1");
    expect(detectDhanContractNote({ filename: "statement.pdf", buffer: stmt })).toBe(0);
  });

  it("refuses a text container and a workbook", () => {
    expect(detectDhanContractNote({ filename: "note.csv", text: "Contract Note dhan" })).toBe(0);
    expect(detectDhanContractNote({ filename: "note.xlsx", buffer: Buffer.from("dhan Contract Note") })).toBe(0);
  });
});

describe("the owner's real contract notes", () => {
  const notes = ownerFiles(OWNER_DHAN_CONTRACT_NOTE);

  it("are claimed on their own bytes under a NEUTRAL filename", () => {
    if (notes.length === 0) return; // not this machine
    for (const f of notes) {
      const { filename, bytes } = ownerContext(f);
      expect(filename).toBe("export.pdf");
      expect(detectDhanContractNote({ filename, buffer: bytes })).toBe(0.95);
      expect(detectPdf({ filename })).toBe(0.9);
    }
  });

  it("parse into enrichments and charges, and never into trades", async () => {
    if (notes.length === 0) return;
    for (const f of notes) {
      const { filename, bytes } = ownerContext(f);
      const file = await parseDhanContractNote({ filename, buffer: bytes });
      expect(file.trades).toEqual([]);
      expect(file.warnings[0]).toMatch(/NEVER creates trades/);
      expect(file.enrich!.length).toBeGreaterThan(0);
      expect(file.enrich!.every((e) => /^\d{2}:\d{2}:\d{2}$/.test(e.time ?? ""))).toBe(true);
      expect(file.enrich!.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))).toBe(true);
      expect(file.reference!.some((r) => r.key === "stt")).toBe(true);
    }
  }, 60_000);

  it("the futures note yields the WIPRO round trip as two `future` enrichments", async () => {
    const note = ownerFutContractNote();
    if (!note) return; // not this machine
    const file = await parseDhanContractNote({
      filename: "export.pdf",
      buffer: fs.readFileSync(note),
    });
    // The BOOK's own name for the contract, which is what the enrichment has
    // to be addressed by — `WIPRO` alone matched no position (2026-09-04).
    const wipro = file.enrich!.filter((e) => e.symbol === "FUT WIPRO 28 Apr 2026");
    expect(wipro).toHaveLength(2);
    expect(wipro.every((e) => e.instrumentType === "future")).toBe(true);
    expect(wipro.every((e) => e.qty === 3000 && e.date === "2026-04-15" && e.exchange === "NSE")).toBe(true);
    expect(wipro.map((e) => e.side)).toEqual(["buy", "sell"]);
    expect(wipro.map((e) => e.time)).toEqual(["12:26:49", "12:28:33"]);
    // Same day, both directions — the intraday round trip the note describes.
    expect(new Set(wipro.map((e) => e.date)).size).toBe(1);
    // The prices the note states for that round trip, read from the annexure
    // itself — the enrich rows carry no price, so this is the only place the
    // WAP is checked against the document.
    const { PDFParse } = await import("pdf-parse");
    const p = new PDFParse({ data: new Uint8Array(fs.readFileSync(note)) });
    const text = (await p.getText()).text ?? "";
    await p.destroy();
    const wiproFills = parseAnnexure(text).filter((f) => f.symbol === "WIPRO");
    expect(wiproFills.map((f) => [f.side, f.qty, f.price])).toEqual([
      ["buy", 3000, 205.72],
      ["sell", 3000, 205.41],
    ]);
    // Every other fill on this note is an option, and none of them is a trade.
    expect(file.trades).toEqual([]);
    expect(file.enrich!.some((e) => e.instrumentType === "option")).toBe(true);
  }, 60_000);
});

/**
 * The book's own name for a contract, and the ISIN behind an equity ticker.
 *
 * Before 2026-09-04 the enrichment was addressed by the bare underlying
 * (`NIFTY`) for a derivative and by the exchange ticker (`BBOX`) for equity.
 * The book — the Global Transaction Report — holds
 * `OPT NIFTY 21 Apr 2026 24200 CE` and `Black Box`. Neither string was ever
 * equal to the other, which is why enrichment matched ZERO of 1,161 real
 * fills. These are the two translations that fixed it.
 */
describe("the name the enrichment is addressed by", () => {
  const fills = parseAnnexure(SYNTHETIC_WITH_SUMMARY);

  it("rebuilds the GTR's own derivative grammar, strike and all", () => {
    expect(bookName({ symbol: "NIFTY", expiry: "2026-04-21", strike: 24200, optionType: "CE", instrumentType: "option" }))
      .toBe("OPT NIFTY 21 Apr 2026 24200 CE");
    expect(bookName({ symbol: "WIPRO", expiry: "2026-04-28", strike: null, optionType: null, instrumentType: "future" }))
      .toBe("FUT WIPRO 28 Apr 2026");
    // Equity has no contract to name: the ticker is the whole name.
    expect(bookName({ symbol: "ACME", expiry: null, strike: null, optionType: null, instrumentType: "equity" }))
      .toBe("ACME");
    // `classify` must be able to read what we write — the same grammar the
    // GTR uses, or the trade row and the note would still disagree.
    expect(parseInstrumentName("OPT NIFTY 21 Apr 2026 24200 CE"))
      .toMatchObject({ kind: "option", symbol: "NIFTY", expiry: "2026-04-21", strike: 24200, optionType: "CE" });
    expect(parseInstrumentName("FUT WIPRO 28 Apr 2026")).toMatchObject({ kind: "future", symbol: "WIPRO", expiry: "2026-04-28" });
  });

  it("reads the ISIN per equity contract out of the settlement summary", () => {
    expect(parseEquityIsins(SYNTHETIC_WITH_SUMMARY)).toEqual({ ACME: "INE676A01027" });
  });

  it("carries the ISIN, the company name and the book name onto every fill", () => {
    const equity = fills.find((f) => f.instrumentType === "equity")!;
    expect(equity).toMatchObject({ symbol: "ACME", name: "ACME LIMITED", isin: "INE676A01027", bookName: "ACME" });
    const option = fills.find((f) => f.instrumentType === "option")!;
    expect(option).toMatchObject({ bookName: "OPT NIFTY 21 Apr 2026 24200 CE", strike: 24200, optionType: "CE" });
    // A derivative has no ISIN and none is invented for it.
    expect(option.isin).toBeNull();
  });

  it("emits the book name as `symbol` on the enrichment rows", () => {
    const parsed = readContractNoteText(SYNTHETIC_WITH_SUMMARY);
    expect(parsed.enrich.map((e) => e.symbol)).toEqual(
      expect.arrayContaining(["ACME", "OPT NIFTY 21 Apr 2026 24200 CE", "FUT ACME 28 Apr 2026"]),
    );
    expect(parsed.enrich.find((e) => e.symbol === "ACME")).toMatchObject({ isin: "INE676A01027", name: "ACME LIMITED" });
  });
});

/**
 * The whole point, measured against the owner's own paperwork.
 *
 * The Global Transaction Report is imported as the book, then each contract
 * note is committed against it. Before 2026-09-04 this matched ZERO of 1,161
 * real fills. The numbers below are what it does now — asserted as FLOORS
 * plus an exact count of the one contract the book calls by a nickname, so a
 * regression shows up as a number and not as a vague "still works".
 *
 * Owner files only; skipped everywhere else. Nothing here prints anything
 * that identifies the account.
 */
const OWNER_GTR = /^Dhan_GlobalTransction_Report_.*\.csv$/i;

describe("the owner's real notes against the owner's real book", () => {
  const gtrs = ownerFiles(OWNER_GTR);
  const notes = ownerFiles(OWNER_DHAN_CONTRACT_NOTE);
  const futNote = ownerFutContractNote();
  const have = gtrs.length > 0 && (notes.length > 0 || futNote != null);

  let t: TempDb;
  let commit: typeof import("@/lib/import/commit");

  beforeAll(async () => {
    if (!have) return;
    t = await openTempDb("cnreal", { seed: true });
    commit = await import("@/lib/import/commit");
  }, 60_000);

  afterAll(async () => { await t?.cleanup?.(); });

  it("matches nearly every contract-day, and says honestly which it cannot", async () => {
    if (!have) return;
    const { parseDhanGtr } = await import("@/lib/import/parsers/dhan-gtr");
    const { buildContext } = await import("@/lib/import/detect");

    // The BOOK first — EVERY transaction report this machine has, into one
    // account. The notes come from more than one account and a note can only
    // enrich a book that holds its day, so the test would otherwise be
    // measuring which files happen to pair up rather than whether matching
    // works.
    let booked = 0;
    for (const g of gtrs) {
      const book = await parseDhanGtr(buildContext("gtr.csv", fs.readFileSync(g)));
      booked += commit.commitParsedFile(book, "gtr.csv", null, 1).added;
    }
    expect(booked).toBeGreaterThan(100);

    let fills = 0, days = 0, applied = 0, alreadyHad = 0, unmatched = 0;
    for (const p of [...notes, ...(futNote ? [futNote] : [])]) {
      const parsed = await parseDhanContractNote(buildContext("note.pdf", fs.readFileSync(p)));
      if (!parsed.enrich?.length) continue;
      const res = commit.commitParsedFile(parsed, "note.pdf", null, 1);
      fills += parsed.enrich.length;
      const line = (res.warnings ?? []).find((w) => /aggregated into/.test(w)) ?? "";
      const m = /aggregated into (\d+) contract-days?: applied (\d+), already had times (\d+), unmatched (\d+)/.exec(line);
      expect(m, "the commit reports applied / already-had / unmatched separately").not.toBeNull();
      days += Number(m![1]); applied += Number(m![2]); alreadyHad += Number(m![3]); unmatched += Number(m![4]);
      // Per NOTE, not just in aggregate: one contract-day has exactly one
      // outcome, so the three counters partition the days they are printed
      // beside. A `<=` here let a split day be counted three times as applied.
      expect(Number(m![2]) + Number(m![3]) + Number(m![4]), "applied + alreadyHad + unmatched === contract-days").toBe(Number(m![1]));
    }

    // Fills really do outnumber contract-days by an order of magnitude — the
    // aggregation is not cosmetic, it is the thing that makes a match possible.
    expect(fills).toBeGreaterThan(900);
    expect(days).toBeLessThan(fills / 10);
    // 45 of 46 on the two notes this machine has. A floor, not an equality:
    // another machine may hold a different set of notes.
    expect(applied / days).toBeGreaterThan(0.9);
    // The residue is the honest part. Every miss is reported with a reason,
    // and the three outcomes PARTITION the contract-days — a day is applied,
    // or it already had the facts, or it matched nothing. Never two of those.
    expect(applied + alreadyHad + unmatched).toBe(days);
  }, 300_000);

  it("gives the WIPRO futures round trip its real fill times and its instrument type", async () => {
    if (!have || !futNote) return;
    const row = t.sqlite.prepare(
      "SELECT symbol, instrument_type AS instrumentType, entry_time AS entryTime, exit_time AS exitTime FROM trades WHERE tradingsymbol = 'FUT WIPRO 28 Apr 2026'",
    ).get() as Record<string, unknown> | undefined;
    expect(row, "the GTR books the WIPRO future for 15 Apr 2026").toBeTruthy();
    expect(row!.instrumentType).toBe("future");
    expect(row!.entryTime).toBe("12:26:49");
    expect(row!.exitTime).toBe("12:28:33");
  });

  it("never creates a trade, however many fills it could not place", async () => {
    if (!have) return;
    const before = (t.sqlite.prepare("SELECT count(*) AS n FROM trades").get() as { n: number }).n;
    const p = [...notes, ...(futNote ? [futNote] : [])][0]!;
    const { buildContext } = await import("@/lib/import/detect");
    const parsed = await parseDhanContractNote(buildContext("note.pdf", fs.readFileSync(p)));
    commit.commitParsedFile(parsed, "note-again.pdf", null, 1);
    expect((t.sqlite.prepare("SELECT count(*) AS n FROM trades").get() as { n: number }).n).toBe(before);
  }, 120_000);
});
