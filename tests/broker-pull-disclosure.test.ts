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

  it("Fyers: a browser login on each day you pull; nothing else is stored", () => {
    expect(text("fyers")).toContain("A browser login on each day you pull; nothing else is stored.");
    expect(text("fyers")).toContain("App ID and App Secret");
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
