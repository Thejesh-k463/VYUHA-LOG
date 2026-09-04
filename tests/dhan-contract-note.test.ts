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
import { describe, expect, it } from "vitest";
import {
  detectDhanContractNote,
  parseAnnexure,
  parseContractDescription,
  parseDhanContractNote,
  parseNoteCharges,
  parseNoteDate,
  readContractNoteText,
} from "@/lib/import/parsers/dhan-contract-note";
import { detectPdf } from "@/lib/import/parsers/pdf";
import {
  OWNER_DHAN_CONTRACT_NOTE,
  OWNER_FUT_CONTRACT_NOTE,
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

  it("reads a description on its own", () => {
    expect(parseContractDescription("OPTSTK ADANIPOWER 28Apr2026 190 CE - NSE"))
      .toEqual({ symbol: "ADANIPOWER", expiry: "2026-04-28", instrumentType: "option", exchange: "NSE" });
    expect(parseContractDescription("FUTIDX NIFTY 28Apr2026 - NSE"))
      .toEqual({ symbol: "NIFTY", expiry: "2026-04-28", instrumentType: "future", exchange: "NSE" });
    expect(parseContractDescription("SHAILY-SHAILY ENG PLASTICS LTD"))
      .toEqual({ symbol: "SHAILY", expiry: null, instrumentType: "equity", exchange: null });
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
    if (!fs.existsSync(OWNER_FUT_CONTRACT_NOTE)) return; // not this machine
    const file = await parseDhanContractNote({
      filename: "export.pdf",
      buffer: fs.readFileSync(OWNER_FUT_CONTRACT_NOTE),
    });
    const wipro = file.enrich!.filter((e) => e.symbol === "WIPRO");
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
    const p = new PDFParse({ data: new Uint8Array(fs.readFileSync(OWNER_FUT_CONTRACT_NOTE)) });
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
