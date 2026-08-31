import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tradingSessions } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { getWriteAccountId } from "@/lib/queries/accounts";
import { getAliasMap } from "@/lib/queries/aliases";
import { getSymbolsByIsin } from "@/lib/queries/instruments";
import { bundledSymbolByIsin } from "@/lib/import/isin-symbol";
import { canonicaliseWatchlist, ISIN_RE } from "@/lib/import/watchlist";

export const runtime = "nodejs";
const input = z.object({ id: z.number().int().positive().optional(), accountId: z.number().int().positive().optional(), sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), market: z.string().min(1).default("NSE"), plannedSymbols: z.array(z.string()).default([]), plannedPlaybookIds: z.array(z.number().int().positive()).default([]), maxTrades: z.number().int().positive().nullable().optional(), maxLoss: z.number().positive().nullable().optional(), cutoffTime: z.string().nullable().optional(), thesis: z.string().nullable().optional(), status: z.enum(["planned", "reviewed"]).default("planned"), reviewNotes: z.string().nullable().optional() });

export async function POST(req: Request) {
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: parsed.error.issues[0]?.message ?? "Invalid session plan." }, { status: 400 });
  // The write account is RESOLVED, never trusted: an explicit id is validated
  // against the accounts table and anything else falls back to the selected
  // account (invariant 9). The old shape took the client's number verbatim,
  // so a stale tab could write — and via the update below, MOVE — a session
  // into an account that was never on screen (defect D7, 2026-08-12).
  const accountId = getWriteAccountId(parsed.data.accountId ?? null);
  const v = { ...parsed.data, accountId };
  // CANONICAL tickers are what gets stored: an alias (broker full name) or an
  // ISIN resolves to its exchange ticker so the review compares like with
  // like. Resolution chain for ISINs: the user's own instruments table first,
  // then the bundled snapshots. Anything unknown is KEPT as typed — never
  // refused, never guessed into a different symbol (isin-symbol.ts rule).
  const typed = [...new Set(v.plannedSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const instrumentIsins = getSymbolsByIsin(typed.filter((s) => ISIN_RE.test(s)));
  const canonical = canonicaliseWatchlist(typed, {
    aliasMap: getAliasMap(),
    isinLookup: (isin) => instrumentIsins.get(isin) ?? bundledSymbolByIsin(isin),
  });
  const values = { ...v, plannedSymbols: canonical, updatedAt: new Date().toISOString() };
  // Scoped to (id, account): an id from another account is treated as "no
  // such session" rather than overwritten across the boundary.
  const existing = v.id
    ? db.select().from(tradingSessions).where(and(eq(tradingSessions.id, v.id), eq(tradingSessions.accountId, accountId))).get()
    : null;
  if (existing) db.update(tradingSessions).set(values).where(eq(tradingSessions.id, existing.id)).run();
  else db.insert(tradingSessions).values(values).onConflictDoUpdate({ target: [tradingSessions.accountId, tradingSessions.sessionDate], set: values }).run();
  recordAudit({ entity: "session", entityId: v.id, action: existing ? "update" : "create", summary: `${v.sessionDate} session ${v.status}`, after: values, source: "ui" });
  revalidatePath("/sessions");
  return NextResponse.json({ ok: true });
}

const patchInput = z.object({
  id: z.number().int().positive(),
  accountId: z.number().int().positive(),
  status: z.enum(["planned", "reviewed"]),
  reviewNotes: z.string().nullable().optional(),
});

/**
 * Close the review loop: mark a past session reviewed (or back to planned)
 * with an optional note, WITHOUT resending the whole plan — the POST upsert
 * replaces every field, so a status-only client call through it would wipe
 * the watchlist and playbooks to their [] defaults.
 */
export async function PATCH(req: Request) {
  const parsed = patchInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: parsed.error.issues[0]?.message ?? "Invalid review." }, { status: 400 });
  const v = parsed.data;
  // A review updates an EXISTING row, so the target account is the row's own —
  // the session card sends it. getWriteAccountId validates the explicit id
  // against the accounts table (archived included: a past session on an
  // archived book stays reviewable) and never resolves to 0 (invariant 9).
  // Resolving getWriteAccountId(null) here instead fell back to the SELECTED
  // account — in the All-accounts view that is the lowest-id account, which
  // 404'd "Mark reviewed" for every other account's sessions (v3.5.0).
  const accountId = getWriteAccountId(v.accountId);
  // Scoped to (id, account) like the POST: an id from another account is "no
  // such session", never a cross-boundary write (invariant 9 / defect D7).
  const existing = db.select().from(tradingSessions).where(and(eq(tradingSessions.id, v.id), eq(tradingSessions.accountId, accountId))).get();
  if (!existing) return NextResponse.json({ ok: false, message: "No such session in this account." }, { status: 404 });
  const patch = {
    status: v.status,
    reviewNotes: v.reviewNotes === undefined ? existing.reviewNotes : v.reviewNotes,
    updatedAt: new Date().toISOString(),
  };
  db.update(tradingSessions).set(patch).where(eq(tradingSessions.id, existing.id)).run();
  recordAudit({ entity: "session", entityId: existing.id, action: "update", summary: `${existing.sessionDate} session marked ${v.status}`, after: patch, source: "ui" });
  revalidatePath("/sessions");
  return NextResponse.json({ ok: true });
}
