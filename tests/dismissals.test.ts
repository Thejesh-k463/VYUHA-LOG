import { describe, expect, it } from "vitest";
import {
  situationFingerprint,
  isDismissed,
  pruneDismissals,
  PER_SUBJECT_PANELS,
  type Dismissal,
  type DismissiblePanel,
} from "@/lib/domain/dismissals";

/**
 * Dismiss-with-memory. The property that makes it honest: a panel stays hidden
 * only while the facts it described are unchanged. Any real change to the
 * situation — one more item, one fewer, a different quantity — resurfaces it.
 */

const d = (panel: string, fingerprint: string): Dismissal => ({ panel, fingerprint, dismissedAt: "2026-08-06T00:00:00Z" });

describe("situationFingerprint", () => {
  it("is stable for the same situation", () => {
    expect(situationFingerprint(["1:10", "2:20"])).toBe(situationFingerprint(["1:10", "2:20"]));
  });

  it("is order-independent — a query returning rows differently must not resurface the panel", () => {
    expect(situationFingerprint(["2:20", "1:10"])).toBe(situationFingerprint(["1:10", "2:20"]));
  });

  it("changes when an item is added", () => {
    expect(situationFingerprint(["1:10"])).not.toBe(situationFingerprint(["1:10", "2:20"]));
  });

  it("changes when an item is removed", () => {
    expect(situationFingerprint(["1:10", "2:20"])).not.toBe(situationFingerprint(["1:10"]));
  });

  it("changes when a fact inside an item changes", () => {
    // Same holding, different quantity — the situation moved, the panel returns.
    expect(situationFingerprint(["1:10"])).not.toBe(situationFingerprint(["1:15"]));
  });

  it("mixed number/string items fingerprint identically", () => {
    expect(situationFingerprint([1, 2])).toBe(situationFingerprint(["1", "2"]));
  });
});

describe("isDismissed", () => {
  it("hides only the matching panel + fingerprint pair", () => {
    const ds = [d("unmarked-holdings", "abc")];
    expect(isDismissed(ds, "unmarked-holdings", "abc")).toBe(true);
    expect(isDismissed(ds, "unmarked-holdings", "def")).toBe(false); // data changed
    expect(isDismissed(ds, "acquisition-basis", "abc")).toBe(false); // other panel
  });

  it("an empty store hides nothing", () => {
    expect(isDismissed([], "unmarked-holdings", "abc")).toBe(false);
  });
});

describe("pruneDismissals", () => {
  it("keeps a dismissal whose situation still exists", () => {
    const ds = [d("unmarked-holdings", "abc")];
    const current = new Map([["unmarked-holdings", "abc"]] as const);
    expect(pruneDismissals(ds, current as never)).toHaveLength(1);
  });

  it("drops a dismissal whose situation moved on", () => {
    // The stale fingerprint must not linger where a future state could collide.
    const ds = [d("unmarked-holdings", "old")];
    const current = new Map([["unmarked-holdings", "new"]] as const);
    expect(pruneDismissals(ds, current as never)).toHaveLength(0);
  });

  it("drops dismissals for panels the app no longer computes", () => {
    const ds = [d("unmarked-holdings", "abc"), d("gone-panel", "zzz")];
    const current = new Map([["unmarked-holdings", "abc"]] as const);
    expect(pruneDismissals(ds, current as never).map((x) => x.panel)).toEqual(["unmarked-holdings"]);
  });
});

/**
 * R13 — "Keep my mark" on /risk is ONE dismissal PER SYMBOL in one panel
 * (`spot-close-diff`, fingerprint `${SYMBOL}|${close day}|${close paise}`).
 * The one-fingerprint prune would keep one symbol and drop the rest, and its
 * "not in the map ⇒ stale" rule would wipe them all from any caller that only
 * computed the Trades panels. The pure half and lib/queries/dismissals.ts agree.
 */
describe("pruneDismissals — a per-subject panel (spot-close-diff)", () => {
  const SBIN = "SBIN|2026-09-11|82050";
  const TCS_OLD = "TCS|2026-09-10|400000";
  const TCS_NEW = "TCS|2026-09-11|401000";
  const ds = [d("spot-close-diff", SBIN), d("spot-close-diff", TCS_OLD), d("unmarked-holdings", "abc")];

  it("is declared per-subject", () => {
    expect(PER_SUBJECT_PANELS).toContain("spot-close-diff");
  });

  it("keeps a symbol whose close is unchanged and drops the one whose close moved", () => {
    const current = new Map<DismissiblePanel, string | readonly string[]>([
      ["spot-close-diff", [SBIN, TCS_NEW]],
      ["unmarked-holdings", "abc"],
    ]);
    expect(pruneDismissals(ds, current).map((x) => x.fingerprint)).toEqual([SBIN, "abc"]);
  });

  it("a prune that does not name the panel leaves every spot dismissal alone", () => {
    const current = new Map<DismissiblePanel, string>([["unmarked-holdings", "abc"]]);
    expect(pruneDismissals(ds, current).map((x) => x.fingerprint)).toEqual([SBIN, TCS_OLD, "abc"]);
  });

  it("isDismissed finds one symbol's row among several", () => {
    expect(isDismissed(ds, "spot-close-diff", TCS_OLD)).toBe(true);
    expect(isDismissed(ds, "spot-close-diff", TCS_NEW)).toBe(false);
  });
});
