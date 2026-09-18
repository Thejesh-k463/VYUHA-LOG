#!/usr/bin/env node
/**
 * Redact ONE real broker contract note (PDF) into a committable TEXT fixture.
 *
 *   node scripts/fixtures/redact-contract-note.mjs <in.pdf> <out.txt>
 *
 * `redact-broker-export.mjs` reads workbooks and CSVs; a contract note is a
 * signed PDF whose text lives in compressed streams, and a real note is
 * nothing but identity plus numbers. So the committed fixture is the note's
 * TEXT, exactly as the repo's own `pdf-parse` renders it for the parsers,
 * with identity tokenised — every line kept, every figure untouched:
 *
 *   1. extract the text with the repo's pdf-parse (the parse path's own reader);
 *   2. discover identity from its LABELS — `Name`, `Dear …,`, `Mobile Number`,
 *      `PAN` / `PAN OF CLIENT`, the address block (Groww: `Address` … up to
 *      `State Code`; Upstox: the lines between `Trade Date :` and `PAN OF
 *      CLIENT`) — plus id-looking tokens in the INPUT filename (brokers put
 *      the client code there) and every word of every discovered name;
 *   3. replace them with the fixed tokens the workbook redactor uses; every
 *      PAN-shaped and e-mail value anywhere (the broker's own included) too,
 *      and the contract-note number's digits wherever the number recurs
 *      (Upstox repeats it as the GST invoice number — found 2026-09-18);
 *   4. re-scan the OUTPUT and refuse (exit 1, output deleted) if any
 *      discovered value survives.
 *
 * Parser equivalence is asserted by the suite, not here: the golden-books pins
 * run on the redacted text, and the private leg re-reads the real PDF and
 * requires the identical parse (skipped where the PDF is absent).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(ROOT, "package.json"));

const TOKENS = { name: "REDACTED NAME", pan: "AAAAA0000A", email: "user@example.com", mobile: "9999999999", client: "ACC000000", address: "REDACTED ADDRESS" };
/** No word boundary: a GSTIN (`27AAGCE3230K1ZP`) carries its holder's PAN inside it. */
const PAN_RE = /[A-Z]{5}[0-9]{4}[A-Z]/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word, whitespace-flexible, case-insensitive: `Road` must never hit `BROADCAST`. */
const valueRe = (v) => new RegExp(`\\b${v.trim().split(/\s+/).map(esc).join("\\s+")}\\b`, "gi");

/** Same rule as redact-broker-export.mjs: a client code, never a yyyymmdd. */
function filenameIds(file) {
  return path.basename(file, path.extname(file)).split(/[^A-Za-z0-9]+/).filter((t) => {
    if (t.length < 6 || t.length > 14) return false;
    const letters = /[A-Za-z]/.test(t), digits = /\d/.test(t);
    return (letters && digits) || (digits && !letters && t.length >= 9);
  });
}

async function extract(file) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(file)) });
  try { return (await parser.getText()).text ?? ""; } finally { await parser.destroy(); }
}

function redact(text, inFile) {
  const lines = text.split("\n");
  const found = new Map(); // value -> token kind
  const addName = (v) => {
    const s = v.replace(/[,.]+$/, "").trim();
    if (!s) return;
    found.set(s, "name");
    for (const w of s.split(/[\s,/]+/)) if (w.length >= 4 && /^[A-Za-z]+$/.test(w)) found.set(w, "name");
  };
  for (const id of filenameIds(inFile)) found.set(id, "client");

  let addressFrom = -1, addressTo = -1;
  lines.forEach((raw, i) => {
    const l = raw.trim();
    let m;
    if ((m = /Unique Client Code\s+(\S+)\s+Name\s+(.+)$/.exec(l))) { found.set(m[1], "client"); addName(m[2]); }
    if ((m = /^Dear\s+(.+?),?$/.exec(l))) addName(m[1]);
    if ((m = /Mobile Number\s+(\d{10})/.exec(l))) found.set(m[1], "mobile");
    if ((m = /(?:UCC OF CLIENT|Trading Code)\s*:\s*(\S+)/i.exec(l))) found.set(m[1], "client");
    if (/\bAddress\b/.test(l) && addressFrom < 0) addressFrom = i;
    if (/^State Code\b/.test(l) && addressFrom >= 0 && addressTo < 0) addressTo = i - 1;
    // Upstox: name, then the address, between the trade date and the PAN line.
    if (/^Trade Date\s*:/.test(l) && /^PAN OF CLIENT/.test((lines.slice(i + 1).find((x) => /^PAN OF CLIENT/.test(x.trim())) ?? "").trim())) {
      const pan = lines.findIndex((x, k) => k > i && /^PAN OF CLIENT/.test(x.trim()));
      if (pan > i + 1 && pan - i <= 8) {
        addName(lines[i + 1].trim());
        addressFrom = i + 2;
        addressTo = pan - 1;
      }
    }
  });

  // The contract-note number is the document's own reference, and a note
  // repeats it: Upstox prints it again as the GST invoice number
  // (`NSE/<number>`), and puts it in the filename. Every digit run of 6+ in
  // the stated number is zeroed wherever it stands, not just on its label line.
  const docNumbers = new Set();
  for (const raw of lines) {
    const m = /Contract Note No\.?\s*:?\s*(\S+)/i.exec(raw);
    if (m) for (const d of m[1].match(/\d{6,}/g) ?? []) docNumbers.add(d);
  }
  const out = lines.map((raw, i) => {
    let l = raw;
    if (addressFrom >= 0 && i >= addressFrom && i <= addressTo) {
      // Keep what precedes the word "Address" on its line (Groww prints the
      // state of supply there); everything after it is the client's address.
      const at = l.indexOf("Address");
      for (const w of l.split(/[\s,/()-]+/)) if (w.length >= 4 && /^[A-Za-z]+$/.test(w) && !/^(address|pradesh|state|code)$/i.test(w)) found.set(w, "address");
      l = at >= 0 && i === addressFrom ? `${l.slice(0, at)}Address ${TOKENS.address}` : TOKENS.address;
    }
    l = l.replace(EMAIL_RE, TOKENS.email).replace(PAN_RE, TOKENS.pan);
    l = l.replace(/(Contract Note No\.?\s*:?\s*)(\S+)/i, (_, p, v) => p + v.replace(/\d/g, "0"));
    for (const d of docNumbers) l = l.replace(new RegExp(`(?<!\\d)${d}(?!\\d)`, "g"), "0".repeat(d.length));
    return l;
  });
  let text2 = out.join("\n");
  // Longest first, so a full name is replaced before its words.
  for (const [v, kind] of [...found].sort((a, b) => b[0].length - a[0].length)) text2 = text2.replace(valueRe(v), TOKENS[kind]);
  return { text: text2, found, docNumbers };
}

async function main() {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) { console.error("usage: node scripts/fixtures/redact-contract-note.mjs <in.pdf> <out.txt>"); process.exit(2); }
  const text = await extract(inFile);
  const { text: red, found, docNumbers } = redact(text, inFile);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, red, "utf8");
  const hits = [...found.keys()].filter((v) => valueRe(v).test(red))
    .concat([...docNumbers].filter((d) => new RegExp(`(?<!\\d)${d}(?!\\d)`).test(red)));
  const pans = (red.match(PAN_RE) ?? []).filter((p) => p !== TOKENS.pan);
  const emails = (red.match(EMAIL_RE) ?? []).filter((e) => e !== TOKENS.email);
  if (hits.length || pans.length || emails.length) {
    fs.rmSync(outFile, { force: true });
    console.error(`LEAK — output deleted: ${hits.length} discovered value(s), ${pans.length} PAN(s), ${emails.length} e-mail(s) survive`);
    process.exit(1);
  }
  const inLines = text.split("\n").length, outLines = red.split("\n").length;
  if (inLines !== outLines) { fs.rmSync(outFile, { force: true }); console.error(`line count changed ${inLines} -> ${outLines}`); process.exit(1); }
  console.log(`${path.basename(inFile)} -> ${path.relative(ROOT, outFile)}: ${outLines} lines kept, ${found.size} identity value(s) tokenised, leak scan 0`);
}

main().catch((e) => { console.error(`redact-contract-note: ${e.message}`); process.exit(1); });
