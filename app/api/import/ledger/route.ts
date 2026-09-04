import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { brokerReference, ledgerEntries, trades } from "@/lib/db/schema";
import { and, eq, gte, lte } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { parseDhanCashFile, reconcileMtfInterest } from "@/lib/import/parsers/dhan-ledger";
import { buildContext } from "@/lib/import/detect";
import type { ParseContext } from "@/lib/import/types";
import { detectUpstoxLedger, parseUpstoxLedger, type ParsedCashFile } from "@/lib/import/parsers/upstox-ledger";
import { detectAngelOneLedger, parseAngelOneLedger } from "@/lib/import/parsers/angelone-ledger";
import { detectDhanDpCharges, parseDhanDpChargesWorkbook } from "@/lib/import/parsers/dhan-dp-charges";
import { persistReference } from "@/lib/import/commit";
import type { ReferenceRow } from "@/lib/import/types";
import { getSelectedAccountId, getWriteAccountId } from "@/lib/queries/accounts";

export const runtime = "nodejs";

/**
 * Every stored reference row for one (account, broker, source), as comparable
 * strings. Used either side of `persistReference` to tell a re-upload of an
 * unchanged file from a file that actually states something new.
 */
function referenceFingerprint(
  tx: { select: typeof db.select },
  accountId: number,
  broker: string,
  sourceId: string,
): string[] {
  return tx
    .select({
      scope: brokerReference.scope,
      key: brokerReference.key,
      isin: brokerReference.isin,
      symbol: brokerReference.symbol,
      fy: brokerReference.fy,
      asOf: brokerReference.asOf,
      figuresJson: brokerReference.figuresJson,
      note: brokerReference.note,
    })
    .from(brokerReference)
    .where(and(
      eq(brokerReference.accountId, accountId),
      eq(brokerReference.broker, broker),
      eq(brokerReference.sourceId, sourceId),
    ))
    .all()
    .map((r) => JSON.stringify(r));
}

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

/**
 * The workbook cash files this door accepts, resolved THROUGH THE PARSERS'
 * OWN DETECT FUNCTIONS -- never by extension, never by filename.
 *
 * Until 2026-09-04 this route read the upload as UTF-8 text and handed it
 * straight to `parseDhanCashFile`, so an `.xlsx` ledger arrived as mojibake
 * and came back "no rows". Upstox and Angel One both publish their ledgers as
 * workbooks only, so the door had to learn bytes.
 *
 * The CSV path below is UNCHANGED and deliberately not routed through
 * detection: `parseDhanCashFile` already tells the Dhan ledger and the Dhan
 * dividend payout apart by their verified headers, and every existing CSV
 * behaviour -- including the exact warning text a file with no header comes
 * back with -- is a behaviour the Cash & Ledger screen is tested against.
 */
/**
 * A cash file plus the two things a reference-carrying one also states: whose
 * figures they are, and which export they came from.
 */
type CashParse = ParsedCashFile & {
  reference?: ReferenceRow[];
  broker?: string;
  sourceId?: string;
};

/**
 * Dhan's DP charges report as CASH.
 *
 * The parser has always ended its own warning with "upload it on the Cash &
 * Ledger screen, where each line lands as a charge entry" — and until
 * 2026-09-04 that screen refused the file with a 422, because this list named
 * Upstox and Angel One only. Advertising a door that is shut is worse than
 * having no door. Each printed debit lands as a `charge` entry; the file's own
 * per-(ISIN, day) figures land in `broker_reference` beside them.
 */
function parseDpChargesAsCash(ctx: ParseContext): CashParse {
  const p = parseDhanDpChargesWorkbook(ctx);
  const dates = p.rows.map((r) => r.date).filter(Boolean).sort();
  return {
    rows: p.rows,
    mtfInterestTotal: 0,
    unclassified: [],
    openingBalance: null,
    // The title states the window; the rows are the fallback, because a
    // window Vyuha cannot read must not become a crash on `parsed.from!`.
    from: p.from ?? dates[0] ?? null,
    to: p.to ?? dates[dates.length - 1] ?? null,
    warnings: p.warnings,
    source: "dhan-dp-charges",
    reference: p.reference,
    broker: "dhan",
    sourceId: "dhan-dp-charges",
  };
}

const WORKBOOK_CASH_SOURCES: {
  detect: (ctx: ParseContext) => number;
  parse: (ctx: ParseContext) => CashParse;
}[] = [
  { detect: detectUpstoxLedger, parse: parseUpstoxLedger },
  { detect: detectAngelOneLedger, parse: (c) => ({ ...parseAngelOneLedger(c), broker: "angelone", sourceId: "angelone-ledger" }) },
  { detect: detectDhanDpCharges, parse: parseDpChargesAsCash },
];

/** Read whichever cash file was uploaded. */
function readCashFile(filename: string, bytes: Buffer): CashParse {
  const ctx = buildContext(filename, bytes);
  // The dividend payout report shares this door (2026-09-04): it is cash that
  // reached the account, so it lands as dividend entries in the same table.
  if (ctx.text != null) return parseDhanCashFile(ctx.text);

  let best: { score: number; parse: (c: ParseContext) => ParsedCashFile } | null = null;
  for (const s of WORKBOOK_CASH_SOURCES) {
    const score = s.detect(ctx);
    if (score > 0 && (!best || score > best.score)) best = { score, parse: s.parse };
  }
  if (best) return best.parse(ctx);
  return {
    rows: [], mtfInterestTotal: 0, unclassified: [], openingBalance: null, from: null, to: null,
    warnings: [
      `No cash-file parser recognised ${filename}. The Cash & Ledger screen reads Dhan's ledger and dividend payout CSVs, Dhan's DP charges report, the Upstox ledger workbook and the Angel One account statement -- a file it cannot recognise is refused rather than read as something it is not.`,
    ],
  };
}

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

  const bytes = Buffer.from(await file.arrayBuffer());
  const parsed = readCashFile(file.name, bytes);

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

  const source = parsed.source ?? "dhan-ledger";
  let referenceStored = 0;
  /**
   * Whether the upsert actually CHANGED any stored figure.
   *
   * `persistReference` counts rows OFFERED, not rows altered — its upsert
   * re-writes an identical row and still returns 1. Re-uploading the same
   * unchanged DP-charges file therefore wrote a fresh "2 broker-stated figures
   * imported" audit entry every time, and an audit trail that records changes
   * that did not happen is worse than one that records nothing.
   */
  let referenceChanged = 0;
  const writeAccountId = db.transaction((tx) => {
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
          source,
        })
        .run();
    }
    // A cash file can also STATE figures (Dhan's DP charges report gives a fee
    // per ISIN per day; Angel One's statement gives its charge tables). Those
    // are the broker's own numbers and belong in `broker_reference`, in the
    // same transaction as the entries they describe — under the WRITE account,
    // never the selection, and never account #1 by fallback.
    if (parsed.reference?.length) {
      const broker = parsed.broker ?? "dhan";
      const sourceId = parsed.sourceId ?? source;
      // Read the rows this file is about to overwrite, BEFORE and AFTER, and
      // compare the stored values themselves. `changes()` cannot be used: an
      // `ON CONFLICT ... DO UPDATE` that writes byte-identical values still
      // reports one changed row.
      const before = referenceFingerprint(tx, accountId, broker, sourceId);
      referenceStored = persistReference(
        tx as unknown as Parameters<typeof persistReference>[0],
        parsed.reference,
        accountId,
        broker,
        sourceId,
        null,
      );
      const after = referenceFingerprint(tx, accountId, broker, sourceId);
      referenceChanged = after.filter((row) => !before.includes(row)).length;
    }
    return accountId;
  });

  // The audit line used to say "Dhan ledger imported" whatever the file was —
  // an Upstox ledger, an Angel One statement and a DP charges report all
  // logged themselves as a Dhan ledger. It names the actual source now.
  recordAudit({
    entity: "settings",
    action: "create",
    summary: `${source} imported: ${fresh.length} entries (${from} → ${to}), MTF interest ₹${mtf.actual}`,
    before: null,
    after: { source, from, to, added: fresh.length, mtfInterest: mtf.actual, referenceStored, referenceChanged },
  });
  // ONE audit entry per reference import, not one per figure — the house shape
  // from commitParsedFile — and NONE at all when the figures are the ones
  // already stored. A re-upload of an unchanged file changed nothing, so there
  // is nothing for the audit trail to record.
  if (referenceChanged > 0) {
    recordAudit({
      entity: "broker_reference",
      action: "create",
      summary: `${referenceChanged} broker-stated figure${referenceChanged === 1 ? "" : "s"} from ${file.name}`,
      before: null,
      after: { accountId: writeAccountId, broker: parsed.broker ?? "dhan", sourceId: parsed.sourceId ?? source, figures: referenceChanged },
    });
  }

  for (const p of ["/cash", "/reports/charges", "/"]) revalidatePath(p);

  return NextResponse.json({
    ok: true,
    mode: "commit",
    added: fresh.length,
    skipped: parsed.rows.length - fresh.length,
    from,
    to,
    source,
    referenceStored,
    referenceChanged,
    referenceNote:
      referenceStored > 0 && referenceChanged === 0
        ? `figures unchanged — the ${referenceStored} figure${referenceStored === 1 ? "" : "s"} this file states were already stored, so nothing changed and nothing was logged.`
        : null,
    mtf,
    warnings: parsed.warnings,
  });
}
