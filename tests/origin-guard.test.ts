import { describe, expect, it } from "vitest";
import { isCrossSiteWrite, proxy } from "@/proxy";

/**
 * The cross-site write guard (proxy.ts).
 *
 * Before it, `/api/import/remove-broker` executed for anyone: `Request.json()`
 * ignores `Content-Type`, so a `text/plain` POST is a CORS *simple* request —
 * no preflight to refuse — and any page open in the user's browser could empty
 * a broker out of the journal while the app was running. The attacker never
 * needs to read the reply; the damage is that the route runs.
 *
 * Synthetic requests only: the decision is a pure function of the method and
 * the `Sec-Fetch-Site` header the browser sets, so no server is needed to
 * prove it.
 */

const REMOVE = "http://localhost:3000/api/import/remove-broker";

const req = (method: string, site: string | null) =>
  new Request(REMOVE, {
    method,
    headers: {
      "Content-Type": "text/plain",
      ...(site === null ? {} : { "Sec-Fetch-Site": site }),
    },
    ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify({ accountId: 1, broker: "paytm", confirm: true }) }),
  });

describe("isCrossSiteWrite — the decision", () => {
  it("refuses a mutating request that another site's page initiated", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "post", "delete"]) {
      for (const site of ["cross-site", "same-site", "CROSS-SITE", " cross-site "]) {
        expect(isCrossSiteWrite(method, site), `${method} ${site}`).toBe(true);
      }
    }
  });

  it("allows the app's own writes, address-bar navigations, and header-less callers", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      // The Tauri WebView2 shell and Playwright both drive the app's own
      // origin (playwright.config.ts pins baseURL http://localhost:3100 and the
      // Tauri window loads the same server), so their fetches are same-origin.
      expect(isCrossSiteWrite(method, "same-origin")).toBe(false);
      expect(isCrossSiteWrite(method, "none")).toBe(false);
      // Node, curl and this test suite send no such header at all.
      expect(isCrossSiteWrite(method, null)).toBe(false);
    }
  });

  it("never blocks a read — a cross-site GET changes nothing and cannot be read back", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isCrossSiteWrite(method, "cross-site")).toBe(false);
    }
  });
});

describe("proxy — the response", () => {
  it("answers 403 CROSS_SITE and does not fall through to the route", async () => {
    const res = proxy(req("POST", "cross-site"));
    expect(res).toBeDefined();
    expect(res!.status).toBe(403);
    expect(await res!.json()).toMatchObject({ ok: false, code: "CROSS_SITE" });
  });

  it("passes the honest callers through untouched", () => {
    expect(proxy(req("POST", "same-origin"))).toBeUndefined();
    expect(proxy(req("POST", null))).toBeUndefined();
    expect(proxy(req("GET", "cross-site"))).toBeUndefined();
  });
});
