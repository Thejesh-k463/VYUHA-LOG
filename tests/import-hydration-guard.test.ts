import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Hydration guard for the /import surface (v3.8 Wave 4).
 *
 * The production perf sweep reported `Minified React error #418` on /import —
 * "Hydration failed because the server rendered HTML didn't match the
 * client". React then throws the server markup away and re-renders the whole
 * tree on the client: a flash, a paint-time cost on every visit, and any
 * server-rendered state (focus, scroll, form values) lost. Dev mode named the
 * cause: `In HTML, <div> cannot be a descendant of <p>` — a <Badge> (which
 * renders a <div>) inside <p data-testid="save-target">. The HTML parser
 * closes a <p> the moment it meets a block element, so the DOM the browser
 * builds from the server HTML can NEVER equal the tree React renders, no
 * matter how deterministic the data is.
 *
 * The other way the same error appears is a value that differs between the
 * two renders: `Date.now()`, `toLocaleString()` (the server's locale and zone
 * are not the user's), a `localStorage`/`window` read, or `typeof window`
 * branching. The sanctioned answer for those is `useStoredValue` /
 * `useSyncExternalStore` (components/layout/use-stored-value.ts): the server
 * snapshot renders the default and the live value lands after hydration.
 *
 * vitest runs in node with no DOM, so this pins the SOURCE of the four
 * components the page is built from. Behaviour under a real browser is the
 * perf sweep (scripts/perf-sweep.mjs), which fails on any console error.
 */

const FILES = [
  "components/import/broker-connect.tsx",
  "components/import/remove-broker-panel.tsx",
  "components/import/import-client.tsx",
  "app/import/page.tsx",
];

// CRLF on disk (Windows checkout) — normalise so offsets and regexes agree.
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

/** Source with prose blanked — `//` lines, `*` doc lines and brace-star JSX
 *  comments talk ABOUT <p> and <div>; only markup counts. Blanked to spaces,
 *  not cut, so a failure's line number still points at the file. */
const markupOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*(\/\/|\*|\/\*)[^\n]*/gm, (c) => c.replace(/[^\n]/g, " "));

/** Elements the HTML parser refuses inside <p>: raw block tags, plus the UI
 *  primitives that render one. Badge is a <div>; Card/CardContent are <div>s. */
const BLOCK_IN_P = /<(div|p|ul|ol|li|table|section|article|header|footer|h[1-6]|pre|blockquote|form|Badge|Card|CardHeader|CardContent|CardTitle|Alert|Table)\b/;

describe("invalid HTML nesting on /import — the #418 the sweep caught", () => {
  for (const rel of FILES) {
    it(`${rel}: no block element or Badge inside a <p>`, () => {
      const src = markupOnly(read(rel));
      const offenders: string[] = [];
      // <p> cannot nest, so the first </p> after an opening <p> closes it.
      const open = /<p(\s[^>]*)?>/g;
      let m: RegExpExecArray | null;
      while ((m = open.exec(src))) {
        const close = src.indexOf("</p>", m.index);
        if (close === -1) break;
        const body = src.slice(m.index + m[0].length, close);
        const hit = BLOCK_IN_P.exec(body);
        if (hit) offenders.push(`line ${lineOf(src, m.index)}: <p> contains <${hit[1]}> — the browser closes the <p> first, so server HTML ≠ client tree (React #418)`);
        open.lastIndex = close;
      }
      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }
});

/** A top-level declaration's name; components are UpperCamel, helpers are not. */
function enclosingDeclaration(src: string, idx: number): string | null {
  const head = src.slice(0, idx);
  const decls = [...head.matchAll(/^(?:export )?(?:async )?(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=)/gm)];
  const last = decls[decls.length - 1];
  return last ? (last[1] ?? last[2] ?? null) : null;
}

const RENDER_HAZARDS = /\b(toLocaleString|toLocaleDateString|toLocaleTimeString|Date\.now)\(|\blocalStorage\b|\bsessionStorage\b|typeof window/g;
const IDIOM = /useStoredValue\(|useSyncExternalStore\(/;

describe("time, locale and storage never reach the server render of /import", () => {
  for (const rel of FILES) {
    it(`${rel}: hazards live in helpers or behind the post-mount idiom, never directly in a component body`, () => {
      const src = markupOnly(read(rel));
      const offenders: string[] = [];
      for (const m of src.matchAll(RENDER_HAZARDS)) {
        const lineNo = lineOf(src, m.index!);
        const line = src.split("\n")[lineNo - 1] ?? "";
        if (IDIOM.test(line)) continue; // the sanctioned idiom: server snapshot is the default
        const decl = enclosingDeclaration(src, m.index!);
        // A component (UpperCamel) evaluating the hazard in its own body puts
        // it on the SSR path. A lowercase helper is only as safe as its input:
        // the pin below keeps that input client-fetched.
        if (decl && /^[A-Z]/.test(decl)) offenders.push(`${rel}:${lineNo} in <${decl}>: ${m[0]} — renders on the server too; read it via useStoredValue/useSyncExternalStore or after mount`);
      }
      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }

  it("broker-connect: the rows that feed formatTs/tokenExpired start EMPTY, so the locale strings never SSR", () => {
    // `formatTs` (toLocaleString) and `tokenExpired` (Date.now) are pure
    // helpers; ModeBadge renders them for every row of `conns`. That is only
    // hydration-safe because the first render has no rows — the list arrives
    // by client fetch. Seed it from props and the mode pill drifts by zone.
    const src = read("components/import/broker-connect.tsx");
    expect(src).toMatch(/useState<ConnStatus\[\]>\(\[\]\)/);
  });

  it("no suppressHydrationWarning and no typeof-window branching anywhere on the page", () => {
    for (const rel of FILES) {
      const src = markupOnly(read(rel));
      expect(src, `${rel} hides a mismatch instead of fixing it`).not.toContain("suppressHydrationWarning");
      expect(src, `${rel} branches on typeof window`).not.toMatch(/typeof window/);
    }
  });
});
