import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { IMPORT_HELP_CARDS } from "@/lib/domain/import-help-content";
import { HELP_ENTRIES } from "@/lib/domain/help-content";

/**
 * docs/client/BROKER_API_SETUP_GUIDE.html is the standalone walkthrough for the
 * four DIRECT broker connections (added 2026-09-21, after a buyer was stuck on
 * Angel One's "Add App" form with nothing in the client package to open — the
 * steps existed only inside the app's Import Help cards).
 *
 * A guide is a promise in prose, so the three ways it can go wrong are pinned
 * here:
 *
 *  1. It quietly drops a broker, or the two phrases the Angel One section
 *     exists for ("TOTP secret", "not the 6-digit").
 *  2. It claims Vyuha can act on an order. Vyuha's broker modules export a
 *     login and a read and nothing else (tests/angelone-api.test.ts pins that
 *     export list); a doc that says otherwise is the claim the code refuses.
 *     Every order verb in this file must be negated.
 *  3. It names a menu path the app does not have. The paths are checked against
 *     the app's own help/nav copy, so a renamed screen reddens here instead of
 *     sending a buyer hunting.
 *
 * Plus the Brand rule from AGENTS.md: never a Devanagari text node — on a
 * machine without the font it is a tofu box.
 */

const root = process.cwd();
const GUIDE_REL = "docs/client/BROKER_API_SETUP_GUIDE.html";
const guide = readFileSync(path.join(root, GUIDE_REL), "utf8");

/** Visible-ish text: HTML comments and the <style> block are not prose. */
const prose = guide.replace(/<!--[\s\S]*?-->/g, "").replace(/<style[\s\S]*?<\/style>/gi, "");

describe("the broker API setup guide covers what it claims to", () => {
  it.each(["Angel One", "Dhan", "Upstox", "Zerodha"])("names %s", (broker) => {
    expect(prose).toContain(broker);
  });

  it("names each broker's own API by the name the broker uses", () => {
    for (const name of ["SmartAPI", "DhanHQ", "Analytics token", "Kite Connect"]) {
      expect(prose, `${name} missing`).toContain(name);
    }
  });

  it("warns that the TOTP secret is not the 6-digit code", () => {
    expect(prose).toContain("TOTP secret");
    expect(prose.toLowerCase()).toContain("not the 6-digit");
  });

  it("walks the Angel One Add App form field by field", () => {
    for (const field of ["App Name", "Redirect URL", "Post back URL", "Primary Static IP", "Secondary Static IP"]) {
      expect(prose, `${field} missing from the Angel One walk-through`).toContain(field);
    }
  });

  it("tells the reader not to enter localhost in the Redirect URL (observed on the form, 2026-09-21)", () => {
    expect(prose).toContain("127.0.0.1");
    expect(prose.toLowerCase()).toContain("localhost is not allowed");
  });

  it("names only the brokers' own hosts", () => {
    for (const host of ["apiconnect.angelone.in", "api.dhan.co", "api.upstox.com", "api.kite.trade"]) {
      expect(prose, `${host} missing`).toContain(host);
    }
  });
});

describe("the guide never claims Vyuha can act on an order", () => {
  /** Every sentence carrying an order verb, so each can be checked for its negation. */
  const ORDER_VERB = /\b(place|places|placing|modify|modifies|cancel|cancels|square off|squares off)\b[^.]*\border/i;

  it("every order verb in the guide sits inside a negation", () => {
    const sentences = prose
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/);
    const offenders = sentences.filter(
      (s) => ORDER_VERB.test(s) && !/\b(never|not|no |cannot|nothing)\b/i.test(s),
    );
    expect(offenders, `unnegated order claim:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("states the read-only promise in as many words", () => {
    expect(prose).toContain("never places, modifies or cancels an order");
  });

  it("carries no Devanagari text node (AGENTS.md Brand)", () => {
    expect(/[ऀ-ॿ]/.test(guide), "Devanagari character in the guide").toBe(false);
  });
});

describe("every Vyuha menu path the guide names exists in the app's own copy", () => {
  /** The app's user-visible copy, flattened — help screens and the Import Help cards. */
  const appCopy = [
    ...HELP_ENTRIES.flatMap((e) => [e.title, e.answers, ...e.body, ...(e.refusals ?? [])]),
    ...IMPORT_HELP_CARDS.flatMap((c) => [
      c.title,
      c.summary,
      ...c.steps,
      ...(c.api ?? []),
      ...(c.openalgo ?? []),
      ...(c.notes ?? []),
    ]),
  ].join(" \n ");

  it.each(["Import → Connect broker", "Settings → Live feed"])("%s is a path the app uses too", (menuPath) => {
    expect(appCopy, `${menuPath} appears in the guide but nowhere in the app's copy`).toContain(menuPath);
  });

  it("the guide really does name those paths", () => {
    expect(prose).toContain("Import → Connect broker");
    expect(prose).toContain("Settings → Live feed");
  });

  it("the Import Help cards point at this guide by filename", () => {
    const pointers = IMPORT_HELP_CARDS.filter((c) => (c.api ?? []).some((line) => line.includes("BROKER_API_SETUP_GUIDE.html")));
    expect(pointers.map((c) => c.id).sort()).toEqual(["angelone", "dhan", "upstox", "zerodha"]);
  });

  it("the client package ships both forms of the guide", () => {
    const builder = readFileSync(path.join(root, "scripts", "build-client-package.mjs"), "utf8");
    expect(builder).toContain('["docs/client/BROKER_API_SETUP_GUIDE.html", "BROKER_API_SETUP_GUIDE.html"]');
    expect(builder).toContain('["docs/client/BROKER_API_SETUP_GUIDE.docx", "BROKER_API_SETUP_GUIDE.docx"]');
    // The START_HERE.md the builder generates has to point at it, or the file
    // sits in the ZIP unread.
    expect(builder).toContain("Connecting a broker's API? Open BROKER_API_SETUP_GUIDE.html");
  });
});
