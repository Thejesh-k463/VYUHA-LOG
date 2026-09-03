import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  REMOVE_BROKER_BUTTON,
  REMOVE_BROKER_ENDPOINT,
  REMOVE_BROKER_PANEL_TITLE,
  REMOVE_BROKER_PICK_ACCOUNT,
  REMOVE_BROKER_REIMPORT_BUTTON,
  dateSpan,
  removeBrokerConfirmSentence,
  removeBrokerErrorCopy,
} from "@/components/import/remove-broker-panel";
import { OPENING_SELL_REVIEW_HREF, splitShapeSentence } from "@/components/import/import-client";
import { importShapeSentence } from "@/lib/domain/import-shape";

/**
 * v3.8 W3 — the remove-broker panel and the commit-shape cautions.
 *
 * No jsdom here (vitest runs in node), so the UI is pinned two ways: the copy
 * and helpers are imported and asserted directly, and the wiring — which
 * endpoint the panel talks to, which test ids the e2e spec relies on, where
 * the opening-sell caution links — is read out of the component source.
 */

const root = process.cwd();
const panelSrc = fs.readFileSync(path.join(root, "components", "import", "remove-broker-panel.tsx"), "utf8");
const clientSrc = fs.readFileSync(path.join(root, "components", "import", "import-client.tsx"), "utf8");
const pageSrc = fs.readFileSync(path.join(root, "app", "import", "page.tsx"), "utf8");
const shapeSrc = fs.readFileSync(path.join(root, "lib", "domain", "import-shape.ts"), "utf8");

describe("remove-broker panel wiring", () => {
  it("talks to Wave 2's route, GET with the account and POST with confirm: true", () => {
    expect(REMOVE_BROKER_ENDPOINT).toBe("/api/import/remove-broker");
    expect(panelSrc).toMatch(/fetch\(`\/api\/import\/remove-broker\?accountId=\$\{accountId\}`/);
    expect(panelSrc).toMatch(/fetch\("\/api\/import\/remove-broker", \{\s*method: "POST"/);
    expect(panelSrc).toMatch(/JSON\.stringify\(\{ accountId, broker: row\.broker, confirm: true \}\)/);
    // The GET's list is `sources` (route.ts), not `brokers`.
    expect(panelSrc).toMatch(/json\.sources \?\? \[\]/);
  });

  it("is a route-handler + fetch + router.refresh() write, never a server action", () => {
    expect(panelSrc).not.toMatch(/"use server"|useActionState|formAction/);
    expect(clientSrc).toMatch(/onRemoved=\{\(\) => \{ setPreview\(null\); setCommitted\(null\); router\.refresh\(\); \}\}/);
  });

  it("mounts on the import page below the dropzone, collapsed, with the named account", () => {
    expect(clientSrc.indexOf('data-testid="import-dropzone"')).toBeGreaterThan(0);
    expect(clientSrc.indexOf("<RemoveBrokerPanel")).toBeGreaterThan(clientSrc.indexOf('data-testid="import-dropzone"'));
    expect(panelSrc).toMatch(/const \[open, setOpen\] = React\.useState\(false\)/);
    expect(REMOVE_BROKER_PANEL_TITLE).toBe("Remove a broker's imported rows");
    // The page resolves the selector's account and hands it down — 0 is null.
    expect(pageSrc).toMatch(/getSelectedAccountId\(\)/);
    expect(pageSrc).toMatch(/selectedId > 0 \? \(getAccounts\(\)\.find\(\(a\) => a\.id === selectedId\) \?\? null\) : null/);
    expect(pageSrc).toMatch(/<ImportClient writeAccounts=\{writeAccounts\} selectedAccount=/);
  });

  it("carries the test ids the e2e spec drives", () => {
    for (const id of [
      "remove-broker-panel",
      "remove-broker-toggle",
      "remove-broker-pick-account",
      "remove-broker-confirm-copy",
      "remove-broker-confirm",
      "remove-broker-done",
      "remove-broker-error",
      "remove-broker-empty",
    ]) {
      expect(panelSrc, id).toContain(`data-testid="${id}"`);
    }
    expect(panelSrc).toContain("data-testid={`remove-broker-row-${r.broker}`}");
  });

  it("'Now re-import the file' scrolls to and focuses the dropzone, refreshes, and re-reads a held file", () => {
    expect(REMOVE_BROKER_REIMPORT_BUTTON).toBe("Now re-import the file");
    expect(clientSrc).toMatch(/dropRef\.current\?\.scrollIntoView\(/);
    expect(clientSrc).toMatch(/dropRef\.current\?\.focus\(\);\s*router\.refresh\(\);/);
    expect(clientSrc).toMatch(/if \(file\) void doPreview\(file, mapping\);/);
  });
});

describe("remove-broker copy", () => {
  const row = { broker: "paytm", trades: 142, closed: 118, open: 24, earliest: "2025-04-01", latest: "2026-03-31" };

  it("the confirmation sentence is the owner's, verbatim", () => {
    expect(removeBrokerConfirmSentence(row, "Main")).toBe(
      "Remove all 142 Paytm Money trades from “Main”? 118 closed, 24 open, 2025-04-01–2026-03-31. " +
        "Staged legs and screenshots go with them; ledger entries and IPO records are kept and unlinked. " +
        "A snapshot is saved first — restore from Backup & Restore → Deleted items. Re-import the file afterwards.",
    );
  });

  it("says — for the date span when the rows carry no dates (Dhan P&L), and singular for one trade", () => {
    expect(dateSpan(null, null)).toBe("—");
    expect(dateSpan("2026-01-02", "2026-01-02")).toBe("2026-01-02–2026-01-02");
    expect(removeBrokerConfirmSentence({ ...row, broker: "dhan", trades: 1, closed: 1, open: 0, earliest: null, latest: null }, "Primary"))
      .toMatch(/^Remove all 1 Dhan trade from “Primary”\? 1 closed, 0 open, —\. /);
  });

  it("the buttons and the All-accounts refusal read as specified", () => {
    expect(REMOVE_BROKER_BUTTON).toBe("Remove and re-import");
    expect(REMOVE_BROKER_PICK_ACCOUNT).toBe("Pick an account first");
    // On All accounts the panel explains and every button is disabled — the
    // one it still renders is disabled with that reason as its title.
    expect(panelSrc).toMatch(/<Button size="sm" variant="destructive" disabled title=\{REMOVE_BROKER_PICK_ACCOUNT\}>/);
  });

  it("branches on the server's code, and never claims to know what a generic failure did", () => {
    expect(removeBrokerErrorCopy("ACCOUNT_REQUIRED", "x", "dhan", 400)).toMatch(/^Pick an account first — “All accounts” is a view/);
    expect(removeBrokerErrorCopy("ACCOUNT_NOT_FOUND", "x", "dhan", 404)).toMatch(/no longer exists/);
    expect(removeBrokerErrorCopy("BROKER_REQUIRED", "x", "dhan", 400)).toMatch(/Pick which broker/);
    expect(removeBrokerErrorCopy("NO_ROWS", "x", "dhan", 404)).toBe(
      "No Dhan trades are left in this account — they may already have been removed. Nothing was changed.",
    );
    expect(removeBrokerErrorCopy("CONFIRM_REQUIRED", "x", "dhan", 400)).toMatch(/not confirmed/);
    expect(removeBrokerErrorCopy("FAILED", "Nothing was removed — disk full. Your journal is unchanged.", "dhan", 500))
      .toBe("Nothing was removed — disk full. Your journal is unchanged.");
    expect(removeBrokerErrorCopy(undefined, undefined, "dhan", 502)).toBe(
      "Nothing was removed — the request failed (HTTP 502). Your journal is unchanged.",
    );
  });
});

describe("commit-shape cautions", () => {
  it("render inside the commit-shape block under their own test ids, the opening-sell one linking to the unknown-basis trades", () => {
    const block = clientSrc.slice(clientSrc.indexOf('data-testid="commit-shape"'), clientSrc.indexOf("View trades →"));
    expect(block).toContain('data-testid="shape-opening-sell-review"');
    expect(block).toContain('data-testid="shape-relabelled"');
    expect(block).toMatch(/<Link href=\{OPENING_SELL_REVIEW_HREF\}/);
    expect(OPENING_SELL_REVIEW_HREF).toBe("/trades?basis=unknown");
    // The "View trades →" button is still there, after the block.
    expect(clientSrc).toMatch(/onClick=\{\(\) => router\.push\("\/trades"\)\}>\s*View trades →/);
  });

  it("splits the headline from the cautions by the sentence's own rule", () => {
    // The rule this relies on, pinned at its source.
    expect(shapeSrc).toContain('return cautions.length > 0 ? `${base}. ${cautions.join(". ")}.` : base;');

    const both = { sourceRows: 414, positions: 142, open: 3, openingSells: 24, relabelled: 2 };
    expect(splitShapeSentence(both)).toEqual({
      headline: "414 executions → 142 positions (3 open, 24 opening sells without buy history)",
      review: "24 sales without a purchase — review before trusting Net P&L",
      relabelled: "2 securities appeared under two labels — paired by ISIN",
    });
    // Nothing is lost: headline + cautions is the sentence.
    const s = splitShapeSentence(both);
    expect(`${s.headline}. ${s.review}. ${s.relabelled}.`).toBe(importShapeSentence(both));

    const none = { sourceRows: 7544, positions: 793, open: 62, openingSells: 38 };
    expect(splitShapeSentence(none)).toEqual({
      headline: importShapeSentence(none),
      review: null,
      relabelled: null,
    });
  });
});
