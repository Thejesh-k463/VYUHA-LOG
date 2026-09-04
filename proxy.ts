import { NextResponse } from "next/server";

/**
 * Cross-site write guard for every `/api` route (v3.8 fix wave).
 *
 * ── The hole ────────────────────────────────────────────────────────────────
 *
 * The journal serves its API on localhost with no origin check anywhere, and
 * `Request.json()` does not care what `Content-Type` says. So a `text/plain`
 * POST is a CORS *simple* request — no preflight, no opt-in from us — and any
 * web page the user happens to have open can reach a destructive route while
 * the app is running:
 *
 *     fetch("http://localhost:3000/api/import/remove-broker", {
 *       method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" },
 *       body: JSON.stringify({ accountId: 1, broker: "paytm", confirm: true }),
 *     })
 *
 * The attacker never reads the reply — the damage is that the route RUNS.
 *
 * ── The check ───────────────────────────────────────────────────────────────
 *
 * `Sec-Fetch-Site` is set by the browser, cannot be forged from page script
 * (it is a forbidden header name), and states the relationship between the
 * initiator and the target:
 *
 *   same-origin  the app's own fetch                → allow
 *   none         typed in the address bar, a tool   → allow
 *   same-site / cross-site  another page's fetch    → 403
 *
 * An ABSENT header is allowed on purpose. Node, curl, the test suite and the
 * Tauri shell's own non-browser requests send no such header, and every browser
 * that could mount the attack above has sent it since 2020 — so treating
 * "absent" as hostile would break the honest callers while stopping nobody.
 * The guard is a lock on the browser door, not an authentication scheme.
 *
 * Reads are left alone: a cross-site GET cannot change anything, and its reply
 * is unreadable to the attacker without CORS headers, which we never send.
 *
 * ── Convention note ─────────────────────────────────────────────────────────
 *
 * Next 16 renamed the `middleware` file convention to `proxy` and deprecated
 * the old name (node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md
 * §"`middleware` to `proxy`"). This file is therefore `proxy.ts` with a `proxy`
 * export; it is the same request-boundary hook the fix asked for.
 */

/** Methods that can change the journal. */
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Values of `Sec-Fetch-Site` that mean "not another site's page". */
const TRUSTED_SITE = new Set(["same-origin", "none"]);

/**
 * The whole decision, as a pure function of (method, header) so it can be
 * exercised without a server. `null` header means the request carried none.
 */
export function isCrossSiteWrite(method: string, secFetchSite: string | null): boolean {
  if (!MUTATING.has(method.toUpperCase())) return false;
  if (secFetchSite === null) return false;
  return !TRUSTED_SITE.has(secFetchSite.trim().toLowerCase());
}

export function proxy(request: Request): NextResponse | undefined {
  if (!isCrossSiteWrite(request.method, request.headers.get("sec-fetch-site"))) return undefined;
  return NextResponse.json(
    {
      ok: false,
      code: "CROSS_SITE",
      message: "Refused — this request came from another site. Nothing was changed.",
    },
    { status: 403 },
  );
}

export default proxy;

export const config = {
  matcher: "/api/:path*",
};
