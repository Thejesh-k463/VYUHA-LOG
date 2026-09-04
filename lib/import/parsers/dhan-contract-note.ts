/**
 * Dhan **contract note** PDF (`*_Contract_Note_Eqfo_signed.pdf`) — the only
 * Dhan document that states the TIME of every fill.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── A contract note never creates a trade ─────────────────────────────────
 *
 * The Global Transaction Report is the book. A note describes ONE day on ONE
 * exchange pair, and importing it as trades would double-book every execution
 * the GTR already carries — with no dedup key strong enough to notice, because
 * a note states no order-level P&L and prices its lines differently (WAP after
 * brokerage). So this parser emits `enrich` rows — fill times, instrument type
 * and exchange, applied at commit to trades the book ALREADY holds — plus
 * `reference` rows for the note's own charge totals, and `trades: []` with a
 * warning that says so out loud.
 *
 * ── Verified on three real notes, 2026-09-04 ─────────────────────────────
 *
 * 38-page equity+F&O note (924 annexure lines), a 6-page 80-line F&O note and
 * a 9-page 157-line F&O note from a second account. `pdf-parse` renders the
 * annexure as ONE LINE PER FILL:
 *
 *   `<order no> <hh:mm:ss> <trade no> <hh:mm:ss> <description> <B|S> <qty>
 *    <price> <net rate> <net amount> [remark]`
 *
 * with a segment marker line above each block (`NCL-NSE-Equity-M`, `NSEFO`).
 * Descriptions come in two shapes:
 *
 *   equity      `SHAILY-SHAILY ENG PLASTICS LTD`      → symbol before the `-`
 *   derivative  `FUTSTK WIPRO 28Apr2026 - NSE`        → future
 *               `OPTIDX NIFTY 21Apr2026 24200 CE - NSE`  → option
 *
 * The DERIVATIVE SUMMARY table above the annexure wraps mid-description across
 * lines and states WAP-after-brokerage rather than the traded price, so it is
 * NOT read — the annexure is the per-fill truth and it is unwrapped.
 *
 * ── Detection, and why it outranks the generic PDF source ────────────────
 *
 * `detect` is synchronous and PDF text is compressed, so the text cannot be
 * read while ranking. What CAN be read synchronously is the file's raw bytes,
 * and all three notes carry the broker's legal name (`Raise Securities` /
 * `Moneylicious`) uncompressed in the document metadata. That is the
 * in-content fingerprint AGENTS.md demands — the filename alone would claim
 * any broker's contract note. Scores:
 *
 *   generic `pdf` source          0.90  (any .pdf, by extension)
 *   this parser, note + marker    0.95
 *   …with "dhan" in the filename  1.00
 *
 * so a Dhan note is always claimed here and every other PDF still falls to the
 * generic text extractor. If a future note stops carrying the marker in its
 * metadata, this returns 0 and the generic source handles it: the user gets
 * the text and a question instead of a confident wrong answer.
 */

import type { EnrichmentRow, ParseContext, ParsedFile, ReferenceRow } from "../types";

/** The same marker `dhan-realised-pnl` uses: trading name or legal entity. */
const DHAN_MARKER = /\bdhan\b|raise securities|moneylicious/i;
const NOTE_MARKER = /contract[\s_-]*note/i;

/** One annexure fill, exactly as the note prints it. */
export interface ContractNoteFill {
  orderNo: string;
  orderTime: string;
  tradeNo: string;
  tradeTime: string;
  description: string;
  symbol: string;
  /** The company name the description prints after the ticker (equity only). */
  name: string | null;
  expiry: string | null;
  strike: number | null;
  optionType: "CE" | "PE" | null;
  instrumentType: "equity" | "option" | "future";
  /**
   * The name the BOOK uses for this contract — `OPT NIFTY 21 Apr 2026 24200 CE`
   * / `FUT WIPRO 28 Apr 2026` for a derivative, the ticker for equity. See
   * `bookName` below for why this, and not the bare underlying.
   */
  bookName: string;
  /** From the note's own settlement summary, when it prints one (equity). */
  isin: string | null;
  side: "buy" | "sell";
  qty: number;
  price: number;
  exchange: string | null;
}

const ANNEXURE_LINE =
  /^(\d{8,})\s+(\d{2}:\d{2}:\d{2})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})\s+(.+?)\s+([BS])\s+([\d,]+)\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)(?:\s+\S+)?\s*$/;

/** A line that names the exchange for the block that follows it. */
const SEGMENT_LINE = /^(?:NCL-)?(NSE|BSE|MCX)(?:[-A-Za-z]*)$/;

const num = (s: string): number => {
  const v = Number(String(s ?? "").replace(/[,\s₹]/g, ""));
  return Number.isFinite(v) ? v : 0;
};

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * `FUTSTK WIPRO 28Apr2026 - NSE` → future/WIPRO/2026-04-28.
 * `OPTIDX NIFTY 21Apr2026 24200 CE - NSE` → option/NIFTY/2026-04-21.
 * `SHAILY-SHAILY ENG PLASTICS LTD` → equity/SHAILY.
 *
 * The instrument type comes from the contract PREFIX the exchange itself
 * writes, never from the shape of the symbol.
 */
export function parseContractDescription(desc: string): {
  symbol: string;
  name: string | null;
  expiry: string | null;
  strike: number | null;
  optionType: "CE" | "PE" | null;
  instrumentType: ContractNoteFill["instrumentType"];
  exchange: string | null;
} {
  const s = String(desc ?? "").trim();
  const der = /^(OPTIDX|OPTSTK|FUTIDX|FUTSTK|OPTCUR|FUTCUR|OPTCOM|FUTCOM)\s+(\S+)\s+(\d{1,2})([A-Za-z]{3})(\d{4})(?:\s+([\d,]+(?:\.\d+)?)\s+(CE|PE))?/i.exec(s);
  if (der) {
    const mm = MONTHS[der[4]!.toLowerCase()];
    const exch = /-\s*(NSE|BSE|MCX)\b/i.exec(s);
    const strike = der[6] ? Number(der[6].replace(/,/g, "")) : null;
    return {
      symbol: der[2]!.toUpperCase(),
      name: null,
      expiry: mm ? `${der[5]}-${mm}-${der[3]!.padStart(2, "0")}` : null,
      strike: strike != null && Number.isFinite(strike) ? strike : null,
      optionType: der[7] ? (der[7].toUpperCase() as "CE" | "PE") : null,
      instrumentType: der[1]!.toUpperCase().startsWith("OPT") ? "option" : "future",
      exchange: exch ? exch[1]!.toUpperCase() : null,
    };
  }
  // Equity: `SYMBOL-COMPANY NAME`. The symbol is what precedes the first "-";
  // the remainder is the company's own registered name, which is how the
  // Global Transaction Report books an equity line (`Black Box`), so it is
  // kept rather than thrown away — see `bookName`.
  const cut = s.indexOf("-");
  const sym = (cut >= 0 ? s.slice(0, cut) : s).trim().toUpperCase();
  const name = cut >= 0 ? s.slice(cut + 1).trim() : null;
  return { symbol: sym, name: name || null, expiry: null, strike: null, optionType: null, instrumentType: "equity", exchange: null };
}

/** `2026-04-28` → `28 Apr 2026`, the shape the GTR (and `classify`) writes. */
function gtrDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const mon = Object.entries(MONTHS).find(([, v]) => v === m)?.[0] ?? "";
  return `${d} ${mon.charAt(0).toUpperCase()}${mon.slice(1)} ${y}`;
}

/**
 * The name the BOOK holds for this contract.
 *
 * The Global Transaction Report — the book — writes a derivative as
 * `OPT NIFTY 07 Apr 2026 23000 CE` / `FUT WIPRO 28 Apr 2026` and `classify`
 * parses exactly that grammar, so the trade row carries it in
 * `tradingsymbol`. Until 2026-09-04 this parser emitted the bare underlying
 * (`NIFTY`) and buried the strike and expiry in a prose note, which made
 * every option on a busy day look like the same contract — and matched the
 * wrong one, or none. Rebuilding the book's own name is what makes an
 * enrichment addressable.
 */
export function bookName(p: {
  symbol: string;
  expiry: string | null;
  strike: number | null;
  optionType: "CE" | "PE" | null;
  instrumentType: ContractNoteFill["instrumentType"];
}): string {
  if (p.instrumentType === "equity" || !p.expiry) return p.symbol;
  const head = p.instrumentType === "option" ? "OPT" : "FUT";
  const tail = p.instrumentType === "option" && p.strike != null
    ? ` ${p.strike}${p.optionType ? ` ${p.optionType}` : ""}`
    : "";
  return `${head} ${p.symbol} ${gtrDate(p.expiry)}${tail}`;
}

/**
 * ISIN per equity contract, read from the note's own settlement summary —
 * `INE676A01027 BBOX 2,000 534.6737 …`, one line per scrip. This is the only
 * identity in the document that is not a name, and a name is exactly what the
 * two sides disagree about: the annexure prints the exchange ticker (`BBOX`)
 * while the book prints the company (`Black Box`).
 */
export function parseEquityIsins(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*(IN[EF][0-9A-Z]{9})\s+([A-Z0-9&.\-]{1,20})\s+-?[\d,]/.exec(raw.trim());
    if (m && !out[m[2]!.toUpperCase()]) out[m[2]!.toUpperCase()] = m[1]!;
  }
  return out;
}

/** Every fill in the trade annexure, in the order the note prints them. */
export function parseAnnexure(text: string): ContractNoteFill[] {
  const out: ContractNoteFill[] = [];
  const isins = parseEquityIsins(text);
  let segmentExchange: string | null = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const seg = SEGMENT_LINE.exec(line);
    if (seg) { segmentExchange = seg[1]!.toUpperCase(); continue; }
    const m = ANNEXURE_LINE.exec(line);
    if (!m) continue;
    const desc = m[5]!.trim();
    const parsed = parseContractDescription(desc);
    out.push({
      orderNo: m[1]!,
      orderTime: m[2]!,
      tradeNo: m[3]!,
      tradeTime: m[4]!,
      description: desc,
      symbol: parsed.symbol,
      name: parsed.name,
      expiry: parsed.expiry,
      strike: parsed.strike,
      optionType: parsed.optionType,
      instrumentType: parsed.instrumentType,
      bookName: bookName(parsed),
      isin: parsed.instrumentType === "equity" ? (isins[parsed.symbol] ?? null) : null,
      side: m[6] === "B" ? "buy" : "sell",
      qty: num(m[7]!),
      price: num(m[8]!),
      exchange: parsed.exchange ?? segmentExchange,
    });
  }
  return out;
}

/** `Contract Date : 15-04-2026` / `Trade Date: 15-04-2026` → ISO. */
export function parseNoteDate(text: string): string | null {
  const m = /(?:contract date|trade date)\s*:?\s*(\d{2})-(\d{2})-(\d{4})/i.exec(String(text ?? ""));
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  if (mo > 12 && d <= 12) return null; // genuinely ambiguous — refuse, never guess
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * The note's own charge lines, from the settlement summary. Each line reads
 * `<label> <per-segment figures…> <total> <DR|CR>`; the LAST figure is the
 * across-segment total, and `DR` means the client paid it. Charges are stored
 * as POSITIVE costs, which is how every other reference source states them.
 */
const CHARGE_LINES: { key: string; re: RegExp }[] = [
  { key: "brokerage", re: /taxable value of supply \(brokerage\)/i },
  { key: "exchangeTxn", re: /taxable value of supply \((?:nse|bse) transaction charges\)/i },
  { key: "ipft", re: /taxable value of supply \(ipft contribution\)/i },
  { key: "sebi", re: /taxable value of supply \(sebi fees\)/i },
  { key: "gst", re: /^(?:i|c|s)gst\*?\s*rate/i },
  { key: "stamp", re: /^stamp duty/i },
  { key: "stt", re: /^securities transactions? tax/i },
];

/** Trailing `1,234.56 DR` / `1,234.56 CR` / `0.00` — the total column. */
function lineTotal(line: string): number | null {
  const m = /([\d,]+\.\d{2})\s*(DR|CR)?\s*$/i.exec(line.trim());
  if (!m) return null;
  const v = num(m[1]!);
  return m[2] && m[2].toUpperCase() === "CR" ? -v : v;
}

/** Charge totals stated by the note, summed across its segments. */
export function parseNoteCharges(text: string, date: string | null): ReferenceRow[] {
  const totals = new Map<string, number>();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    for (const { key, re } of CHARGE_LINES) {
      if (!re.test(line)) continue;
      const v = lineTotal(line);
      if (v === null) break;
      totals.set(key, Math.round(((totals.get(key) ?? 0) + v) * 100) / 100);
      break;
    }
  }
  return [...totals].map(([key, amount]) => ({
    scope: "charge" as const,
    key,
    isin: null,
    symbol: null,
    asOf: date,
    figures: { amount },
    note: "stated by the contract note, summed across its segments",
  }));
}

/**
 * Detection — see the header. Both a contract-note name and the broker marker
 * in the raw bytes are required, so this can never claim another broker's PDF.
 */
export function detectDhanContractNote(ctx: ParseContext): number {
  if (!/\.pdf$/i.test(ctx.filename) || !ctx.buffer) return 0;
  // `latin1` keeps every byte one character, so a marker split by nothing but
  // encoding still matches; the scan is a substring test, not a decode.
  const bytes = ctx.buffer.toString("latin1");
  if (!DHAN_MARKER.test(bytes)) return 0;
  if (!NOTE_MARKER.test(ctx.filename) && !NOTE_MARKER.test(bytes)) return 0;
  return /dhan/i.test(ctx.filename) ? 1 : 0.95;
}

export interface ParsedContractNote {
  date: string | null;
  fills: ContractNoteFill[];
  enrich: EnrichmentRow[];
  reference: ReferenceRow[];
  warnings: string[];
}

/** Turn the extracted text into enrichments and charge references. */
export function readContractNoteText(text: string): ParsedContractNote {
  const warnings: string[] = [];
  const date = parseNoteDate(text);
  if (!date) warnings.push("This contract note states no readable contract date, so its fill times cannot be matched to a trading day and nothing will be applied.");
  const fills = parseAnnexure(text);
  if (fills.length === 0) warnings.push("No trade-annexure lines could be read from this note. Nothing is imported; the extracted text is returned so the layout can be checked.");

  // ONE ROW PER FILL, still — the aggregation into positions happens at
  // commit, where the book's own quantities are visible. What changed on
  // 2026-09-04 is WHAT each row is addressed by: the book's own contract name
  // and, for equity, the ISIN and the company name, because the ticker the
  // annexure prints is not what the book stores.
  const enrich: EnrichmentRow[] = date
    ? fills.map((f) => ({
        symbol: f.bookName,
        isin: f.isin,
        name: f.name,
        date,
        side: f.side,
        qty: f.qty,
        time: f.tradeTime,
        instrumentType: f.instrumentType,
        exchange: f.exchange,
        note: f.expiry ? `${f.description} (expiry ${f.expiry})` : f.description,
      }))
    : [];

  return { date, fills, enrich, reference: parseNoteCharges(text, date), warnings };
}

/** The registered import source. Enrichment + charge references; no trades. */
export async function parseDhanContractNote(ctx: ParseContext): Promise<ParsedFile> {
  const base = {
    sourceId: "dhan-contract-note",
    broker: "dhan" as const,
    format: "contract-note",
    trades: [],
  };
  if (!ctx.buffer) return { ...base, warnings: ["No file buffer."] };

  let text = "";
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(ctx.buffer) });
    const res = await parser.getText();
    text = res.text ?? "";
    await parser.destroy();
  } catch (e) {
    return { ...base, warnings: [`Failed to read the contract note PDF: ${(e as Error).message}`] };
  }

  if (!DHAN_MARKER.test(text)) {
    return {
      ...base,
      rawText: text,
      warnings: ["Nothing in this PDF's text names Dhan, so it is not read as a Dhan contract note. The extracted text is returned for a manual check."],
    };
  }

  const parsed = readContractNoteText(text);
  const times = parsed.fills.filter((f) => f.tradeTime).length;
  return {
    ...base,
    sourceRows: parsed.fills.length,
    enrich: parsed.enrich,
    reference: parsed.reference,
    warnings: [
      `This is a Dhan contract note${parsed.date ? ` for ${parsed.date}` : ""} — ${parsed.fills.length} fill${parsed.fills.length === 1 ? "" : "s"}, ${times} with a trade time. A contract note NEVER creates trades: the transaction report is the book, and importing a note beside it would double-book the same day. These fills are applied to trades the book already holds — fill time, instrument type and exchange — and anything that matches nothing is reported, not stored.`,
      ...parsed.warnings,
    ],
  };
}
