import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * A1 — the backup is the ONLY copy of a user's trading life. tests/backup-format
 * covers the envelope shape; this file covers the thing that actually matters:
 * that a dump, once restored, reproduces the database it came from.
 *
 * Everything here goes through a real migrated SQLite file (see helpers/temp-db),
 * because the bugs this is guarding against — a wiped attachment directory, a
 * half-applied restore, paise read back as rupees — cannot occur in a mock.
 */

let t: TempDb;
// Loaded dynamically: lib/backup imports lib/db, which binds its file at import
// time. See the note in helpers/temp-db.ts.
let backup: typeof import("@/lib/backup");

beforeAll(async () => {
  t = await openTempDb("backup", { seed: true });
  backup = await import("@/lib/backup");
});

afterAll(() => t?.cleanup());

/** Reset user tables between tests; leaves the seeded config alone. */
function clearTrades() {
  t.db.delete(t.schema.tradeAttachments).run();
  t.db.delete(t.schema.trades).run();
  if (fs.existsSync(t.attachmentsDir)) fs.rmSync(t.attachmentsDir, { recursive: true, force: true });
}

function writeAttachment(name: string, body: string, tradeId: number) {
  fs.mkdirSync(t.attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(t.attachmentsDir, name), body);
  t.db.insert(t.schema.tradeAttachments).values({ tradeId, fileName: name, storedName: name, mime: "image/png", sizeBytes: body.length }).run();
}

describe("backup round-trip", () => {
  it("reproduces every table after a wipe", () => {
    clearTrades();
    t.db.insert(t.schema.trades).values([
      tradeRow({ symbol: "TCS", buyQty: 10, avgBuyPrice: 2057.5, isOpen: true }),
      tradeRow({ symbol: "INFY", buyQty: 5, avgBuyPrice: 1500.25, isOpen: false }),
    ]).run();

    const before = backup.dbCounts();
    const dump = backup.dumpDatabase();

    // Wipe the way a fresh install would look, then restore.
    t.db.delete(t.schema.trades).run();
    expect(t.db.select().from(t.schema.trades).all()).toHaveLength(0);

    const res = backup.restoreDatabase(dump);
    expect(res.ok).toBe(true);
    expect(backup.dbCounts()).toEqual(before);

    const rows = t.db.select().from(t.schema.trades).all().sort((a, b) => a.symbol.localeCompare(b.symbol));
    expect(rows.map((r) => r.symbol)).toEqual(["INFY", "TCS"]);
    expect(rows[1].avgBuyPrice).toBe(2057.5);
    expect(rows[0].isOpen).toBe(false);
    expect(rows[1].isOpen).toBe(true);
  });

  it("round-trips money without re-scaling it", () => {
    // Invariant #1: money is integer paise at rest, rupees at runtime. A backup
    // that multiplies or divides by 100 on the way through is a 100x bug that
    // would look plausible on screen.
    clearTrades();
    t.db.insert(t.schema.trades).values(tradeRow({ buyValue: 1234.56, netPnl: -987.65, riskAmount: 1000 })).run();

    const dump = backup.dumpDatabase();
    t.db.delete(t.schema.trades).run();
    backup.restoreDatabase(dump);

    const row = t.db.select().from(t.schema.trades).all()[0];
    expect(row.buyValue).toBe(1234.56);
    expect(row.netPnl).toBe(-987.65);
    expect(row.riskAmount).toBe(1000);
  });

  it("restores attachment bytes alongside their rows", () => {
    clearTrades();
    const id = t.db.insert(t.schema.trades).values(tradeRow()).returning({ id: t.schema.trades.id }).get()!.id;
    writeAttachment("chart-a.png", "PNG-BYTES-A", id);

    const dump = backup.dumpDatabase();
    expect(dump.attachments).toHaveLength(1);

    fs.rmSync(t.attachmentsDir, { recursive: true, force: true });
    t.db.delete(t.schema.tradeAttachments).run();

    backup.restoreDatabase(dump);
    expect(t.db.select().from(t.schema.tradeAttachments).all()).toHaveLength(1);
    expect(fs.readFileSync(path.join(t.attachmentsDir, "chart-a.png"), "utf8")).toBe("PNG-BYTES-A");
  });

  it("does NOT delete attachment files when restoring a backup that excludes them", () => {
    // A2 — dumpDatabase(false) still emits `attachments: []`, and an empty array
    // is truthy. Guarding on presence rather than length wipes every screenshot
    // on disk while restoring the trade_attachments rows that point at them.
    clearTrades();
    const id = t.db.insert(t.schema.trades).values(tradeRow()).returning({ id: t.schema.trades.id }).get()!.id;
    writeAttachment("chart-keep.png", "MUST-SURVIVE", id);

    const dump = backup.dumpDatabase(false);
    expect(dump.attachments ?? []).toHaveLength(0);

    const res = backup.restoreDatabase(dump);
    expect(res.ok).toBe(true);

    // The rows came back, so the files they reference must still be there.
    expect(t.db.select().from(t.schema.tradeAttachments).all()).toHaveLength(1);
    expect(fs.existsSync(path.join(t.attachmentsDir, "chart-keep.png"))).toBe(true);
    expect(fs.readFileSync(path.join(t.attachmentsDir, "chart-keep.png"), "utf8")).toBe("MUST-SURVIVE");
  });

  it("leaves the database and attachments untouched when a restore fails", () => {
    // A3 — a restore that throws partway must not leave a half-empty journal.
    clearTrades();
    const id = t.db.insert(t.schema.trades).values(tradeRow({ symbol: "SURVIVOR" })).returning({ id: t.schema.trades.id }).get()!.id;
    writeAttachment("chart-safe.png", "SAFE", id);

    const good = backup.dumpDatabase();
    // `trades` passes validateBackup (it is an array) but fails on insert:
    // broker/bucket/segment/... are NOT NULL with no default.
    const broken = { ...good, tables: { ...good.tables, trades: [{ id: 99 }] } };

    const res = backup.restoreDatabase(broken);
    expect(res.ok).toBe(false);

    const rows = t.db.select().from(t.schema.trades).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("SURVIVOR");
    expect(fs.readFileSync(path.join(t.attachmentsDir, "chart-safe.png"), "utf8")).toBe("SAFE");
  });

  it("recreates a Primary account when the backup has none", () => {
    clearTrades();
    const dump = backup.dumpDatabase();
    const res = backup.restoreDatabase({ ...dump, tables: { ...dump.tables, accounts: [] } });
    expect(res.ok).toBe(true);
    const accounts = t.db.select().from(t.schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].name).toBe("Primary");
  });
});

describe("encrypted backups", () => {
  it("round-trips through encrypt → decrypt → restore", () => {
    clearTrades();
    t.db.insert(t.schema.trades).values(tradeRow({ symbol: "SECRET", buyValue: 4321.99 })).run();

    const dump = backup.dumpDatabase();
    const sealed = backup.encryptBackup(dump, "correct horse battery");
    expect(sealed.vyuhaEncrypted).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain("SECRET");

    t.db.delete(t.schema.trades).run();

    const opened = backup.decryptBackup(sealed, "correct horse battery");
    const res = backup.restoreDatabase(opened);
    expect(res.ok).toBe(true);

    const row = t.db.select().from(t.schema.trades).all()[0];
    expect(row.symbol).toBe("SECRET");
    expect(row.buyValue).toBe(4321.99);
  });

  it("rejects a wrong password without leaking why", () => {
    const sealed = backup.encryptBackup(backup.dumpDatabase(), "the-right-one");
    expect(() => backup.decryptBackup(sealed, "the-wrong-one")).toThrow(/could not decrypt/i);
  });

  it("rejects tampered ciphertext (GCM authentication)", () => {
    const sealed = backup.encryptBackup(backup.dumpDatabase(), "password123");
    const raw = Buffer.from(sealed.ciphertext, "base64");
    raw[Math.floor(raw.length / 2)] ^= 0xff;
    const tampered = { ...sealed, ciphertext: raw.toString("base64") };
    expect(() => backup.decryptBackup(tampered, "password123")).toThrow(/could not decrypt/i);
  });

  it("refuses a password too short to be worth encrypting with", () => {
    expect(() => backup.encryptBackup(backup.dumpDatabase(), "short")).toThrow(/8 characters/i);
  });

  it("still opens a v1 envelope written with the old scrypt cost", () => {
    // A4 raised the KDF cost and recorded the parameters in the envelope.
    // Backups written before that carry no params and must keep opening.
    const dump = backup.dumpDatabase();
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync("legacy-password", salt, 32); // Node defaults: N=16384
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(dump), "utf8"), cipher.final()]);
    const legacy = {
      vyuhaEncrypted: true as const,
      version: 1 as const,
      algorithm: "aes-256-gcm" as const,
      kdf: "scrypt" as const,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };

    const opened = backup.decryptBackup(legacy, "legacy-password") as { vyuhaBackup: boolean };
    expect(opened.vyuhaBackup).toBe(true);
  });

  it("previews an encrypted backup without restoring it", () => {
    clearTrades();
    t.db.insert(t.schema.trades).values(tradeRow()).run();
    const sealed = backup.encryptBackup(backup.dumpDatabase(), "preview-password");
    const p = backup.previewBackup(sealed, "preview-password") as { ok: boolean; counts?: Record<string, number> };
    expect(p.ok).toBe(true);
    expect(p.counts?.trades).toBe(1);
    // Previewing must not have changed anything.
    expect(t.db.select().from(t.schema.trades).all()).toHaveLength(1);
  });
});

describe("v3: the four tables the list had fallen behind on", () => {
  it("round-trips mtf_margins — user uploads must survive backup → wipe → restore", () => {
    t.db.insert(t.schema.mtfMargins).values({ broker: "dhan", symbol: "RELIANCE", marginPct: 25, asOf: "2026-08-01", source: "upload: dhan.json" }).run();
    const dump = backup.dumpDatabase(false);
    expect(dump.tables.mtf_margins?.length).toBeGreaterThanOrEqual(1);

    t.db.delete(t.schema.mtfMargins).run();
    const res = backup.restoreDatabase(dump);
    expect(res.ok).toBe(true);
    const rows = t.db.select().from(t.schema.mtfMargins).all();
    expect(rows.some((r) => r.symbol === "RELIANCE" && r.marginPct === 25)).toBe(true);
  });

  it("a v2 envelope (no mtf_margins key) leaves today's rows ALONE instead of wiping them", () => {
    // The old restore deleted every BACKUP_TABLES table then reinserted
    // `tables[name] ?? []` — a pre-v3 file would have zeroed uploads it never
    // claimed to hold. Absent key = preserve; present-but-empty = truly empty.
    t.db.delete(t.schema.mtfMargins).run();
    t.db.insert(t.schema.mtfMargins).values({ broker: "groww", symbol: "TCS", marginPct: 30, asOf: "2026-08-01", source: "upload: groww.json" }).run();

    const dump = backup.dumpDatabase(false);
    delete (dump.tables as Record<string, unknown>).mtf_margins; // simulate a v2 file
    dump.version = 2;

    const res = backup.restoreDatabase(dump);
    expect(res.ok).toBe(true);
    const rows = t.db.select().from(t.schema.mtfMargins).all();
    expect(rows.some((r) => r.symbol === "TCS")).toBe(true);
  });
});

describe("v3: licence and trial state stay on the machine", () => {
  it("the dump carries no licence key and no trial clock", () => {
    t.db.update(t.schema.settings).set({
      licenseKey: "VYUHA-someone.signedkey",
      trialStartedAt: "2026-08-01",
      clockHighWaterMark: "2026-08-12",
    }).run();

    const dump = backup.dumpDatabase(false);
    const s = (dump.tables.settings as Record<string, unknown>[])[0];
    // A backup travels — a shared file must not be a shared key or a trial reset.
    expect(s.licenseKey).toBeNull();
    expect(s.trialStartedAt).toBeNull();
    expect(s.clockHighWaterMark).toBeNull();
    expect(JSON.stringify(dump)).not.toContain("VYUHA-someone");
  });

  it("restore keeps THIS machine's key and ratchet, whatever the envelope carries", () => {
    t.db.update(t.schema.settings).set({
      licenseKey: "VYUHA-mine.key",
      trialStartedAt: "2026-08-01",
      clockHighWaterMark: "2026-08-12",
    }).run();

    // A hostile/old envelope carrying someone else's key and a LOWER ratchet.
    const dump = backup.dumpDatabase(false);
    const s = (dump.tables.settings as Record<string, unknown>[])[0];
    s.licenseKey = "VYUHA-theirs.key";
    s.trialStartedAt = null;            // would reopen the trial
    s.clockHighWaterMark = "2020-01-01"; // would lower the tamper ratchet

    const res = backup.restoreDatabase(dump);
    expect(res.ok).toBe(true);
    const after = t.db.select().from(t.schema.settings).all()[0];
    expect(after.licenseKey).toBe("VYUHA-mine.key");
    expect(after.trialStartedAt).toBe("2026-08-01");
    expect(after.clockHighWaterMark).toBe("2026-08-12");
  });

  it("a backup neither carries nor grants an integration consent — and a NOT NULL machine column still restores", () => {
    // Two properties in one test because they broke as one:
    //
    //  1. Consent is a statement a PERSON made on a MACHINE. Restoring anyone's
    //     backup must leave the OpenAlgo gate exactly where a fresh install
    //     leaves it — off, disclosure unseen — even when the envelope says on.
    //  2. openalgo_enabled is NOT NULL. Redacting it to null (what every other
    //     machine column gets) made the restore INSERT violate the constraint,
    //     so restoreDatabase returned ok:false and took the whole round-trip
    //     down with it. A NOT NULL machine column needs its SAFE value, and
    //     for a gate the safe value is off — see settingsMachineBlank().
    t.db.update(t.schema.settings).set({ openalgoEnabled: false, openalgoAckVersion: null }).run();

    const dump = backup.dumpDatabase(false);
    const dumped = (dump.tables.settings as Record<string, unknown>[])[0];
    // The dump itself must not be able to say "on" — redaction happens there.
    expect(dumped.openalgoEnabled).toBe(false);
    expect(dumped.openalgoAckVersion).toBeNull();

    // Now forge an envelope that claims the integration was on and accepted.
    dumped.openalgoEnabled = true;
    dumped.openalgoAckVersion = "1";

    const res = backup.restoreDatabase(dump);
    expect(res.ok).toBe(true); // property 2: NOT NULL survives the round trip
    const after = t.db.select().from(t.schema.settings).all()[0];
    expect(after.openalgoEnabled).toBe(false); // property 1: no inherited consent
    expect(after.openalgoAckVersion).toBeNull();
  });
});

describe("connection pragmas", () => {
  it("sets a busy timeout before WAL, so concurrent openers wait instead of erroring", () => {
    // `next build` opens this file from several worker processes at once. With
    // no timeout the second one fails instantly with SQLITE_BUSY — which is how
    // the macOS build broke while Linux passed on timing luck alone.
    expect(t.sqlite.pragma("busy_timeout", { simple: true })).toBeGreaterThanOrEqual(10000);
    expect(String(t.sqlite.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
  });
});
