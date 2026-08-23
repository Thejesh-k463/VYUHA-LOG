import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLedger } from "../scripts/lib/license-mint.mjs";
import { nextReceiptNo, receiptText, sendMessage, upcomingRenewals, chaseFrom, inr, longDate } from "../scripts/lib/sale-flow.mjs";

/**
 * `npm run sell` end to end against a THROWAWAY keypair, ledger and archive in
 * a temp dir — the same VYUHA_LICENSE_PEM / VYUHA_LICENSE_LEDGER overrides the
 * other licence tests use. The real license-private.pem and ledger are never
 * opened. The backup passphrase comes from VYUHA_BACKUP_PASSPHRASE so nothing
 * prompts.
 *
 * The pure helpers are tested first without spawning anything; then the
 * orchestrator is run for real, twice on the same day, because the second run
 * is where the same-day-backup rename has to fire.
 */

const root = process.cwd();
let tmp: string;
let env: NodeJS.ProcessEnv;
let archive: string;
let ledgerPath: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-sell-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const pemPath = path.join(tmp, "test-private.pem");
  fs.writeFileSync(pemPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  ledgerPath = path.join(tmp, "ledger.jsonl");
  archive = path.join(tmp, "archive");
  env = {
    ...process.env,
    VYUHA_LICENSE_PEM: pemPath,
    VYUHA_LICENSE_LEDGER: ledgerPath,
    VYUHA_KEY_ARCHIVE_DIR: archive,
    VYUHA_BACKUP_PASSPHRASE: "test-passphrase-not-real",
    VYUHA_RECEIPT_FLOOR: "0",
  };
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sell(args: string[]) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "sell.mjs"), ...args], { encoding: "utf8", env });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
function renewals(args: string[] = []) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "renewals.mjs"), ...args], { encoding: "utf8", env });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe("sale-flow helpers (pure)", () => {
  it("numbers receipts sequentially per year, above a hand-written floor", () => {
    expect(nextReceiptNo([], 2026, 2)).toBe("VY-2026-003");
    expect(nextReceiptNo([{ receipt: "VY-2026-007" }], 2026, 2)).toBe("VY-2026-008");
    // A different year restarts at 001 — but never below the floor for THIS year.
    expect(nextReceiptNo([{ receipt: "VY-2026-007" }], 2027, 0)).toBe("VY-2027-001");
    // Keys with no receipt (pre-receipt era) are skipped, not crashed on.
    expect(nextReceiptNo([{}, { receipt: null }, { receipt: "VY-2026-004" }], 2026, 0)).toBe("VY-2026-005");
  });

  it("formats rupees with Indian grouping and dates in the receipt's long form", () => {
    expect(inr(9999)).toBe("9,999");
    expect(inr(29999)).toBe("29,999");
    expect(inr(1234567)).toBe("12,34,567");
    expect(longDate("2026-08-23")).toBe("23 August 2026");
  });

  it("writes a receipt that is a receipt, not a tax invoice, and quotes the key id never the key", () => {
    const r = receiptText({ receiptNo: "VY-2026-002", issued: "2026-08-23", name: "Shivangi Kulkarni", email: "x@y.com", plan: "annual", keyId: "35CF-B8B5-8E", utr: "072712985315", expires: "2027-08-23" });
    expect(r).toContain("Receipt no.    VY-2026-002");
    expect(r).toContain("Item           Vyuha — Pro (Annual)");
    expect(r).toContain("Licence term   1 year from 23 August 2026 (expires 23 August 2027)");
    expect(r).toContain("Amount paid    ₹9,999");
    expect(r).toContain("Not a tax invoice. No GST has been charged");
    expect(r).not.toMatch(/GSTIN|HSN|SAC|CGST|SGST|IGST/);
    expect(r).not.toMatch(/VYUHA-[A-Za-z0-9]/); // never the key itself
    const life = receiptText({ receiptNo: "VY-2026-001", issued: "2026-08-23", name: "S", email: "x@y.com", plan: "lifetime", keyId: "A5E2-A025-D6", utr: "1", expires: null });
    expect(life).toContain("Licence term   perpetual");
    expect(life).toContain("₹29,999");
  });

  it("the send message carries a paste marker and never the key", () => {
    const m = sendMessage({ receipt: "R", email: "x@y.com", zipName: "Vyuha_2.99.100_Client_Package.zip" });
    expect(m).toContain("<<< PASTE THE KEY HERE");
    expect(m).toContain('Licensed to x@y.com');
    expect(m).toContain("Vyuha_2.99.100_Client_Package.zip");
    expect(m).not.toMatch(/VYUHA-[A-Za-z0-9]/);
  });

  it("finds renewals inside the window, sorted soonest first, and ignores lifetime keys", () => {
    const recs = [
      { keyId: "L", expires: null },
      { keyId: "FAR", expires: "2027-08-23" },
      { keyId: "SOON", expires: "2026-09-10" },
      { keyId: "PAST", expires: "2026-08-01" },
    ];
    const due = upcomingRenewals(recs, "2026-08-23", 60);
    expect(due.map((r: { keyId: string }) => r.keyId)).toEqual(["PAST", "SOON"]);
    expect(due[0].daysLeft).toBeLessThan(0);
    expect(chaseFrom("2027-08-23")).toBe("2027-07-24");
  });
});

describe("npm run sell — end to end on a throwaway ledger", () => {
  it("refuses without a term, without a name, and without a UTR or --no-payment", () => {
    expect(sell(["a@b.com", "--name", "A"]).status).not.toBe(0);
    expect(sell(["a@b.com", "--lifetime"]).status).not.toBe(0);
    expect(sell(["a@b.com", "--lifetime", "--name", "A"]).status).not.toBe(0);
    expect(sell(["a@b.com", "--lifetime", "--name", "A", "--utr", "123"]).err).toMatch(/12-digit/);
    expect(fs.existsSync(ledgerPath)).toBe(false); // nothing was minted by any refusal
  });

  it("lifetime sale: mints, verifies, numbers the receipt, backs up, writes the message — and the key is only where it should be", () => {
    const r = sell(["siddhi@example.com", "--lifetime", "--utr", "627604880174", "--name", "Siddhi Gunwant", "--today", "2026-08-23"]);
    expect(r.status, r.err).toBe(0);

    const ledger = readLedger(ledgerPath);
    expect(ledger).toHaveLength(1);
    const rec = ledger[0];
    expect(rec.email).toBe("siddhi@example.com");
    expect(rec.expires).toBeNull();
    expect(rec.note).toContain("UTR 627604880174");
    expect(rec.receipt).toBe("VY-2026-001");

    const receipt = fs.readFileSync(path.join(archive, "VY-2026-001.txt"), "utf8");
    expect(receipt).toContain("Licence Key ID " + rec.keyId);
    expect(receipt).toContain("perpetual");

    const msg = fs.readFileSync(path.join(archive, `send-${rec.keyId}.txt`), "utf8");
    expect(msg).toContain("<<< PASTE THE KEY HERE");
    expect(msg).not.toContain(rec.key);

    // The key exists in exactly two places: the ledger and the archive file.
    const keyFile = fs.readdirSync(archive).find((f) => f.startsWith(rec.keyId + "_"));
    expect(keyFile).toBeDefined();
    expect(fs.readFileSync(path.join(archive, keyFile!), "utf8").split("\n")[0]).toBe(rec.key);

    expect(fs.existsSync(path.join(archive, "vyuha-keys-2026-08-23.vkb"))).toBe(true);
    expect(r.err).toMatch(/holds the \d+-byte ledger \(matches live\)/);
    expect(r.err).not.toMatch(/RENEWAL/); // lifetime has none
  });

  it("annual sale on the SAME day: expiry set, receipt increments, earlier bundle renamed, renewal printed", () => {
    const r = sell(["shivangi@example.com", "--years", "1", "--utr", "072712985315", "--name", "Shivangi Kulkarni", "--today", "2026-08-23"]);
    expect(r.status, r.err).toBe(0);

    const ledger = readLedger(ledgerPath);
    expect(ledger).toHaveLength(2);
    const rec = ledger[1];
    expect(rec.expires).toBe("2027-08-23");
    expect(rec.receipt).toBe("VY-2026-002");

    // Same-day second backup: the earlier bundle must have been renamed, not clobbered.
    expect(fs.existsSync(path.join(archive, "vyuha-keys-2026-08-23-a.vkb"))).toBe(true);
    expect(fs.existsSync(path.join(archive, "vyuha-keys-2026-08-23.vkb"))).toBe(true);
    expect(r.err).toMatch(/earlier bundle today renamed/);
    expect(r.err).toMatch(/RENEWAL: expires 2027-08-23 — chase from 2027-07-24/);
  });

  it("refuses to reuse a receipt number if the file already exists", () => {
    // Simulate a receipt file appearing out of band for the number that would be next.
    fs.writeFileSync(path.join(archive, "VY-2026-003.txt"), "stale");
    const r = sell(["third@example.com", "--lifetime", "--utr", "111122223333", "--name", "Third", "--today", "2026-08-23"]);
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/refusing to overwrite .*VY-2026-003/);
    fs.rmSync(path.join(archive, "VY-2026-003.txt"));
    // The mint DID happen before the receipt step refused, which is the honest
    // order (the ledger is the record); the ledger line simply has no receipt
    // number, and the next run numbers from the last one that does.
    expect(readLedger(ledgerPath)).toHaveLength(3);
  });

  it("refuses a second key for an email that already holds one, BEFORE minting", () => {
    const n = readLedger(ledgerPath).length;
    const r = sell(["siddhi@example.com", "--lifetime", "--utr", "999999999999", "--name", "Again", "--today", "2026-08-23"]);
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/already holds key/);
    expect(r.err).toMatch(/--allow-duplicate-email/);
    // The guard fires before the mint, so the ledger is unchanged — the whole
    // point, since a mint cannot be undone.
    expect(readLedger(ledgerPath)).toHaveLength(n);
  });

  it("npm run renewals reads the same ledger and reports the annual key", () => {
    const far = renewals(["--today", "2026-08-23", "--days", "60"]);
    expect(far.status).toBe(0);
    expect(far.out).toMatch(/Nothing expires in the next 60 days/);

    const near = renewals(["--today", "2027-08-01", "--days", "60"]);
    expect(near.status).toBe(0);
    expect(near.out).toMatch(/35CF|[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{2}/);
    expect(near.out).toMatch(/2027-08-23/);
    expect(near.out).toMatch(/22d left/);

    const lapsed = renewals(["--today", "2027-09-01", "--days", "60"]);
    expect(lapsed.status).toBe(2); // non-zero so a scheduled run can alert
    expect(lapsed.out).toMatch(/LAPSED 9d ago/);
  });
});
