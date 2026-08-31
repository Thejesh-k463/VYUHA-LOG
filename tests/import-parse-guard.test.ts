import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import {
  guardReadable,
  unreadableError,
  ERROR_ENCRYPTED,
  ERROR_UNREADABLE,
} from "@/lib/import/parse-guard";

const fixture = (f: string) => fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", f));

/**
 * A CFB container with an EncryptedPackage entry — the shape of every
 * password-protected xlsx. SheetJS refuses it with exactly
 * "File is password-protected", which is what the guard classifies on.
 */
function encryptedWorkbookBytes(): Buffer {
  const cfb = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(cfb, "/EncryptedPackage", [1, 2, 3, 4]);
  XLSX.CFB.utils.cfb_add(cfb, "/EncryptionInfo", [4, 0, 4, 0]);
  return Buffer.from(XLSX.CFB.write(cfb, { type: "buffer" }) as Buffer);
}

describe("import parse guard — refuses bytes the pipeline would throw on", () => {
  it("refuses an image with 'not a spreadsheet' copy, not a raw XLSX error", () => {
    const res = guardReadable("screenshot.png", fixture("pixel-a.png"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(ERROR_UNREADABLE);
      // The copy must be actionable, never a parser internals message.
      expect(res.error).toMatch(/not a spreadsheet or CSV/i);
    }
  });

  it("refuses a password-protected workbook and says to export an unprotected copy", () => {
    const res = guardReadable("tradebook.xlsx", encryptedWorkbookBytes());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(ERROR_ENCRYPTED);
      expect(res.error).toMatch(/password-protected/i);
      expect(res.error).toMatch(/unprotected copy/i);
    }
  });
});

describe("import parse guard — passes everything the pipeline can handle", () => {
  it("passes a real broker XLSX", () => {
    expect(guardReadable("groww-pnl.xlsx", fixture("groww-pnl.xlsx"))).toEqual({ ok: true });
  });

  it("passes an in-memory workbook", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], ["1", "2"]]), "Sheet1");
    const bytes = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    expect(guardReadable("book.xlsx", bytes)).toEqual({ ok: true });
  });

  it("passes junk binary XLSX can open — the generic mapper's 'no table found' question must survive", () => {
    // XLSX.read parses arbitrary binary as a garbage single sheet without
    // throwing; refusing it here would replace the column-mapper's honest
    // question with a refusal. Only THROWING bytes are the guard's business.
    const junk = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x99, 0x88, 0x77, 0x66, 0x55]);
    expect(guardReadable("mystery.xlsx", junk)).toEqual({ ok: true });
  });

  it("never probes CSVs or PDFs with XLSX — they take the text and pdf-parse paths", () => {
    // These bytes would fail the workbook probe; the extension routes past it.
    expect(guardReadable("tradebook.csv", fixture("pixel-a.png"))).toEqual({ ok: true });
    expect(guardReadable("contract-note.pdf", fixture("pixel-a.png"))).toEqual({ ok: true });
  });
});

describe("unreadableError — classifies a throw into the two error classes", () => {
  it("maps SheetJS's encrypted-file message to the password copy", () => {
    expect(unreadableError(new Error("File is password-protected"))).toBe(ERROR_ENCRYPTED);
  });

  it("maps every other throw (including non-Errors) to the unreadable copy", () => {
    expect(unreadableError(new Error("PNG Image File is not a spreadsheet"))).toBe(ERROR_UNREADABLE);
    expect(unreadableError("boom")).toBe(ERROR_UNREADABLE);
  });
});
