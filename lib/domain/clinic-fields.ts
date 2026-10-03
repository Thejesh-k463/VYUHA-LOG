// The trade forms' Edge Clinic fields (PURE — no DB, no React; invariant 2).
//
// v4.7.0 C2: this lived in app/trades/actions.ts until the UI half moved it.
// That file is "use server", and every async function EXPORTED from a
// "use server" module is a callable server endpoint — a validator does not
// belong on the network. Here it is a plain synchronous function the actions
// call and a unit test reads directly.

import { SETUP_GRADES, type SetupGrade } from "@/lib/analytics/edge-clinic-contract";
import { parseFormNumber } from "@/lib/domain/signal";

/**
 * The raw field, trimmed, with the HTML number input's leading-dot spelling (".5", "-.5" is a
 * valid floating-point number there and is submitted as typed) given its zero. Not a second
 * rule: commas, exponents and everything else stay `parseFormNumber`'s to accept or refuse.
 * (Moved here from app/trades/actions.ts with `clinicFieldsFrom`, which reads it; the actions
 * import this one spelling.)
 */
export const typedNumber = (v: FormDataEntryValue | null): string =>
  String(v ?? "").trim().replace(/^([-+]?)\.(?=\d)/, (_m, sign: string) => `${sign}0.`);

const str = (v: FormDataEntryValue | null): string | null => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

export type ClinicFormFields =
  | { ok: true; setupGrade: SetupGrade | null | undefined; intraHigh: number | null | undefined; intraLow: number | null | undefined }
  | { ok: false; message: string };

/**
 * The setup grade and the typed intra-trade range, read and VALIDATED before
 * anything is written (design D1: refuse with a message, never coerce).
 *
 *   grade  blank = ungraded (null); anything outside SETUP_GRADES is refused.
 *   range  both or neither; per-unit prices (REAL, never paise — invariant 1);
 *          low ≤ high always; on a CLOSED trade also low ≤ min(avgBuy, avgSell)
 *          and high ≥ max(avgBuy, avgSell) — a range that does not contain the
 *          fills is not the range the trade traded in.
 *
 * `mode: "update"` keeps the edit dialog's "absent = not mentioned" rule: a field
 * the form did not post is `undefined` (the stored value is kept), never null.
 */
export function clinicFieldsFrom(
  formData: FormData,
  fills: { closed: boolean; avgBuyPrice: number; avgSellPrice: number },
  mode: "create" | "update",
): ClinicFormFields {
  let setupGrade: SetupGrade | null | undefined = undefined;
  if (mode === "create" || formData.has("setupGrade")) {
    const g = str(formData.get("setupGrade"));
    if (g != null && !(SETUP_GRADES as readonly string[]).includes(g)) {
      return { ok: false, message: `Setup grade “${g}” is not one of ${SETUP_GRADES.join(", ")} (or blank). Nothing was saved.` };
    }
    setupGrade = (g as SetupGrade | null) ?? null;
  }
  let intraHigh: number | null | undefined = undefined;
  let intraLow: number | null | undefined = undefined;
  if (mode === "create" || formData.has("intraHigh") || formData.has("intraLow")) {
    const hs = typedNumber(formData.get("intraHigh"));
    const ls = typedNumber(formData.get("intraLow"));
    const h = hs === "" ? null : parseFormNumber(hs);
    const l = ls === "" ? null : parseFormNumber(ls);
    if ((h == null) !== (l == null)) {
      return { ok: false, message: "Enter both the intra-trade high and the intra-trade low, or leave both blank. Nothing was saved." };
    }
    if (h != null && l != null) {
      if (!Number.isFinite(h) || !Number.isFinite(l) || h < 0 || l < 0) {
        return { ok: false, message: "The intra-trade high and low must be prices of 0 or more. Nothing was saved." };
      }
      if (l > h) return { ok: false, message: `Intra-trade low ${l} is above the high ${h}. Nothing was saved.` };
      if (fills.closed) {
        const lo = Math.min(fills.avgBuyPrice, fills.avgSellPrice);
        const hi = Math.max(fills.avgBuyPrice, fills.avgSellPrice);
        if (l > lo) return { ok: false, message: `Intra-trade low ${l} is above a fill (${lo}) — the low must be at or below both the buy and the sell price. Nothing was saved.` };
        if (h < hi) return { ok: false, message: `Intra-trade high ${h} is below a fill (${hi}) — the high must be at or above both the buy and the sell price. Nothing was saved.` };
      }
    }
    intraHigh = h;
    intraLow = l;
  }
  return { ok: true, setupGrade, intraHigh, intraLow };
}
