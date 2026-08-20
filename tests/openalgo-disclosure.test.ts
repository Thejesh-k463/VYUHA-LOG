import { describe, expect, it } from "vitest";
import {
  OPENALGO_DEFAULT_HOST,
  OPENALGO_DISCLOSURE_VERSION,
  OPENALGO_REFUSALS,
  OPENALGO_RISKS,
  OPENALGO_WHAT_IT_DOES,
  OPENALGO_WHAT_IT_IS,
  isAckCurrent,
  isLocalOpenAlgoHost,
  openAlgoGate,
} from "@/lib/domain/openalgo-disclosure";

/**
 * The disclosure is the thing standing between a user and handing a second
 * program their broker credentials. These tests pin the two properties that
 * make it worth anything: the gate is CLOSED unless both halves hold, and the
 * copy actually names the risks it claims to name.
 */

describe("the gate", () => {
  it("refuses when the switch is off, whatever the acknowledgement says", () => {
    const g = openAlgoGate({ enabled: false, ackVersion: OPENALGO_DISCLOSURE_VERSION });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/Settings/);
  });

  it("refuses when the disclosure was never accepted", () => {
    expect(openAlgoGate({ enabled: true, ackVersion: null }).allowed).toBe(false);
    expect(openAlgoGate({ enabled: true, ackVersion: undefined }).allowed).toBe(false);
    expect(openAlgoGate({ enabled: true, ackVersion: "" }).allowed).toBe(false);
  });

  it("refuses an acknowledgement of an OLDER disclosure — a changed risk re-prompts", () => {
    const g = openAlgoGate({ enabled: true, ackVersion: "0" });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/changed since you accepted/i);
  });

  it("allows only when the switch is on AND the acceptance is current", () => {
    expect(openAlgoGate({ enabled: true, ackVersion: OPENALGO_DISCLOSURE_VERSION }).allowed).toBe(true);
  });

  it("isAckCurrent agrees with the gate", () => {
    expect(isAckCurrent(OPENALGO_DISCLOSURE_VERSION)).toBe(true);
    expect(isAckCurrent("0")).toBe(false);
    expect(isAckCurrent(null)).toBe(false);
  });
});

describe("host locality — the 'nothing leaves your computer' promise", () => {
  it("treats the loopback block and localhost as local", () => {
    for (const h of ["http://127.0.0.1:5000", "127.0.0.1:5000", "http://localhost:5000", "localhost", "http://127.7.7.7:5000"]) {
      expect(isLocalOpenAlgoHost(h), h).toBe(true);
    }
  });

  it("treats a LAN address or a remote name as REMOTE — under-warning is the failure that matters", () => {
    for (const h of ["http://192.168.1.9:5000", "http://10.0.0.4:5000", "https://algo.example.com", "http://openalgo.local"]) {
      expect(isLocalOpenAlgoHost(h), h).toBe(false);
    }
  });

  it("refuses to call an unparseable or empty host local", () => {
    expect(isLocalOpenAlgoHost("")).toBe(false);
    expect(isLocalOpenAlgoHost("   ")).toBe(false);
    expect(isLocalOpenAlgoHost("http://")).toBe(false);
  });

  it("ships a loopback default", () => {
    expect(isLocalOpenAlgoHost(OPENALGO_DEFAULT_HOST)).toBe(true);
  });
});

describe("the copy says what it must say", () => {
  it("has a what-it-is, a what-it-does and a risk section, none empty", () => {
    for (const list of [OPENALGO_WHAT_IT_IS, OPENALGO_WHAT_IT_DOES, OPENALGO_RISKS]) {
      expect(list.length).toBeGreaterThanOrEqual(3);
      for (const item of list) {
        expect(item.title.trim().length).toBeGreaterThan(0);
        expect(item.body.trim().length).toBeGreaterThan(40);
      }
    }
    expect(OPENALGO_REFUSALS.length).toBeGreaterThanOrEqual(3);
  });

  it("names the six risks a user could not discover for themselves", () => {
    const all = OPENALGO_RISKS.map((r) => `${r.title} ${r.body}`).join(" ").toLowerCase();
    expect(all).toMatch(/credential/); // whose keys OpenAlgo holds
    expect(all).toMatch(/quantity 0|quantity zero/); // the documented zero-size fill
    expect(all).toMatch(/contract note/); // and what to check it against
    expect(all).toMatch(/charge/); // computed, not stated
    expect(all).toMatch(/current trading day|today only/); // not a backfill
    expect(all).toMatch(/not running|could not reach/); // the common failure
    expect(all).toMatch(/leaves? this machine|travels? to that machine/); // non-local host
  });

  it("says plainly that Vyuha neither supports OpenAlgo nor places orders", () => {
    const refusals = OPENALGO_REFUSALS.join(" ").toLowerCase();
    expect(refusals).toMatch(/does not install|support/);
    expect(refusals).toMatch(/never places|cancel/);
  });

  it("never claims the pull is more accurate on charges than a file import", () => {
    const all = [...OPENALGO_WHAT_IT_IS, ...OPENALGO_WHAT_IT_DOES, ...OPENALGO_RISKS]
      .map((r) => r.body)
      .join(" ")
      .toLowerCase();
    // The honest direction: files carry the broker's own charges, the API does not.
    expect(all).toMatch(/more accurate source for costs/);
  });

  it("version is a bare string a stored ack can be compared against", () => {
    expect(OPENALGO_DISCLOSURE_VERSION).toMatch(/^\d+$/);
  });
});
