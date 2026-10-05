import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROKER_PULL_DISCLOSURES,
  KOTAK_TRADE_API_BROKERAGE_NOTE,
  PULL_UNVERIFIED_LABEL,
  pullAckCurrent,
} from "@/lib/domain/broker-pull-disclosure";

/**
 * The three C6 consent sheets (design D9, review R6). Versions are pinned so a
 * bump is a deliberate, reviewed change (it re-prompts every install), and the
 * sentences the owner's answers require are pinned so they cannot drift out.
 */

const text = (id: keyof typeof BROKER_PULL_DISCLOSURES) => BROKER_PULL_DISCLOSURES[id].items.join("\n");

describe("BROKER_PULL_DISCLOSURES", () => {
  it("one sheet per broker, each at version 1", () => {
    expect(Object.keys(BROKER_PULL_DISCLOSURES).sort()).toEqual(["fyers", "kotakneo", "nuvama"]);
    expect(BROKER_PULL_DISCLOSURES.fyers.version).toBe(1);
    expect(BROKER_PULL_DISCLOSURES.kotakneo.version).toBe(1);
    expect(BROKER_PULL_DISCLOSURES.nuvama.version).toBe(1);
  });

  it("every sheet says what is stored, which host is called and when, and what comes back — and carries the unverified label (B2, Q4)", () => {
    expect(PULL_UNVERIFIED_LABEL).toBe("documented, not yet verified with a real account");
    for (const id of ["fyers", "kotakneo", "nuvama"] as const) {
      const t = text(id);
      expect(t, id).toContain("encrypted with a key bound to this computer");
      expect(t, id).toContain("today's fills only");
      expect(t, id).toContain("Vyuha stores the trades it reads from them, never the raw response");
      expect(t, id).toContain(PULL_UNVERIFIED_LABEL);
      expect(t, id).toMatch(/only when you pull/);
    }
    expect(text("fyers")).toContain("api-t1.fyers.in");
    expect(text("kotakneo")).toContain("mis.kotaksecurities.com");
    expect(text("nuvama")).toContain("nc.nuvamawealth.com");
  });

  it("Fyers: a browser login on each day you pull; the password and PIN are never stored", () => {
    expect(text("fyers")).toContain("A browser login on each day you pull. Your Fyers password and PIN are never stored");
    expect(text("fyers")).toContain("App ID and App Secret");
  });

  /**
   * v4.7.0 audit DC-A1 — the route STORES one more thing than the v1 sheets
   * said: the login identity stamped on a first pull (`fyId` / `nuvamaUserId`,
   * read by `refuseForeignLogin`). "Nothing else is stored" was untrue. v1 is
   * AMENDED, not bumped (v4.7.0 is unreleased — the header's rule 3).
   */
  it("DC-A1 — Fyers and Nuvama name the stored login identity and why it is kept; the route really stamps it", () => {
    expect(text("fyers")).not.toContain("nothing else is stored");
    expect(text("fyers")).toContain(
      "From your first pull, your Fyers client ID is kept the same way, so a pull made with a different Fyers login is refused rather than imported into this account.",
    );
    expect(text("nuvama")).toContain(
      "From your first login, your Nuvama user ID is kept the same way, so a pull made with a different Nuvama login is refused rather than imported into this account.",
    );
    expect(text("nuvama")).toContain("Your Nuvama password and PIN are never stored");
    // The sentences are true only while the route stamps and checks these ids.
    const route = readFileSync(path.join(process.cwd(), "app/api/import/broker/route.ts"), "utf8");
    expect(route).toMatch(/fyId: n\.clientId/);
    expect(route).toMatch(/nuvamaUserId: fresh\.userId/);
    expect(route).toMatch(/refuseForeignLogin\(c, "fyers"/);
    expect(route).toMatch(/refuseForeignLogin\(c, "nuvama"/);
    // Amended, never bumped while unreleased.
    expect(BROKER_PULL_DISCLOSURES.fyers.version).toBe(1);
    expect(BROKER_PULL_DISCLOSURES.nuvama.version).toBe(1);
  });

  it("Kotak: TOTP secret + MPIN stored so pulls run unattended, launch-time auto-pull, and the Q5 ₹0 note", () => {
    const t = text("kotakneo");
    expect(t).toContain("MPIN and TOTP secret");
    expect(t).toContain("so pulls run unattended");
    expect(t).toContain("if you switch on the once-a-day auto-pull, once at launch");
    expect(t).toContain(KOTAK_TRADE_API_BROKERAGE_NOTE);
  });

  it("Nuvama: the secret as a password field, the static-IP sentence, no public-IP lookup", () => {
    const t = text("nuvama");
    expect(t).toContain("The API secret is sent to Nuvama as a password field over HTTPS");
    expect(t).toContain(
      "Nuvama's documentation marks a static IP as mandatory and does not exempt read-only calls — a pull from a home connection may be refused.",
    );
    expect(t).toContain("Vyuha does not look up or send your public IP address");
  });

  /**
   * v4.7.0 audit RN-3 — the client broker-API guide (and its Word twin's single
   * source) named only the four verified brokers and listed Kotak Neo among
   * brokers "with no direct connection". It now names the three C6 pulls with
   * the SAME unverified label the app shows, and their hosts.
   */
  it("RN-3 — the broker API guide (HTML + docx source) names Fyers, Kotak Neo and Nuvama as documented, not yet verified", () => {
    const html = readFileSync(path.join(process.cwd(), "docs/client/BROKER_API_SETUP_GUIDE.html"), "utf8").replace(/\s+/g, " ");
    const docx = readFileSync(path.join(process.cwd(), "scripts/build-broker-api-docx.mjs"), "utf8").replace(/\s+/g, " ");
    for (const [name, src] of [["html", html], ["docx", docx]] as const) {
      expect(src, name).toContain("9 · Fyers, Kotak Neo and Nuvama — documented, not yet verified");
      expect(src, name).toContain(PULL_UNVERIFIED_LABEL);
      for (const host of ["api-t1.fyers.in", "mis.kotaksecurities.com", "nc.nuvamawealth.com"]) expect(src, `${name}: ${host}`).toContain(host);
      expect(src, name).not.toMatch(/Paytm Money, Kotak Neo,? and/);
      expect(src, name).toContain("Kotak Neo works through either");
    }
  });

  it("no counterfactual copy anywhere", () => {
    const all = Object.values(BROKER_PULL_DISCLOSURES).flatMap((d) => [d.title, ...d.items]).join("\n");
    expect(all).not.toMatch(/would have|could have made|missed out/i);
    const src = readFileSync(path.join(process.cwd(), "lib/domain/broker-pull-disclosure.ts"), "utf8").replace(/\r\n/g, "\n");
    // Pure: no DB, no React, no fetch.
    expect(src).not.toMatch(/from\s+["'](?:@\/lib\/db|react|node:)/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("pullAckCurrent", () => {
  it("true only for the CURRENT version of a known broker (=== — a string, an older number, null are all false)", () => {
    expect(pullAckCurrent("fyers", 1)).toBe(true);
    expect(pullAckCurrent("kotakneo", 1)).toBe(true);
    expect(pullAckCurrent("nuvama", 1)).toBe(true);
    expect(pullAckCurrent("fyers", 0)).toBe(false);
    expect(pullAckCurrent("fyers", 2)).toBe(false);
    expect(pullAckCurrent("fyers", "1")).toBe(false);
    expect(pullAckCurrent("fyers", null)).toBe(false);
    expect(pullAckCurrent("fyers", undefined)).toBe(false);
    expect(pullAckCurrent("zerodha", 1)).toBe(false);
    expect(pullAckCurrent("toString", 1)).toBe(false);
  });
});
