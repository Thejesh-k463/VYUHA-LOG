import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A-11 — EVERY "Import → x" BREADCRUMB NAMES SOMETHING THE IMPORT PAGE HAS.
 *
 * The v4.2 wave coined "Import → Brokers" and spread it through 29 user-facing
 * strings in 11 files. No element in the app carries the word "Brokers": the
 * page title is "Import" (`app/import/page.tsx`) and the card the reader is
 * being sent to is titled "Connect broker (API) — Zerodha, Dhan, Angel One &
 * Upstox" (`components/import/broker-connect.tsx`). Pre-wave copy said
 * "Import → Connect broker" eleven times, and that is the ruling.
 *
 * A one-off search-and-replace does not survive the next wave, so this reads
 * the LABELS OUT OF THE SOURCE and holds every breadcrumb to them:
 *
 *   • "Connect broker"          ← the card's own <CardTitle>, minus its
 *                                 "(API) — …" tail. Rename the card and this
 *                                 guard moves with it; retype the breadcrumb
 *                                 by hand and it fails.
 *   • "OpenAlgo (self-hosted)"  ← the tab label in the same file. The BARE
 *                                 "Import → OpenAlgo" stays banned, which is
 *                                 what `tests/live-feed-copy.test.ts` (N1)
 *                                 already says: the tab is the second step,
 *                                 not a destination you can reach cold.
 *   • "Broker Truth"            ← `app/reports/reconcile/page.tsx`'s own
 *                                 PageHeader title, kept because the Import
 *                                 screen really does link to it
 *                                 ("Open Broker Truth →", import-client.tsx).
 *
 * A BREADCRUMB IS A CAPITALISED TARGET. "Import → pick the kind of file you
 * have" (docs/client/README.md) is prose about the flow, not a claim about a
 * label, so the scan starts at an upper-case letter or an opening bracket.
 * Widening it to lower case would make the guard argue with English.
 */

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Comment-stripped, exactly as the sibling copy guards do: a citation comment
 *  quoting the wording it replaced is the record of why, not a live claim. */
const stripComments = (src: string) =>
  src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CARD = "components/import/broker-connect.tsx";
const RECONCILE = "app/reports/reconcile/page.tsx";
const IMPORT_CLIENT = "components/import/import-client.tsx";

/* ───────────────────────── the labels, read from source ──────────────────── */

/** The connect card's title, as rendered — never re-typed in this file. */
function cardTitle(): string {
  const m = read(CARD).match(/<CardTitle>\s*\n\s*([^<{\n]+)/);
  expect(m, `${CARD} no longer renders a plain-text <CardTitle> this guard can read`).not.toBeNull();
  return m![1].trim();
}

/** "Connect broker (API) — Zerodha, …" → "Connect broker". */
function connectBrokerLabel(): string {
  return cardTitle().split(/\s+\(/)[0].trim();
}

/** The OpenAlgo tab's own label, from the same file. */
function openAlgoTabLabel(): string {
  const tabs = [...read(CARD).matchAll(/tab:\s*"([^"]+)"/g)].map((m) => m[1]);
  const tab = tabs.find((t) => /openalgo/i.test(t));
  expect(tab, `${CARD} no longer declares an OpenAlgo tab`).toBeDefined();
  return tab!;
}

/** The Broker Truth screen's own PageHeader title. */
function brokerTruthLabel(): string {
  const m = read(RECONCILE).match(/title="([^"]+)"/);
  expect(m, `${RECONCILE} no longer sets a PageHeader title`).not.toBeNull();
  return m![1];
}

function allowedLabels(): string[] {
  return [connectBrokerLabel(), openAlgoTabLabel(), brokerTruthLabel()];
}

/* ────────────────────────────── the scanned set ──────────────────────────── */

function walk(rel: string, keep: (f: string) => boolean): string[] {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(child, keep));
    else if (keep(e.name)) out.push(child);
  }
  return out;
}

const isSource = (f: string) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx");

/** Every surface whose copy a user reads a breadcrumb on. */
function scanned(): string[] {
  return [
    ...walk("lib/domain", isSource),
    "lib/live/connect-prompt.ts",
    ...walk("lib/quotes", isSource),
    ...walk("components", isSource),
    ...walk("app/api/live", isSource),
    ...walk("docs/client", (f) => f.endsWith(".md")),
    "README.md",
  ];
}

/** Copy as a reader meets it: comments gone, wrapping flattened (PRIVACY.md
 *  breaks "Import →" and its target across two lines). */
function copyOf(rel: string): string {
  const raw = read(rel);
  const text = /\.tsx?$/.test(rel) ? stripComments(raw) : raw;
  return text.replace(/\s+/g, " ");
}

/* ─────────────────────────────── the checker ─────────────────────────────── */

/** Every breadcrumb in `text` whose target is not one of `labels`. */
function offendersIn(text: string, labels: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/Import → (?=[A-Z(])/g)) {
    const tail = text.slice(m.index! + m[0].length, m.index! + m[0].length + 60);
    if (!labels.some((l) => tail.startsWith(l))) out.push(`Import → ${tail}`);
  }
  return out;
}

/** The files this builder owns — green now, whatever the concurrent waves do. */
const B4_OWNED = [
  "lib/domain/help-content.ts",
  "lib/domain/import-help-content.ts",
  "lib/domain/live-feed-disclosure.ts",
  "lib/live/connect-prompt.ts",
  "docs/client/PRIVACY.md",
  "docs/client/README.md",
  "README.md",
];

describe("the Import breadcrumb names a label the Import page actually has (A-11)", () => {
  it("reads the three labels out of the source rather than restating them", () => {
    expect(cardTitle(), "the connect card's title no longer names the connection").toMatch(/^Connect broker/);
    expect(connectBrokerLabel()).toBe("Connect broker");
    expect(openAlgoTabLabel()).toMatch(/^OpenAlgo/);
    expect(brokerTruthLabel()).toBe("Broker Truth");
    // …and the Import screen really does send the reader to that second screen,
    // which is why its breadcrumb is allowed at all.
    expect(read(IMPORT_CLIENT), "the Import screen no longer links to Broker Truth").toContain("Broker Truth");
  });

  it("the checker fires on the coined breadcrumb and passes the real one", () => {
    const labels = allowedLabels();
    expect(offendersIn("Add Upstox under Import → Brokers first.", labels)).toHaveLength(1);
    expect(offendersIn("Add Upstox under Import → Connect broker first.", labels)).toEqual([]);
    expect(offendersIn("A screen (Import → Broker Truth) shows the broker's own numbers.", labels)).toEqual([]);
    // Prose is not a breadcrumb: a lower-case target is left alone.
    expect(offendersIn("Import → pick the kind of file you have.", labels)).toEqual([]);
    // The bare tab name is still not a destination (N1, live-feed-copy).
    expect(offendersIn("Paste the key under Import → OpenAlgo.", labels)).toHaveLength(1);
  });

  it("no B4-owned copy surface names a label the Import page does not have", () => {
    const labels = allowedLabels();
    const bad = B4_OWNED.flatMap((rel) => offendersIn(copyOf(rel), labels).map((o) => `${rel}: ${o}`));
    expect(bad, `breadcrumbs naming nothing:\n${bad.join("\n")}`).toEqual([]);
  });

  it("no copy surface anywhere names a label the Import page does not have", () => {
    const labels = allowedLabels();
    const bad = scanned().flatMap((rel) => offendersIn(copyOf(rel), labels).map((o) => `${rel}: ${o}`));
    expect(bad, `breadcrumbs naming nothing:\n${bad.join("\n")}`).toEqual([]);
  });

  it('the coined phrase "Import → Brokers" appears on no surface at all', () => {
    const carriers = scanned().filter((rel) => copyOf(rel).includes("Import → Brokers"));
    expect(carriers, `still coining a screen that does not exist: ${carriers.join(", ")}`).toEqual([]);
  });
});
