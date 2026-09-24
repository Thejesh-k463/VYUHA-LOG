import { describe, expect, it, vi } from "vitest";
import {
  OPENALGO_MIN_VERSION,
  assertOpenAlgoVersion,
  compareOpenAlgoVersions,
  fetchOpenAlgoTradebook,
  normalizeOpenAlgoTrades,
  openAlgoFeedVersionWarning,
  openAlgoImportSource,
  openAlgoVersionVerdict,
  parseOpenAlgoVersion,
  readOpenAlgoVersion,
  recoverQuantity,
  sandboxRefusal,
  toParsedFile,
  unpriceableExchange,
  type OpenAlgoTradeRow,
} from "@/lib/import/api/openalgo";
import { createOpenAlgoProvider, type FeedGateState, type OpenAlgoHealth } from "@/lib/quotes/openalgo";
import { OPENALGO_RISKS } from "@/lib/domain/openalgo-disclosure";

/**
 * v4.6.0 W8 — OpenAlgo safety (spec 22-V460-BUILD §2 W8; research R6; owner
 * ruling 2026-09-25: below the minimum, EVERY broker's pull is refused).
 *
 * The four "FAIL looks like" lines of the spec, one block each: a sandbox fill
 * in the journal; a Groww fill at 1/100th of its price (the version gate); an
 * MCX row whose size was invented; an `NCO` row filed under NSE. Plus the
 * version claim's SOURCE — `/auth/app-info`, never a guess.
 */

const DATE = "2026-09-25";
const HOST = "http://127.0.0.1:5000";

const row = (over: Partial<OpenAlgoTradeRow>): OpenAlgoTradeRow => ({
  action: "BUY",
  symbol: "RELIANCE",
  exchange: "NSE",
  product: "MIS",
  quantity: 10,
  average_price: 1400,
  timestamp: "10:00:00",
  trade_value: 14000,
  ...over,
});

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fetch that answers app-info with `version` and anything else with `other`. */
function bridge(version: unknown, other: unknown = { status: "success", data: [] }) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith("/auth/app-info")) {
      return version === 404 ? new Response("not found", { status: 404 }) : reply({ status: "success", version, name: "OpenAlgo" });
    }
    return reply(other);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("trap 3 — a sandbox (Analyzer mode) tradebook is refused whole", () => {
  it("a live answer (no mode, or 'live') passes; 'analyze' and any unknown mode are refused", () => {
    expect(sandboxRefusal(undefined)).toBeNull();
    expect(sandboxRefusal(null)).toBeNull();
    expect(sandboxRefusal("live")).toBeNull();
    expect(sandboxRefusal("LIVE")).toBeNull();
    expect(sandboxRefusal("analyze")).toMatch(/Analyzer \(sandbox\) mode/);
    expect(sandboxRefusal("Analyze")).toMatch(/SIMULATED/);
    expect(sandboxRefusal("paper")).toMatch(/does not recognise \("paper"\)/);
  });

  it("fetchOpenAlgoTradebook throws on the sandbox envelope and returns rows on a live one", async () => {
    const trade = row({});
    vi.stubGlobal("fetch", async () => reply({ status: "success", mode: "analyze", data: [trade] }));
    try {
      await expect(fetchOpenAlgoTradebook({ apiKey: "k", host: HOST, broker: "dhan" })).rejects.toThrow(/nothing was imported/);
      vi.stubGlobal("fetch", async () => reply({ status: "success", data: [trade] }));
      await expect(fetchOpenAlgoTradebook({ apiKey: "k", host: HOST, broker: "dhan" })).resolves.toEqual([trade]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("trap 4 — the version gate (minimum 2.0.2.6, every broker)", () => {
  it("the minimum is 2.0.2.6", () => {
    expect(OPENALGO_MIN_VERSION).toBe("2.0.2.6");
  });

  it("parses dotted versions and compares them numerically, not as strings", () => {
    expect(parseOpenAlgoVersion("2.0.2.6")).toEqual([2, 0, 2, 6]);
    expect(parseOpenAlgoVersion("v2.1")).toEqual([2, 1]);
    expect(parseOpenAlgoVersion("2.0.2.6-beta")).toBeNull();
    expect(parseOpenAlgoVersion("")).toBeNull();
    expect(parseOpenAlgoVersion(undefined)).toBeNull();
    // "2.0.10.0" > "2.0.2.6" numerically, < as strings.
    expect(compareOpenAlgoVersions([2, 0, 10, 0], [2, 0, 2, 6])).toBeGreaterThan(0);
    expect(compareOpenAlgoVersions([2, 1], [2, 0, 2, 6])).toBeGreaterThan(0);
    expect(compareOpenAlgoVersions([2, 0, 2, 6], [2, 0, 2, 6])).toBe(0);
    expect(compareOpenAlgoVersions([2, 0, 2, 5], [2, 0, 2, 6])).toBeLessThan(0);
  });

  it.each(["2.0.2.6", "2.0.2.7", "2.0.10.0", "2.1"])("%s is allowed", (v) => {
    expect(openAlgoVersionVerdict({ state: "ok", version: v }, "dhan")).toEqual({ ok: true, version: v, message: null });
  });

  it.each(["dhan", "upstox", "angelone", "paytm", "kotakneo"] as const)("2.0.2.5 is refused for %s too (the ruling: every broker)", (b) => {
    const v = openAlgoVersionVerdict({ state: "ok", version: "2.0.2.5" }, b);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/2\.0\.2\.5, older than 2\.0\.2\.6, so nothing was pulled/);
    expect(v.message).toMatch(/uv run upgrade\/migrate_all\.py/);
    expect(v.message).toMatch(/Never copy \.sample\.env over an existing \.env/);
  });

  it("names the broker's own bug: Groww's ÷100 prices, Zerodha's MCX contracts", () => {
    expect(openAlgoVersionVerdict({ state: "ok", version: "2.0.2.3" }, "groww").message).toMatch(/one hundredth of its price/);
    expect(openAlgoVersionVerdict({ state: "ok", version: "2.0.2.5" }, "zerodha").message).toMatch(/MCX quantity in contracts/);
  });

  it("a pre-2.0 instance (no /auth/app-info) and an unreadable version are refused, never guessed", () => {
    expect(openAlgoVersionVerdict({ state: "pre-2.0" }).ok).toBe(false);
    expect(openAlgoVersionVerdict({ state: "pre-2.0" }).message).toMatch(/older than 2\.0\.2\.6/);
    const u = openAlgoVersionVerdict({ state: "unreadable", reason: "HTTP 500" });
    expect(u.ok).toBe(false);
    expect(u.message).toMatch(/could not read your OpenAlgo's version \(HTTP 500\)/);
  });

  it("reads the version from GET /auth/app-info with no key, and classifies each answer", async () => {
    const ok = bridge("2.0.2.6");
    expect(await readOpenAlgoVersion("127.0.0.1:5000", ok.impl)).toEqual({ state: "ok", version: "2.0.2.6" });
    expect(ok.calls).toEqual(["http://127.0.0.1:5000/auth/app-info"]);
    const init = (ok.impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined(); // no apikey travels on this request

    expect(await readOpenAlgoVersion(HOST, bridge(404).impl)).toEqual({ state: "pre-2.0", base: HOST });
    expect((await readOpenAlgoVersion(HOST, bridge(undefined).impl)).state).toBe("unreadable");
    expect((await readOpenAlgoVersion(HOST, bridge("two point oh").impl)).state).toBe("unreadable");
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await readOpenAlgoVersion(HOST, down);
    expect(r.state).toBe("unreachable");
    expect(r.state === "unreachable" && r.reason).toMatch(/Cannot reach OpenAlgo at http:\/\/127\.0\.0\.1:5000/);
  });

  // Skeptic finding (W8 review): a stopped OpenAlgo or a port typo is not a
  // version fact, so its refusal must not tell the user to upgrade.
  it("a bridge that does not answer is told to start/check the host — never to upgrade", () => {
    const v = openAlgoVersionVerdict({ state: "unreachable", reason: "Cannot reach OpenAlgo at http://127.0.0.1:5051 (ECONNREFUSED)" }, "groww");
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/Start your OpenAlgo instance and confirm the host and port/);
    expect(v.message).not.toMatch(/Upgrade|older than/);
  });

  it("a 404 names the server that answered and says it may not be OpenAlgo at all", () => {
    const v = openAlgoVersionVerdict({ state: "pre-2.0", base: "http://127.0.0.1:3000" });
    expect(v.message).toMatch(/The server at http:\/\/127\.0\.0\.1:3000 does not answer \/auth\/app-info/);
    expect(v.message).toMatch(/either not OpenAlgo \(check the host and port/);
  });

  it("assertOpenAlgoVersion resolves to the version, or throws the refusal", async () => {
    await expect(assertOpenAlgoVersion({ apiKey: "k", host: HOST, broker: "groww" }, bridge("2.0.2.6").impl)).resolves.toBe("2.0.2.6");
    await expect(assertOpenAlgoVersion({ apiKey: "k", host: HOST, broker: "groww" }, bridge("2.0.2.3").impl)).rejects.toThrow(/one hundredth/);
  });

  it("the ApiImportSource path refuses too — the tradebook is never dialled below the minimum", async () => {
    const b = bridge("2.0.1.8", { status: "success", data: [row({})] });
    vi.stubGlobal("fetch", b.impl);
    try {
      await expect(openAlgoImportSource({ apiKey: "k", host: HOST, broker: "dhan" }).fetchTrades({})).rejects.toThrow(/older than 2\.0\.2\.6/);
      expect(b.calls.some((u) => u.endsWith("/api/v1/tradebook"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("trap 5 — exchange codes Vyuha cannot price are refused, never mapped", () => {
  it("NCO and NCDEX (and any other unmappable stated code) are refused; mapped and ABSENT codes are not", () => {
    expect(unpriceableExchange("NCO")).toMatch(/NSE's commodity segment/);
    expect(unpriceableExchange("ncdex")).toMatch(/NCDEX/);
    expect(unpriceableExchange("CRYPTO")).toMatch(/exchange code CRYPTO/);
    for (const ok of ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS", "BCD", "NSE_INDEX", "BSE_INDEX", "", undefined]) {
      expect(unpriceableExchange(ok)).toBeNull();
    }
  });

  it("an NCO row never becomes a trade — not under NSE, not under MCX — and the warning names it", () => {
    const result = normalizeOpenAlgoTrades(
      [
        row({ symbol: "RELIANCE" }),
        row({ symbol: "GOLDM26OCTFUT", exchange: "NCO", product: "NRML" }),
        row({ symbol: "GOLDM26OCTFUT", exchange: "NCO", product: "NRML", action: "SELL" }),
        row({ symbol: "CASTOR26OCTFUT", exchange: "NCDEX", product: "NRML" }),
      ],
      "dhan",
      DATE,
    );
    expect(result.trades.map((t) => t.tradingsymbol)).toEqual(["RELIANCE"]);
    expect(result.refusedByExchange).toEqual({ NCO: 2, NCDEX: 1 });
    expect(result.refused).toBe(0); // counted in their own bucket, with their own sentence
    const warnings = toParsedFile("dhan", result).warnings.join("\n");
    expect(warnings).toMatch(/REFUSED — 2 rows on NSE's commodity segment \(OpenAlgo's code NCO\)/);
    expect(warnings).toMatch(/REFUSED — 1 row on NCDEX/);
  });
});

describe("trap 6 — MCX: quantity is units, and trade_value is not qty × price", () => {
  it("a zero-quantity MCX row is refused, never repaired from trade_value ÷ price", () => {
    // Zerodha MCX, 2.0.2.6: one GOLDM lot, trade_value = contracts × multiplier × price.
    const mcx = row({ symbol: "GOLDM26OCTFUT", exchange: "MCX", product: "NRML", quantity: 0, average_price: 76000, trade_value: 760000 });
    expect(recoverQuantity(mcx)).toBeNull();
    const result = normalizeOpenAlgoTrades([mcx], "zerodha", DATE);
    expect(result.trades).toEqual([]);
    expect(result.repaired).toBe(0);
    expect(result.refusedMcxNoQuantity).toBe(1);
    expect(toParsedFile("zerodha", result).warnings.join("\n")).toMatch(/REFUSED — 1 MCX row arrived with quantity 0/);
    // Off MCX the documented repair still runs.
    expect(recoverQuantity(row({ quantity: 0, average_price: 100, trade_value: 500 }))).toEqual({ qty: 5, repaired: true });
  });

  it("a positive MCX quantity imports as stated (units), and a disagreeing trade_value is said, not hidden", () => {
    const crude = row({ symbol: "CRUDEOIL19OCT26FUT", exchange: "MCX", product: "NRML", quantity: 100, average_price: 6000, trade_value: 600000 });
    const gold = row({ symbol: "GOLD05DEC26FUT", exchange: "MCX", product: "NRML", quantity: 1, average_price: 76000, trade_value: 7600000 });
    const result = normalizeOpenAlgoTrades([crude, gold], "zerodha", DATE);
    const by = Object.fromEntries(result.trades.map((t) => [t.tradingsymbol, t]));
    expect(by["FUT CRUDEOIL 19 Oct 2026"]!.buyQty).toBe(100); // never lots × units
    expect(by["FUT GOLD 05 Dec 2026"]!.buyQty).toBe(1);
    expect(result.notes.filter((n) => /MCX\): OpenAlgo states a trade value/.test(n))).toHaveLength(1);
    expect(result.notes.join("\n")).toMatch(/GOLD05DEC26FUT \(MCX\)/);
  });
});

describe("the feed warns (it does not refuse) below the minimum", () => {
  const READY: FeedGateState = { state: "ready", creds: { apiKey: "k-123", host: HOST } };
  const provider = (version: unknown) => {
    const b = bridge(version, { status: "success", data: {} });
    return { p: createOpenAlgoProvider({ readGate: async () => READY, fetchImpl: b.impl }), calls: b.calls };
  };

  it("an old bridge is still 'ok' — prices flow — with the upgrade warning beside it", async () => {
    const { p, calls } = provider("2.0.1.8");
    const h = (await p.health()) as OpenAlgoHealth;
    expect(h.ok).toBe(true);
    expect(h.state).toBe("ok");
    expect(h.warning).toMatch(/2\.0\.1\.8, older than 2\.0\.2\.6: prices still update, but trade pulls are refused/);
    expect(calls).toEqual([`${HOST}/api/v1/funds`, `${HOST}/auth/app-info`]);
  });

  it("a current bridge carries no warning", async () => {
    const h = (await provider("2.0.2.6").p.health()) as OpenAlgoHealth;
    expect(h.ok).toBe(true);
    expect(h.warning).toBeNull();
  });

  it("the warning helper covers pre-2.0 and unreadable too", () => {
    expect(openAlgoFeedVersionWarning({ state: "pre-2.0" })).toMatch(/older than 2\.0\.0\.0/);
    expect(openAlgoFeedVersionWarning({ state: "unreadable", reason: "HTTP 502" })).toMatch(/could not read .* \(HTTP 502\)/);
    expect(openAlgoFeedVersionWarning({ state: "ok", version: "2.0.2.6" })).toBeNull();
  });
});

describe("the accepted disclosure says what W8 does", () => {
  it("names the version read, the minimum, the sandbox refusal, the exchange refusals and the MCX rule", () => {
    const all = OPENALGO_RISKS.map((r) => `${r.title} ${r.body}`).join("\n");
    expect(all).toContain("/auth/app-info");
    expect(all).toContain(OPENALGO_MIN_VERSION);
    expect(all).toMatch(/Analyzer \(sandbox\) mode/);
    expect(all).toMatch(/NCO/);
    expect(all).toMatch(/NCDEX/);
    expect(all).toMatch(/zero-size MCX row is refused, never repaired/);
  });
});
