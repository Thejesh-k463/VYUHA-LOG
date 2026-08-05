import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

// Resolve <project>/data/vyuha.sqlite and ensure the directory exists.
const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.VYUHA_DB_PATH ?? path.join(dataDir, "vyuha.sqlite");

// Cache the connection across Next.js dev hot-reloads to avoid leaking handles.
const globalForDb = globalThis as unknown as {
  __vyuhaSqlite?: Database.Database;
};

const sqlite =
  globalForDb.__vyuhaSqlite ??
  (() => {
    const conn = new Database(dbPath);
    // busy_timeout MUST be set before any pragma that takes a write lock.
    //
    // `next build` collects page data with several worker PROCESSES, and every
    // route that reaches a query opens this file in each of them. Without a
    // timeout the second worker to arrive fails instantly with SQLITE_BUSY
    // rather than waiting the few milliseconds the first one needs — which is
    // exactly how the macOS build broke while Linux passed on timing luck.
    // Setting WAL is itself a locking operation, so ordering matters here.
    //
    // It protects the shipped app too: the desktop sidecar and any second
    // process touching the same journal now queue instead of erroring.
    conn.pragma("busy_timeout = 10000");
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    return conn;
  })();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__vyuhaSqlite = sqlite;
}

export const db = drizzle(sqlite, { schema });
export { schema, sqlite };

// Attachments live next to the DB file (project data/ in dev, OS app-data on
// desktop via VYUHA_DB_PATH) so they survive reinstalls with the journal.
export const attachmentsDir = path.join(path.dirname(dbPath), "attachments");
