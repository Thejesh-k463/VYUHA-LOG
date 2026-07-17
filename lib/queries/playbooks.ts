import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { playbooks } from "@/lib/db/schema";
import { asc } from "drizzle-orm";
import type { Playbook } from "@/lib/db/schema";

/** All playbooks, active first, alphabetical within. */
export const getPlaybooks = cache((): Playbook[] => {
  return db.select().from(playbooks).orderBy(asc(playbooks.archived), asc(playbooks.name)).all();
});
