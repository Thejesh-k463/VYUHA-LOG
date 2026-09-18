import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type * as TS from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { moveIndex } from "@/components/layout/nav-config";
import { PAGE_IDS, PAGE_SECTIONS, type PageId, type SectionDef } from "@/lib/domain/section-registry";
import {
  SECTION_ORDER_KEY,
  commitSectionMove,
  movableIds,
  parseSectionOrder,
  resolveSectionOrder,
  serializeSectionOrder,
  stepSectionMove,
} from "@/lib/domain/section-order";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * USER-MOVABLE PAGE SECTIONS (v4.4.0 wave UI-B1) — the pure half, the
 * registry↔render pin, and Appearance's own save.
 *
 * Each block names the FAIL signature it guards (research pack
 * `page-section-order-and-user-arrangement.md` §8):
 *   - envelope     → "a future-version envelope read field-by-field renders a nonsense order"
 *   - hidden       → "the drag commits the RENDERED order; the arrangement is quietly rebuilt"
 *   - AST pin      → "a registry id drifts from the rendered id; a card silently disappears"
 *   - appearance   → "skin picked, navigate away, it reverts" (the route half; e2e has the rest)
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const ts = createRequire(import.meta.url)("typescript") as typeof TS;
const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const def = (id: string, movable?: false): SectionDef => (movable === false ? { id, label: id.toUpperCase(), movable } : { id, label: id.toUpperCase() });
const SIX: SectionDef[] = ["a", "b", "c", "d", "e", "f"].map((id) => def(id));

/* ═══ the stored envelope ═══════════════════════════════════════════════ */

describe("envelope: vyuha-section-order:<page>, {v:1, order}", () => {
  it("is keyed per page with the AGENTS.md :suffix convention", () => {
    expect(SECTION_ORDER_KEY("settings")).toBe("vyuha-section-order:settings");
    expect(SECTION_ORDER_KEY("dashboard")).toBe("vyuha-section-order:dashboard");
  });

  it("round-trips through serialize → parse", () => {
    const raw = serializeSectionOrder(["settings-appearance", "settings-workspace"]);
    expect(JSON.parse(raw)).toEqual({ v: 1, order: ["settings-appearance", "settings-workspace"] });
    expect(parseSectionOrder(raw)).toEqual({ v: 1, order: ["settings-appearance", "settings-workspace"] });
  });

  it("discards a future version WHOLE — never reads it field by field", () => {
    const future = JSON.stringify({ v: 2, order: ["settings-appearance"] });
    expect(parseSectionOrder(future)).toBeNull();
    // …so the page renders its defaults, not a half-understood arrangement.
    expect(resolveSectionOrder(PAGE_SECTIONS.settings, parseSectionOrder(future)?.order)).toEqual(
      PAGE_SECTIONS.settings.map((s) => s.id),
    );
  });

  it("refuses an absent or non-numeric version (nothing ever wrote a legacy shape)", () => {
    expect(parseSectionOrder(JSON.stringify({ order: ["a"] }))).toBeNull();
    expect(parseSectionOrder(JSON.stringify({ v: "1", order: ["a"] }))).toBeNull();
  });

  it("refuses garbage rather than crashing", () => {
    for (const raw of [null, undefined, "", "{", "[]", "null", "42", JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, order: "a" })]) {
      expect(parseSectionOrder(raw as string | null)).toBeNull();
    }
  });

  it("drops non-string entries and duplicates (a duplicate would render one card twice)", () => {
    expect(parseSectionOrder(JSON.stringify({ v: 1, order: ["a", 3, null, "b", "a"] }))).toEqual({ v: 1, order: ["a", "b"] });
  });
});

/* ═══ the registry ══════════════════════════════════════════════════════ */

describe("registry: PAGE_SECTIONS", () => {
  it("covers exactly the pilot pages (/settings and the dashboard)", () => {
    expect([...PAGE_IDS].sort()).toEqual(Object.keys(PAGE_SECTIONS).sort());
    expect([...PAGE_IDS].sort()).toEqual(["dashboard", "settings"]);
  });

  it("ids are unique per page, kebab-case, page-prefixed, and labelled", () => {
    const prefix: Record<PageId, string> = { settings: "settings-", dashboard: "dash-" };
    for (const page of PAGE_IDS) {
      const ids = PAGE_SECTIONS[page].map((s) => s.id);
      expect(new Set(ids).size, `${page}: duplicate id`).toBe(ids.length);
      for (const s of PAGE_SECTIONS[page]) {
        expect(s.id, `${page}: ${s.id}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(s.id.startsWith(prefix[page]), `${page}: ${s.id} lacks ${prefix[page]}`).toBe(true);
        expect(s.label.trim().length, `${page}: ${s.id} has no label`).toBeGreaterThan(0);
      }
    }
  });

  it("a section id is a PERMANENT name — renaming one loses every user's saved position for it", () => {
    // If this fails because an id was RENAMED, put the old id back: a stored
    // order names ids, and mergeOrder drops the ones it no longer knows. Adding
    // an id is fine (it slots in at its default rank) — extend this list.
    const ever = {
      settings: [
        "settings-capital-golive", "settings-capital-management", "settings-capital-goals", "settings-capital-growth",
        "settings-workspace", "settings-preferences", "settings-accounts", "settings-defaults", "settings-risk-rules",
        "settings-charge-rates", "settings-telegram", "settings-live-feed", "settings-integrations", "settings-license",
        "settings-first-run", "settings-app-updates", "settings-appearance",
      ],
      dashboard: ["dash-kpis", "dash-equity-curve", "dash-daily-calendar", "dash-by-segment", "dash-streaks"],
    } satisfies Record<PageId, string[]>;
    for (const page of PAGE_IDS) {
      for (const id of ever[page]) expect(PAGE_SECTIONS[page].map((s) => s.id), `${page} lost ${id}`).toContain(id);
    }
  });

  it("/settings default follows the owner's three instructions", () => {
    const ids = PAGE_SECTIONS.settings.map((s) => s.id);
    // Capital & Go-Live first; the goals DIRECTLY below total capital.
    expect(ids[0]).toBe("settings-capital-golive");
    expect(ids.indexOf("settings-capital-goals")).toBe(ids.indexOf("settings-capital-management") + 1);
    // Appearance LAST (owner screenshot 2026-09-16), after Preferences.
    expect(ids.at(-1)).toBe("settings-appearance");
    expect(ids.indexOf("settings-preferences")).toBeLessThan(ids.indexOf("settings-appearance"));
    // License near the bottom, whatever the licence state (v4.4.0 ruling).
    expect(ids.indexOf("settings-license")).toBeGreaterThanOrEqual(ids.length - 4);
  });

  it("nothing on the pilot pages is pinned (move-only, every card movable)", () => {
    for (const page of PAGE_IDS) expect(movableIds(PAGE_SECTIONS[page])).toEqual(PAGE_SECTIONS[page].map((s) => s.id));
  });
});

/* ═══ resolving a saved order ═══════════════════════════════════════════ */

describe("resolveSectionOrder: the saved order over the current registry", () => {
  it("no saved order → the defaults", () => {
    expect(resolveSectionOrder(SIX, null)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(resolveSectionOrder(SIX, [])).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("the saved order wins; a deleted id drops out; a NEW id slots in after its default neighbour", () => {
    // `x` was deleted by a release; `g` was added after `c`.
    const withG = [...SIX.slice(0, 3), def("g"), ...SIX.slice(3)];
    expect(resolveSectionOrder(withG, ["f", "x", "e", "d", "c", "b", "a"])).toEqual(["f", "e", "d", "c", "g", "b", "a"]);
  });

  it("every id exactly once, even from a saved array with duplicates", () => {
    const out = resolveSectionOrder(SIX, ["b", "b", "a", "b"]);
    expect([...out].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    // Deduped to [b, a]; the unsaved ids then follow their default neighbours.
    expect(out).toEqual(["b", "c", "d", "e", "f", "a"]);
  });
});

/* ═══ FAIL: the drag commits the RENDERED order ═════════════════════════ */

describe("commitSectionMove: a conditionally-absent section keeps its place", () => {
  it("the user's earlier move of a now-hidden section survives a later move", () => {
    // The user once dragged `e` to the top. Today `e` is not rendered (a
    // conditional card), and they drag `f` to the top of what they can see.
    const saved = ["e", "a", "b", "c", "d", "f"];
    const visible = ["a", "b", "c", "d", "f"];
    const next = commitSectionMove(SIX, saved, visible, 4, 0);
    // `e` is still first when it comes back — not rebuilt to its default slot.
    expect(resolveSectionOrder(SIX, next)).toEqual(["e", "f", "a", "b", "c", "d"]);
  });

  it("exhaustively: only the moved section moves, over every from/to and hidden set", () => {
    const hiddenSets = [[], ["c"], ["a", "f"], ["b", "d", "e"]];
    const saveds = [null, ["f", "e", "d", "c", "b", "a"], ["c", "a", "e", "b", "f", "d"]];
    let cases = 0;
    for (const saved of saveds) {
      const full = resolveSectionOrder(SIX, saved);
      for (const hidden of hiddenSets) {
        const visible = full.filter((id) => !hidden.includes(id));
        for (let from = 0; from < visible.length; from++) {
          for (let to = 0; to < visible.length; to++) {
            const next = resolveSectionOrder(SIX, commitSectionMove(SIX, saved, visible, from, to));
            const moved = visible[from];
            // What is on screen is exactly the list move the user performed…
            expect(next.filter((id) => !hidden.includes(id))).toEqual(moveIndex(visible, from, to));
            // …and nothing else changed place relative to anything else.
            expect(next.filter((id) => id !== moved)).toEqual(full.filter((id) => id !== moved));
            cases++;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(150);
  });
});

/* ═══ movable:false ═════════════════════════════════════════════════════ */

describe("a movable:false section never moves, under any commit", () => {
  const PINNED: SectionDef[] = [def("top", false), def("a"), def("b"), def("mid", false), def("c"), def("d")];
  const pinnedAt = (order: string[]) => [order.indexOf("top"), order.indexOf("mid")];

  it("is pinned at its default index even when a saved array names it", () => {
    expect(pinnedAt(resolveSectionOrder(PINNED, ["mid", "d", "top", "c", "b", "a"]))).toEqual([0, 3]);
    expect(resolveSectionOrder(PINNED, ["d", "c", "b", "a"])).toEqual(["top", "d", "c", "mid", "b", "a"]);
  });

  it("no drag or step can move it, and no commit ever persists it", () => {
    const visible = resolveSectionOrder(PINNED, null); // the stack passes movable ids; pass all to be hostile
    for (let from = 0; from < visible.length; from++) {
      for (let to = 0; to < visible.length; to++) {
        const next = commitSectionMove(PINNED, null, visible, from, to);
        expect(next).not.toContain("top");
        expect(next).not.toContain("mid");
        expect(pinnedAt(resolveSectionOrder(PINNED, next))).toEqual([0, 3]);
      }
    }
    for (const s of ["up", "down", "start", "end"] as const) {
      expect(stepSectionMove(PINNED, null, visible, "top", s)).toBeNull();
      expect(stepSectionMove(PINNED, null, visible, "mid", s)).toBeNull();
    }
  });
});

/* ═══ the keyboard / dialog step ════════════════════════════════════════ */

describe("stepSectionMove: ↑ ↓ Home End", () => {
  const S = PAGE_SECTIONS.settings;
  const all = S.map((s) => s.id);

  it("moves one slot, or to an end", () => {
    const up = resolveSectionOrder(S, stepSectionMove(S, null, all, "settings-appearance", "up"));
    expect(up.at(-1)).toBe("settings-app-updates");
    expect(up.at(-2)).toBe("settings-appearance");
    const home = resolveSectionOrder(S, stepSectionMove(S, null, all, "settings-appearance", "start"));
    expect(home[0]).toBe("settings-appearance");
    const end = resolveSectionOrder(S, stepSectionMove(S, null, all, "settings-capital-golive", "end"));
    expect(end.at(-1)).toBe("settings-capital-golive");
    const down = resolveSectionOrder(S, stepSectionMove(S, null, all, "settings-capital-golive", "down"));
    expect(down.slice(0, 2)).toEqual(["settings-capital-management", "settings-capital-golive"]);
  });

  it("is a no-op (null) at an edge or for an id that is not on screen", () => {
    expect(stepSectionMove(S, null, all, "settings-capital-golive", "up")).toBeNull();
    expect(stepSectionMove(S, null, all, "settings-capital-golive", "start")).toBeNull();
    expect(stepSectionMove(S, null, all, "settings-appearance", "down")).toBeNull();
    expect(stepSectionMove(S, null, all, "settings-appearance", "end")).toBeNull();
    expect(stepSectionMove(S, null, all, "settings-nope", "up")).toBeNull();
  });
});

/* ═══ FAIL: a registry id drifts from the rendered id (AST) ═════════════ */

type StackScan = { stacks: Map<string, string[]>; problems: string[] };

function jsxName(n: TS.JsxOpeningLikeElement): string {
  return n.tagName.getText();
}

function literalAttr(n: TS.JsxOpeningLikeElement, name: string): string | null | undefined {
  for (const p of n.attributes.properties) {
    if (!ts.isJsxAttribute(p) || p.name.getText() !== name) continue;
    const init = p.initializer;
    if (!init) return null;
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)) return init.expression.text;
    return null; // present but not a literal
  }
  return undefined;
}

/**
 * Walk a source file's JSX: every `<Section id="…">` must sit inside a
 * `<SectionStack page="…">`, both attributes must be string literals, and the
 * ids are collected per page. Parsed, not grepped — a split line, a comment
 * or a conditional wrapper cannot fool it.
 */
const STACK_MODULE = "@/components/layout/section-stack";

function scanSource(file: string, text: string, into: StackScan): void {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Only the components imported from the stack module count (under whatever
  // local name) — other files declare an unrelated local `Section`.
  const local = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (st.moduleSpecifier.text !== STACK_MODULE) continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) local.set(el.name.text, (el.propertyName ?? el.name).text);
    }
  }
  if (local.size === 0) return;
  const visit = (node: TS.Node, page: string | null) => {
    let nextPage = page;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      const name = local.get(jsxName(open));
      const where = `${file}:${sf.getLineAndCharacterOfPosition(open.getStart()).line + 1}`;
      if (name === "SectionStack") {
        const p = literalAttr(open, "page");
        if (typeof p !== "string") into.problems.push(`${where}: <SectionStack page> is not a string literal`);
        else {
          nextPage = p;
          if (!into.stacks.has(p)) into.stacks.set(p, []);
          else into.problems.push(`${where}: a second <SectionStack page="${p}">`);
        }
      } else if (name === "Section") {
        const id = literalAttr(open, "id");
        if (typeof id !== "string") into.problems.push(`${where}: <Section id> is not a string literal`);
        else if (!page) into.problems.push(`${where}: <Section id="${id}"> outside any <SectionStack>`);
        else into.stacks.get(page)!.push(id);
      }
    }
    node.forEachChild((c) => visit(c, nextPage));
  };
  visit(sf, null);
}

function listTsx(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsx(rel));
    else if (e.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

function disagreements(scan: StackScan): string[] {
  const out = [...scan.problems];
  for (const page of PAGE_IDS) {
    const rendered = scan.stacks.get(page);
    if (!rendered) {
      out.push(`page "${page}" has a registry entry but no <SectionStack page="${page}">`);
      continue;
    }
    const registry = PAGE_SECTIONS[page].map((s) => s.id);
    for (const id of registry) if (!rendered.includes(id)) out.push(`${page}: registry id "${id}" is never rendered`);
    for (const id of rendered) if (!registry.includes(id)) out.push(`${page}: <Section id="${id}"> is not in the registry`);
    if (new Set(rendered).size !== rendered.length) out.push(`${page}: a <Section id> is rendered twice`);
  }
  for (const page of scan.stacks.keys()) {
    if (!(PAGE_IDS as readonly string[]).includes(page)) out.push(`<SectionStack page="${page}"> has no registry entry`);
  }
  return out;
}

describe("registry ↔ render agreement (TypeScript AST over app/ and components/)", () => {
  it("every registry id is rendered by its page, and every rendered <Section> is registered", () => {
    const scan: StackScan = { stacks: new Map(), problems: [] };
    const files = [...listTsx("app"), ...listTsx("components")];
    for (const f of files) {
      const text = read(f);
      if (text.includes("Section")) scanSource(f, text, scan);
    }
    expect(disagreements(scan)).toEqual([]);
    // Sanity: the scan actually found both pilot stacks and all their cards.
    expect(scan.stacks.get("settings")?.length).toBe(PAGE_SECTIONS.settings.length);
    expect(scan.stacks.get("dashboard")?.length).toBe(PAGE_SECTIONS.dashboard.length);
  });

  it("the scanner can fire: a typo'd id, an unregistered page and a stray <Section> are all caught", () => {
    const scan: StackScan = { stacks: new Map(), problems: [] };
    const ids = PAGE_SECTIONS.settings.map((s) => s.id);
    const imp = `import { Section, SectionStack } from "${STACK_MODULE}";\n`;
    const settingsSrc = `${imp}const x = (<SectionStack page="settings">
      ${ids
        .map((id) => (id === "settings-appearance" ? `{ok && <Section\n id="settings-apperance"><A /></Section>}` : `<Section id="${id}"><A /></Section>`))
        .join("\n")}
    </SectionStack>);`;
    scanSource("probe/settings.tsx", settingsSrc, scan);
    // An unrelated local `Section` (import-help.tsx has one) is NOT a section…
    scanSource("probe/local.tsx", `function Section() { return null; }\nconst z = <Section id={x} />;`, scan);
    // …but the stack's own, even aliased, is.
    scanSource("probe/stray.tsx", `import { Section as Sec, SectionStack } from "${STACK_MODULE}";\nconst y = <div><Sec id="dash-kpis"><B /></Sec><SectionStack page="nowhere" /></div>;`, scan);
    expect(scan.problems.some((m) => m.startsWith("probe/local.tsx"))).toBe(false);
    const found = disagreements(scan);
    expect(found).toContain('settings: registry id "settings-appearance" is never rendered');
    expect(found).toContain('settings: <Section id="settings-apperance"> is not in the registry');
    expect(found.some((m) => m.includes('<Section id="dash-kpis"> outside any <SectionStack>'))).toBe(true);
    expect(found).toContain('<SectionStack page="nowhere"> has no registry entry');
    expect(found).toContain('page "dashboard" has a registry entry but no <SectionStack page="dashboard">');
  });
});

/* ═══ the stack's own shape (derive, key by id, commit through the pure module) ═══ */

describe("components/layout/section-stack.tsx", () => {
  const src = read("components/layout/section-stack.tsx");
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  it("derives the order — no effect, no state copy of the stored value", () => {
    expect(code).not.toMatch(/useEffect|useLayoutEffect/);
    expect(code).toMatch(/useStoredValue\(key\)/);
    expect(code).toMatch(/parseSectionOrder\(raw\)/);
  });

  it("keys each frame by its section id (a remount would replay or blank a chart)", () => {
    expect(code).toMatch(/key=\{id\}[\s\S]{0,300}data-section=\{id\}/);
  });

  it("commits every move through the pure module (moveWithinVisible over the full registry)", () => {
    expect(code).toMatch(/commitSectionMove\(defs, saved, visibleMovable, from, to\)/);
    expect(code).toMatch(/stepSectionMove\(/);
    expect(code).not.toMatch(/\bmoveIndex\(/);
  });

  it("is a client module that takes sections as children, and imports no page section", () => {
    expect(src.trimStart().startsWith('"use client"')).toBe(true);
    expect(code).not.toMatch(/from "@\/components\/(settings|dashboard)\//);
    expect(code).not.toMatch(/from "@\/lib\/(db|queries)/);
  });
});

/* ═══ FAIL: Appearance moved away from its Save ═════════════════════════ */

describe("Appearance saves on its own (v4.4.0 ruling)", () => {
  const form = read("components/settings/settings-form.tsx");

  it("the card's copy names a button that is in the card", () => {
    expect(form).not.toMatch(/kept by\{" "\}\s*<span className="text-foreground">Save settings<\/span>/);
    expect(form).toMatch(/kept by\{" "\}\s*<span className="text-foreground">Save appearance<\/span>/);
    expect(form).toMatch(/fetch\("\/api\/settings\/appearance"/);
    expect(form).not.toMatch(/"use server"/);
  });

  it("the settings-form save sends the LAST SAVED look, never an unsaved preview", () => {
    expect(form).toMatch(/theme: savedLook\.theme, accentSkin: savedLook\.accentSkin, density: savedLook\.density/);
    // The old body sent the live preview state (`accentSkin: skin`) — a
    // Preferences save would have persisted a skin the user was only trying on.
    const mainSave = form.slice(form.indexOf('fetch("/api/settings",'), form.indexOf("async function saveAppearance"));
    expect(mainSave).not.toMatch(/accentSkin: skin/);
    expect(mainSave).not.toMatch(/tintIntensity, panelStyle/);
  });

  it("Appearance is the LAST section /settings renders by default", () => {
    expect(PAGE_SECTIONS.settings.at(-1)?.id).toBe("settings-appearance");
  });
});

describe("POST /api/settings/appearance (temp DB)", () => {
  let t: TempDb;
  let route: typeof import("@/app/api/settings/appearance/route");
  const row = () => t.db.select().from(t.schema.settings).all()[0];
  const post = (body: unknown) =>
    route.POST(new Request("http://local/api/settings/appearance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

  beforeAll(async () => {
    t = await openTempDb("section-order-appearance", { seed: true });
    route = await import("@/app/api/settings/appearance/route");
  });
  afterAll(() => t?.cleanup());

  it("writes the look and ONLY the look — capital, go-live and workspace are untouched", async () => {
    const before = row();
    const res = await post({ theme: "light", accentSkin: "rose", density: "comfortable", tintIntensity: 80, panelStyle: "flat", wallpaperOpacity: 20 });
    expect(res.status).toBe(200);
    const after = row();
    expect(after).toMatchObject({ theme: "light", accentSkin: "rose", density: "comfortable", tintIntensity: 80, panelStyle: "flat", wallpaperOpacity: 20 });
    for (const k of ["goLiveDate", "equityCapital", "activeCapital", "workspace", "fyStartMonth", "colorblindSafe", "autoMtmEnabled", "customTheme", "wallpaperStoredName"] as const) {
      expect(after[k], k).toEqual(before[k]);
    }
  });

  it("an absent optional field keeps the stored value; a bad value is a 400 that writes nothing", async () => {
    expect((await post({ theme: "dark", accentSkin: "luxe", density: "compact" })).status).toBe(200);
    expect(row()).toMatchObject({ theme: "dark", accentSkin: "luxe", tintIntensity: 80, panelStyle: "flat" });
    const bad = await post({ theme: "sepia", accentSkin: "luxe", density: "compact" });
    expect(bad.status).toBe(400);
    expect(row().theme).toBe("dark");
    expect((await post({ theme: "dark", accentSkin: "custom", density: "compact", customTheme: { nope: 1 } })).status).toBe(400);
  });
});
