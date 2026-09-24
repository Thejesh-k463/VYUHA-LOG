import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { DEFAULT_SEND_TIME } from "@/lib/telegram/digest-gate";
import { SETTINGS_MACHINE_BLANKS } from "@/lib/backup-format";

/**
 * Migration 0075 — the Telegram digest's stored send time moves past the F&O
 * close (owner ruling 2026-09-25, STATE §0.4 item 4). Three halves, each red on
 * its own revert:
 *
 *   1. the SQL moves a row still at 0053's default '15:35' to '15:45' and leaves
 *      a time the user typed alone;
 *   2. a FRESH settings row (the seed runs AFTER migrations, so the UPDATE never
 *      sees it) gets '15:45' from the schema default drizzle writes on insert —
 *      the DDL default is still '15:35', and only this test notices if the
 *      schema default reverts;
 *   3. the backup machine-blank and the digest's derived fallback agree with it.
 *
 * ONE temp database per file (lib/db caches its connection on globalThis).
 */

let t: TempDb;
const MIGRATION = path.join(process.cwd(), "drizzle", "0075_telegram-send-time-after-fo-close.sql");

beforeAll(async () => {
  t = await openTempDb("migration-0075", { seed: true });
});
afterAll(() => t?.cleanup());

const sendTime = () =>
  (t.sqlite.prepare("SELECT telegram_send_time AS v FROM settings").get() as { v: string }).v;

describe("migration 0075 — telegram_send_time past the F&O close", () => {
  it("is registered in the journal with a matching .sql file", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((e) => e.idx === 75);
    expect(entry?.tag).toBe("0075_telegram-send-time-after-fo-close");
    expect(fs.existsSync(MIGRATION)).toBe(true);
  });

  it("a freshly seeded settings row gets 15:45 (the schema default drizzle writes), not the DDL's 15:35", () => {
    const ddlDefault = (t.sqlite.prepare("PRAGMA table_info(settings)").all() as { name: string; dflt_value: string | null }[])
      .find((c) => c.name === "telegram_send_time")?.dflt_value;
    expect(ddlDefault, "the DDL default is 0053's and is deliberately NOT rebuilt").toBe("'15:35'");
    expect(sendTime()).toBe("15:45");
  });

  it("moves a row still at the old default, and only that row's value", () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    t.sqlite.prepare("UPDATE settings SET telegram_send_time = '15:35'").run();
    t.sqlite.exec(sql);
    expect(sendTime()).toBe("15:45");
    // Idempotent: a second run finds nothing to move.
    t.sqlite.exec(sql);
    expect(sendTime()).toBe("15:45");
  });

  it("never touches a time the user typed", () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    for (const typed of ["16:10", "15:36", "09:00"]) {
      t.sqlite.prepare("UPDATE settings SET telegram_send_time = ?").run(typed);
      t.sqlite.exec(sql);
      expect(sendTime()).toBe(typed);
    }
  });

  it("the schema default, the backup machine-blank and the calendar-derived fallback are one value", () => {
    expect(DEFAULT_SEND_TIME).toBe("15:45");
    expect(SETTINGS_MACHINE_BLANKS.telegramSendTime).toBe(DEFAULT_SEND_TIME);
  });
});
