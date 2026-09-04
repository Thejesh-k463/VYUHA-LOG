import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_REENROL_CTA,
  KEY_KEPT_PLACEHOLDER,
  PICK_ACCOUNT_FIRST,
  TOKEN_EXPIRY_SEEN_KEY,
} from "@/components/import/broker-connect";

/**
 * Source-level pins on components/import/broker-connect.tsx (v3.8 Wave 3).
 *
 * vitest runs in node with no DOM, so the component cannot be rendered here;
 * what CAN be pinned is that the wiring the owner ruled on (2026-09-04) is
 * present in the source — the pure gate is the gate, the placeholder is a
 * sentence and never a value shape, every row carries the mode label, the
 * expiry pop-up's storage key exists and every storage access is guarded.
 * Behaviour under a browser is e2e/z-broker-connect.spec.ts.
 */
// CRLF on disk (Windows checkout) — normalise so multi-line pins match either way.
const SRC = fs
  .readFileSync(path.join(process.cwd(), "components", "import", "broker-connect.tsx"), "utf8")
  .replace(/\r\n/g, "\n");

/** The source between two unique anchors — a named block, so a failure says WHERE. */
function between(start: string, end: string): string {
  const a = SRC.indexOf(start);
  expect(a, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const b = SRC.indexOf(end, a + start.length);
  expect(b, `end anchor not found after ${start}: ${end}`).toBeGreaterThan(-1);
  return SRC.slice(a, b);
}

describe("the pure gate module is the gate", () => {
  it("imports saveDisabled, connectionModeLabel and saveTargetLabel from broker-connect-gate", () => {
    const m = SRC.match(/import \{([^}]*)\} from "@\/components\/import\/broker-connect-gate";/);
    expect(m, "no import from the gate module").not.toBeNull();
    for (const name of ["saveDisabled", "connectionModeLabel", "saveTargetLabel"]) {
      expect(m![1]).toContain(name);
    }
  });

  it("calls all three", () => {
    expect(SRC).toMatch(/\bsaveDisabled\(\{/);
    expect(SRC).toMatch(/\bconnectionModeLabel\(/);
    expect(SRC).toMatch(/\bsaveTargetLabel\(/);
  });

  it("the Save button's disabled prop IS the gate call — the inline rule is gone", () => {
    // The v3.7.1 inline expression's opening — `!apiKey` alone was the bug.
    expect(SRC).not.toMatch(/busy != null \|\| !apiKey \|\|/);
    const btn = between("onClick={save}", '{busy === "save"');
    // `[\s\S]*` between `disabled={` and `saveDisabled({` accepted ANYTHING in
    // the gap, so re-inserting the v3.7.1 inline rule on its own line passed
    // this pin. Read the gap and require it to be EXACTLY the account guard.
    const at = btn.indexOf("disabled={");
    expect(at, "the Save button has no disabled prop").toBeGreaterThan(-1);
    const call = btn.indexOf("saveDisabled({", at);
    expect(call, "the disabled prop does not call the gate").toBeGreaterThan(-1);
    const gap = btn.slice(at + "disabled={".length, call);
    expect(gap.replace(/\s+/g, " ").trim(), "the disabled prop carries a rule the gate module does not own").toBe("pickMissing ||");
    expect(btn).toMatch(/saveDisabled\(\{[\s\S]*hasSavedRow: saveTargetConn != null/);
  });
});

describe("the key box placeholder is a sentence, never a value shape", () => {
  it("no literal 1000000009 remains anywhere", () => {
    expect(SRC).not.toContain("1000000009");
  });

  it("with no saved row, Dhan's placeholder is the field label", () => {
    const dhan = between('label: "Dhan",', "needsToken: true,");
    expect(dhan).toContain('keyLabel: "Client ID"');
    expect(dhan).toContain('keyPlaceholder: "Client ID"');
  });

  it("with a saved row, the placeholder is the leave-blank sentence — not the masked key", () => {
    expect(KEY_KEPT_PLACEHOLDER).toBe("saved — leave blank to keep");
    expect(SRC).toContain("placeholder={saveTargetConn ? KEY_KEPT_PLACEHOLDER : spec.keyPlaceholder}");
    expect(SRC).not.toMatch(/placeholder=\{saveTargetConn \? saveTargetConn\.apiKeyMasked/);
  });
});

describe("the mode label is on EVERY connection row and the single badge", () => {
  /** A rendered row block: keyed per (account, broker) and ending in its own Disconnect button. */
  function rowBlocks(): string[] {
    const key = "key={`${c.accountId}:${c.broker}`}";
    const blocks: string[] = [];
    let i = SRC.indexOf(key);
    while (i !== -1) {
      const next = SRC.indexOf(key, i + key.length);
      const end = SRC.indexOf("Disconnect\n", i);
      // A block is a ROW only if its Disconnect comes before the next key
      // (the expiry dialog reuses the key shape and has no Disconnect).
      if (end !== -1 && (next === -1 || end < next)) blocks.push(SRC.slice(i, end));
      i = next;
    }
    return blocks;
  }

  it("two row lists exist (OpenAlgo instances, per-account rows), each rendering the ModeBadge", () => {
    const blocks = rowBlocks();
    expect(blocks).toHaveLength(2);
    for (const b of blocks) expect(b).toContain("<ModeBadge conn={c} />");
  });

  it("the single-connection header badge carries it too", () => {
    const header = between("brokerConns.length === 1 && conn && (", "brokerConns.length > 1 && (");
    expect(header).toContain("<ModeBadge conn={conn} />");
  });

  it("ModeBadge is connectionModeLabel, localised, in a highlighted pill", () => {
    const label = between("function modeLabelOf(", "function ModeBadge(");
    expect(label).toMatch(/connectionModeLabel\(\s*\{[^}]*\},\s*formatTs,?\s*\)/);
    const badge = between("function ModeBadge(", "function readExpirySeen(");
    expect(badge).toContain("modeLabelOf(conn)");
    expect(badge).toMatch(/<Badge variant=\{variant\}/);
    expect(badge).toContain('data-testid="connection-mode"');
  });
});

describe("the one-time expired-token pop-up", () => {
  it("uses the vyuha- kebab storage key, and the key string is in the source", () => {
    expect(TOKEN_EXPIRY_SEEN_KEY).toBe("vyuha-token-expiry-seen");
    expect(SRC).toContain('"vyuha-token-expiry-seen"');
  });

  it("every localStorage / writeStored access sits inside a try block", () => {
    const accesses = [...SRC.matchAll(/localStorage\.|writeStored\(/g)].map((m) => m.index!);
    expect(accesses.length).toBeGreaterThanOrEqual(2);
    for (const idx of accesses) {
      const lastTry = SRC.lastIndexOf("try {", idx);
      const lastCatch = SRC.lastIndexOf("} catch", idx);
      expect(lastTry, `unguarded storage access at offset ${idx}`).toBeGreaterThan(lastCatch);
    }
  });

  it("is a Dialog keyed on the unseen-expired list, and closing it marks the pair seen", () => {
    const dlg = between("open={expiryPrompt != null}", "</Dialog>");
    expect(dlg).toContain("markExpirySeen(expiryPrompt)");
    expect(dlg).toContain("TOKEN_EXPIRED_TITLE");
    expect(dlg).toContain("tokenExpiredMessage(");
    // The identity of a dead token is (broker, tokenExpiresAt).
    expect(SRC).toContain("`${c.broker}@${c.tokenExpiresAt}`");
    // Trigger: a pasted token whose exp is behind us — never a TOTP row.
    expect(between("function tokenExpired(", "function formatTs(")).toContain('c.authMode !== "token"');
  });

  it("is set from the fetch callbacks, never from an effect", () => {
    const effect = between("useEffect(() => {", "}, []);");
    expect(effect).toContain("setExpiryPrompt(dead)");
    expect(effect).not.toMatch(/setDhanTotp/);
    expect((SRC.match(/setExpiryPrompt\(dead\)/g) ?? []).length).toBe(2); // initial load + refresh()
  });
});

describe("Dhan's TOTP toggle is DERIVED from the saved row", () => {
  it("no boolean useState for the mode; the user's pick overrides the row's authMode", () => {
    expect(SRC).not.toMatch(/\[dhanTotpMode, setDhanTotpMode\] = useState/);
    expect(SRC).toContain('const dhanTotpMode = dhanTotpPick ?? saveTargetConn?.authMode === "totp";');
    // switchBroker returns it to "follow the row", not to false.
    expect(between("function switchBroker(", "setMsg(null);")).toContain("setDhanTotpPick(null)");
  });
});

describe("the unreadable-enrolment warning and the visible remove button", () => {
  it("renders the server's authWarning prominently with the re-enrol call to action and the clear action", () => {
    const block = between('data-testid="auth-unreadable"', "</div>\n        )}");
    expect(block).toContain("saveTargetConn.authWarning");
    expect(block).toContain("AUTH_REENROL_CTA");
    expect(block).toContain("onClick={clearAuthEnrollment}");
    expect(AUTH_REENROL_CTA).toMatch(/enrol again/);
  });

  it("no removal button is a ghost any more; the Dhan one is labelled from the mode", () => {
    expect(SRC).not.toMatch(/variant="ghost" onClick=\{clearAuthEnrollment\}/);
    expect((SRC.match(/variant="secondary" onClick=\{clearAuthEnrollment\}/g) ?? []).length).toBe(3);
    expect(SRC).toMatch(/saveTargetConn\.authMode === "totp"\s*\? "Remove PIN \+ TOTP enrolment/);
  });
});

describe("the All-accounts save names the account", () => {
  it("with 2+ accounts there is NO default pick, and the button waits on one", () => {
    expect(SRC).toContain("useState<number>(needsPick ? 0 : writeAccounts[0]?.id ?? 0)");
    expect(SRC).toContain("const pickMissing = needsPick && saveAccountId === 0;");
    const btn = between("onClick={save}", "{/* With several accounts connected");
    expect(btn).toMatch(/disabled=\{\s*pickMissing \|\|/);
    expect(btn).toContain("? PICK_ACCOUNT_FIRST");
    expect(PICK_ACCOUNT_FIRST).toBe("Pick an account first");
  });

  it("the picker gets an explicit empty row (id 0 — the aggregate, never a write target) and says 'Saving to <name>'", () => {
    expect(SRC).toContain("[{ id: 0, name: PICK_ACCOUNT_PLACEHOLDER }, ...writeAccounts]");
    expect(SRC).toContain("saveTargetLabel(pickerAccounts, savePick, 0)");
    expect((SRC.match(/Saving to \{saveTarget\}/g) ?? []).length).toBe(2); // beside the picker + beside the button
  });
});
