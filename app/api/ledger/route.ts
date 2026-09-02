import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { ledgerEntries } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { toPaise } from "@/lib/money";
import { LEDGER_PAGE_SIZE, LEDGER_TYPES, type LedgerType } from "@/lib/analytics/ledger";
import { recordAudit } from "@/lib/audit";
import { getSelectedAccountId, getWriteAccountId } from "@/lib/queries/accounts";
import { countLedgerEntries, getLedgerRunningRows } from "@/lib/queries/ledger";

export const runtime = "nodejs";

/**
 * Pages of the running-balance ledger (latest first), so /cash can render one
 * page instead of SSR-ing every entry. `?all=1` returns the full ledger for the
 * on-demand CSV/XLSX export — fetched only when the user clicks Export, never
 * as part of a render. Balances come from the same SQL window the page uses,
 * scoped to the selected account like every other read.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("all") === "1") {
    // limit < 0 is SQLite's "no limit".
    const rows = getLedgerRunningRows({ limit: -1 });
    return NextResponse.json({ ok: true, rows, total: rows.length });
  }
  const rawOffset = Number(url.searchParams.get("offset") ?? 0);
  const rawLimit = Number(url.searchParams.get("limit") ?? LEDGER_PAGE_SIZE);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  const limit = Number.isFinite(rawLimit) ? Math.min(1000, Math.max(1, Math.trunc(rawLimit))) : LEDGER_PAGE_SIZE;
  const rows = getLedgerRunningRows({ limit, offset });
  return NextResponse.json({ ok: true, rows, total: countLedgerEntries() });
}

// Types whose sign is fixed regardless of how the magnitude is entered.
const FIXED_SIGN: Partial<Record<LedgerType, 1 | -1>> = {
  deposit: 1,
  interest: 1,
  dividend: 1,
  withdrawal: -1,
  charge: -1,
  mtf_interest: -1,
  dividend_tds: -1,
  margin_penalty: -1,
};

function revalidate() {
  for (const p of ["/cash", "/", "/equity", "/active", "/risk"]) revalidatePath(p);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  if (body.action === "delete") {
    const id = Number(body.id);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, message: "Bad id" }, { status: 400 });
    const accountId = getSelectedAccountId();
    const owned = accountId > 0 ? and(eq(ledgerEntries.id, id), eq(ledgerEntries.accountId, accountId)) : eq(ledgerEntries.id, id);
    const prev = db.select().from(ledgerEntries).where(owned).get();
    if (!prev) return NextResponse.json({ ok: false, message: "Entry not found in this account." }, { status: 404 });
    db.delete(ledgerEntries).where(owned).run();
    recordAudit({
      entity: "ledger",
      entityId: id,
      action: "delete",
      summary: prev ? `${prev.type} ${prev.amountPaise} paise removed` : `entry ${id} removed`,
      before: prev ? { date: prev.date, bucket: prev.bucket, type: prev.type, amountPaise: prev.amountPaise } : null,
    });
    revalidate();
    return NextResponse.json({ ok: true, message: "Entry deleted." });
  }

  if (body.action === "add") {
    // Invariant 9 FIRST, before any parsing: a cash entry belongs to ONE book,
    // and getWriteAccountId()'s no-selection fallback is "the lowest account
    // id" — so a ₹50,000 deposit added from the All-accounts view landed on
    // account #1 and answered "Ledger entry added." The refusal shape is the
    // house one (lib/queries/challans.ts, /api/bf-losses): 403 for the
    // aggregate-view write ban, 400 for everything else. A WriteAccountPicker
    // on /cash — the way /import and /trades solve this — would be friendlier
    // still, but that is UI work; refusing is what stops the misfiling.
    if (getSelectedAccountId() === 0) {
      return NextResponse.json(
        {
          ok: false,
          forbidden: true,
          message: "A cash entry belongs to one account's book — pick an account in the sidebar first. The All-accounts view only reads.",
        },
        { status: 403 },
      );
    }
    const type = body.type as LedgerType;
    if (!LEDGER_TYPES.includes(type)) {
      return NextResponse.json({ ok: false, message: "Unknown entry type" }, { status: 400 });
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : new Date().toISOString().slice(0, 10);
    const bucket = body.bucket === "equity" || body.bucket === "active" ? body.bucket : "";
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      return NextResponse.json({ ok: false, message: "Enter a non-zero amount" }, { status: 400 });
    }
    const fixed = FIXED_SIGN[type];
    // Fixed-sign types use the magnitude; realised_pnl / adjustment keep the entered sign.
    const amountPaise = fixed != null ? fixed * toPaise(Math.abs(amount)) : toPaise(amount);
    const note = typeof body.note === "string" ? body.note.slice(0, 200) : null;

    const accountId = getWriteAccountId();
    const ins = db.insert(ledgerEntries).values({ accountId, date, bucket, type, amountPaise, note, source: "manual" }).returning({ id: ledgerEntries.id }).get();
    recordAudit({
      entity: "ledger",
      entityId: ins?.id ?? null,
      action: "create",
      summary: `${type} ${amountPaise} paise · ${bucket || "—"}`,
      after: { date, bucket, type, amountPaise, note },
    });
    revalidate();
    return NextResponse.json({ ok: true, message: "Ledger entry added." });
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
