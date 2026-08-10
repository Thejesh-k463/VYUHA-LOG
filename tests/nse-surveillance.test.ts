import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseNseSurveillance, type NseSurveillanceResult } from "@/lib/import/nse-surveillance";

// REAL files, captured from NSE on 2026-08-10 (trimmed to representative rows
// for REG_IND) — see docs/DECISIONS.md for the download URLs.
const fx = (n: string) => readFileSync(path.join(process.cwd(), "tests", "fixtures", n), "utf8");
const BAN = fx("fo_secban.csv");
const REG = fx("REG_IND070826.csv");

const ok = (r: ReturnType<typeof parseNseSurveillance>): NseSurveillanceResult => {
  if ("refused" in r) throw new Error(`unexpectedly refused: ${r.refused}`);
  return r;
};

describe("fo_secban.csv — the F&O ban list", () => {
  it("claims the file, reads every symbol, and derives the date from the header", () => {
    const r = ok(parseNseSurveillance(BAN, "fo_secban.csv"));
    expect(r.kind).toBe("fo_ban");
    expect(r.categories).toEqual(["fno_ban"]);
    expect(r.asOf).toBe("2026-08-10"); // "10-AUG-2026" in the real header
    expect(r.rows.map((x) => x.symbol)).toEqual(["BANDHANBNK", "KAYNES", "LICI"]);
    expect(r.rows.every((x) => x.category === "fno_ban")).toBe(true);
  });

  it("the leading ordinal is presentation, not data", () => {
    const r = ok(parseNseSurveillance("Securities in Ban For Trade Date 07-JUL-2025:\n1,RBLBANK\n"));
    expect(r.rows).toEqual([{ symbol: "RBLBANK", category: "fno_ban", stage: null, note: null }]);
    expect(r.asOf).toBe("2025-07-07");
  });

  it("an empty ban day parses with a warning, not an error", () => {
    const r = ok(parseNseSurveillance("Securities in Ban For Trade Date 10-AUG-2026:\n"));
    expect(r.count).toBe(0);
    expect(r.warnings[0]).toMatch(/empty ban day|truncated/i);
  });
});

describe("REG_IND — the consolidated surveillance indicator file", () => {
  it("claims the file and assigns each category from its own column", () => {
    const r = ok(parseNseSurveillance(REG, "REG_IND070826.csv"));
    expect(r.kind).toBe("reg_ind");
    expect(r.categories).toEqual(["gsm", "asm", "esm"]);
    const by = (cat: string) => r.rows.filter((x) => x.category === cat).map((x) => x.symbol);
    // The fixture's real rows: 4 GSM (two at Stage 0), 4 ASM, 2 ESM, 2 clean.
    expect(by("gsm")).toEqual(["AGSTRA", "ANKITMETAL", "ANSALAPI", "BLUECHIP"]);
    expect(by("asm")).toEqual(["21STCENMGM", "ACUTAAS", "63MOONS", "A2ZINFRA"]);
    expect(by("esm")).toEqual(["AAREYDRUGS", "AARTECH"]);
    // Clean securities produce NO rows — 100 is the "not under" sentinel.
    expect(r.rows.some((x) => x.symbol === "20MICRONS" || x.symbol === "360ONE")).toBe(false);
  });

  it("GSM Stage 0 is a REAL stage — the sentinel is 100, not 0", () => {
    const r = ok(parseNseSurveillance(REG, "REG_IND070826.csv"));
    const agstra = r.rows.find((x) => x.symbol === "AGSTRA");
    expect(agstra).toEqual({ symbol: "AGSTRA", category: "gsm", stage: "Stage 0", note: null });
  });

  it("names the ASM flavour in the stage text", () => {
    const r = ok(parseNseSurveillance(REG, "REG_IND070826.csv"));
    expect(r.rows.find((x) => x.symbol === "21STCENMGM")?.stage).toBe("Long-term Stage 1");
    expect(r.rows.find((x) => x.symbol === "63MOONS")?.stage).toBe("Short-term Stage 1");
  });

  it("a scrip under BOTH ASM flavours gets one row naming both", () => {
    // Synthetic input to a pure function: no scrip in the captured file is
    // under both, but the file format allows it and the parser must not
    // produce two competing asm rows.
    const header = readFileSync(path.join(process.cwd(), "tests", "fixtures", "REG_IND070826.csv"), "utf8").split("\n")[0];
    const cells = header.split(",").map(() => "100");
    cells[1] = "BOTHWAYS"; // Symbol column
    const h = header.split(",");
    cells[h.findIndex((x) => x.startsWith("Long_Term_Additional"))] = "1";
    cells[h.findIndex((x) => x.startsWith("Short_Term_Additional"))] = "2";
    const r = ok(parseNseSurveillance(`${header}\n${cells.join(",")}`, "REG_IND010126.csv"));
    const rows = r.rows.filter((x) => x.symbol === "BOTHWAYS");
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe("Long-term Stage 1 · Short-term Stage 2");
  });

  it("a TRUNCATED first data row neither refuses the file nor hides the ESM column", () => {
    // Papa gives a short row only the keys its cells reach, so fingerprinting
    // on Object.keys(data[0]) either refused this legitimate file or —
    // depending on where the row cut — dropped esmKey and silently wiped the
    // ESM category while reporting success (2026-08-10 audit, lane C). The
    // header line is the honest column list; meta.fields carries it.
    const lines = REG.split(/\r?\n/).filter(Boolean);
    const truncatedFirst = lines[1].split(",").slice(0, 2).join(","); // Symbol + one cell
    const doctored = [lines[0], truncatedFirst, ...lines.slice(2)].join("\n");
    const r = ok(parseNseSurveillance(doctored, "REG_IND070826.csv"));
    expect(r.kind).toBe("reg_ind");
    // ESM rows from LATER, intact rows still parse.
    expect(r.rows.filter((x) => x.category === "esm").map((x) => x.symbol)).toEqual(["AAREYDRUGS", "AARTECH"]);
  });

  it("derives asOf from the FILENAME, and returns null when renamed", () => {
    expect(ok(parseNseSurveillance(REG, "REG_IND070826.csv")).asOf).toBe("2026-08-07");
    expect(ok(parseNseSurveillance(REG, "downloaded (3).csv")).asOf).toBeNull();
    expect(ok(parseNseSurveillance(REG)).asOf).toBeNull();
  });
});

describe("detection refuses what it cannot fingerprint", () => {
  it("a broker tradebook with a Symbol column is NOT claimed", () => {
    const tradebook = "Symbol,Side,Qty,Price\nRELIANCE,BUY,10,2450\nTCS,SELL,5,4100\n";
    const r = parseNseSurveillance(tradebook, "tradebook.csv");
    expect("refused" in r).toBe(true);
  });

  it("the refusal names what it saw, so the user learns why", () => {
    const r = parseNseSurveillance("A,B,C\n1,2,3\n", "mystery.csv");
    if (!("refused" in r)) throw new Error("should have refused");
    expect(r.refused).toContain("fo_secban");
    expect(r.refused).toContain("REG_IND");
    expect(r.refused).toContain("A,B,C");
  });

  it("an empty file is refused outright", () => {
    for (const t of ["", "   \n  "]) {
      const r = parseNseSurveillance(t);
      if (!("refused" in r)) throw new Error("should have refused");
    }
  });
});
