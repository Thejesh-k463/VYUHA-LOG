import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HUBS,
  HUB_TAB_PARAM,
  LEGACY_HREFS,
  hubForHref,
  hubTabForHref,
  hubTabHref,
  legacyRedirect,
  resolveTab,
} from "@/lib/domain/hubs";
import { NAV_DEFAULT_VISIBLE, NAV_GROUPS, NAV_ITEMS, mergeOrder, mergeShown, migrateNavHrefs, navGroupHrefs, parseNavOrder, type NavOrderState } from "@/components/layout/nav-config";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { WORKSPACES, hubStripTabs, screenVisible, tabVisible } from "@/lib/domain/workspace";
import { PRO_FEATURES, ENTITLEMENT_PATHS } from "@/lib/license";
import { lockFor } from "@/lib/domain/search-scope";
import { buildCommands, commandsFor } from "@/components/system/command-palette";

/**
 * v4.6.0 W3 (owner ruling T1) — seven analytics screens folded into three
 * hubs, one tab each. lib/domain/hubs.ts is the ONE registry; every other
 * surface (sidebar, PRO_FEATURES, help, palette, saved nav order, the seven
 * legacy redirects) derives from it. These tests pin the registry and each
 * derivation.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const hub = (href: string) => hubForHref(href)!;

const EXPECTED: Record<string, string> = {
  "/reports/edge": "/reports/edge-clinic?tab=setups",
  "/reports/discipline": "/reports/edge-clinic?tab=discipline",
  "/reports/scaling": "/reports/edge-clinic?tab=scaling",
  "/reports/rom": "/reports/capital?tab=rom",
  "/reports/expiry": "/reports/capital?tab=expiry",
  "/reports/charges": "/reports/costs?tab=charges",
  "/reports/broker-compare": "/reports/costs?tab=broker-compare",
};

describe("HUBS — the registry's shape", () => {
  it("three hubs, unique hrefs, unique tab ids per hub, a default tab that exists", () => {
    expect(HUBS.map((h) => h.href)).toEqual(["/reports/edge-clinic", "/reports/capital", "/reports/costs"]);
    expect(new Set(HUBS.map((h) => h.href)).size).toBe(HUBS.length);
    for (const h of HUBS) {
      const ids = h.tabs.map((t) => t.id);
      expect(new Set(ids).size, h.href).toBe(ids.length);
      expect(ids, `${h.href} default`).toContain(h.defaultTab);
      for (const t of h.tabs) expect(t.description.length, `${h.href}#${t.id}`).toBeGreaterThan(10);
    }
    // 4.6.0: Setups is the Edge Clinic's default; no placeholder Clinic tab.
    expect(hub("/reports/edge-clinic").defaultTab).toBe("setups");
    expect(hub("/reports/edge-clinic").tabs.map((t) => t.id)).toEqual(["setups", "discipline", "scaling"]);
  });

  it("the seven legacy hrefs each map exactly once", () => {
    expect([...LEGACY_HREFS].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(new Set(LEGACY_HREFS).size).toBe(7);
  });

  it("tab descriptions are the old screens' own PageHeader descriptions, verbatim", () => {
    const d = (h: string, id: string) => hub(h).tabs.find((t) => t.id === id)!.description;
    expect(d("/reports/edge-clinic", "setups")).toBe("Which edges pay — expectancy, win rate and avg R per setup and segment.");
    expect(d("/reports/edge-clinic", "discipline")).toBe("Weekly adherence to the rules that protect your capital.");
    expect(d("/reports/edge-clinic", "scaling")).toBe("Did the ladder improve the trade, and what path did price take around each fill?");
    expect(d("/reports/capital", "rom")).toBe("What your capital actually earned while it was tied up — not return on turnover.");
    expect(d("/reports/capital", "expiry")).toBe("How your F&O P&L splits between expiry days and the rest — and what's expiring next.");
    expect(d("/reports/costs", "charges")).toBe("Where the edge leaks — by segment and by month, with break-even move %.");
    expect(d("/reports/costs", "broker-compare")).toBe("Your whole trade history re-priced on every broker's rate card.");
  });
});

describe("legacyRedirect / hubTabHref / resolveTab / hubForHref", () => {
  it.each(Object.entries(EXPECTED))("%s → %s", (from, to) => {
    expect(legacyRedirect(from)).toBe(to);
  });

  it("anything that is not a legacy route has no redirect", () => {
    expect(legacyRedirect("/trades")).toBeNull();
    expect(legacyRedirect("/reports/edge-clinic")).toBeNull();
    expect(legacyRedirect("/reports/edge/")).toBeNull();
  });

  it("hubTabHref spells a tab URL one way", () => {
    expect(hubTabHref(hub("/reports/capital"), "expiry")).toBe(`/reports/capital?${HUB_TAB_PARAM}=expiry`);
  });

  it("resolveTab: a known id opens it; missing, unknown and repeated all open the default", () => {
    const h = hub("/reports/edge-clinic");
    expect(resolveTab(h, "scaling").id).toBe("scaling");
    expect(resolveTab(h, undefined).id).toBe("setups");
    expect(resolveTab(h, "nope").id).toBe("setups");
    expect(resolveTab(h, "").id).toBe("setups");
    expect(resolveTab(h, ["scaling", "discipline"]).id).toBe("setups");
    expect(resolveTab(hub("/reports/costs"), undefined).id).toBe("charges");
    expect(resolveTab(hub("/reports/capital"), "expiry").id).toBe("expiry");
  });

  it("hubForHref matches the PATH; hubTabForHref needs a real tab", () => {
    expect(hubForHref("/reports/costs?tab=charges")?.href).toBe("/reports/costs");
    expect(hubForHref("/reports/costs#x")?.href).toBe("/reports/costs");
    expect(hubForHref("/reports/cost")).toBeUndefined();
    expect(hubTabForHref("/reports/costs?tab=charges")?.tab.id).toBe("charges");
    expect(hubTabForHref("/reports/costs?tab=nope")).toBeUndefined();
    expect(hubTabForHref("/reports/costs")).toBeUndefined();
  });
});

describe("the sidebar derives from HUBS", () => {
  it("every hub href is a NAV item in Analytics, and NO legacy href is", () => {
    const nav = new Map(NAV_ITEMS.map((n) => [n.href, n]));
    for (const h of HUBS) {
      expect(nav.get(h.href)?.group, h.href).toBe("Analytics");
      expect(nav.get(h.href)?.label, h.href).toBe(h.label);
    }
    for (const l of LEGACY_HREFS) expect(nav.has(l), l).toBe(false);
  });

  it("Analytics is Performance · Arjun's Eye · Report (PDF) · the three hubs; its fold is unchanged", () => {
    expect(NAV_ITEMS.filter((n) => n.group === "Analytics").map((n) => n.label)).toEqual([
      "Performance", "Arjun's Eye", "Report (PDF)", "Edge Clinic", "Capital & Expiry", "Costs",
    ]);
    expect(NAV_DEFAULT_VISIBLE.Analytics).toEqual(["/reports/performance", "/arjuns-eye"]);
  });
});

describe("workspace — the hub is shared, the Expiry TAB is F&O", () => {
  const capital = hub("/reports/capital");
  const expiry = capital.tabs.find((t) => t.id === "expiry")!;
  const rom = capital.tabs.find((t) => t.id === "rom")!;

  it("tabVisible: expiry hidden for equity, shown for fno and both; rom shown everywhere", () => {
    expect(tabVisible(capital, expiry, "equity")).toBe(false);
    expect(tabVisible(capital, expiry, "fno")).toBe(true);
    expect(tabVisible(capital, expiry, "both")).toBe(true);
    for (const ws of WORKSPACES) expect(tabVisible(capital, rom, ws)).toBe(true);
  });

  it("every hub is visible in every workspace", () => {
    for (const ws of WORKSPACES) for (const h of HUBS) expect(screenVisible(h.href, ws), `${h.href} in ${ws}`).toBe(true);
    expect(screenVisible("/reports/capital", "equity")).toBe(true);
  });

  it("the strip drops a hidden tab — unless it is the tab being viewed", () => {
    expect(hubStripTabs(capital, "rom", "equity")).toEqual(["rom"]);
    expect(hubStripTabs(capital, "expiry", "equity")).toEqual(["rom", "expiry"]);
    expect(hubStripTabs(capital, "rom", "fno")).toEqual(["rom", "expiry"]);
    expect(hubStripTabs(capital, "rom", "both")).toEqual(["rom", "expiry"]);
  });
});

describe("migrateNavHrefs — a saved nav order survives the merge", () => {
  const state = (items: Record<string, string[]>, shown: Record<string, string[]> = {}): NavOrderState => ({
    v: 1, groups: ["Analytics"], items, shown, expanded: { Analytics: true },
  });

  it("a legacy href becomes its hub at the FIRST member's position; later members drop out", () => {
    const out = migrateNavHrefs(state({
      Analytics: ["/reports/rom", "/reports/performance", "/reports/edge", "/reports/expiry", "/reports/scaling", "/arjuns-eye", "/reports/discipline"],
    }));
    expect(out.items.Analytics).toEqual(["/reports/capital", "/reports/performance", "/reports/edge-clinic", "/arjuns-eye"]);
  });

  it("no duplicates when the hub is already saved", () => {
    const out = migrateNavHrefs(state({ Analytics: ["/reports/costs", "/reports/charges", "/reports/broker-compare"] }));
    expect(out.items.Analytics).toEqual(["/reports/costs"]);
  });

  it("if ANY legacy member was shown, the hub is shown (the FAIL case: Edge Clinic hidden)", () => {
    const out = migrateNavHrefs(state({}, { Analytics: ["/reports/performance", "/reports/scaling"] }));
    expect(out.shown.Analytics).toEqual(["/reports/performance", "/reports/edge-clinic"]);
    // …and through the sidebar's own merge, which drops unknown hrefs silently:
    const current = NAV_ITEMS.filter((n) => n.group === "Analytics").map((n) => n.href);
    expect(mergeShown(out.shown.Analytics, NAV_DEFAULT_VISIBLE.Analytics, current)).toContain("/reports/edge-clinic");
    // A set of ONLY legacy hrefs is not "stale" after migration — it keeps its hub.
    const only = migrateNavHrefs(state({}, { Analytics: ["/reports/edge"] }));
    expect(mergeShown(only.shown.Analytics, NAV_DEFAULT_VISIBLE.Analytics, current)).toEqual(["/reports/edge-clinic"]);
  });

  it("is idempotent, keeps v1 and leaves every other field and group alone", () => {
    const s = state(
      { Analytics: ["/reports/edge", "/reports/charges"], Positions: ["/risk", "/live"] },
      { Analytics: ["/reports/expiry"], Tax: ["/reports/tax"] },
    );
    const once = migrateNavHrefs(s);
    expect(migrateNavHrefs(once)).toEqual(once);
    expect(once.v).toBe(1);
    expect(once.groups).toEqual(s.groups);
    expect(once.expanded).toEqual(s.expanded);
    expect(once.items.Positions).toEqual(["/risk", "/live"]);
    expect(once.shown.Tax).toEqual(["/reports/tax"]);
    expect(once.items.Analytics).toEqual(["/reports/edge-clinic", "/reports/costs"]);
    expect(once.shown.Analytics).toEqual(["/reports/capital"]);
  });

  it("is wired where vyuha-nav-order is parsed — before mergeOrder/mergeShown can drop anything", () => {
    const raw = JSON.stringify(state({ Analytics: ["/reports/scaling", "/reports/performance"] }, { Analytics: ["/reports/discipline"] }));
    const parsed = parseNavOrder(raw)!;
    expect(parsed.items.Analytics).toEqual(["/reports/edge-clinic", "/reports/performance"]);
    expect(parsed.shown.Analytics).toEqual(["/reports/edge-clinic"]);
    const current = NAV_ITEMS.filter((n) => n.group === "Analytics").map((n) => n.href);
    expect(mergeOrder(parsed.items.Analytics, current)[0]).toBe("/reports/edge-clinic");
    // the LEGACY un-versioned shape is migrated too
    expect(parseNavOrder(JSON.stringify({ groups: [], items: { Analytics: ["/reports/rom"] } }))!.items.Analytics).toEqual(["/reports/capital"]);
  });
});

describe("routes — the seven old pages redirect, the three hubs gate", () => {
  it("next.config.ts answers every legacy route with a config-level 307 derived from HUBS", async () => {
    // The page.tsx redirect() below is the second layer: under the root
    // loading.tsx boundary it streams as an RSC NEXT_REDIRECT over a 200
    // (measured 2026-09-25), which only client JS follows. The config
    // redirect is the one a bookmark, curl or the screenshot script sees.
    const config = (await import("../next.config")).default;
    const rules = await config.redirects!();
    const expected = Object.entries(EXPECTED).map(([source, destination]) => ({ source, destination, permanent: false }));
    expect(rules).toEqual(expected);
    expect(rules.every((r) => r.permanent === false), "a 308 would outlive 4.7.0's re-map").toBe(true);
  });

  it.each(Object.keys(EXPECTED))("app%s/page.tsx redirects (307) and carries no <ProGate>", (legacy) => {
    const src = read(`app${legacy}/page.tsx`);
    expect(src).toContain("redirect(");
    expect(src).toContain(`legacyRedirect("${legacy}")`);
    expect(src, "a cached 308 would outlive 4.7.0's re-map").not.toMatch(/permanentRedirect\s*\(/);
    expect(src).not.toContain("<ProGate>");
    expect(fs.existsSync(path.join(ROOT, `app${legacy}/loading.tsx`)), `app${legacy}/loading.tsx must be gone`).toBe(false);
  });

  it.each(HUBS.map((h) => h.href))("app%s/page.tsx: force-dynamic, reads ?tab= through resolveTab, gates with <ProGate>", (href) => {
    const src = read(`app${href}/page.tsx`);
    expect(src).toContain("<ProGate>");
    // ONE gate, wrapping whichever body the URL selected — a page that gated
    // only some tabs (`tab.id === "rom" ? <ProGate>… : body`) would still
    // contain the literal and pass the per-file pro-gating scan.
    expect(src.match(/<ProGate>/g)).toHaveLength(1);
    expect(src).toContain("<ProGate>{BODIES[tab.id]()}</ProGate>");
    expect(src).toContain("resolveTab(");
    expect(src).toContain('export const dynamic = "force-dynamic"');
    expect(src).toContain("searchParams: Promise<");
    expect(src).toContain("<HubTabs");
    expect(fs.existsSync(path.join(ROOT, `app${href}/loading.tsx`))).toBe(true);
    // one body per tab, in the private _tabs folder (never a route)
    for (const t of hub(href).tabs) expect(fs.existsSync(path.join(ROOT, `app${href}/_tabs/${t.id}.tsx`)), `${href} ${t.id}`).toBe(true);
  });

  it("a tab body owns neither the page header nor the gate (the hub does)", () => {
    for (const h of HUBS) {
      for (const t of h.tabs) {
        const src = read(`app${h.href}/_tabs/${t.id}.tsx`);
        expect(src, `${t.id}`).not.toContain("<PageHeader");
        expect(src, `${t.id}`).not.toContain("<ProGate>");
        expect(src, `${t.id}`).not.toMatch(/export default/);
      }
    }
  });
});

describe("command palette — one row per hub tab, filtered by hub AND tab", () => {
  const rows = (ws: (typeof WORKSPACES)[number]) => commandsFor(buildCommands(null, null), ws);
  const tabRows = (ws: (typeof WORKSPACES)[number]) => rows(ws).filter((c) => c.href.includes("?tab="));

  it("'both' offers all seven tabs as '<Hub> › <Tab>' in Analytics, each opening its tab URL", () => {
    const got = tabRows("both").map((c) => [c.label, c.href, c.group]);
    const want = HUBS.flatMap((h) => h.tabs.map((t) => [`${h.label} › ${t.label}`, hubTabHref(h, t.id), "Analytics"]));
    expect(got).toEqual(want);
    expect(got).toHaveLength(7);
  });

  it("an equity workspace keeps the Capital & Expiry hub and its ROM tab, and drops the Expiry TAB row", () => {
    const eq = rows("equity");
    expect(eq.some((c) => c.href === "/reports/capital")).toBe(true);
    expect(eq.some((c) => c.href === "/reports/capital?tab=rom")).toBe(true);
    expect(eq.some((c) => c.href === "/reports/capital?tab=expiry")).toBe(false);
    expect(tabRows("equity")).toHaveLength(6);
    expect(rows("fno").some((c) => c.href === "/reports/capital?tab=expiry")).toBe(true);
  });

  it("a tab row's keywords come from that tab's own help entry", async () => {
    const { HELP_ENTRIES } = await import("@/lib/domain/help-content");
    const { deriveKeywords } = await import("@/components/system/use-search-session");
    const map = new Map(HUBS.flatMap((h) => h.tabs.map((t) => [hubTabHref(h, t.id), deriveKeywords(HELP_ENTRIES, hubTabHref(h, t.id), t.label)] as const)));
    const discipline = buildCommands(map, null).find((c) => c.href === "/reports/edge-clinic?tab=discipline")!;
    expect(discipline.keywords).toContain("process score");
    expect(discipline.keywords).toContain("sebi");
  });
});

describe("Pro gating follows the tabs", () => {
  const FREE = { pro: false };

  it("PRO_FEATURES carries all seven tab hrefs, whole-page, and no legacy href", () => {
    const hrefs = PRO_FEATURES.map((f) => f.href);
    for (const to of Object.values(EXPECTED)) {
      const f = PRO_FEATURES.find((x) => x.href === to);
      expect(f, to).toBeDefined();
      expect(f!.partial, to).toBeUndefined();
    }
    for (const l of LEGACY_HREFS) expect(hrefs, l).not.toContain(l);
    for (const h of HUBS) expect(ENTITLEMENT_PATHS).toContain(h.href);
  });

  it("the hub PATH and each tab URL lock for a free user; a tab URL names its own feature", () => {
    expect(lockFor("/reports/edge-clinic", FREE).locked).toBe(true);
    expect(lockFor("/reports/edge-clinic?tab=scaling", FREE)).toEqual({
      locked: true,
      unlocks: PRO_FEATURES.find((f) => f.href === "/reports/edge-clinic?tab=scaling")!.label,
    });
    expect(lockFor("/reports/capital", FREE).locked).toBe(true);
    expect(lockFor("/reports/costs?tab=broker-compare", FREE).unlocks).toMatch(/Broker cost comparison/);
    expect(lockFor("/reports/edge-clinic?tab=scaling", { pro: true })).toEqual({ locked: false });
  });
});

describe("the Help Desk (/help) still shows every entry after the hubs", () => {
  // /help groups HELP_ENTRIES by the hrefs a sidebar group owns. With the seven
  // analytics entries now keyed by `?tab=` URL, a bare NAV_ITEMS filter would
  // have grouped none of them — seven entries gone from the desk with every
  // registry test green. navGroupHrefs owns the rule; the page must use it.
  it("navGroupHrefs covers every HELP_ENTRIES href exactly once", () => {
    const owned = NAV_GROUPS.flatMap((g) => navGroupHrefs(g));
    const missing = HELP_ENTRIES.map((e) => e.href).filter((h) => !owned.includes(h));
    expect(missing, `help entries no sidebar group owns: ${missing.join(", ")}`).toEqual([]);
    expect(new Set(owned).size).toBe(owned.length);
  });
  it("an analytics hub owns its tab URLs; a plain screen owns only itself", () => {
    expect(navGroupHrefs("Analytics")).toEqual(expect.arrayContaining(["/reports/edge-clinic", "/reports/edge-clinic?tab=setups", "/reports/costs?tab=broker-compare"]));
    expect(navGroupHrefs("System")).toEqual(NAV_ITEMS.filter((i) => i.group === "System").map((i) => i.href));
  });
  it("app/help/page.tsx groups through navGroupHrefs, not a bare NAV_ITEMS filter", () => {
    const src = read("app/help/page.tsx");
    expect(src).toContain("navGroupHrefs(label)");
    expect(src).not.toMatch(/NAV_ITEMS\.filter\([^)]*\)\.map\(\(i\) => i\.href\)/);
  });
});

/**
 * LEDGER D-9, CLOSED (v4.6.0 W4). Global search's "screens" source listed
 * NAV_ITEMS only, so after W3 a tab name ("Expiry", "Discipline") was found only
 * as a HELP result, never as a screen. The source now carries one row per hub
 * tab, derived from HUBS — this pin is the record, against the real reader on a
 * migrated database (the module imports lib/db, so it needs one).
 */
describe("global search finds a hub TAB as a screen (D-9)", () => {
  let t: import("./helpers/temp-db").TempDb;
  let search: typeof import("@/lib/queries/search");
  beforeAll(async () => {
    const { openTempDb } = await import("./helpers/temp-db");
    t = await openTempDb("hubs-search", { seed: true });
    search = await import("@/lib/queries/search");
  });
  afterAll(() => t?.cleanup());

  it("one screens row per tab, '<Hub> › <Tab>', opening hubTabHref, grouped under the hub's sidebar group", () => {
    const tabRows = search.SCREEN_CANDIDATES.filter((c) => c.href.includes("?tab="));
    const want = HUBS.flatMap((h) =>
      h.tabs.map((tab) => [`${h.label} › ${tab.label}`, hubTabHref(h, tab.id), NAV_ITEMS.find((n) => n.href === h.href)!.group]),
    );
    expect(tabRows.map((c) => [c.label, c.href, c.group])).toEqual(want);
    expect(tabRows).toHaveLength(7);
  });

  it.each([
    ["expiry", "/reports/capital?tab=expiry"],
    ["discipline", "/reports/edge-clinic?tab=discipline"],
    ["broker costs", "/reports/costs?tab=broker-compare"],
  ])("searching %s returns %s from the screens source", (query, href) => {
    const got = search.SOURCE_READERS.screens(query, 0).map((r) => r.href);
    expect(got).toContain(href);
  });
});

describe("command palette — help topics join only once something is typed (v4.6.0 W4)", () => {
  it("the empty pool carries no help row; a built pool carries one per topic, deep-linking to /help#topic-…", async () => {
    const { HELP_TOPICS } = await import("@/lib/domain/help-content");
    const { helpCommands } = await import("@/components/system/command-palette");
    expect(buildCommands(null, null).filter((c) => c.group === "Help")).toEqual([]);
    const rows = helpCommands(HELP_TOPICS);
    expect(rows).toHaveLength(HELP_TOPICS.length);
    expect(rows.every((c) => /^\/help#topic-[a-z0-9-]+$/.test(c.href))).toBe(true);
    const all = buildCommands(null, null, rows);
    expect(all.filter((c) => c.group === "Help")).toHaveLength(HELP_TOPICS.length);
    // A step's words reach the row's keywords.
    const trades = rows.find((c) => c.href === "/help#topic-trades")!;
    const tradesTopic = HELP_TOPICS.find((t) => t.href === "/trades")!;
    expect(trades.keywords).toContain(tradesTopic.steps[0].toLowerCase());
  });

  it("the palette passes help rows only for a non-empty query, and offers the shortcuts sheet as an action", () => {
    const src = read("components/system/command-palette.tsx");
    expect(src).toMatch(/const help = ql \? helpCmds : null;/);
    expect(src).toContain("buildCommands(keywords, opts, help)");
    const action = buildCommands(null, null).find((c) => c.label === "Keyboard shortcuts");
    expect(action?.event).toBe("vyuha:shortcuts");
  });
});
