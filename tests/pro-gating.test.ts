import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PRO_FEATURES, ENTITLEMENT_PATHS } from "@/lib/license";

/**
 * PRO_FEATURES is the list the upsell card shows; <ProGate> is what actually
 * gates. Nothing in the type system ties them together, and they DID drift:
 * the registry advertised six screens while several substantive analytics
 * pages rendered free. These tests are the coupling — they read the real page
 * files, so a page listed as Pro but left ungated fails here.
 */

const ROOT = path.resolve(__dirname, "..");

/**
 * "/reports/edge" → app/reports/edge/page.tsx.
 *
 * A href carrying a QUERY STRING is an action on an otherwise-free page
 * (`/trades?add=open` opens a dialog on the ungated Trades screen), not a Pro
 * page — gating the page would gate the core journal. Those return null and
 * are covered by the open-trade test below.
 */
function pageFileFor(href: string): string | null {
  if (href.includes("?")) return null;
  const p = path.join(ROOT, "app", href === "/" ? "" : href, "page.tsx");
  return fs.existsSync(p) ? p : null;
}

/** app/reports/edge/page.tsx → /reports/edge (no route groups exist under app/). */
function hrefForPageFile(file: string): string {
  return file
    .slice(path.join(ROOT, "app").length)
    .replace(/\\/g, "/")
    .replace(/\/page\.tsx$/, "") || "/";
}

/** Every page.tsx under app/, skipping api/. */
function allPageFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "api") continue;
        walk(full);
      } else if (e.name === "page.tsx") out.push(full);
    }
  };
  walk(path.join(ROOT, "app"));
  return out;
}

const read = (p: string) => fs.readFileSync(p, "utf8");

describe("Pro gating — the registry and the real gates agree", () => {
  it("every advertised Pro page is actually wrapped in <ProGate>", () => {
    const ungated: string[] = [];
    for (const f of PRO_FEATURES) {
      // `partial` entries are Pro capabilities inside FREE pages — they must
      // NOT be page-gated; their own test below checks the entitlement read.
      if (f.partial) continue;
      const file = pageFileFor(f.href);
      if (!file) continue;
      const src = read(file);
      if (!src.includes("<ProGate>")) ungated.push(f.href);
    }
    expect(ungated, `advertised as Pro but rendering free: ${ungated.join(", ")}`).toEqual([]);
  });

  it("every page wrapped in <ProGate> is advertised in PRO_FEATURES — the direction that was missing", () => {
    // /trades/report was gated for releases without ever appearing on the
    // upsell card: a user was blocked by something they were never told they
    // would get. This direction makes that class of drift fail CI.
    const advertised = new Set(PRO_FEATURES.filter((f) => !f.partial).map((f) => f.href.split("?")[0]));
    const unadvertised = allPageFiles()
      .filter((p) => read(p).includes("<ProGate>"))
      .map(hrefForPageFile)
      .filter((h) => !advertised.has(h));
    expect(
      unadvertised,
      `gated but never advertised — blocked by something the upsell card does not mention: ${unadvertised.join(", ")}`,
    ).toEqual([]);
  });

  it("a partially-gated screen really checks entitlement, and is not page-gated", () => {
    for (const f of PRO_FEATURES.filter((x) => x.partial)) {
      const pathname = f.href.split("?")[0];
      const page = path.join(ROOT, "app", pathname === "/" ? "" : pathname, "page.tsx");
      const src = read(page);
      expect(src, `${f.href} must read getEntitlement`).toContain("getEntitlement");
      expect(src, `${f.href} is partial — a whole-page <ProGate> would gate the free part`).not.toContain("<ProGate>");
    }
  });

  it("PRO_FEATURES labels are unique — two entries with one label is a copy bug", () => {
    const labels = PRO_FEATURES.map((f) => f.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("activation revalidates EVERY entitlement-dependent route, derived — never a hand list", () => {
    // The hand-written list this replaced covered 4 of 17 Pro screens; a
    // paying customer could activate and still meet the upsell panel. Derived
    // from PRO_FEATURES, a new Pro screen registers itself.
    for (const f of PRO_FEATURES) {
      const pathname = f.href.split("?")[0];
      expect(ENTITLEMENT_PATHS, `${pathname} missing from ENTITLEMENT_PATHS`).toContain(pathname);
    }
    for (const p of ["/", "/settings", "/trades", "/lenses"]) {
      expect(ENTITLEMENT_PATHS).toContain(p);
    }
    expect(new Set(ENTITLEMENT_PATHS).size).toBe(ENTITLEMENT_PATHS.length);
    // And the route must actually use the derived list — a literal report path
    // in the file is the hand-written list creeping back.
    const route = read(path.join(ROOT, "app/api/license/route.ts"));
    expect(route).toContain("ENTITLEMENT_PATHS");
    expect(route).not.toMatch(/"\/reports\//);
  });

  it("every in-app #fragment link points at an id that exists", () => {
    // The locked Open-trade button linked to /settings#license for a release
    // in which no element carried id="license" — the one deep link from a
    // locked feature to the buy surface landed at the top of Settings. This
    // guards the CLASS: scan for fragment links, assert each target id exists
    // somewhere under app/ or components/.
    const trees = ["app", "components"].map((d) => path.join(ROOT, d));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name)) files.push(full);
      }
    };
    trees.forEach(walk);

    const sources = files.map((f) => ({ f, src: read(f) }));
    const wanted = new Set<string>();
    for (const { src } of sources) {
      for (const m of src.matchAll(/(?:href=|location\.href\s*=\s*)"\/[^"#]*#([A-Za-z][\w-]*)"/g)) {
        wanted.add(m[1]);
      }
    }
    const missing = [...wanted].filter((id) => !sources.some(({ src }) => src.includes(`id="${id}"`)));
    expect(missing, `fragment links with no matching id=: #${missing.join(", #")}`).toEqual([]);
  });

  it("the open-trade entry point is entitlement-gated in the trades client", () => {
    const src = read(path.join(ROOT, "components/trades/trades-client.tsx"));
    // The button must be behind the `pro` flag, not merely styled differently.
    expect(src).toMatch(/\{!pro \?/);
    expect(src).toContain("Open trade");
  });

  it("the CORE JOURNAL stays free — recording trades is never held hostage", () => {
    // Invariant 7. These pages must NOT contain a gate.
    const free = [
      "app/page.tsx", // dashboard
      "app/trades/page.tsx",
      "app/import/page.tsx",
      "app/playbooks/page.tsx",
      "app/backup/page.tsx",
      "app/settings/page.tsx", // must stay reachable to enter a licence
      "app/cash/page.tsx",
      "app/help/page.tsx",
      // Hybrid: the grouping/delete half is journal hygiene and must stay
      // free; only the edge columns are Pro, gated by field omission in the
      // server page — never by a whole-page <ProGate>.
      "app/lenses/page.tsx",
      // The buy surface itself obviously renders unlicensed.
      "app/pricing/page.tsx",
    ];
    const gated = free.filter((rel) => {
      const p = path.join(ROOT, rel);
      return fs.existsSync(p) && read(p).includes("<ProGate>");
    });
    expect(gated, `core-journal pages must never be gated: ${gated.join(", ")}`).toEqual([]);
  });

  it("no Pro page is advertised twice", () => {
    const hrefs = PRO_FEATURES.map((f) => f.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("the gate SHOWS the entitlement's reason, in both locked branches", () => {
    // `Entitlement.reason` carries the only sentence that tells a blocked user
    // what actually happened: a revocation message (v2.99.91), a key locked to
    // another computer, an unreadable vault. It was produced and never
    // rendered anywhere — a revoked buyer read "Your annual license has
    // expired", which is untrue and unactionable, and the message the vendor
    // wrote with the list never arrived. Both locked branches must surface it.
    const gate = read(path.join(ROOT, "components/system/pro-gate.tsx"));
    const mentions = gate.split("ent.reason").length - 1;
    expect(mentions, "pro-gate.tsx must render ent.reason in the banner AND block branches").toBeGreaterThanOrEqual(3);
    // …and the heading must not assert an expiry story over a reason that says otherwise.
    expect(gate).toMatch(/ent\.reason \? "This licence is no longer active"/);
  });
});
