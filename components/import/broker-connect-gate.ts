/**
 * The broker-connect save gate and its two labels, as PURE functions.
 *
 * No React, no DOM, no DB — node-safe so tests/broker-connect-gate.test.ts can
 * table every case. components/import/broker-connect.tsx wires these in; the
 * rule used to live inline in that component's `disabled` prop, where the one
 * behaviour anyone ever argued about (an empty Client ID box) could not be
 * pinned without rendering the whole form.
 */

export type GateBroker = "zerodha" | "dhan" | "angelone" | "upstox" | "openalgo";

export interface SaveGateState {
  /** A request is in flight (`busy != null` in the component). */
  busy: boolean;
  /** The broker whose form is showing. */
  active: GateBroker;
  /** The key / Client ID box. */
  apiKey: string;
  /** A row already exists for (save-target account, broker) — the server
   *  carries the stored key over when the box is empty (owner ruling
   *  2026-09-04), so an empty box is no longer a reason to block the save. */
  hasSavedRow: boolean;
  /** The pasted access-token box. */
  token: string;
  /** Dhan: the PIN + TOTP toggle, and its explicit consent checkbox. */
  totpMode: boolean;
  consent: boolean;
  /** Shared PIN / TOTP-secret boxes (Dhan TOTP mode, Angel One). */
  pin: string;
  totpSecret: string;
  /** Angel One's client code. */
  clientCode: string;
  /** Zerodha's API secret. */
  apiSecret: string;
  /** OpenAlgo's host and the broker behind the instance. */
  host: string;
  underlyingBroker: string;
  /** The generic branch (Upstox and any future broker): spec.needsToken. */
  needsToken: boolean;
}

/**
 * Is the Save button disabled? Reproduces the component's rule exactly,
 * except that an empty key box blocks only when there is NO saved row to
 * carry the stored key over from.
 */
export function saveDisabled(s: SaveGateState): boolean {
  if (s.busy) return true;
  if (!s.apiKey && !s.hasSavedRow) return true;
  switch (s.active) {
    case "openalgo":
      return !s.host.trim() || !s.underlyingBroker;
    case "angelone":
      return !s.clientCode || !s.pin || !s.totpSecret;
    case "dhan":
      // TOTP mode: PIN + secret + the explicit consent; the pasted token is
      // then optional. Otherwise: token mode.
      return s.totpMode ? !s.pin || !s.totpSecret || !s.consent : !s.token;
    case "zerodha":
      // Either the day's token or the API secret must be there.
      return !s.token && !s.apiSecret;
    default:
      // Upstox: the Analytics token in the key field is the whole credential.
      return s.needsToken ? !s.token : false;
  }
}

/** The GET projection fields the mode label reads (app/api/import/broker). */
export interface ConnectionMode {
  authMode: "totp" | "token" | "none";
  /** ISO timestamp decoded server-side from the stored token's `exp`. */
  tokenExpiresAt: string | null;
}

/**
 * One line saying HOW this connection authenticates and, for a pasted token,
 * WHEN it dies. `formatTs` lets the UI localise the timestamp; the default is
 * the ISO string as the server sent it.
 */
export function connectionModeLabel(
  c: ConnectionMode | null | undefined,
  formatTs: (iso: string) => string = (iso) => iso,
): string {
  if (!c || c.authMode === "none") return "not connected";
  if (c.authMode === "totp") return "PIN + TOTP · mints its own token";
  return c.tokenExpiresAt ? `pasted token · expires ${formatTs(c.tokenExpiresAt)}` : "pasted token · expiry unknown";
}

export interface AccountOption {
  id: number;
  name: string;
}

/**
 * The name of the account a save will write to, so the UI can say "Saving to
 * <name>" — the same resolution the component and the route use:
 *
 *  - a specific account is selected (`selectedAccountId > 0`): that account,
 *    whatever the picker holds (the picker is only rendered in All-accounts);
 *  - All-accounts (0): the picker's choice if it is still in the list, else
 *    the first listed account (a picked id that left the list falls back at
 *    render time, never via an effect);
 *  - nothing to pick from: null — the route then resolves the first real
 *    account, and the UI should say nothing rather than guess a name.
 */
export function saveTargetLabel(accounts: readonly AccountOption[], savePick: number, selectedAccountId: number): string | null {
  if (selectedAccountId > 0) {
    return accounts.find((a) => a.id === selectedAccountId)?.name ?? `Account ${selectedAccountId}`;
  }
  const id = accounts.some((a) => a.id === savePick) ? savePick : (accounts[0]?.id ?? 0);
  if (id <= 0) return null;
  return accounts.find((a) => a.id === id)?.name ?? null;
}
