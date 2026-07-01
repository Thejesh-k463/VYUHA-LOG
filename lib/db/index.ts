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
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    return conn;
  })();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__vyuhaSqlite = sqlite;
}

export const db = drizzle(sqlite, { schema });
export { schema, sqlite };
