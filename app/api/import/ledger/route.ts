import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { ledgerEntries, trades } from "@/lib/db/schema";
import { and, eq, gte, lte } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { parseDhanCashFile, reconcileMtfInterest } from "@/lib/import/parsers/dhan-ledger";
import { getSelectedAccountId, getWriteAccountId } from "@/lib/queries/accounts";

export const runtime = "nodejs";

/**
 * Ledger import — the only place MTF interest can be read rather than guessed.
 *
 * Dhan calculates MTF interest daily and posts it WEEKLY to the ledger, so it
 * appears in no P&L export and on no contract note. Until now Vyuha estimated
 * it from the funded amount and a day count; this reads what was charged.
 *
 * Preview shows the reconciliation between the two and commits nothing, because
 * a ledger import writes to the account's money history and the user should see
 * the delta before that happens.
 */

/** Ledger rows already present in the same window, so re-importing the same
 *  file does not double-post. Keyed on date+amount+narration, which is as close
 *  to an identity as a ledger line has. */
function existingKeys(from: string, to: string): Set<string> {
  const accountId = getSelectedAccountId();
  const rows = db
    .select()
    .from(ledgerEntries)
    .where(accountId > 0
      ? and(gte(ledgerEntries.date, from), lte(ledgerEntries.date, to), eq(ledgerEntries.accountId, accountId))
      : and(gte(ledgerEntries.date, from), lte(ledgerEntries.date, to)))
    .all();
  return new Set(rows.map((r) => `${r.date}|${r.amountPaise}|${(r.note ?? "").slice(0, 60)}`));
}

/** Vyuha's own MTF interest estimate over the same window, for comparison. */
function estimatedMtfInterest(from: string, to: string): number {
  const accountId = getSelectedAccountId();
  const rows = db.select().from(trades).where(accountId > 0
    ? and(eq(trades.segment, "eq_mtf"), eq(trades.accountId, accountId))
    : eq(trades.segment, "eq_mtf")).all();
  return rows
    .filter((t) => {
      const d = t.sellDate ?? t.buyDate;
      return d != null && d >= from && d <= to;
    })
    .reduce((s, t) => s + (t.mtfInterest ?? 0), 0);
}

export async function POST(req: Request) {
  // Invariant 9 FIRST, before the file is even read. A ledger import writes the
  // WHOLE statement, and `getWriteAccountId()` below had no selection to
  // resolve in the All-accounts view — its fallback is
  // `orderBy(asc(accounts.id)).limit(1)`, so every line of someone's Dhan
  // ledger landed on account #1 inside one transaction, behind
  // "Imported N ledger entries". Same defect as the single-row /api/ledger add,
  // one statement wide.
  //
  // PREVIEW is refused too, not just the commit. The preview's newCount,
  // dupCount and MTF reconciliation all come from existingKeys() and
  // estimatedMtfInterest(), which read across EVERY account when none is
  // selected — so an aggregate-view preview shows numbers that no per-account
  // commit could ever reproduce. Showing a reconciliation that cannot be acted
  // on is its own dishonesty; refusing at the door says the true thing once.
  //
  // House shape (lib/queries/challans.ts, /api/bf-losses): 403 for the
  // aggregate-view write ban, everything else keeps its existing status.
  if (getSelectedAccountId() === 0) {
    return NextResponse.json(
      {
        ok: false,
        forbidden: true,
        message: "A ledger import writes one account's money history — pick an account in the sidebar first. The All-accounts view only reads.",
      },
      { status: 403 },
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const mode = String(form?.get("mode") ?? "preview");

  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, message: "No file supplied." }, { status: 400 });
  }

  const text = Buffer.from(await file.arrayBuffer()).toString("utf-8");
  // The dividend payout report shares this door (2026-09-04): it is cash that
  // reached the account, so it lands as dividend entries in the same table.
  const parsed = parseDhanCashFile(text);

  if (parsed.rows.length === 0) {
    return NextResponse.json({ ok: false, message: parsed.warnings.join(" ") }, { status: 422 });
  }

  const from = parsed.from!;
  const to = parsed.to!;
  const seen = existingKeys(from, to);
  const fresh = parsed.rows.filter(
    (r) => !seen.has(`${r.date}|${Math.round(r.amount * 100)}|${r.narration.slice(0, 60)}`),
  );

  const estimated = estimatedMtfInterest(from, to);
  const mtf = reconcileMtfInterest(parsed.mtfInterestTotal, estimated);

  if (mode !== "commit") {
    return NextResponse.json({
      ok: true,
      mode: "preview",
      from,
      to,
      openingBalance: parsed.openingBalance,
      total: parsed.rows.length,
      newCount: fresh.length,
      dupCount: parsed.rows.length - fresh.length,
      mtf,
      unclassified: parsed.unclassified.map((r) => ({ date: r.date, narration: r.narration, amount: r.amount })),
      byKind: Object.entries(
        parsed.rows.reduce<Record<string, { count: number; amount: number }>>((a, r) => {
          const k = a[r.kind] ?? { count: 0, amount: 0 };
          k.count += 1;
          k.amount = Math.round((k.amount + r.amount) * 100) / 100;
          a[r.kind] = k;
          return a;
        }, {}),
      ).map(([kind, v]) => ({ kind, ...v })),
      warnings: parsed.warnings,
    });
  }

  db.transaction((tx) => {
    const accountId = getWriteAccountId();
    for (const r of fresh) {
      tx.insert(ledgerEntries)
        .values({
          accountId,
          date: r.date,
          bucket: "",
          type: r.kind,
          amountPaise: Math.round(r.amount * 100),
          note: r.narration.slice(0, 240),
          source: parsed.source ?? "dhan-ledger",
        })
        .run();
    }
  });

  recordAudit({
    entity: "settings",
    action: "create",
    summary: `Dhan ledger imported: ${fresh.length} entries (${from} → ${to}), MTF interest ₹${mtf.actual}`,
    before: null,
    after: { from, to, added: fresh.length, mtfInterest: mtf.actual },
  });

  for (const p of ["/cash", "/reports/charges", "/"]) revalidatePath(p);

  return NextResponse.json({
    ok: true,
    mode: "commit",
    added: fresh.length,
    skipped: parsed.rows.length - fresh.length,
    from,
    to,
    mtf,
    warnings: parsed.warnings,
  });
}
