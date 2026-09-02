import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * /lenses — the drill-down race (v3.7.0 adversarial audit, C-2).
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * Only the clicked row carried `disabled={busy === group.key}`, so a second
 * group could be opened while the first was still fetching. Both responses
 * then painted, unconditionally, in RESPONSE order: click a large (slow) group
 * and then a small one and the small one appeared first, then the large one
 * overwrote it and the user was left in the group they had clicked FIRST.
 * `busy` was cleared by whichever finished first, re-enabling a row that was
 * still loading, and a response outstanding across a tab switch re-opened a
 * drill-down that had already been closed.
 *
 * The numbers were never wrong — `openDetail` is key-matched, so a detail from
 * one group cannot render against another group's row. This is the wrong
 * SCREEN, which is exactly the class of defect a data-shaped test misses.
 *
 * ── Why this is a source guard ─────────────────────────────────────────────
 *
 * `lenses-client.tsx` is a client component and vitest runs in the node
 * environment by design (vitest.config.ts) — there is no DOM here and nothing
 * to render the race against. The house answer to that is the guard style
 * `tests/render-windowing.test.ts` already applies to this very file: read the
 * real source and pin the invariant. What is pinned here is ORDER — that every
 * `await` of the members fetch is followed by a ticket comparison BEFORE any
 * state is written — which is the one property that makes a stale response
 * unable to paint.
 */

const ROOT = path.resolve(__dirname, "..");
const CLIENT = fs.readFileSync(path.join(ROOT, "components/lenses/lenses-client.tsx"), "utf8");

/** The file with its comments removed. No literal in it contains "//", so a
 *  regex sweep is safe here and the header prose (which discusses the banned
 *  effect by name) stops answering for the code. */
const CODE = CLIENT.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");

/** Every `setX(` call this file makes — the things that can paint a screen. */
const SETTERS = /\b(setDetail|setOpenKey|setBusy|setDeleting)\s*\(/g;

/** The body of one top-level `const name = ... => { … }` handler. */
function handler(name: string): string {
  const at = CLIENT.indexOf(`const ${name} = `);
  expect(at, `${name} is gone from lenses-client`).toBeGreaterThan(0);
  const rest = CLIENT.slice(at);
  // Handlers are separated by a blank line followed by two-space indentation
  // or a comment — stopping at the next `  const ` declaration is enough.
  const end = rest.indexOf("\n  const ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("a superseded drill-down fetch paints nothing", () => {
  it("every navigation takes a ticket, and the ticket lives in a ref", () => {
    // A ref, not state: it has to be readable and bumpable inside an async
    // handler without re-rendering, and without an effect (AGENTS.md).
    expect(CLIENT).toMatch(/const nav = React\.useRef\(0\)/);
    expect(CLIENT).toMatch(/const claim = \(\) => \+\+nav\.current/);
    for (const fn of ["selectTab", "closeGroup", "openGroup", "askDelete"]) {
      expect(handler(fn), `${fn} does not claim a ticket`).toMatch(/claim\(\)/);
    }
  });

  it("openGroup compares its ticket BEFORE it writes anything", () => {
    const body = handler("openGroup");
    const awaited = body.indexOf("await fetchGroup(");
    const guard = body.indexOf("ticket !== nav.current");
    expect(awaited, "openGroup no longer awaits the members fetch").toBeGreaterThan(0);
    expect(guard, "openGroup lost its staleness guard").toBeGreaterThan(awaited);
    // Nothing may paint between the await and the guard — not the detail, not
    // the open key, and not `busy`, which belongs to whatever is still in
    // flight rather than to the request that lost.
    const between = body.slice(awaited, guard);
    expect(between.match(SETTERS), `a setState runs before the guard:\n${between}`).toBeNull();
    // …and the guard's answer is to leave, not to fall through.
    expect(body.slice(guard, guard + 60)).toMatch(/return;/);
  });

  it("askDelete compares its ticket too — a stale preview arms the wrong group", () => {
    // The one place a wrong screen becomes a wrong ACTION: the delete dialog
    // is confirmed against whatever preview is loaded into it.
    const body = handler("askDelete");
    const awaited = body.indexOf("await fetchGroup(");
    const guard = body.indexOf("ticket !== nav.current");
    expect(awaited).toBeGreaterThan(0);
    expect(guard, "askDelete lost its staleness guard").toBeGreaterThan(awaited);
    const between = body.slice(awaited, guard);
    expect(between.match(SETTERS), `a setState runs before the guard:\n${between}`).toBeNull();
    expect(body.indexOf("setDeleting("), "the preview is armed before the guard").toBeGreaterThan(guard);
  });

  it("leaving a group is a navigation, so a fetch in the air cannot re-open it", () => {
    // Back, tab switch and a completed delete all had the same hole: they
    // cleared `openKey`, and then a late response set it again.
    expect(CLIENT).toMatch(/onBack=\{closeGroup\}/);
    expect(handler("selectTab")).toMatch(/setOpenKey\(null\)/);
    expect(handler("closeGroup")).toMatch(/setOpenKey\(null\)/);
    // The delete dialog's onDone routes through the same close.
    const onDone = CLIENT.slice(CLIENT.indexOf("onDone={() => {"));
    expect(onDone.slice(0, 200)).toMatch(/closeGroup\(\)/);
  });

  it("the guard is not bought with an effect", () => {
    // The file's own header promises the fetch is started from click handlers
    // and never from an effect keyed on state — the shape AGENTS.md bans.
    expect(CODE, "a useEffect appeared in lenses-client").not.toMatch(/useEffect/);
    expect(CODE, "the scanner stripped the whole file").toMatch(/const openGroup = async/);
  });
});
