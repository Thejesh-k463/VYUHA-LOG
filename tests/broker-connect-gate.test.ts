import { describe, expect, it } from "vitest";
import {
  connectionModeLabel,
  saveDisabled,
  saveTargetLabel,
  type SaveGateState,
} from "@/components/import/broker-connect-gate";

/**
 * The broker-connect save gate, tabled (v3.7.x). The component's inline
 * `disabled` expression could only be exercised by rendering the form; the
 * pure module lets every branch be pinned, including the one owner ruling
 * that changed it: an EMPTY key box with a SAVED row is allowed through (the
 * server carries the stored Client ID over), an empty box with no row is not.
 */

const base: SaveGateState = {
  busy: false,
  active: "dhan",
  apiKey: "1000000009",
  hasSavedRow: false,
  token: "",
  totpMode: false,
  consent: false,
  pin: "",
  totpSecret: "",
  clientCode: "",
  apiSecret: "",
  host: "",
  underlyingBroker: "",
  needsToken: true,
};

const g = (over: Partial<SaveGateState>): SaveGateState => ({ ...base, ...over });

describe("saveDisabled — the empty-key rule (owner ruling 2026-09-04)", () => {
  const cases: [string, Partial<SaveGateState>, boolean][] = [
    ["empty box + saved row + token → ENABLED (server keeps the stored key)", { apiKey: "", hasSavedRow: true, token: "t" }, false],
    ["empty box + NO row + token → disabled", { apiKey: "", hasSavedRow: false, token: "t" }, true],
    ["empty box + saved row but nothing else filled → still disabled by the mode rule", { apiKey: "", hasSavedRow: true }, true],
    ["busy always disables, even with everything filled", { busy: true, token: "t" }, true],
  ];
  it.each(cases)("%s", (_name, over, expected) => {
    expect(saveDisabled(g(over))).toBe(expected);
  });
});

describe("saveDisabled — reproduces the component's per-broker rule", () => {
  const cases: [string, Partial<SaveGateState>, boolean][] = [
    // dhan, token mode
    ["dhan token mode: key + token → enabled", { token: "t" }, false],
    ["dhan token mode: key, no token → disabled", {}, true],
    // dhan, TOTP mode: pin + secret + consent; the token is optional
    ["dhan totp: pin + secret + consent, no token → enabled", { totpMode: true, pin: "1", totpSecret: "S", consent: true }, false],
    ["dhan totp: pin + secret, NO consent → disabled", { totpMode: true, pin: "1", totpSecret: "S", consent: false }, true],
    ["dhan totp: consent but no pin → disabled", { totpMode: true, totpSecret: "S", consent: true }, true],
    ["dhan totp: consent but no secret → disabled", { totpMode: true, pin: "1", consent: true }, true],
    ["dhan totp: a token alone does not satisfy TOTP mode", { totpMode: true, token: "t" }, true],
    // zerodha: token OR api secret
    ["zerodha: token only → enabled", { active: "zerodha", token: "t" }, false],
    ["zerodha: api secret only → enabled", { active: "zerodha", apiSecret: "s" }, false],
    ["zerodha: neither → disabled", { active: "zerodha" }, true],
    // angelone: all three
    ["angelone: code + pin + secret → enabled", { active: "angelone", clientCode: "c", pin: "1", totpSecret: "S" }, false],
    ["angelone: missing client code → disabled", { active: "angelone", pin: "1", totpSecret: "S" }, true],
    ["angelone: missing secret → disabled", { active: "angelone", clientCode: "c", pin: "1" }, true],
    // openalgo: host + underlying broker
    ["openalgo: host + broker → enabled", { active: "openalgo", host: "http://127.0.0.1:5000", underlyingBroker: "groww" }, false],
    ["openalgo: whitespace host → disabled", { active: "openalgo", host: "   ", underlyingBroker: "groww" }, true],
    ["openalgo: no broker → disabled", { active: "openalgo", host: "http://127.0.0.1:5000" }, true],
    // upstox: the key is the whole credential
    ["upstox: key alone → enabled", { active: "upstox", needsToken: false }, false],
    ["upstox: empty key, no row → disabled", { active: "upstox", needsToken: false, apiKey: "" }, true],
  ];
  it.each(cases)("%s", (_name, over, expected) => {
    expect(saveDisabled(g(over))).toBe(expected);
  });
});

describe("connectionModeLabel", () => {
  const cases: [string, Parameters<typeof connectionModeLabel>[0], string][] = [
    ["totp", { authMode: "totp", tokenExpiresAt: null }, "PIN + TOTP · mints its own token"],
    ["totp ignores a cached token's expiry", { authMode: "totp", tokenExpiresAt: "2026-09-05T03:30:00.000Z" }, "PIN + TOTP · mints its own token"],
    ["token with expiry", { authMode: "token", tokenExpiresAt: "2026-09-05T03:30:00.000Z" }, "pasted token · expires 2026-09-05T03:30:00.000Z"],
    ["token, expiry unknown", { authMode: "token", tokenExpiresAt: null }, "pasted token · expiry unknown"],
    ["none", { authMode: "none", tokenExpiresAt: null }, "not connected"],
    ["no connection", null, "not connected"],
    ["undefined connection", undefined, "not connected"],
  ];
  it.each(cases)("%s", (_name, c, expected) => {
    expect(connectionModeLabel(c)).toBe(expected);
  });

  it("lets the UI localise the timestamp", () => {
    expect(connectionModeLabel({ authMode: "token", tokenExpiresAt: "2026-09-05T03:30:00.000Z" }, (iso) => `on ${iso.slice(0, 10)}`)).toBe(
      "pasted token · expires on 2026-09-05",
    );
  });
});

describe("saveTargetLabel — the account a save writes to", () => {
  const accounts = [
    { id: 1, name: "Primary" },
    { id: 2, name: "Swing" },
  ];
  const cases: [string, Parameters<typeof saveTargetLabel>, string | null][] = [
    ["a specific selection wins over the picker", [accounts, 2, 1], "Primary"],
    ["a specific selection not in the list is still named by id", [[], 0, 7], "Account 7"],
    ["All-accounts: the picker's choice", [accounts, 2, 0], "Swing"],
    ["All-accounts: a picked id that left the list falls back to the first account", [accounts, 9, 0], "Primary"],
    ["All-accounts: picker unset (0) falls back to the first account", [accounts, 0, 0], "Primary"],
    ["All-accounts with nothing to pick from: null, never an invented name", [[], 0, 0], null],
  ];
  it.each(cases)("%s", (_name, args, expected) => {
    expect(saveTargetLabel(...args)).toBe(expected);
  });
});
