import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { UNJOIN_MENU_LABEL } from "@/lib/import/close-open-lots";
import { everyRIsARisk } from "@/components/edge-clinic/decay-card";

/**
 * v4.8.0 FIX-A — the COPY the review requires (J-3 UI / Help; D-2), pinned as
 * text so a later edit cannot silently drop the door's name or the backup caveat.
 *
 *  • Help (Data Quality, Trades) and the stale-lot dialog's hint name the ONE
 *    label (`UNJOIN_MENU_LABEL`) and say Deleted items are not part of a backup.
 *  • The Trades row menu offers the un-join from the wire flag `staleJoined`.
 *  • D-2: Help's rupee-line sentence states the rule the card computes
 *    (`everyRIsARisk`: no cap-unit R, none unclassified, at least one real risk;
 *    trades with no R are outside the sample) — checked against the function.
 */

const read = (p: string) => fs.readFileSync(p, "utf8");
const entry = (href: string) => HELP_ENTRIES.find((e) => e.href === href)!;

describe("FIX-A copy — the un-join door is named where the join is confirmed and explained", () => {
  it("Help / Data Quality: the undo, its label, and that Deleted items are not in a backup", () => {
    const text = entry("/data-quality").body.join(" ");
    expect(text).toContain(`the row's menu → ${UNJOIN_MENU_LABEL}`);
    expect(text).toContain("the removed row comes back from Deleted items");
    expect(text).toContain("not part of a backup");
    expect(entry("/data-quality").keywords).toContain("undo");
  });

  it("Help / Trades: the joined row carries the un-join, not an Un-close; it needs the Deleted items entry a backup does not carry", () => {
    const text = entry("/trades").body.join(" ");
    expect(text).toContain(`carries ${UNJOIN_MENU_LABEL} instead`);
    expect(text).toContain("which a backup does not carry");
  });

  it("the stale-lot dialog's hint (the one-click and the month-only tick) names the label and the backup caveat", () => {
    const src = read("components/quality/stale-lot-fix.tsx");
    expect(src).toContain("export const UNJOIN_HINT");
    expect(src).toContain("You can undo this from Trades (the row's menu → ${UNJOIN_MENU_LABEL})");
    expect(src).toContain("not inside a backup");
    // Shown in BOTH places: the dialog description and the month-only confirmation paragraph.
    expect(src.split("UNJOIN_HINT").length - 1, "the definition and two render sites").toBe(3);
    expect(src).toMatch(/data-stale-month-only-confirm=""[\s\S]*?\{UNJOIN_HINT\}/);
  });

  it("the Trades row menu offers the un-join from `staleJoined` (route handler + fetch + router.refresh, never a server action)", () => {
    const src = read("components/trades/trades-client.tsx");
    expect(src).toContain("row.original.staleJoined && (");
    expect(src).toContain('data-testid="unjoin-stale"');
    expect(src).toContain("aria-label={UNJOIN_MENU_LABEL}");
    expect(src).toContain('fetch("/api/data-quality/unjoin-stale"');
    expect(src).toMatch(/const unJoin = React\.useCallback[\s\S]*?router\.refresh\(\)/);
    expect(src, "a server action would remount the table and reset its state").not.toMatch(/unjoin[\s\S]{0,80}action=/i);
    expect(UNJOIN_MENU_LABEL).toBe("Undo Data Quality join");
  });
});

describe("D-2 — Help's rupee-line sentence states the card's own rule", () => {
  it("the sentence scopes 'every trade' to the R sample and names the two things that hide the line, which is what everyRIsARisk computes", () => {
    const text = entry("/reports/edge-clinic?tab=clinic").body.join(" ");
    expect(text).toContain("counting only the trades that carry an R");
    expect(text).toContain("a trade with no R is not in the card's sample");
    expect(text).toContain("one R from the default per-trade cap, or one that cannot be classified, hides the line");
    // The rule the sentence describes, as the card computes it.
    expect(everyRIsARisk({ cap: 0, unknown: 0, plan: 3, typed: 0, noR: 0 })).toBe(true);
    // D-2's point: rows with NO R are outside the sample and do not hide the line.
    expect(everyRIsARisk({ cap: 0, unknown: 0, plan: 3, typed: 0, noR: 7 }), "trades with no R do not bar the line").toBe(true);
    expect(everyRIsARisk({ cap: 1, unknown: 0, plan: 3, typed: 0, noR: 0 }), "one cap-unit R hides the line").toBe(false);
    expect(everyRIsARisk({ cap: 0, unknown: 1, plan: 3, typed: 0, noR: 0 }), "one unclassified R hides the line").toBe(false);
    expect(everyRIsARisk({ cap: 0, unknown: 0, plan: 0, typed: 0, noR: 0 }), "no real risk at all: no line").toBe(false);
  });
});
