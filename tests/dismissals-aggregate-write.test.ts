import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import type { DismissiblePanel } from "@/lib/domain/dismissals";

/**
 * D-3 — a panel dismissal recorded from the All-accounts view must be REFUSED,
 * not filed against whichever account sorts first (invariant 9).
 *
 * The shipped bug: all three writers in lib/queries/dismissals.ts asked
 * `getWriteAccountId()`, whose no-selection fallback is the lowest account id.
 * Probed: `POST /api/dismissals` in the aggregate view → 200,
 * `panel_dismissals.account_id = 1`.
 *
 * Why it is not merely cosmetic. Reads in the aggregate view are UNSCOPED, so
 * the row looks right from there. But `situationFingerprint` is computed from
 * the rows on screen, so when account #1 happens to be the only account with
 * the situation the aggregate view describes, the two fingerprints are the
 * SAME string — and account #1 alone then quietly stops being warned about its
 * own unmarked holdings. That case is the last test in the first group.
 *
 * THE JUDGEMENT CALL: the alternative was a fan-out (write the dismissal to
 * every account, mirroring how the aggregate READS). Rejected: it does not
 * actually fix the leak — the fingerprint-collision case above still hides the
 * panel for that one account — and it invents a write pattern this codebase
 * does not have. Refusing is the house shape (lib/queries/review.ts,
 * lib/queries/challans.ts): resolve to null in the aggregate view and return
 * the `forbidden` marker for the route to map to 403.
 *
 * FOLLOW-UP OUTSIDE THIS FILE SET: `app/api/dismissals/route.ts` still discards
 * these results and answers `{ok:true}`. Nothing lies to the user today — the
 * only client (components/trades/unmarked-holdings-panel.tsx) shows no toast at
 * all, it just refreshes, so a refused dismissal simply leaves the panel up —
 * but that route wants the one-line `res.forbidden ? 403 : 400` mapping the
 * bf-losses route already has.
 */

let t: TempDb;
let q: typeof import("@/lib/queries/dismissals");

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

const PANEL = "unmarked-holdings" as const;
const FP = "fingerprint-abc123";

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

const rows = () => t.db.select().from(t.schema.panelDismissals).all();

beforeAll(async () => {
  t = await openTempDb("dismissals-aggregate", { seed: true });
  q = await import("@/lib/queries/dismissals");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
});

afterAll(() => t?.cleanup());

describe("D-3: the All-accounts view may not record a dismissal", () => {
  it("REFUSES the dismissal the probe filed against account #1, with the forbidden marker", () => {
    selectAccount(ALL);
    const res = q.dismissPanel(PANEL, FP);

    expect(res.ok).toBe(false);
    expect(res.forbidden).toBe(true); // the route maps this to 403, not 400
    expect(res.message).toMatch(/pick an account in the sidebar/i);

    // THE assertion. Reverting to getWriteAccountId() puts a row on account #1.
    expect(rows()).toHaveLength(0);
  });

  it("refuses the restore and the prune too — a delete guessed at is the same bug", () => {
    selectAccount(ALL);
    expect(q.undismissPanels().forbidden).toBe(true);
    expect(q.undismissPanels(PANEL).forbidden).toBe(true);
    expect(q.pruneStaleDismissals(new Map([[PANEL, FP]])).forbidden).toBe(true);
  });

  it("an existing per-account dismissal survives an aggregate-view restore", () => {
    selectAccount(SWING);
    expect(q.dismissPanel(PANEL, "swing-only").ok).toBe(true);
    selectAccount(ALL);
    q.undismissPanels();
    q.pruneStaleDismissals(new Map([[PANEL, "something-else"]]));
    // Both would have deleted account #1's rows before; neither may reach
    // account #2's, which is what the aggregate view resolved to here.
    expect(rows().map((r) => [r.accountId, r.fingerprint])).toEqual([[SWING, "swing-only"]]);
    selectAccount(SWING);
    expect(q.undismissPanels().ok).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  it("the leak in full: an aggregate dismissal used to hide the panel for account #1 alone", () => {
    // When account #1 is the only account holding the situation, the aggregate
    // view's fingerprint IS account #1's fingerprint. The old code wrote that
    // row onto account #1, so switching to that account found the advisory
    // already dismissed — a decision it never made.
    const shared = "one-account-holds-it";
    selectAccount(ALL);
    expect(q.dismissPanel(PANEL, shared).ok).toBe(false);

    selectAccount(PRIMARY);
    expect(q.panelHidden(PANEL, shared)).toBe(false); // still warned, correctly
    selectAccount(SWING);
    expect(q.panelHidden(PANEL, shared)).toBe(false);
  });
});

describe("the per-account path still works — the guard must not over-refuse", () => {
  it("a selected account records its own dismissal, and only its own", () => {
    selectAccount(SWING);
    const res = q.dismissPanel(PANEL, FP);
    expect(res.ok).toBe(true);
    expect(res.forbidden).toBeUndefined();

    expect(rows()).toHaveLength(1);
    expect(rows()[0].accountId).toBe(SWING);

    expect(q.panelHidden(PANEL, FP)).toBe(true);
    selectAccount(PRIMARY);
    expect(q.panelHidden(PANEL, FP)).toBe(false); // the neighbour is unaffected
  });

  it("it is still idempotent — a second dismissal is not a second row", () => {
    selectAccount(SWING);
    expect(q.dismissPanel(PANEL, FP).ok).toBe(true);
    expect(rows()).toHaveLength(1);
  });

  it("the aggregate view still READS every account's dismissals — only the writes changed", () => {
    selectAccount(ALL);
    expect(q.getDismissals().map((d) => d.fingerprint)).toEqual([FP]);
    expect(q.panelHidden(PANEL, FP)).toBe(true);
  });

  it("restore and prune still work for a selected account", () => {
    selectAccount(SWING);
    expect(q.dismissPanel(PANEL, "stale-one").ok).toBe(true);
    expect(rows()).toHaveLength(2);

    // Prune keeps only the fingerprint the app just computed.
    expect(q.pruneStaleDismissals(new Map([[PANEL, FP]])).ok).toBe(true);
    expect(rows().map((r) => r.fingerprint)).toEqual([FP]);

    expect(q.undismissPanels(PANEL).ok).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  it("an empty prune map is a no-op that still reports ok", () => {
    selectAccount(SWING);
    expect(q.dismissPanel(PANEL, FP).ok).toBe(true);
    expect(q.pruneStaleDismissals(new Map()).ok).toBe(true);
    expect(rows()).toHaveLength(1); // nothing computed ⇒ nothing pruned
  });
});

/**
 * R13 — "Keep my mark" on /risk files ONE row PER SYMBOL under one panel,
 * `spot-close-diff`, fingerprint `${SYMBOL}|${close day}|${close paise}`.
 *
 * The trap this pins: `pruneStaleDismissals` kept ONE fingerprint per panel
 * and deleted WHOLESALE every panel missing from its map. Handed the Trades
 * panels only, it would have wiped every kept mark on /risk; handed one spot
 * fingerprint, it would have kept one symbol and deleted the rest. Today only
 * tests call it (grep), which is exactly why the rule must be pinned before a
 * caller appears.
 */
describe("R13: spot-close-diff — the prune can never wipe a symbol whose close is unchanged", () => {
  const SPOT = "spot-close-diff" as const;
  const SBIN = "SBIN|2026-09-11|82050";
  const TCS_OLD = "TCS|2026-09-10|400000";
  const TCS_NEW = "TCS|2026-09-11|401000";
  const spotRows = () =>
    rows()
      .filter((r) => r.panel === SPOT)
      .map((r) => r.fingerprint)
      .sort();

  it("two symbols are two live rows of one panel, read back through the scoped reader", () => {
    selectAccount(SWING);
    expect(q.dismissPanel(SPOT, SBIN).ok).toBe(true);
    expect(q.dismissPanel(SPOT, TCS_OLD).ok).toBe(true);
    expect(spotRows()).toEqual([SBIN, TCS_OLD]);
    expect(q.getDismissedFingerprints(SPOT).sort()).toEqual([SBIN, TCS_OLD]);
    selectAccount(PRIMARY);
    expect(q.getDismissedFingerprints(SPOT)).toEqual([]); // account-scoped read
  });

  it("a prune that does not name the panel (a Trades-panel caller) leaves every spot dismissal alone", () => {
    selectAccount(SWING);
    expect(q.pruneStaleDismissals(new Map([[PANEL, FP]])).ok).toBe(true);
    expect(spotRows()).toEqual([SBIN, TCS_OLD]);
    // …and the one-fingerprint rule still holds for the panel it does name.
    expect(rows().filter((r) => r.panel === PANEL).map((r) => r.fingerprint)).toEqual([FP]);
  });

  it("a prune handed the current closes keeps the unchanged symbol and removes the one whose close moved", () => {
    selectAccount(SWING);
    const current = new Map<DismissiblePanel, string | readonly string[]>([
      [SPOT, [SBIN, TCS_NEW]],
      [PANEL, FP],
    ]);
    expect(q.pruneStaleDismissals(current).ok).toBe(true);
    expect(spotRows()).toEqual([SBIN]);
    expect(rows().filter((r) => r.panel === PANEL)).toHaveLength(1);
  });

  it("the aggregate view still refuses the prune for this panel too", () => {
    selectAccount(ALL);
    expect(q.pruneStaleDismissals(new Map([[SPOT, [] as string[]]])).forbidden).toBe(true);
    selectAccount(SWING);
    expect(spotRows()).toEqual([SBIN]);
  });

  /**
   * T1 (wave 2R). The case above hands ONE unchanged symbol, so a prune that
   * kept only the FIRST fingerprint of the list (`[...fp].slice(0, 1)`) passed
   * it — while wiping every other symbol whose close did not move, which is the
   * whole reason the panel is per-subject. Three unchanged symbols, the moved one
   * in the MIDDLE of the list, so a first-only AND a last-only keep both fail.
   */
  it("T1: several unchanged symbols ALL keep their dismissal; only the moved close loses its row", () => {
    selectAccount(SWING);
    const INFY = "INFY|2026-09-11|150025";
    const RELIANCE = "RELIANCE|2026-09-11|295000";
    for (const fp of [INFY, TCS_OLD, RELIANCE]) expect(q.dismissPanel(SPOT, fp).ok).toBe(true);
    expect(spotRows()).toEqual([INFY, RELIANCE, SBIN, TCS_OLD]);
    // A neighbouring book's row for the same symbol is out of reach of this prune.
    selectAccount(PRIMARY);
    expect(q.dismissPanel(SPOT, TCS_OLD).ok).toBe(true);

    selectAccount(SWING);
    const current = new Map<DismissiblePanel, readonly string[]>([[SPOT, [SBIN, TCS_NEW, INFY, RELIANCE]]]);
    expect(q.pruneStaleDismissals(current).ok).toBe(true);
    expect(
      rows()
        .filter((r) => r.panel === SPOT && r.accountId === SWING)
        .map((r) => r.fingerprint)
        .sort(),
    ).toEqual([INFY, RELIANCE, SBIN]);
    expect(rows().filter((r) => r.panel === SPOT && r.accountId === PRIMARY).map((r) => r.fingerprint)).toEqual([TCS_OLD]);
  });
});
