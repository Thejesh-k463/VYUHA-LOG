import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { guardReadable, ERROR_ENCRYPTED, ERROR_UNREADABLE } from "@/lib/import/parse-guard";

/**
 * Magic-byte pre-check: a file NAMED .xlsx/.xls must LOOK like one before its
 * bytes reach `XLSX.read`.
 *
 * The pair that proves the check is doing the deciding (and not SheetJS) is
 * JUNK / JUNK_NAMED_XLSX below: the exact same ten bytes. SheetJS opens them
 * happily as a garbage single sheet — so under a name that claims no format
 * they still pass through to the generic column-mapper's "no table found"
 * question, which is the module's stated design rule. Under a name that claims
 * to be a workbook, the signature disagrees with the name and the file is
 * refused before the parser ever sees it.
 */

const fixture = (f: string) => fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", f));

/** Deterministic non-signature binary containing NUL — not zip, not CFB, not text. */
const JUNK = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x99, 0x88, 0x77, 0x66, 0x55]);

function encryptedWorkbookBytes(): Buffer {
  const cfb = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(cfb, "/EncryptedPackage", [1, 2, 3, 4]);
  XLSX.CFB.utils.cfb_add(cfb, "/EncryptionInfo", [4, 0, 4, 0]);
  return Buffer.from(XLSX.CFB.write(cfb, { type: "buffer" }) as Buffer);
}

describe("magic bytes — a spreadsheet name must be backed by spreadsheet bytes", () => {
  it("refuses binary named .xlsx that SheetJS would otherwise open as garbage", () => {
    // Same bytes, no format claim in the name → still allowed (design rule).
    expect(guardReadable("mystery.dat", JUNK)).toEqual({ ok: true });
    // Same bytes, named as a workbook → refused on the signature alone.
    const res = guardReadable("tradebook.xlsx", JUNK);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(ERROR_UNREADABLE);
  });

  it("refuses an image renamed .xlsx", () => {
    const res = guardReadable("statement.xlsx", fixture("pixel-a.png"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not a spreadsheet or CSV/i);
  });

  it("refuses binary named .xls too", () => {
    expect(guardReadable("tradebook.xls", JUNK).ok).toBe(false);
  });

  it("passes a real broker XLSX — the zip signature is the common case", () => {
    const bytes = fixture("groww-pnl.xlsx");
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(guardReadable("groww-pnl.xlsx", bytes)).toEqual({ ok: true });
  });

  it("passes a CFB workbook through to XLSX.read — the password copy still fires", () => {
    // CFB is a legitimate .xls container, so the signature check must NOT
    // swallow it: the encrypted-workbook message comes from XLSX.read.
    const res = guardReadable("old-tradebook.xls", encryptedWorkbookBytes());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(ERROR_ENCRYPTED);
  });

  it("passes HTML served under a .xls name — several brokers do exactly this", () => {
    const html = Buffer.from(
      "<html><body><table><tr><td>Symbol</td><td>Qty</td></tr></table></body></html>",
      "utf8",
    );
    expect(guardReadable("tradebook.xls", html)).toEqual({ ok: true });
  });

  it("passes a CSV — the extension short-circuits before any signature test", () => {
    expect(guardReadable("tradebook.csv", fixture("zerodha-tradebook.csv"))).toEqual({ ok: true });
    // Even bytes that are not text at all: CSVs are decoded, never probed.
    expect(guardReadable("tradebook.csv", JUNK)).toEqual({ ok: true });
  });
});
