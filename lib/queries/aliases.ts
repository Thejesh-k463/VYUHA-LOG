import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { symbolAliases } from "@/lib/db/schema";
import { asc } from "drizzle-orm";
import { buildAliasMap } from "@/lib/analytics/aliases";

export interface AliasDisplay {
  id: number;
  alias: string;
  ticker: string;
  note: string | null;
}

export function getAliases(): AliasDisplay[] {
  return db
    .select()
    .from(symbolAliases)
    .orderBy(asc(symbolAliases.alias))
    .all()
    .map((r) => ({ id: r.id, alias: r.alias, ticker: r.ticker, note: r.note }));
}

/** alias (upper) → ticker (upper). */
export const getAliasMap = cache((): Map<string, string> => {
  return buildAliasMap(getAliases());
});
