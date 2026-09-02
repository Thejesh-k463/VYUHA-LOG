import "server-only";
import { getSettings } from "./settings";
import { getSelectedAccount } from "./accounts";

/**
 * The one copy of the `account ?? settings ?? 0` capital chain.
 *
 * It lives in its OWN module, not in `./capital`, on purpose: `capital.ts`
 * imports `./trades` and `./ipos` at module level for `getCapitalSummary`, and
 * the pre-trade limit path (`./limits`) and the cash ledger (`./ledger`) need
 * the chain WITHOUT inheriting that graph. This module imports only `./settings`
 * and `./accounts`, both of which reach nothing but `lib/db` — so there is no
 * cycle and nothing heavy to drag along. `./capital` re-exports it, so every
 * existing importer keeps working unchanged.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface BucketCapital {
  equityCapital: number;
  activeCapital: number;
  totalCapital: number;
}

/**
 * The bucket capitals every denominator should use, resolved ACCOUNT-FIRST:
 * the selected account's own figure wins, the global settings row is only the
 * single-account fallback (migration 0044 moved capital onto accounts; the
 * settings columns remain for installs that never created a second account).
 * The aggregate view ("All accounts", id 0) has no single account to ask, so
 * it reads the settings row — unchanged behaviour for that case.
 *
 * Pages that read `settings.equityCapital` directly silently show the GLOBAL
 * figure in a per-account view (the defect this helper was extracted for — the
 * performance page in v3.6, its eight siblings in v3.7). 0 still means NOT
 * CONFIGURED (invariant 6): callers render "—", a nudge, or a skipped check,
 * never a return on an invented base.
 */
export function getBucketCapital(): BucketCapital {
  const s = getSettings();
  const account = getSelectedAccount();
  const equityCapital = account?.equityCapital ?? s?.equityCapital ?? 0;
  const activeCapital = account?.activeCapital ?? s?.activeCapital ?? 0;
  return { equityCapital, activeCapital, totalCapital: r2(equityCapital + activeCapital) };
}
