import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { deflateRawSync } from "node:zlib";
import { parseBhavcopy } from "@/lib/import/bhavcopy";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * UDiFF first, `sec_bhavdata_full` second (research answer Q48).
 *
 * NSE has been signalling for two years that the legacy full bhavcopy will be
 * retired; UDiFF is the current publication and is a ZIP, which is why this
 * wave had to learn to unzip at all. Three things are worth a test:
 *
 *   1. The zip reader is `node:zlib` and nothing else. Adding a zip dependency
 *      would have rewritten package-lock.json, which AGENTS.md forbids
 *      casually — so the ~20 lines in auto-mtm.ts carry the risk, and a
 *      malformed archive has to come back as `null` rather than as a throw.
 *   2. The ORDER of the two URLs, and that both sit on the host the egress
 *      guard already allows. v4.0 promised no new network host (Q58); a
 *      fallback that quietly reached a second one would break that promise
 *      with no visible symptom.
 *   3. The legacy file's `DELIV_QTY`. UDiFF does not publish it, so switching
 *      the primary source silently dropped a column the fallback still has —
 *      `parseBhavcopy` keeps it when the file carries it, and reports NOTHING
 *      (not zero) when it does not.
 *
 * The temp database exists only because auto-mtm.ts pulls lib/db into the
 * graph; nothing here writes a row.
 */

let t: TempDb;
let mod: typeof import("@/lib/jobs/auto-mtm");

beforeAll(async () => {
  t = await openTempDb("udiff", { seed: true });
  mod = await import("@/lib/jobs/auto-mtm");
});

afterAll(() => t?.cleanup());
afterEach(() => vi.unstubAllGlobals());

/** A one-member ZIP, built the way NSE's archive is: no data descriptor. */
function makeZip(name: string, content: string, method: 0 | 8 = 8): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const body = method === 8 ? deflateRawSync(Buffer.from(content, "utf8")) : Buffer.from(content, "utf8");
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0, 6); // flags: not encrypted, no data descriptor
  head.writeUInt16LE(method, 8);
  head.writeUInt32LE(0, 14); // crc32 — not verified by the reader
  head.writeUInt32LE(body.length, 18);
  head.writeUInt32LE(Buffer.byteLength(content, "utf8"), 22);
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, nameBuf, body]);
}

const UDIFF_CSV = [
  "TradDt,BizDt,Sgmt,Src,FinInstrmTp,ISIN,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol",
  "2026-09-04,2026-09-04,CM,NSE,STK,INE002A01018,RELIANCE,EQ,1400,1425,1395,1420,120000",
  "2026-09-04,2026-09-04,CM,NSE,STK,INE467B01029,TCS,EQ,3000,3040,2990,3010,45000",
].join("\n");

const LEGACY_CSV = [
  "SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, CLOSE_PRICE, TTL_TRD_QNTY, DELIV_QTY",
  "RELIANCE, EQ, 04-Sep-2026, 1410, 1400, 1425, 1395, 1420, 120000, 60000",
  "TCS, EQ, 04-Sep-2026, 3005, 3000, 3040, 2990, 3010, 45000, 22500",
].join("\n");

const okResponse = (bytes: Buffer) => ({
  ok: true,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

describe("unzipSingleCsv — node:zlib only, and null for anything odd", () => {
  it("inflates a deflated single member", () => {
    const zip = makeZip("BhavCopy_NSE_CM_0_0_0_20260904_F_0000.csv", UDIFF_CSV);
    expect(mod.unzipSingleCsv(zip)).toBe(UDIFF_CSV);
  });

  it("reads a STORED (method 0) member too", () => {
    expect(mod.unzipSingleCsv(makeZip("x.csv", UDIFF_CSV, 0))).toBe(UDIFF_CSV);
  });

  it("returns null — never throws — for bytes that are not a zip", () => {
    expect(mod.unzipSingleCsv(Buffer.from("SYMBOL,CLOSE\nTCS,3010\n"))).toBeNull();
    expect(mod.unzipSingleCsv(Buffer.alloc(4))).toBeNull();
  });

  it("refuses an encrypted member instead of returning rubbish", () => {
    const zip = makeZip("x.csv", UDIFF_CSV);
    zip.writeUInt16LE(0x1, 6); // general-purpose bit 0 = encrypted
    expect(mod.unzipSingleCsv(zip)).toBeNull();
  });
});

describe("fetchBhavcopyForDate — UDiFF first, legacy second, one host", () => {
  it("asks the UDiFF path first and reports source=udiff", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return okResponse(makeZip("bc.csv", UDIFF_CSV));
      }),
    );
    const got = await mod.fetchBhavcopyForDate("2026-09-04");
    expect(got?.source).toBe("udiff");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20260904_F_0000.csv.zip",
    );
    expect(got?.text).toContain("TckrSymb");
  });

  it("falls back to sec_bhavdata_full when UDiFF does not answer", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes("BhavCopy_NSE_CM")) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
        return okResponse(Buffer.from(LEGACY_CSV, "utf8"));
      }),
    );
    const got = await mod.fetchBhavcopyForDate("2026-09-04");
    expect(got?.source).toBe("legacy");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe("https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_04092026.csv");
    // Q58: no new host in v4.0 — both URLs are the archive already allowlisted.
    expect(calls.every((u) => new URL(u).hostname === "nsearchives.nseindia.com")).toBe(true);
  });

  it("treats a holiday HTML error page as no file at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(Buffer.from("<html>Not found</html>", "utf8"))));
    expect(await mod.fetchBhavcopyForDate("2026-09-04")).toBeNull();
  });

  it("returns null rather than throwing when the network is gone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
    expect(await mod.fetchBhavcopyForDate("2026-09-04")).toBeNull();
  });
});

describe("parseBhavcopy — the delivery column the switch could have lost", () => {
  it("keeps DELIV_QTY from the legacy file", () => {
    const r = parseBhavcopy(LEGACY_CSV);
    expect(r.format).toBe("nse-eq");
    expect(r.delivery).toEqual({ RELIANCE: 60000, TCS: 22500 });
  });

  it("reports NOTHING — not zero — for a UDiFF file, which has no such column", () => {
    const r = parseBhavcopy(UDIFF_CSV);
    expect(r.format).toBe("nse-udiff");
    expect(r.delivery).toEqual({});
    expect(r.count).toBe(2);
    expect(r.bars.TCS.close).toBe(3010);
  });

  it("still returns the key on an unreadable file, so no caller can crash on it", () => {
    expect(parseBhavcopy("").delivery).toEqual({});
    expect(parseBhavcopy("nothing,useful\n1,2\n").delivery).toEqual({});
  });
});
