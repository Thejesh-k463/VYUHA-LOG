import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A SERVER MODULE MAY IMPORT ONLY COMPONENTS FROM A `"use client"` MODULE.
 *
 * THE DEFECT THIS EXISTS FOR. `app/risk/page.tsx` imported the VALUE
 * `resolveSpotRef` from `components/risk/spot-mark-editor.tsx` — a `"use client"`
 * module — and called it during the server render;
 * `components/risk/expiry-obligations.tsx` imported the constant `UNKNOWN_SPOT`
 * from the same module and read it while rendering on the server. Next's flight
 * loader rewrites EVERY export of a client module reached from the server layer
 * into a `registerClientReference` proxy
 * (`node_modules/next/dist/build/webpack/loaders/next-flight-loader/index.js`),
 * and that proxy THROWS when the value is called or otherwise used as itself.
 * So `/risk` threw at request time on any book with an open F&O position, while
 * BOTH existing gates stayed green: vitest imports the raw module (there is no
 * webpack loader in the test run) and `next build` compiles the stub without
 * complaint because the call happens at request time, not at build time.
 *
 * A runtime test cannot catch this — the failure only exists inside the Next
 * bundler's output. So the rule is enforced on the SOURCE SHAPE instead:
 *
 *   For every module under app/, components/ and lib/ whose first statement is
 *   NOT `"use client"`, every named import from a module whose first statement
 *   IS `"use client"` must be a COMPONENT name — PascalCase, i.e. an initial
 *   capital and at least one lowercase letter, no underscores. `SpotMarkEditor`
 *   passes; `resolveSpotRef` and `UNKNOWN_SPOT` do not.
 *
 * Uppercase-initial alone is NOT the rule, deliberately: `UNKNOWN_SPOT` is
 * uppercase and is exactly one of the two values that broke the page. A
 * SCREAMING_SNAKE constant is not a component.
 *
 * TYPES ARE EXEMPT (`import type …`, and inline `type X` specifiers): a type is
 * erased before any loader sees it, so `import { type SpotRef }` from a client
 * module is free. That is why the fix keeps a type import and moves only the
 * values.
 *
 * `import * as ns from "<client module>"` is flagged too — a namespace import
 * pulls every export, lowercase ones included, and would drive straight through
 * the name rule.
 *
 * T-1 (2026-09-10) — THREE SHAPES THE FIRST SCANNER NEVER LOOKED AT. It read
 * only the brace list and the `* as` slot of an `import … from`, so each of
 * these reached the server layer unexamined:
 *
 *  1. THE DEFAULT SLOT. `import helper from "@/components/x"` has no braces at
 *     all. A default export is very often the component, which is why the rule
 *     is the same one: a PascalCase default binding passes, a lowercase or
 *     SCREAMING_SNAKE one is a value and is an offender.
 *  2. A RE-EXPORT CHAIN THROUGH A BARREL. `components/x/index.ts` carrying
 *     `export { resolveSpotRef } from "./chip"` is not itself a client module,
 *     so a server file importing that name from the barrel resolved to a
 *     module the old scanner cleared. The name is chased through
 *     `export { … } from`, `export * from` and `export * as ns from` until it
 *     lands on a real module; landing on a `"use client"` one is the offence,
 *     however many barrels it crossed.
 *  3. `await import("@/components/…")`. A dynamic import of a client module is
 *     legal — `next/dynamic(() => import("…"))` is exactly how a client
 *     component is code-split, and that form is NOT flagged. What is flagged is
 *     an AWAITED one whose binding is then read as a value:
 *     `const { resolveSpotRef } = await import(…)` and
 *     `(await import(…)).resolveSpotRef` both hold the same throwing stub a
 *     static import would have. Flagged for review rather than assumed fatal —
 *     the awaited module object is the one shape where a human has to look.
 */

const root = process.cwd();
/** Where a Next server render can begin. */
const ROOTS = ["app", "components", "lib"] as const;

// ---------------------------------------------------------------------------
// KNOWN — pre-existing offenders the orchestrator has been told about and has
// NOT yet ruled on. Key is `<relative path>:<imported name>`; the value is the
// reason it is still here. An entry is a DEBT, not an exemption: the second
// test below fails the day an entry stops being a real offender, so a fixed one
// cannot sit here rotting.
//
// EMPTY on purpose — the repo-wide scan on 2026-09-09 found exactly the two
// offenders this wave fixes and no others.
// ---------------------------------------------------------------------------
const KNOWN = new Map<string, string>([]);

/* ── collecting the tree ─────────────────────────────────────────────────── */

/** Every source module under the three roots, keyed by POSIX-relative path. */
function collect(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(e.name)) continue;
      if (/\.d\.ts$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
      out.set(path.relative(root, p).split(path.sep).join("/"), readFileSync(p, "utf8"));
    }
  };
  for (const r of ROOTS) walk(path.join(root, r));
  return out;
}

/* ── the scan (pure: a map of sources in, offenders out) ─────────────────── */

/** Comments BLANKED, not removed — every line number below is still the real
 *  one, and a commented-out import can no longer be reported as code. */
function blankComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\r\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:])\/\/[^\r\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

/** `"use client"` as the FIRST statement — leading comments and whitespace do
 *  not count, and a `"use client"` further down the file is not a directive. */
export function isClientModule(src: string): boolean {
  let s = src.replace(/^﻿/, "");
  for (;;) {
    const t = s.replace(/^\s+/, "");
    if (t.startsWith("//")) {
      const nl = t.search(/\r?\n/);
      if (nl < 0) return false;
      s = t.slice(nl + 1);
      continue;
    }
    if (t.startsWith("/*")) {
      const end = t.indexOf("*/");
      if (end < 0) return false;
      s = t.slice(end + 2);
      continue;
    }
    s = t;
    break;
  }
  return /^["']use client["']/.test(s);
}

/** `@/x` → repo-root-relative; `./x`, `../x` → resolved against the importer.
 *  Anything else is a package. Returns the key in `sources`, or null. */
function resolveSpecifier(spec: string, fromRel: string, sources: ReadonlyMap<string, string>): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (sources.has(c)) return c;
  }
  return null;
}

/** A component name: initial capital, at least one lowercase, no underscores. */
export const isComponentName = (name: string): boolean =>
  /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name);

export interface Offender {
  /** `<relative path>:<imported name>` — the KNOWN key. */
  key: string;
  file: string;
  line: number;
  name: string;
  from: string;
  /** The `"use client"` module the name actually comes from, when the
   *  specifier the file wrote is a barrel that re-exports it (T-1). */
  origin?: string;
}

/* ── re-export chains (T-1) ──────────────────────────────────────────────── */

/** `export { a, b as c } from "…"`, `export * from "…"`, `export * as ns from "…"`. */
const REEXPORT_RE = /^[ \t]*export\b([^;]*?)\bfrom\s*["']([^"']+)["']/gm;

/** Named specifiers of a brace list, as `[localName, exportedName]` pairs.
 *  Inline `type` specifiers are erased before any loader sees them. */
function specifiers(braceBody: string): [string, string][] {
  const out: [string, string][] = [];
  for (const piece of braceBody.split(",")) {
    const s = piece.trim();
    if (!s || /^type\b/.test(s)) continue;
    const parts = s.split(/\s+as\s+/).map((x) => x.trim());
    if (!parts[0]) continue;
    out.push([parts[0], parts[1] ?? parts[0]]);
  }
  return out;
}

/** Does `mod` itself export `name`? Used to decide whether an `export * from`
 *  is the path a name actually travelled. */
function moduleExports(mod: string, name: string, sources: ReadonlyMap<string, string>): boolean {
  const raw = sources.get(mod);
  if (!raw) return false;
  const src = blankComments(raw);
  if (name === "default" && /^[ \t]*export\s+default\b/m.test(src)) return true;
  const decl = new RegExp(`^[ \\t]*export\\s+(?:async\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${name}\\b`, "m");
  if (decl.test(src)) return true;
  for (const m of src.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) {
    if (specifiers(m[1]).some(([, exported]) => exported === name)) return true;
  }
  return false;
}

/**
 * Follow `name` out of `mod` through every `export … from` it carries, and
 * return the `"use client"` module it ultimately comes from — or null.
 *
 * `seen` closes the cycle two barrels re-exporting each other would otherwise
 * open.
 */
export function reexportOrigin(
  mod: string,
  name: string,
  sources: ReadonlyMap<string, string>,
  seen: Set<string> = new Set(),
): string | null {
  const memo = `${mod}:${name}`;
  if (seen.has(memo)) return null;
  seen.add(memo);
  const raw = sources.get(mod);
  if (!raw) return null;
  const src = blankComments(raw);

  for (const m of src.matchAll(REEXPORT_RE)) {
    const clause = m[1];
    if (/^\s*type\b/.test(clause)) continue; // `export type { … } from …`
    const target = resolveSpecifier(m[2], mod, sources);
    if (!target) continue;
    const targetIsClient = isClientModule(sources.get(target)!);

    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces) {
      for (const [local, exported] of specifiers(braces[1])) {
        if (exported !== name) continue;
        if (targetIsClient) return target;
        const deeper = reexportOrigin(target, local, sources, seen);
        if (deeper) return deeper;
      }
      continue;
    }

    // `export * as ns from "…"` — one namespace binding, every export inside it.
    const nsAs = /^\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*$/.exec(clause);
    if (nsAs) {
      if (nsAs[1] !== name) continue;
      if (targetIsClient) return target;
      continue;
    }

    // `export * from "…"` — every name flows through, so follow only the one
    // the target actually has.
    if (/^\s*\*\s*$/.test(clause)) {
      if (targetIsClient) {
        if (moduleExports(target, name, sources)) return target;
        continue;
      }
      if (moduleExports(target, name, sources)) continue; // its own, not a client's
      const deeper = reexportOrigin(target, name, sources, seen);
      if (deeper) return deeper;
    }
  }
  return null;
}

/* ── dynamic imports (T-1) ───────────────────────────────────────────────── */

/** `const { a } = await import("…")` / `const ns = await import("…")`. */
const DYN_BINDING_RE = /\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*await\s+import\s*\(\s*["']([^"']+)["']\s*\)/g;
/** `(await import("…")).name`. */
const DYN_MEMBER_RE = /\(\s*await\s+import\s*\(\s*["']([^"']+)["']\s*\)\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g;

/**
 * An import statement, however many lines its brace list spans. `[^;]` can
 * cross a newline (CRLF included) but never a statement terminator, so a
 * side-effect `import "./x.css";` can never swallow the next statement's
 * `from`.
 */
const IMPORT_RE = /^[ \t]*import\b([^;]*?)\bfrom\s*["']([^"']+)["']/gm;

export function scan(sources: ReadonlyMap<string, string>): Offender[] {
  const offenders: Offender[] = [];
  for (const [rel, raw] of sources) {
    if (isClientModule(raw)) continue; // a client module may import anything
    const src = blankComments(raw);
    const lineAt = (offset: number) => src.slice(0, offset).split(/\r?\n/).length;

    for (const m of src.matchAll(IMPORT_RE)) {
      const [clause, spec] = [m[1], m[2]];
      if (/^\s*type\b/.test(clause)) continue; // `import type { … } from …`
      const target = resolveSpecifier(spec, rel, sources);
      if (!target) continue;
      const targetIsClient = isClientModule(sources.get(target)!);
      const startLine = src.slice(0, m.index).split(/\r?\n/).length;
      const lineOf = (offsetInMatch: number) =>
        startLine + m[0].slice(0, offsetInMatch).split(/\r?\n/).length - 1;
      /** Where this NAME really comes from: the module itself when it is a
       *  client one, else whatever a barrel re-exports it from (T-1). */
      const originOf = (name: string) => (targetIsClient ? target : reexportOrigin(target, name, sources));

      const ns = /\*\s*as\s+[A-Za-z_$][\w$]*/.exec(clause);
      if (ns && targetIsClient) {
        offenders.push({
          key: `${rel}:* as`,
          file: rel,
          line: lineOf(m[0].indexOf(ns[0])),
          name: ns[0],
          from: spec,
        });
      }

      // The DEFAULT slot — `import helper from …`, `import helper, { … } from …`.
      const def = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|\s*$)/.exec(clause);
      if (def && !isComponentName(def[1])) {
        const origin = originOf("default");
        if (origin) {
          offenders.push({
            key: `${rel}:${def[1]}`,
            file: rel,
            line: lineOf(Math.max(0, m[0].indexOf(def[1]))),
            name: def[1],
            from: spec,
            origin: targetIsClient ? undefined : origin,
          });
        }
      }

      const braces = /\{([\s\S]*)\}/.exec(clause);
      if (!braces) continue;
      let cursor = m[0].indexOf("{");
      for (const piece of braces[1].split(",")) {
        const at = m[0].indexOf(piece.trim(), cursor);
        if (at >= 0) cursor = at + piece.trim().length;
        const s = piece.trim();
        if (!s || /^type\b/.test(s)) continue; // inline `type X` specifier
        const name = s.split(/\s+as\s+/)[0].trim();
        if (!name || isComponentName(name)) continue;
        const origin = originOf(name);
        if (!origin) continue;
        offenders.push({
          key: `${rel}:${name}`,
          file: rel,
          line: at >= 0 ? lineOf(at) : startLine,
          name,
          from: spec,
          origin: targetIsClient ? undefined : origin,
        });
      }
    }

    // `await import("<client module>")` whose result is read as a value.
    // A bare `dynamic(() => import("…"))` is untouched: nothing is awaited and
    // nothing is taken off the module object.
    for (const m of src.matchAll(DYN_BINDING_RE)) {
      const target = resolveSpecifier(m[2], rel, sources);
      if (!target || !isClientModule(sources.get(target)!)) continue;
      const line = lineAt(m.index!);
      if (m[1].startsWith("{")) {
        for (const [local] of specifiers(m[1].slice(1, -1).replace(/:/g, " as "))) {
          if (isComponentName(local)) continue;
          offenders.push({ key: `${rel}:${local}`, file: rel, line, name: local, from: m[2] });
        }
      } else {
        offenders.push({ key: `${rel}:await import`, file: rel, line, name: `await import → ${m[1]}`, from: m[2] });
      }
    }
    for (const m of src.matchAll(DYN_MEMBER_RE)) {
      const target = resolveSpecifier(m[1], rel, sources);
      if (!target || !isClientModule(sources.get(target)!)) continue;
      if (isComponentName(m[2])) continue;
      offenders.push({ key: `${rel}:${m[2]}`, file: rel, line: lineAt(m.index!), name: m[2], from: m[1] });
    }
  }
  return offenders;
}

const describeOffender = (o: Offender) =>
  `${o.file}:${o.line} imports \`${o.name}\` from "${o.from}"${o.origin ? ` (re-exported from "${o.origin}", "use client")` : ` ("use client")`} — Next turns it into a throwing client reference`;

/* ── the guard ───────────────────────────────────────────────────────────── */

describe("no server module imports a VALUE from a \"use client\" module", () => {
  const sources = collect();
  const offenders = scan(sources);

  it("scans a real tree — the collector is not silently empty", () => {
    expect(sources.size).toBeGreaterThan(300);
    expect([...sources.values()].filter(isClientModule).length).toBeGreaterThan(50);
    // The two files the defect lived in are actually in the scan.
    expect(sources.has("app/risk/page.tsx")).toBe(true);
    expect(sources.has("components/risk/spot-mark-editor.tsx")).toBe(true);
    expect(isClientModule(sources.get("components/risk/spot-mark-editor.tsx")!)).toBe(true);
  });

  it("finds no unlisted offender anywhere under app/, components/ and lib/", () => {
    expect(offenders.filter((o) => !KNOWN.has(o.key)).map(describeOffender)).toEqual([]);
  });

  it("the KNOWN list is debt, not a loophole — every entry is still a real offender", () => {
    const live = new Set(offenders.map((o) => o.key));
    for (const key of KNOWN.keys()) {
      expect(live.has(key), `${key} is fixed — delete it from KNOWN rather than leaving a dead exemption`).toBe(true);
    }
  });
});

/* ── the scanner can go red (a guard that cannot fire is not a guard) ─────── */

describe("the scanner itself", () => {
  const CLIENT = ['"use client";', "export const UNKNOWN_SPOT = { value: null };", "export function resolveSpotRef() {}", "export function SpotMarkEditor() {}"].join("\n");
  const fixture = (page: string, crlf = false) => {
    const map = new Map([
      ["components/risk/chip.tsx", CLIENT],
      ["app/risk/page.tsx", page],
    ]);
    return crlf ? new Map([...map].map(([k, v]) => [k, v.replace(/\n/g, "\r\n")] as const)) : map;
  };

  it("fires on a lowercase function import — the exact shape that broke /risk", () => {
    const found = scan(fixture('import { resolveSpotRef } from "@/components/risk/chip";'));
    expect(found.map((o) => o.name)).toEqual(["resolveSpotRef"]);
  });

  it("fires on a SCREAMING_SNAKE constant — uppercase-initial is not the rule", () => {
    expect(scan(fixture('import { UNKNOWN_SPOT } from "@/components/risk/chip";')).map((o) => o.name)).toEqual([
      "UNKNOWN_SPOT",
    ]);
  });

  it("passes a component, a type import and an inline type specifier", () => {
    expect(scan(fixture('import { SpotMarkEditor } from "@/components/risk/chip";'))).toEqual([]);
    expect(scan(fixture('import type { SpotRef } from "@/components/risk/chip";'))).toEqual([]);
    expect(scan(fixture('import { SpotMarkEditor, type SpotRef } from "@/components/risk/chip";'))).toEqual([]);
  });

  it("fires on a namespace import, which would drive around the name rule", () => {
    expect(scan(fixture('import * as chip from "@/components/risk/chip";')).map((o) => o.name)).toEqual(["* as chip"]);
  });

  it("reads a multi-line brace list, under LF and CRLF alike, and reports the identifier's own line", () => {
    const page = ["import {", "  SpotMarkEditor,", "  resolveSpotRef,", '} from "@/components/risk/chip";'].join("\n");
    for (const crlf of [false, true]) {
      const found = scan(fixture(page, crlf));
      expect(found.map((o) => `${o.name}@${o.line}`), crlf ? "CRLF" : "LF").toEqual(["resolveSpotRef@3"]);
    }
  });

  it("ignores a client module importing a client value, and a relative specifier resolves", () => {
    // client → client is legal; only the server layer gets the throwing stub.
    const asClient = new Map([
      ["components/risk/chip.tsx", CLIENT],
      ["components/risk/other.tsx", '"use client";\nimport { resolveSpotRef } from "./chip";'],
    ]);
    expect(scan(asClient)).toEqual([]);
    const serverSibling = new Map([
      ["components/risk/chip.tsx", CLIENT],
      ["components/risk/panel.tsx", 'import { resolveSpotRef } from "./chip";'],
    ]);
    expect(scan(serverSibling).map((o) => o.name)).toEqual(["resolveSpotRef"]);
  });

  /* ── T-1: the three shapes the first scanner never looked at ───────────── */

  const CLIENT_DEFAULT = ['"use client";', "export default function chipHelper() {}"].join("\n");

  it("fires on a lowercase DEFAULT import — the slot has no braces to read", () => {
    const map = new Map([
      ["components/risk/chip.tsx", CLIENT_DEFAULT],
      ["app/risk/page.tsx", 'import chipHelper from "@/components/risk/chip";'],
    ]);
    expect(scan(map).map((o) => o.name)).toEqual(["chipHelper"]);
  });

  it("fires on a SCREAMING_SNAKE default, and on the default beside a brace list", () => {
    const map = (page: string) =>
      new Map([
        ["components/risk/chip.tsx", [CLIENT_DEFAULT, "export function SpotMarkEditor() {}"].join("\n")],
        ["app/risk/page.tsx", page],
      ]);
    expect(scan(map('import CHIP_DEFAULTS from "@/components/risk/chip";')).map((o) => o.name)).toEqual([
      "CHIP_DEFAULTS",
    ]);
    expect(
      scan(map('import helper, { SpotMarkEditor } from "@/components/risk/chip";')).map((o) => o.name),
    ).toEqual(["helper"]);
  });

  it("passes a PascalCase default — that is the component the slot usually holds", () => {
    const map = new Map([
      ["components/risk/chip.tsx", '"use client";\nexport default function Chip() {}'],
      ["app/risk/page.tsx", 'import Chip from "@/components/risk/chip";'],
      ["app/risk/layout.tsx", 'import type Chip from "@/components/risk/chip";'],
    ]);
    expect(scan(map)).toEqual([]);
  });

  it("follows `export { … } from` through a barrel that is NOT itself a client module", () => {
    const map = new Map([
      ["components/risk/chip.tsx", CLIENT],
      ["components/risk/index.ts", 'export { resolveSpotRef, SpotMarkEditor } from "./chip";'],
      ["app/risk/page.tsx", 'import { resolveSpotRef, SpotMarkEditor } from "@/components/risk";'],
    ]);
    const found = scan(map);
    expect(found.map((o) => o.name)).toEqual(["resolveSpotRef"]);
    expect(found[0].origin).toBe("components/risk/chip.tsx");
    expect(found[0].file).toBe("app/risk/page.tsx");
  });

  it("follows a RENAMED re-export, and a chain of two barrels", () => {
    const map = new Map([
      ["components/risk/chip.tsx", CLIENT],
      ["components/risk/index.ts", 'export { resolveSpotRef as spotRef } from "./chip";'],
      ["components/index.ts", 'export { spotRef } from "./risk";'],
      ["app/risk/page.tsx", 'import { spotRef } from "@/components";'],
    ]);
    expect(scan(map).map((o) => `${o.name}@${o.origin}`)).toEqual(["spotRef@components/risk/chip.tsx"]);
  });

  it("follows `export * from` only for a name the client module really exports", () => {
    const base = (page: string) =>
      new Map([
        ["components/risk/chip.tsx", CLIENT],
        ["components/risk/index.ts", 'export * from "./chip";\nexport const gridGap = 4;'],
        ["app/risk/page.tsx", page],
      ]);
    expect(scan(base('import { resolveSpotRef } from "@/components/risk";')).map((o) => o.name)).toEqual([
      "resolveSpotRef",
    ]);
    // `gridGap` is the barrel's OWN export — nothing client about it.
    expect(scan(base('import { gridGap } from "@/components/risk";'))).toEqual([]);
    // …and a component still passes, however it travelled.
    expect(scan(base('import { SpotMarkEditor } from "@/components/risk";'))).toEqual([]);
  });

  it("terminates on a barrel cycle instead of recursing for ever", () => {
    const map = new Map([
      ["components/a/index.ts", 'export * from "../b";'],
      ["components/b/index.ts", 'export * from "../a";'],
      ["app/risk/page.tsx", 'import { whatever } from "@/components/a";'],
    ]);
    expect(scan(map)).toEqual([]);
  });

  it("flags an AWAITED dynamic import whose binding is read as a value", () => {
    const dyn = (body: string) =>
      new Map([
        ["components/risk/chip.tsx", CLIENT],
        ["app/risk/page.tsx", body],
      ]);
    expect(
      scan(dyn('const { resolveSpotRef } = await import("@/components/risk/chip");')).map((o) => o.name),
    ).toEqual(["resolveSpotRef"]);
    expect(
      scan(dyn('const price = (await import("@/components/risk/chip")).resolveSpotRef();')).map((o) => o.name),
    ).toEqual(["resolveSpotRef"]);
    // A renamed destructure is judged on the EXPORT name, not the binding.
    expect(
      scan(dyn('const { resolveSpotRef: fn } = await import("@/components/risk/chip");')).map((o) => o.name),
    ).toEqual(["resolveSpotRef"]);
    // The whole module object, held as a value — the namespace shape again.
    expect(scan(dyn('const mod = await import("@/components/risk/chip");')).map((o) => o.name)).toEqual([
      "await import → mod",
    ]);
  });

  it("leaves `next/dynamic(() => import(…))` alone — nothing is awaited, nothing is read", () => {
    const map = new Map([
      ["components/risk/chip.tsx", CLIENT],
      [
        "app/risk/page.tsx",
        'const Chip = dynamic(() => import("@/components/risk/chip"), { ssr: false });\nconst { SpotMarkEditor } = await import("@/components/risk/chip");',
      ],
    ]);
    expect(scan(map)).toEqual([]);
  });

  it("does not read a commented-out import, or a `use client` that is not the first statement", () => {
    expect(scan(fixture('// import { resolveSpotRef } from "@/components/risk/chip";'))).toEqual([]);
    expect(scan(fixture('/* import { resolveSpotRef } from "@/components/risk/chip"; */'))).toEqual([]);
    // A directive under a licence comment still counts…
    expect(isClientModule('// a note\n\n"use client";\n')).toBe(true);
    // …one below real code does not.
    expect(isClientModule('import x from "y";\n"use client";\n')).toBe(false);
  });
});
