/**
 * THE TYPED "your broker session is over" ERROR (v4.7.0 wave C6, design review R8).
 *
 * A native pull (Fyers, Kotak Neo, Nuvama) throws `BrokerAuthExpired` — and
 * ONLY this — when the broker itself STATES that the token or session is no
 * longer good (Fyers −8/−15/−16/−17 or HTTP 401; Kotak 401/403 or stCode 1003;
 * Nuvama 222 on logindata, 401 / EGN0011 "Session Expired"). The route maps it
 * to a 409 carrying `need` and clears the cached token/session; every other
 * throw stays a 502. Without the type a dead session read as "the broker is
 * down", and the cached token that caused it was kept for the next pull.
 *
 *   needsAuthCode — Fyers: open the login URL again and paste the new auth_code.
 *   needsLogin    — Kotak: log in again (nothing is cached, the next pull does);
 *                   Nuvama: open the login URL again and paste the new requestId.
 */

import type { Broker } from "@/lib/domain/constants";

export type BrokerAuthNeed = "needsAuthCode" | "needsLogin";

export class BrokerAuthExpired extends Error {
  readonly broker: Broker;
  readonly need: BrokerAuthNeed;

  constructor(broker: Broker, need: BrokerAuthNeed, message: string) {
    super(message);
    this.name = "BrokerAuthExpired";
    this.broker = broker;
    this.need = need;
  }
}

/**
 * True for a `BrokerAuthExpired`. Checks the SHAPE as well as `instanceof`: a
 * bundler can load this module twice (server chunk vs route chunk), and then
 * `instanceof` alone answers false for a real one — the 409 would silently
 * become a 502 again.
 */
export function isBrokerAuthExpired(e: unknown): e is BrokerAuthExpired {
  if (e instanceof BrokerAuthExpired) return true;
  if (!(e instanceof Error) || e.name !== "BrokerAuthExpired") return false;
  const x = e as Partial<BrokerAuthExpired>;
  return (x.need === "needsAuthCode" || x.need === "needsLogin") && typeof x.broker === "string";
}
