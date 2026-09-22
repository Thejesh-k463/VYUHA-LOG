import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TradeCalculator } from "@/components/calculator/trade-calculator";
import { ACCOUNT_PLAN_HREF, planPricingNotice } from "@/lib/analytics/data-quality";
import { readCapitalEntry } from "@/lib/domain/onboarding";
import { parseFormNumber } from "@/lib/domain/signal";
import type { ChargeRates } from "@/lib/engine/types";

/**
 * ════════════════════════════════════════════════════════════════════════════
 * v4.5.0 FIX-LIST WAVE — the PURE half (no database).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The DB half of the same wave is tests/fixlist-v45-db.test.ts (one temp
 * database per FILE, AGENTS.md Testing), A11 is re-pinned in
 * tests/tax-levers.test.ts, B6 in tests/help-content.test.ts and B7 in
 * tests/state-drift.test.ts.
 *
 * WHAT IS PINNED HERE, AND WHY EACH IS PINNED THE WAY IT IS
 *
 *   A1  the calculator's plan default is DERIVED from the account's resolved
 *       plan. Rendered through React's server renderer, which runs the state
 *       initialisers and the derivation but NOT effects — so the markup is the
 *       screen's FIRST paint, which is exactly the moment the defect showed
 *       (a Plus account's pre-trade estimate priced on Basic).
 *       The other half of A1 — an explicit pick, and a restored snapshot,
 *       still winning — is applied by CLIENT code after hydration (`setPlan`
 *       from the picker's onChange, and the mount restore's
 *       `Promise.resolve().then(...)`), which a server render cannot exercise.
 *       It is pinned at SOURCE here (the precedence expression and the two
 *       snapshot writers) and stated as such in the wave report.
 *
 *   A3  the pure half of the one plan-pricing line. The DB half — ONE predicate
 *       feeding both Data Quality and the line — is in the DB file.
 *
 *   A4  the `stated-bill` marker has exactly ONE reader, and it is the helper
 *       (no second literal `"stated-bill"` comparison anywhere). The behaviour
 *       is pinned over a real import in the DB file.
 *
 *   A8  `accountScopeWhere` is the ONLY scope predicate left in
 *       lib/queries/trades.ts — a source pin, because the defect was a SECOND
 *       COPY of a rule, which no single behaviour can see (both copies agreed
 *       on the day they were written; that is how they got there).
 *
 *   A9  the three call sites pass `isin`. Same reason: "the argument is
 *       present" is a fact about the call, and the behaviour it buys is pinned
 *       once, over the real route, in the DB file.
 *
 *   B1  the form-number rule, on the pure reader (`readCapitalEntry`) and on
 *       the lab client's private `numberField` (source pin + the parity its
 *       refusal must keep with `parseFormNumber`).
 *
 * Every source pin below reads the file with `fs`, never a regex over a build
 * artefact, and asserts BOTH that the new shape is there and that the old one
 * is gone — a pin that only looks for the new shape goes green on a file that
 * carries both.
 */

const REPO = process.cwd();
const src = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ───────────────────────────────────────────────────────────────────────────
// A1 — the calculator opens on the account's plan
// ───────────────────────────────────────────────────────────────────────────

/** A rate card with only the fields the calculator and the engine read. */
const card = (plan: string, over: Partial<ChargeRates> = {}): ChargeRates =>
  ({
    broker: "dhan",
    plan,
    planLabel: plan === "default" ? null : "Plus",
    subscriptionMonthly: 0,
    segment: "eq_delivery",
    exchange: "NSE",
    brokerageFlat: null,
    brokeragePct: 0,
    brokerageCap: null,
    brokerageFloor: 0,
    sttPct: 0.001,
    sttSide: "sell",
    exchangeTxnPct: 0,
    sebiPct: 0,
    stampPct: 0,
    ipftPct: 0,
    gstPct: 0.18,
    dpCharge: 0,
    dpPct: 0,
    dpGstApplicable: false,
    dpMinValue: 0,
    mtfInterestAnnual: 0,
    mtfRateUnknown: false,
    mtfTiers: null,
    pledgeCharge: 0,
    unpledgeCharge: 0,
    ...over,
  }) as ChargeRates;

/**
 * The two cards the calculator's default broker (dhan) sells in these cases:
 * the free tier charges ₹20 an order, the opt-in tier charges nothing. They
 * differ ONLY in brokerage, so any difference in the rendered figure is the
 * PLAN and nothing else.
 */
const RATES: Record<string, ChargeRates> = {
  "dhan|default|eq_delivery|NSE": card("default", { brokerageFlat: 20 }),
  "dhan|plus|eq_delivery|NSE": card("plus", { brokerageFlat: 0 }),
};

function calcHtml(props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(React.createElement(TradeCalculator, { rates: RATES, ...props } as never));
}
/** The text of one `data-testid` value cell, as the screen paints it. */
function testId(html: string, id: string): string | null {
  const m = new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(html);
  return m ? m[1] : null;
}
/** The `<option>` the Plan picker opens on, as React's server renderer marks it. */
function selectedPlan(html: string): string | null {
  const sel = /<select[^>]*>((?:(?!<\/select>)[\s\S])*)<\/select>/g;
  for (const m of html.matchAll(sel)) {
    const opts = [...m[1].matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g)];
    // The PLAN picker is the one whose options are this broker's plans.
    if (!opts.some((o) => /Free plan/.test(o[2]))) continue;
    const hit = opts.find((o) => / selected/.test(o[1]));
    return hit ? hit[2].trim() : null;
  }
  return null;
}

describe("A1 · the calculator's plan default is the account's own plan, derived", () => {
  it("an account resolved to `plus` prices on Plus with no interaction — the picker opens there too", () => {
    const onPlus = calcHtml({ accountPlans: { dhan: "plus" } });
    const onNothing = calcHtml({});

    // THE assertion (HEAD before A1: both renders are identical — `plan`
    // started at the literal "default", so a Plus account's estimate was
    // priced on the free tier's ₹20-an-order card).
    expect(selectedPlan(onPlus), "the picker opens on the account's plan").toBe("Plus");
    expect(selectedPlan(onNothing), "and on the free tier when the account states none").toBe("Free plan");

    const netOnPlus = testId(onPlus, "calc-net-target");
    const netOnDefault = testId(onNothing, "calc-net-target");
    expect(netOnPlus, "the estimate is actually priced").not.toBeNull();
    expect(netOnPlus, "the two plans do not bill the same trade the same way").not.toBe(netOnDefault);
  });

  it("a broker the view holds no account for falls back to the free tier, never to another broker's plan", () => {
    // `accountPlans` states a plan for a DIFFERENT broker only.
    const html = calcHtml({ accountPlans: { upstox: "plus" } });
    expect(selectedPlan(html)).toBe("Free plan");
    expect(testId(html, "calc-net-target")).toBe(testId(calcHtml({}), "calc-net-target"));
  });

  it("a plan the broker does not sell is ignored rather than pricing on a card that does not exist", () => {
    const html = calcHtml({ accountPlans: { dhan: "ultra" } });
    expect(selectedPlan(html)).toBe("Free plan");
    expect(testId(html, "calc-net-target")).toBe(testId(calcHtml({}), "calc-net-target"));
  });

  it("the precedence is DERIVED, never synced in an effect — and only an explicit pick is persisted", () => {
    // The half a server render cannot exercise (AGENTS.md: derive, never
    // `setState` in an effect keyed on other state — that is the rule this
    // implementation had to obey, so the pin is that it obeys it).
    const s = src("components/calculator/trade-calculator.tsx");
    expect(s, "null means `the user has not picked`").toMatch(/useState<string \| null>\(null\)/);
    expect(s, "the account's plan is the default, the pick wins").toMatch(/const chosenPlan = plan \?\? accountPlan/);
    expect(s, "no state-sync effect for the plan").not.toMatch(/useEffect\([^)]*setPlan/);
    // Both snapshot writers store an UNPICKED plan as absent, so a plan set in
    // Settings later still reaches this screen.
    expect([...s.matchAll(/plan: plan \?\? undefined/g)]).toHaveLength(2);
    expect(s, "the literal default is gone").not.toMatch(/useState\("default"\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A3 — one line, naming the PLAN and never a price
// ───────────────────────────────────────────────────────────────────────────

describe("A3 · the plan-pricing line (pure half)", () => {
  const acc = (brokerLabel: string, freePlanLabel: string | null = null) => ({ brokerLabel, freePlanLabel });

  it("says nothing at all when there is nothing to say", () => {
    expect(planPricingNotice([])).toBeNull();
  });

  it("one account: names the broker's free plan and where to set the real one", () => {
    const line = planPricingNotice([acc("Upstox")])!;
    expect(line).toContain("Upstox's free plan");
    expect(line).toContain("this account states no brokerage plan");
    expect(line).toContain("Settings › Accounts");
  });

  it("uses the rate table's own plan label when it states one", () => {
    expect(planPricingNotice([acc("Upstox", "Basic")])).toContain("Upstox Basic");
  });

  it("two accounts on DIFFERENT brokers are counted, never merged into one broker's name", () => {
    const line = planPricingNotice([acc("Upstox"), acc("Zerodha")])!;
    expect(line).toContain("2 accounts state no brokerage plan");
    expect(line).not.toContain("Upstox");
    expect(line).not.toContain("Zerodha");
  });

  it("two accounts on the SAME broker read as one sentence about that broker", () => {
    const line = planPricingNotice([acc("Upstox"), acc("Upstox")])!;
    expect(line).toContain("Upstox's free plan");
    expect(line).toContain("these accounts state no brokerage plan");
  });

  it("NEVER states a flat rupee figure — invariant 6 applies to a hint line too", () => {
    // Upstox delivery brokerage is min(₹20, 2.5%), so "(₹20/order)" would be a
    // wrong claim about money on every small order. The line names the PLAN.
    for (const line of [
      planPricingNotice([acc("Upstox")]),
      planPricingNotice([acc("Upstox", "Basic")]),
      planPricingNotice([acc("Upstox"), acc("Zerodha")]),
    ]) {
      expect(line, "no rupee amount in the line").not.toMatch(/₹|\brs\.?\b/i);
      expect(line, "and no per-order price").not.toMatch(/order/i);
    }
  });

  it("both renderers show the line, and both are fed by the server, not by a query of their own", () => {
    const imp = src("components/import/import-client.tsx");
    const calc = src("components/calculator/trade-calculator.tsx");
    expect(imp).toContain('data-testid="preview-plan-notice"');
    expect(calc).toContain('data-testid="calc-plan-notice"');
    // A client component takes the resolved line as a PROP; it never imports a
    // server-only query (that is the boundary, and the reason the page resolves it).
    for (const s of [imp, calc]) {
      expect(s, "a client component never imports a query module").not.toMatch(/from "@\/lib\/queries\//);
    }
    for (const rel of ["app/import/page.tsx", "app/calculator/page.tsx"]) {
      expect(src(rel), `${rel} resolves the line on the server`).toContain("getPlanPricingNotice()");
    }
    // The calculator hides it once the user has answered the question itself.
    expect(calc).toMatch(/planNotice && plan === null/);
  });

  it("the issue and the line point at the ONE destination", () => {
    expect(ACCOUNT_PLAN_HREF).toBe("/settings#settings-accounts");
    const dq = src("lib/analytics/data-quality.ts");
    expect(dq, "the broker_plan issue uses the constant, not a second literal").toMatch(
      /href: ACCOUNT_PLAN_HREF/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A4 / A8 / A9 — source pins (a SECOND COPY of a rule is what each fixed)
// ───────────────────────────────────────────────────────────────────────────

describe("A8 · lib/queries/trades.ts has ONE scope predicate", () => {
  const s = src("lib/queries/trades.ts");

  it("both readers call `accountScopeWhere`, and no inlined copy is left", () => {
    expect([...s.matchAll(/accountScopeWhere\(trades\.accountId, accountIds\)/g)]).toHaveLength(2);
    expect(s).toMatch(/import \{ accountScopeWhere \} from "\.\/tax-scope"/);
    // THE assertion (HEAD: two copies of
    //   `accountIds ? (len ? inArray(trades.accountId, …) : sql\`1 = 0\`)
    //                : accountId > 0 ? eq(trades.accountId, accountId) : undefined`
    // — which is how the tax-person widening reached one reader and not the
    // other).
    //
    // The pin is on the SHAPE of that copy, and on the BODIES of the two
    // whole-book readers. It is deliberately NOT "no `accountId > 0` anywhere
    // in the file": a dozen NARROWER reads below (the option join, the setup
    // tags, the import batches) scope their own aggregate that way and are not
    // book reads — a pin that reddened on them would be a pin nobody could keep.
    expect(s, "the accountIds branch has no second copy").not.toMatch(/inArray\(trades\.accountId/);
    expect(s, "nor its empty-scope half").not.toMatch(/sql`1 = 0`/);
    for (const fn of ["export const getTrades", "function scopedBookRows"]) {
      const start = s.indexOf(fn);
      expect(start, `${fn} is still in the file`).toBeGreaterThan(-1);
      const body = s.slice(start, s.indexOf("\n}", start));
      expect(body, `${fn} resolves the scope through the one rule`).toContain("accountScopeWhere(trades.accountId, accountIds)");
      expect(body, `${fn} no longer reads the selection itself`).not.toContain("getSelectedAccountId()");
      // The ternary itself, with comments stripped — invariant 8's rule is
      // QUOTED in a comment inside `getTrades`, and a comment is not a copy.
      const code = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, `${fn} carries no inlined scope ternary`).not.toMatch(/accountId > 0/);
    }
  });

  it("`isin` is a tracker field, so the row's own identity prices it (A9)", () => {
    expect(s).toMatch(/TRACKER_FIELDS = \[[\s\S]*?"isin",[\s\S]*?\] as const/);
  });
});

describe("A9 · the three call sites hand `ratesForTrade` the row's ISIN", () => {
  it.each([
    ["app/api/charges/preview/route.ts", /isin: previewIsin/],
    ["app/equity/page.tsx", /isin: isinById\.get\(p\.id\) \?\? null/],
    ["app/targets/equity/page.tsx", /isin: isinById\.get\(p\.id\) \?\? null/],
  ])("%s passes an isin into ratesForTrade", (rel, re) => {
    const s = src(rel as string);
    expect(s).toMatch(re as RegExp);
    // The argument object that reaches `ratesForTrade` carries BOTH keys — a
    // symbol alone reads a renamed or ambiguous ticker's class.
    const call = /ratesForTrade\(([\s\S]*?)\)\s*;/.exec(s) ?? /ratesForTrade\(([\s\S]{0,400})/.exec(s);
    expect(call, `${rel} still calls ratesForTrade`).not.toBeNull();
    expect(call![1]).toContain("isin");
    expect(call![1]).toContain("symbol");
  });
});

describe("A4 · the `stated-bill` marker has exactly one reader", () => {
  // Measured 395 ms under full-suite load, alone (2026-09-22, vitest
  // --reporter=verbose): a whole-tree source scan (lib/ app/ components/)
  // competing with every other worker; the timeout is raised, not the scan
  // loosened.
  it("nothing compares the literal by hand — the helper is the only door", () => {
    const helper = src("lib/import/close-open-lots.ts");
    expect(helper).toMatch(/export const STATED_BILL_NOTE = "stated-bill"/);
    // Every other mention of the literal in lib/ app/ components/ would be a
    // second reader that could drift from the writer's rule.
    const roots = ["lib", "app", "components"];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name) && fs.readFileSync(path.join(REPO, rel), "utf8").includes('"stated-bill"')) hits.push(rel);
      }
    };
    for (const r of roots) walk(r);
    expect(hits, "the literal lives in exactly one module").toEqual(["lib/import/close-open-lots.ts"]);
    expect(src("lib/import/commit.ts"), "the re-tag reads it through the helper").toMatch(
      /const statedBill = hasStatedBillNote\(t\.importNotes\)/,
    );
  }, 20_000);
});

// ───────────────────────────────────────────────────────────────────────────
// A12 — the signing key is found by ONE rule, in the test and in the publisher
// ───────────────────────────────────────────────────────────────────────────

describe("A12 · the pem is resolved by the mint script's own rule", () => {
  it("`VYUHA_LICENSE_PEM` wins; without it the repo root is the answer", async () => {
    const { defaultPemPath, repoRoot } = await import("../scripts/lib/license-mint.mjs");
    const saved = process.env.VYUHA_LICENSE_PEM;
    try {
      process.env.VYUHA_LICENSE_PEM = path.join("T:", "nowhere", "key.pem");
      expect(defaultPemPath()).toBe(path.join("T:", "nowhere", "key.pem"));
      delete process.env.VYUHA_LICENSE_PEM;
      expect(defaultPemPath()).toBe(path.join(repoRoot(), "license-private.pem"));
    } finally {
      if (saved === undefined) delete process.env.VYUHA_LICENSE_PEM;
      else process.env.VYUHA_LICENSE_PEM = saved;
    }
  });

  it("neither the round-trip test nor the publisher hard-codes the repo path any more", () => {
    for (const rel of ["tests/revocation-roundtrip.test.ts", "scripts/revocation-publish.mjs"]) {
      const s = src(rel);
      expect(s, `${rel} resolves the key by the rule`).toMatch(/defaultPemPath\(\)/);
      // THE old shape (HEAD of ae39cf1 onward: the key had moved to
      // T:\Thejesh\vyuha-secrets\ behind the env var, and both of these still
      // read the repo root — five cases silently SKIPPED and the publisher was
      // unrunnable on the owner's own machine).
      expect(s, `${rel} still names license-private.pem by hand`).not.toMatch(
        /readFileSync\((?:path\.join\(root, )?"license-private\.pem"/,
      );
    }
    // The publisher says which key it signed with — a receipt naming
    // "license-private.pem" would be a claim about a file it did not read.
    expect(src("scripts/revocation-publish.mjs")).toMatch(/signed with: \$\{pemPath\}/);
  });

  it("the publisher signs with the key the rule points at — a throwaway one, end to end", async () => {
    const { execFileSync } = await import("node:child_process");
    const { generateKeyPairSync, verify } = await import("node:crypto");
    const os = await import("node:os");
    const { canonicalListBytes } = await import("@/lib/revocation-format");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-a12-"));
    try {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const pem = path.join(dir, "throwaway.pem");
      fs.writeFileSync(pem, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
      const out = path.join(dir, "revocations.json");

      // THE assertion (on revert of scripts/revocation-publish.mjs: this throws
      // ENOENT on <repo>/license-private.pem, which is where the key is NOT).
      execFileSync(process.execPath, ["scripts/revocation-publish.mjs", "--out", out, "--grace-days", "14"], {
        cwd: REPO,
        env: { ...process.env, VYUHA_LICENSE_PEM: pem },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const written = JSON.parse(fs.readFileSync(out, "utf8")) as { list: Parameters<typeof canonicalListBytes>[0]; signature: string };
      expect(
        verify(null, Buffer.from(canonicalListBytes(written.list), "utf8"), publicKey, Buffer.from(written.signature, "base64url")),
        "the list the publisher wrote is signed by the key the env var named",
      ).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B1 — one form-number rule
// ───────────────────────────────────────────────────────────────────────────

describe("B1 · the three sites read a typed number by `parseFormNumber`", () => {
  /** Readable → the number; refused → null. The rule's own answers. */
  const CASES: [string, number | null][] = [
    ["1,00,000", 100000], //  Indian grouping, the wave's own example
    ["1,448", 1448], //       Western grouping
    ["1448", 1448], //        plain
    ["1,23,456.50", 123456.5],
    ["14,48", null], //       a decimal comma — 100x if the commas are stripped
    ["1e5", null], //         exponent notation nobody types into a rupee box
    ["abc", null],
    ["1,,448", null],
  ];

  it.each(CASES)("parseFormNumber(%s)", (raw, want) => {
    expect(parseFormNumber(raw)).toBe(want);
  });

  it("the onboarding capital box: blank, amount, unreadable — and 14,48 is unreadable", () => {
    expect(readCapitalEntry("")).toEqual({ kind: "blank", value: null });
    expect(readCapitalEntry("  ")).toEqual({ kind: "blank", value: null });
    expect(readCapitalEntry("1,00,000")).toEqual({ kind: "amount", value: 100000 });
    // THE assertions (HEAD: {amount, 1448} and {amount, 100000} — numbers the
    // user never typed, written over a configured capital base).
    expect(readCapitalEntry("14,48")).toEqual({ kind: "unreadable", value: null, raw: "14,48" });
    expect(readCapitalEntry("1e5")).toEqual({ kind: "unreadable", value: null, raw: "1e5" });
    expect(readCapitalEntry("abc")).toEqual({ kind: "unreadable", value: null, raw: "abc" });
    // A negative is still unreadable — the refusal semantics are unchanged.
    expect(readCapitalEntry("-5")).toEqual({ kind: "unreadable", value: null, raw: "-5" });
    expect(parseFormNumber("-5"), "…even though the rule itself reads it").toBe(-5);
  });

  it("every readable entry agrees with the rule, to the paisa", () => {
    for (const [raw, want] of CASES) {
      const e = readCapitalEntry(raw);
      if (want == null || want < 0) expect(e.kind, raw).toBe("unreadable");
      else expect([e.kind, e.value], raw).toEqual(["amount", want]);
    }
  });

  it("the sizing lab's own number field is the same rule (it is private, so this is its pin)", () => {
    const s = src("components/sizing/lab-client.tsx");
    expect(s).toMatch(/import \{ parseFormNumber \} from "@\/lib\/domain\/signal"/);
    expect(s).toMatch(/return parseFormNumber\(v\) \?\? fallback;/);
    // THE old shape, gone: `Number(v.replace(/,/g, "").trim())`.
    expect(s).not.toMatch(/Number\(v\.replace\(/);
  });

  it("the limits route reads both its numbers by the rule, keeping 0 and null as its refusals", () => {
    const s = src("app/api/risk/limits/route.ts");
    expect(s).toMatch(/const num = \(v: unknown\): number => parseFormNumber\(String\(v \?\? ""\)\) \?\? 0;/);
    expect(s).toMatch(/return parseFormNumber\(s\);/);
    expect(s, "no hand comma-strip survives").not.toMatch(/replace\(\/,\/g/);
  });
});
