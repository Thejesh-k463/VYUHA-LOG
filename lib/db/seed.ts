import { sql } from "drizzle-orm";
import { db, sqlite } from "./index";
import { seedDatabase } from "./seed-core";

console.log("Seeding Vyuha database…");
db.run(sql`PRAGMA foreign_keys = ON`);
seedDatabase(true);
console.log("Done.");
sqlite.close();
