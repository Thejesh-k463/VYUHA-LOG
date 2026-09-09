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
}

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
    for (const m of src.matchAll(IMPORT_RE)) {
      const [clause, spec] = [m[1], m[2]];
      if (/^\s*type\b/.test(clause)) continue; // `import type { … } from …`
      const target = resolveSpecifier(spec, rel, sources);
      if (!target || !isClientModule(sources.get(target)!)) continue;
      const startLine = src.slice(0, m.index).split(/\r?\n/).length;
      const lineOf = (offsetInMatch: number) =>
        startLine + m[0].slice(0, offsetInMatch).split(/\r?\n/).length - 1;

      const ns = /\*\s*as\s+[A-Za-z_$][\w$]*/.exec(clause);
      if (ns) {
        offenders.push({
          key: `${rel}:* as`,
          file: rel,
          line: lineOf(m[0].indexOf(ns[0])),
          name: ns[0],
          from: spec,
        });
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
        offenders.push({ key: `${rel}:${name}`, file: rel, line: at >= 0 ? lineOf(at) : startLine, name, from: spec });
      }
    }
  }
  return offenders;
}

const describeOffender = (o: Offender) =>
  `${o.file}:${o.line} imports \`${o.name}\` from "${o.from}" ("use client") — Next turns it into a throwing client reference`;

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

  it("does not read a commented-out import, or a `use client` that is not the first statement", () => {
    expect(scan(fixture('// import { resolveSpotRef } from "@/components/risk/chip";'))).toEqual([]);
    expect(scan(fixture('/* import { resolveSpotRef } from "@/components/risk/chip"; */'))).toEqual([]);
    // A directive under a licence comment still counts…
    expect(isClientModule('// a note\n\n"use client";\n')).toBe(true);
    // …one below real code does not.
    expect(isClientModule('import x from "y";\n"use client";\n')).toBe(false);
  });
});
