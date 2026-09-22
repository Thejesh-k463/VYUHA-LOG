import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { etfClass, etfRateSegment, ETF_LIST_AS_OF, ETF_LIST_COUNT, ETF_LIST_SHA256, ETF_LIST_URL, ETF_RATE_SEGMENTS } from "@/lib/engine/etf-class";
import raw from "@/lib/data/etf-list.json";

/**
 * v4.5.0 wave 3a — the bundled NSE ETF list and the pure classifier over it
 * (owner ruling T4; wave3-tax-designs.md T1).
 *
 * THE RULE BEING PINNED: an ETF's class comes from NSE's OWN published
 * `ETF Underlying` column and from nothing else — never the fund-house name,
 * never `Underlying Asset`, never the ticker's shape. EQUITY is
 * equity-oriented; every other published value is `other`; a value nobody has
 * seen FAILS THE BUILD rather than being guessed onto one side of the line
 * (invariant 6). The class moves a user's STT (ruling R90) and, from wave 3b,
 * their tax head, so a wrong one is money.
 *
 * `asOf` is the list's OWN date — the HTTP Last-Modified of the download, NOT
 * the day we happened to run the script (standing rule Q50). The two are pinned
 * apart below precisely because they look the same in a diff.
 *
 * An EMPTY or ABSENT snapshot must answer null everywhere and never throw: the
 * `isin-bundle-coverage` precedent, and the reason `ratesForTrade`'s overlay can
 * fall back silently instead of aborting an import over a classification.
 */

type Row = { symbol: string; underlying: string; kind: string; asset?: string };
type Snapshot = {
  asOf: string;
  capturedAt: string;
  source: string;
  provenance: { url: string; sha256: string; rows: number };
  counts: { byIsin: number; bySymbol: number; kinds: Record<string, number>; underlying: Record<string, number> };
  byIsin: Record<string, Row>;
  bySymbol: Record<string, string>;
};
const snap = raw as unknown as Snapshot;

/** The real vendor input lives OUTSIDE the repo, with the other build inputs. */
const SRC = "T:/Thejesh/CLAUDE-CODE/VYUHA/LIVE-DESK-RESEARCH/_data/etf-list-2026-09-11";
const haveSrc = fs.existsSync(path.join(SRC, "eq_etfseclist.csv"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-etf-build-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SCRIPT = path.resolve(__dirname, "../scripts/build-etf-list.mjs");
/** Run the build script; returns its exit code and combined output, never throwing. */
function runBuild(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("the bundled ETF snapshot (lib/data/etf-list.json)", () => {
  it("carries 350 ISINs and 350 symbols, 260 equity-oriented and 90 other, and its own counts agree with its own maps", () => {
    expect(Object.keys(snap.byIsin)).toHaveLength(350);
    expect(Object.keys(snap.bySymbol)).toHaveLength(350);
    expect(snap.counts.byIsin).toBe(350);
    expect(snap.counts.bySymbol).toBe(350);
    expect(snap.counts.kinds).toEqual({ "equity-oriented": 260, other: 90 });
    // The counts block is emitted by the builder; re-derive it from the maps so
    // the file cannot agree with itself.
    const kinds: Record<string, number> = {};
    for (const r of Object.values(snap.byIsin)) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    expect(kinds).toEqual({ "equity-oriented": 260, other: 90 });
    expect(ETF_LIST_COUNT).toBe(350);
  });

  it("is dated by NSE's Last-Modified (2026-09-07), NOT by the build date, and states its source url and sha256", () => {
    expect(snap.asOf).toBe("2026-09-07");
    expect(ETF_LIST_AS_OF).toBe("2026-09-07");
    // Q50: `capturedAt` is the build date. If they were ever made equal the
    // snapshot would be dated to when a script happened to run.
    expect(snap.capturedAt).not.toBe(snap.asOf);
    expect(snap.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ETF_LIST_SHA256).toBe("f246cdf059b005db06e71d19c6288b135a6d19ba49e4dee09347c0094a45d420");
    expect(snap.provenance.sha256).toBe(ETF_LIST_SHA256);
    expect(snap.provenance.rows).toBe(350);
    expect(ETF_LIST_URL).toBe("https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv");
  });

  it.skipIf(!haveSrc)("that asOf IS the download's Last-Modified header, read from the file saved beside the CSV", () => {
    const hdr = fs.readFileSync(path.join(SRC, "eq_etfseclist.csv.response-headers.txt"), "utf8");
    const m = hdr.match(/^last-modified:\s*(.+)$/im);
    expect(m, "no Last-Modified in the saved response headers").not.toBeNull();
    expect(new Date(String(m?.[1]).trim()).toISOString().slice(0, 10)).toBe(snap.asOf);
  });

  it("every key is an INF-prefixed fund ISIN, every bySymbol entry points at a real byIsin row, and no symbol is blank", () => {
    for (const [isin, row] of Object.entries(snap.byIsin)) {
      expect(isin, isin).toMatch(/^INF[A-Z0-9]{9}$/);
      expect(row.symbol, isin).toMatch(/^[A-Z0-9&_-]+$/);
      expect(row.underlying, isin).not.toBe("");
    }
    for (const [symbol, isin] of Object.entries(snap.bySymbol)) {
      expect(snap.byIsin[isin], symbol).toBeDefined();
      expect(snap.byIsin[isin].symbol, symbol).toBe(symbol);
    }
  });

  it("KIND DERIVES FROM `underlying` ALONE, over every row in the file: EQUITY → equity-oriented, everything else → other", () => {
    const seen = new Set<string>();
    for (const [isin, row] of Object.entries(snap.byIsin)) {
      seen.add(row.underlying);
      expect(row.kind, `${isin} ${row.symbol} ${row.underlying}`).toBe(
        row.underlying.trim().toUpperCase() === "EQUITY" ? "equity-oriented" : "other",
      );
    }
    // The five values NSE publishes today. A sixth is a build failure, not a row.
    expect([...seen].sort()).toEqual(["COMMODITY", "DEBT", "EQUITY", "GLOBAL INDICES", "Hybrid"]);
    expect(snap.counts.underlying).toEqual({ EQUITY: 260, DEBT: 38, COMMODITY: 45, "GLOBAL INDICES": 6, Hybrid: 1 });
  });
});

describe("etfClass — the resolution chain", () => {
  it("resolves by ISIN: NIFTYBEES is equity-oriented, GOLDBEES and LIQUIDBEES are not, and the RAW underlying is carried through", () => {
    expect(etfClass({ isin: "INF204KB14I2" })).toEqual({ kind: "equity-oriented", underlying: "EQUITY", isin: "INF204KB14I2", symbol: "NIFTYBEES" });
    expect(etfClass({ isin: "INF204KB17I5" })).toEqual({ kind: "other", underlying: "COMMODITY", isin: "INF204KB17I5", symbol: "GOLDBEES" });
    expect(etfClass({ isin: "INF732E01037" })).toEqual({ kind: "other", underlying: "DEBT", isin: "INF732E01037", symbol: "LIQUIDBEES" });
    // The Hybrid row: `other` for STT, and Data Quality names it separately.
    expect(etfClass({ isin: "INF769K01RJ5" })?.underlying).toBe("Hybrid");
  });

  it("resolves by EXACT symbol when no ISIN is stated, case- and space-insensitively, but never by prefix or substring", () => {
    expect(etfClass({ symbol: "GOLDBEES" })?.kind).toBe("other");
    expect(etfClass({ symbol: " goldbees " })?.kind).toBe("other");
    expect(etfClass({ symbol: "NIFTYBEES" })?.isin).toBe("INF204KB14I2");
    // A near-miss is NOT the ETF: the list answers only what it carries.
    expect(etfClass({ symbol: "GOLDBEE" })).toBeNull();
    expect(etfClass({ symbol: "GOLDBEESX" })).toBeNull();
    expect(etfClass({ symbol: "NIFTY" })).toBeNull();
  });

  it("an unknown or absent key is null — never a guess, and never a throw", () => {
    expect(etfClass({})).toBeNull();
    expect(etfClass({ isin: null, symbol: null })).toBeNull();
    expect(etfClass({ isin: "", symbol: "" })).toBeNull();
    expect(etfClass({ isin: "INE002A01018", symbol: "RELIANCE" })).toBeNull(); // an ordinary equity share
    expect(etfClass({ isin: "INF000000000" })).toBeNull(); // an INF ISIN the list does not carry
  });

  it("a stated ISIN the list does not carry falls back to the symbol, which is how a ticker-only tradebook still resolves", () => {
    expect(etfClass({ isin: "INF999Z01ZZ9", symbol: "NIFTYBEES" })?.kind).toBe("equity-oriented");
    // …and an ISIN the list DOES carry wins over a contradicting symbol: the ISIN is the identity.
    expect(etfClass({ isin: "INF204KB17I5", symbol: "NIFTYBEES" })?.symbol).toBe("GOLDBEES");
  });

  it("etfRateSegment maps the two kinds onto the two rate-row keys, and there are exactly two", () => {
    expect(etfRateSegment("equity-oriented")).toBe("etf_equity");
    expect(etfRateSegment("other")).toBe("etf_other");
    expect([...ETF_RATE_SEGMENTS]).toEqual(["etf_equity", "etf_other"]);
  });
});

describe("an EMPTY or damaged snapshot degrades to silence (the isin-bundle-coverage precedent)", () => {
  /** Re-import the module over a mocked JSON so the bundled file is not touched. */
  async function withSnapshot(json: unknown) {
    vi.resetModules();
    vi.doMock("@/lib/data/etf-list.json", () => ({ default: json }));
    const mod = await import("@/lib/engine/etf-class");
    return mod;
  }
  afterAll(() => {
    vi.doUnmock("@/lib/data/etf-list.json");
    vi.resetModules();
  });

  it("an empty object answers null for everything and throws nothing; the exported facts degrade to '' and 0", async () => {
    const mod = await withSnapshot({});
    expect(mod.etfClass({ isin: "INF204KB14I2" })).toBeNull();
    expect(mod.etfClass({ symbol: "NIFTYBEES" })).toBeNull();
    expect(mod.ETF_LIST_AS_OF).toBe("");
    expect(mod.ETF_LIST_SHA256).toBe("");
    expect(mod.ETF_LIST_COUNT).toBe(0);
  });

  it("empty maps, and a row whose kind is not one of the two known values, are treated as ABSENT rather than as a class", async () => {
    const empty = await withSnapshot({ asOf: "2026-01-01", byIsin: {}, bySymbol: {} });
    expect(empty.etfClass({ isin: "INF204KB14I2" })).toBeNull();
    expect(empty.ETF_LIST_COUNT).toBe(0);

    const bad = await withSnapshot({
      byIsin: { INF204KB14I2: { symbol: "NIFTYBEES", underlying: "EQUITY", kind: "equity" } },
      bySymbol: { NIFTYBEES: "INF204KB14I2" },
    });
    // "equity" is not "equity-oriented": a hand-edited file must not classify.
    expect(bad.etfClass({ isin: "INF204KB14I2" })).toBeNull();
    expect(bad.etfClass({ symbol: "NIFTYBEES" })).toBeNull();
  });
});

describe("scripts/build-etf-list.mjs refuses rather than guesses", () => {
  const HEADER = "Symbol,Underlying Asset,SecurityName,DateofListing,MarketLot,ISINNumber,FaceValue,ETF Underlying,Underlying Key";
  const GOOD = "NIFTYBEES,Nifty 50,NIPINDETFNIFTYBEES,08-Jan-02,1,INF204KB14I2,1,EQUITY,Nifty 50";
  /** A synthetic --src folder, under the OS temp dir — never tests/fixtures. */
  function srcWith(name: string, lines: string[]): string {
    const d = fs.mkdtempSync(path.join(tmp, `${name}-`));
    fs.writeFileSync(path.join(d, "eq_etfseclist.csv"), [HEADER, ...lines].join("\n") + "\n");
    fs.writeFileSync(path.join(d, "eq_etfseclist.csv.response-headers.txt"), "Last-Modified: Mon, 07 Sep 2026 09:00:33 GMT\n");
    return d;
  }

  it("an unknown `ETF Underlying` value (a new NSE category) fails the build, naming the value and the scrip", () => {
    const d = srcWith("crypto", [GOOD, "CRYPTOETF,Bitcoin,SOMEAMC,01-Jan-26,1,INF000C01ZZ1,1,CRYPTO,Bitcoin"]);
    const r = runBuild(["--src", d, "--out", path.join(d, "out.json")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('unknown "ETF Underlying" value "CRYPTO" on CRYPTOETF (INF000C01ZZ1)');
    expect(r.out).toContain("refusing to build");
    // And it wrote NOTHING: a partial snapshot is worse than none.
    expect(fs.existsSync(path.join(d, "out.json"))).toBe(false);
  });

  it("a row with no usable ISIN, a duplicate ISIN, and a missing Last-Modified each fail the build too", () => {
    const noIsin = srcWith("noisin", ["BADETF,Nifty 50,X,01-Jan-26,1,,1,EQUITY,Nifty 50"]);
    expect(runBuild(["--src", noIsin, "--out", path.join(noIsin, "o.json")]).out).toContain("no usable ISIN/symbol");

    const dup = srcWith("dup", [GOOD, "OTHERBEES,Nifty 50,X,01-Jan-26,1,INF204KB14I2,1,EQUITY,Nifty 50"]);
    expect(runBuild(["--src", dup, "--out", path.join(dup, "o.json")]).out).toContain("appears twice");

    const undated = fs.mkdtempSync(path.join(tmp, "undated-"));
    fs.writeFileSync(path.join(undated, "eq_etfseclist.csv"), [HEADER, GOOD].join("\n") + "\n");
    const r = runBuild(["--src", undated, "--out", path.join(undated, "o.json")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to date the snapshot by the build date");
  });

  it("a good synthetic folder builds, and every class in it comes from the `ETF Underlying` column alone", () => {
    const d = srcWith("good", [
      GOOD,
      "GOLDBEES,Gold,X,01-Jan-26,1,INF204KB17I5,1,COMMODITY,Gold",
      // Underlying Asset says "Nifty 50" and the name says EQUITY-ish — the column still rules.
      "TRICKY,Nifty 50,NIPINDETFEQUITY,01-Jan-26,1,INF000T01ZZ2,1,DEBT,Nifty 50",
    ]);
    const out = path.join(d, "o.json");
    const r = runBuild(["--src", d, "--out", out]);
    expect(r.code).toBe(0);
    const built = JSON.parse(fs.readFileSync(out, "utf8")) as Snapshot;
    expect(built.asOf).toBe("2026-09-07");
    expect(built.counts.kinds).toEqual({ "equity-oriented": 1, other: 2 });
    expect(built.byIsin.INF000T01ZZ2).toMatchObject({ kind: "other", underlying: "DEBT" });
  });

  it.skipIf(!haveSrc)("re-run over the REAL input it reproduces the committed snapshot exactly (capturedAt aside)", () => {
    const out = path.join(tmp, "real.json");
    const r = runBuild(["--src", SRC, "--out", out]);
    expect(r.code, r.out).toBe(0);
    const built = JSON.parse(fs.readFileSync(out, "utf8")) as Snapshot;
    // `capturedAt` is the build date by construction — everything else must match byte for byte.
    expect({ ...built, capturedAt: "" }).toEqual({ ...snap, capturedAt: "" });
    expect(path.resolve(out)).not.toBe(path.resolve(__dirname, "../lib/data/etf-list.json"));
  });

  it("the counts the committed snapshot states are the counts its own maps hold (so the rebuild above is not the only check)", () => {
    const underlying: Record<string, number> = {};
    for (const r of Object.values(snap.byIsin)) underlying[r.underlying] = (underlying[r.underlying] ?? 0) + 1;
    expect(underlying).toEqual(snap.counts.underlying);
    expect(Object.values(underlying).reduce((a, b) => a + b, 0)).toBe(snap.provenance.rows);
  });
});

/**
 * The two surfaces that SHOW the snapshot. There is no React test environment
 * in this suite (vitest runs `environment: "node"` and these are a server page
 * and a client component), so they are pinned the way this repo pins the
 * desktop launcher it cannot run: by reading the SOURCE, with comments stripped
 * so a commented-out line cannot satisfy a pin. What is being protected is that
 * the copy DERIVES — two literal strings drifting from the code is the exact
 * failure the import-registry rule exists for.
 */
describe("the surfaces that show the ETF snapshot (read as source)", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const read = (rel: string) => strip(fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8"));

  it("/instruments states the list's asOf, its count and its sha256 — all three from lib/engine/etf-class, never as literals", () => {
    const src = read("app/instruments/page.tsx");
    expect(src).toMatch(/import\s*\{[^}]*ETF_LIST_AS_OF[^}]*\}\s*from\s*"@\/lib\/engine\/etf-class"/);
    for (const name of ["ETF_LIST_AS_OF", "ETF_LIST_COUNT", "ETF_LIST_SHA256"]) {
      expect(src.includes(`{${name}`) || src.includes(`${name} ?`) || src.includes(`${name} ||`), name).toBe(true);
    }
    // The two facts that would drift if anyone typed them in.
    expect(src).not.toContain(snap.asOf);
    expect(src).not.toContain(snap.provenance.sha256);
    // Owner ruling T4: the page must say the refresh is manual, per minor release.
    expect(src).toMatch(/manual/i);
  });

  it("the charge editor labels BOTH etf_* rate rows, so an operator edit (invariant 3) is not offered as `undefined · NSE · current`", () => {
    const src = read("components/settings/charge-editor.tsx");
    for (const seg of ETF_RATE_SEGMENTS) expect(src, seg).toContain(`${seg}:`);
    expect(src).toMatch(/segmentLabel\(r\.segment\)/);
    // The bare lookup that produced `undefined` for a rate-only row must be gone
    // from the rendered option.
    expect(src).not.toMatch(/\{SEGMENT_LABELS\[r\.segment as Segment\]\}/);
  });
});
