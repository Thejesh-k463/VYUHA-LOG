import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { NOT_COMPUTED } from "@/lib/atlas/not-computed";
import { CATCHUP_MAX_FILES } from "@/lib/atlas/catchup-plan";
import { OPENALGO_MIN_VERSION } from "@/lib/import/api/openalgo";

/**
 * v4.6.0 release audit, fix wave (Builder B) — the copy findings that have no
 * natural home in an existing test: DA-5, CL-2/DC-2, README:896, DC-5, DC-4 and
 * RC-2. Each pin reads the SHIPPED text (the doc, the generator, the generated
 * .docx) and states the fact it must carry; each went red against the text the
 * audit found.
 */

const ROOT = path.resolve(__dirname, "..");
// CRLF-normalised: the Windows CI runner checks out with CRLF, and a block terminator such as
// "\n>\n" then never matches — the slice runs to the end of the file and a pin reads the wrong text.
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** The text of one part of a zip (the .docx), read with no dependency: local headers, stored or deflated. */
function zipPart(file: string, name: string): string {
  const buf = fs.readFileSync(file);
  let at = 0;
  while (at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const partName = buf.subarray(at + 30, at + 30 + nameLen).toString("utf8");
    const start = at + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + size);
    if (partName === name) return (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    at = start + size;
  }
  throw new Error(`${name} not found in ${file}`);
}

describe("v4.6.0 audit copy pins", () => {
  it("DA-5: the Atlas does not claim a bhavcopy carries minutes", () => {
    const gaps = NOT_COMPUTED.find((f) => /opening gaps/i.test(f.family))!;
    expect(gaps.note).not.toMatch(/first minutes are in the file/i);
    expect(gaps.note).toMatch(/open, high, low and close, but no minutes/);
  });

  it("CL-2/DC-2: the v4.0.0 release notes describe v4.0.0, not W2/W5 features", () => {
    // README.md's v4.0.0 quote and the client README's v4.0.0 Atlas row are
    // HISTORY; W5 rewrote them with the AMFI band and the median cohort.
    const readme = read("README.md");
    const start = readme.indexOf("> **v4.0.0 — the Live Desk.**");
    expect(start).toBeGreaterThan(0);
    const block = readme.slice(start, readme.indexOf("\n>\n", start));
    for (const later of [/AMFI/, /RSI-14/, /relative strength/i, /median/i, /industry cohort/i]) expect(block).not.toMatch(later);
    expect(block).toContain("the same window by sector and by NSE cap");
    const client = read("docs/client/README.md");
    const row = client.split("\n").find((l) => l.startsWith("| **Market Atlas — the market your book is sitting in**"))!;
    expect(row).toBeDefined();
    expect(row).not.toMatch(/median return|industry cohort/);
    expect(row).toContain("equal-weighted return of their sector cohort");
  });

  it("README:896: the auto-MTM line states the per-open catch-up, not only 'once per trading day'", () => {
    expect(CATCHUP_MAX_FILES).toBe(10);
    const line = read("README.md").split("\n").find((l) => l.startsWith("- **Opt-in EOD auto-MTM**"))!;
    expect(line).toContain("catch up to ten missed sessions");
  });

  it("DC-5: BROKER_FORMATS lists no built parser as 'still not built'", () => {
    const doc = read("docs/BROKER_FORMATS.md");
    const para = doc.split(/\n\s*\n/).filter((p) => /still not built/i.test(p));
    for (const p of para) expect(p).not.toMatch(/Zerodha ledger|Groww ledger|contract-note parsers/);
    expect(doc).toContain("(`zerodha-ledger`, Console Funds statement)");
  });

  it("DC-4: the OpenAlgo Word guide states the minimum version — in its generator AND in the generated file", () => {
    const needs = `Vyuha needs OpenAlgo ${OPENALGO_MIN_VERSION} or later`;
    expect(read("scripts/build-openalgo-docx.mjs")).toContain(needs);
    const xml = zipPart(path.join(ROOT, "docs/client/OPENALGO_SETUP_GUIDE.docx"), "word/document.xml");
    expect(xml).toContain(needs);
    expect(xml).toContain("OpenAlgo version and upgrading");
    expect(xml).toContain(`older than ${OPENALGO_MIN_VERSION}`);
  });

  it("Broker Truth's feed list is exactly the parsers that emit reference rows (Nuvama included)", async () => {
    // Two sources: the parser SOURCE (does it return a `reference` array, which
    // commit.ts persists to broker_reference) vs the declared RECONCILE_FEEDS.
    // A parser file is keyed by its registry sourceId (file name = sourceId).
    const { IMPORT_SOURCES } = await import("@/lib/import/registry-meta");
    const { RECONCILE_FEEDS } = await import("@/lib/analytics/reconcile");
    const ids = new Set(IMPORT_SOURCES.map((s) => s.sourceId));
    const dir = path.join(ROOT, "lib/import/parsers");
    const emitting = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && ids.has(f.slice(0, -3)))
      .filter((f) => {
        const src = fs.readFileSync(path.join(dir, f), "utf8");
        return /\breference\.push\(/.test(src) || /^\s+reference: (?!ReferenceRow)/m.test(src) || /return \{[^\n]*\breference\b/.test(src);
      })
      .map((f) => f.slice(0, -3))
      .sort();
    expect(emitting).toContain("nuvama-pnl-report");
    expect(RECONCILE_FEEDS.map((f) => f.sourceId).sort()).toEqual(emitting);
  });

  it("RC-2: AGENTS.md does not claim the calendar test reaches the build's anchor refusal", () => {
    const agents = read("AGENTS.md").replace(/\r\n/g, "\n");
    expect(agents).toContain("the anchor refusal is the BUILD's own");
    expect(agents).toContain("no test reaches it");
  });
});
