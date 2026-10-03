import "server-only";
import { cache } from "react";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import { accounts, clinicCache, clinicExperiments, riskConfig, trades } from "@/lib/db/schema";
import {
  edgeClinic,
  ENGINE_VERSION,
  type ClinicOptions,
  type ClinicReport,
  type ClinicTrade,
} from "@/lib/analytics/edge-clinic";
import { checkExperiment, findCell, proposalFor, teaser, weeklyNote, type StoredExperiment } from "@/lib/analytics/edge-clinic-note";
import { EXPERIMENT_TARGET_N, type ClinicExperiment, type ClinicState, type TradeCellLine } from "@/lib/analytics/edge-clinic-contract";
import { todayIstIso } from "@/lib/domain/trading-day";
import { readCapRows } from "@/lib/queries/risk-cap";
import { resolvePerTradeCap } from "@/lib/risk/limits";
import { getSelectedAccountId } from "./accounts";
import { getClinicTrades } from "./trades";

/**
 * EDGE CLINIC — the server half (v4.7.0 C2; design D2/D3/D5 + the review's
 * changes 3, 4, 5 and 7). Every account-scoped read starts from
 * `getSelectedAccountId()` (invariant 8); experiments are written only for a
 * REAL account (> 0), never resolved from the All view (invariant 9).
 *
 * THE RULE THIS MODULE EXISTS FOR: a page read NEVER runs the engine.
 * `getClinicState()` reads the projection, hashes it, and compares the hash with
 * the cached report's — fresh / stale / missing — and the client runner then
 * POSTs /api/edge-clinic/compute, which is the ONLY caller of `edgeClinic`.
 *
 * Why the digest cannot go stale (D2): it is a sha256 of the engine's INPUT —
 * ENGINE_VERSION, the scope, today's IST date, the non-default options and every
 * ClinicTrade exactly as handed to the engine (open rows as `{id, isOpen}`: the
 * engine reads only that of them). Any writer that changes something the engine
 * can see changes the digest; a change it cannot see does not matter.
 */

/** `acct:<id>`; 0 = the All-accounts VIEW (readable, never written to). */
export const scopeKeyOf = (accountId: number): string => `acct:${accountId}`;

export interface ClinicInputs {
  accountId: number;
  scopeKey: string;
  trades: ClinicTrade[];
  opts: ClinicOptions;
  digest: string;
}

/**
 * The two non-default engine options, from the install-wide `risk_config` (it has
 * no account_id — caps are per install):
 *   riskCapRupees  the per-trade cap resolved for the ACTIVE bucket (the engine
 *                  uses it only for F&O `oneLotOverCap`, and F&O is the active
 *                  bucket); null when no cap is stated — never invented.
 *   currentRiskPct the global row's `risk_pct_ppm` as a percent (20_000 ppm = 2);
 *                  null when unset.
 */
function engineOptions(today: string): ClinicOptions {
  const cap = resolvePerTradeCap(readCapRows(sqlite), "active", "");
  const ppm = db.select({ ppm: riskConfig.riskPctPpm }).from(riskConfig).where(eq(riskConfig.scope, "global")).get()?.ppm ?? null;
  return {
    today,
    riskCapRupees: cap != null && Number.isFinite(cap) && cap > 0 ? cap : null,
    currentRiskPct: ppm != null && ppm > 0 ? ppm / 10_000 : null,
  };
}

/** sha256 over the engine's exact input (D2). Exported for the tests and the measurement. */
export function clinicDigest(scopeKey: string, opts: ClinicOptions, ts: readonly ClinicTrade[]): string {
  const h = createHash("sha256");
  h.update(`${ENGINE_VERSION}|${scopeKey}|${opts.today}|`);
  h.update(JSON.stringify({ riskCapRupees: opts.riskCapRupees ?? null, currentRiskPct: opts.currentRiskPct ?? null }));
  h.update("|");
  for (const t of ts) {
    h.update(JSON.stringify(t.isOpen ? { id: t.id, isOpen: true } : t));
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * The inputs for one scope. `accountId` 0 = the All view (every account, through
 * `getClinicTrades()`'s selected-scope read, which IS all when the selection is 0);
 * an id > 0 reads exactly that account. Used directly only where the account is
 * NOT the selection: an experiment's own account (review change 3).
 */
export function clinicInputsFor(accountId: number, today: string = todayIstIso()): ClinicInputs {
  const selected = getSelectedAccountId();
  const ts = accountId === selected ? getClinicTrades() : getClinicTrades(accountId > 0 ? [accountId] : allAccountIds());
  const opts = engineOptions(today);
  const scopeKey = scopeKeyOf(accountId);
  return { accountId, scopeKey, trades: ts, opts, digest: clinicDigest(scopeKey, opts, ts) };
}

function allAccountIds(): number[] {
  return db.select({ id: accounts.id }).from(accounts).all().map((r) => r.id);
}

/**
 * THE ONE input builder (review change 7) — the page, the compute route and the
 * cell route all read this, so the report that is cached is computed over exactly
 * the array whose digest is stored. React `cache`: one projection read per request.
 */
export const clinicInputs = cache((): ClinicInputs => clinicInputsFor(getSelectedAccountId()));

interface CachedReport {
  digest: string;
  computedAt: string;
  report: ClinicReport;
}

/** The cached row for a scope, if it was written by THIS engine version (another version's shape is not read). */
function readCache(scopeKey: string): CachedReport | null {
  const row = db.select().from(clinicCache).where(eq(clinicCache.scopeKey, scopeKey)).get();
  if (!row || row.engineVersion !== ENGINE_VERSION) return null;
  try {
    return { digest: row.digest, computedAt: row.computedAt, report: JSON.parse(row.reportJson) as ClinicReport };
  } catch {
    return null;
  }
}

// ── Experiments ─────────────────────────────────────────────────────────────

/** Stored experiments in scope: `accountId > 0 ? filter : all` (invariant 8). */
function experimentRows(accountId: number): StoredExperiment[] {
  const q = db.select().from(clinicExperiments);
  const rows = (accountId > 0 ? q.where(eq(clinicExperiments.accountId, accountId)) : q).orderBy(clinicExperiments.id).all();
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    cellKey: r.cellKey,
    cellLabel: r.cellLabel,
    hypothesis: r.hypothesis,
    startedAt: r.startedAt,
    targetN: r.targetN,
    status: r.status,
    checkedAt: r.checkedAt,
  }));
}

/**
 * Each experiment checked over ITS OWN account's trades (review change 3) — in a
 * single-account scope that is the scope's own array (`inputs`), in the All view
 * one read per account that has experiments.
 */
function checkedExperiments(rows: StoredExperiment[], inputs: ClinicInputs | null, today: string): ClinicExperiment[] {
  const byAccount = new Map<number, ClinicTrade[]>();
  const tradesOf = (accountId: number): ClinicTrade[] => {
    if (inputs && inputs.accountId === accountId) return inputs.trades;
    let ts = byAccount.get(accountId);
    if (!ts) {
      ts = getClinicTrades([accountId]);
      byAccount.set(accountId, ts);
    }
    return ts;
  };
  return rows.map((r) => checkExperiment(tradesOf(r.accountId), r, today));
}

/** The experiments in the selected scope, each read over its own account's book. */
export function listExperiments(): ClinicExperiment[] {
  const inputs = clinicInputs();
  return checkedExperiments(experimentRows(inputs.accountId), inputs, inputs.opts.today);
}

/**
 * Persist `checked` for every OPEN experiment in scope whose progress reached its
 * target (D5) — run by the compute route. The read path derives the same status
 * without writing; this only stamps `checked_at` once. Returns the count stamped.
 */
export function runExperimentChecks(inputs: ClinicInputs = clinicInputs()): number {
  const open = experimentRows(inputs.accountId).filter((r) => r.status === "open");
  let n = 0;
  for (const e of checkedExperiments(open, inputs, inputs.opts.today)) {
    if (e.status !== "checked") continue;
    n += db
      .update(clinicExperiments)
      .set({ status: "checked", checkedAt: e.checkedAt })
      .where(and(eq(clinicExperiments.id, e.id), eq(clinicExperiments.status, "open")))
      .run().changes;
  }
  return n;
}

export type ExperimentWrite =
  | { ok: true; experiment: ClinicExperiment }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string };

/**
 * Start ONE experiment on a cell of the selected account's cached report. Refuses
 * the All view (400 — invariant 9: the write account is never resolved from a
 * view), a missing report (409 — compute first), an unknown or ungraded cell
 * (400) and a second OPEN experiment on the same (account, cell) (409; the partial
 * unique index is the backstop). Stores only `startedAt` (review change 4).
 */
export function startExperiment(cellKey: string): ExperimentWrite {
  const accountId = getSelectedAccountId();
  if (!(accountId > 0)) {
    return { ok: false, status: 400, message: "Choose one account to start an experiment — the All-accounts view is a view, not a book." };
  }
  if (!db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).get()) {
    return { ok: false, status: 400, message: "That account no longer exists." };
  }
  const cached = readCache(scopeKeyOf(accountId));
  if (!cached) return { ok: false, status: 409, message: "The Clinic has not been computed for this account yet." };
  const cell = findCell(cached.report, cellKey);
  const proposal = cell ? proposalFor(cell) : null;
  if (!cell || !proposal) return { ok: false, status: 400, message: "That cell has no graded finding to test." };
  const today = todayIstIso();
  const dup = db
    .select({ id: clinicExperiments.id })
    .from(clinicExperiments)
    .where(and(eq(clinicExperiments.accountId, accountId), eq(clinicExperiments.cellKey, cellKey), eq(clinicExperiments.status, "open")))
    .get();
  if (dup) return { ok: false, status: 409, message: "An experiment is already open on that cell." };
  const row = db
    .insert(clinicExperiments)
    .values({ accountId, cellKey, cellLabel: cell.label, hypothesis: proposal.hypothesis, startedAt: today, targetN: EXPERIMENT_TARGET_N, status: "open" })
    .returning()
    .get();
  const [experiment] = checkedExperiments([{ ...row, status: "open" }], null, today);
  return { ok: true, experiment };
}

/**
 * Abandon an OPEN experiment. Only inside the account that owns it: the selection
 * must be > 0 AND equal `exp.accountId` (review change 5) — 403 otherwise, so a
 * view (0) or another book can never close someone else's experiment.
 */
export function abandonExperiment(id: number): ExperimentWrite {
  const accountId = getSelectedAccountId();
  const row = db.select().from(clinicExperiments).where(eq(clinicExperiments.id, id)).get();
  if (!row) return { ok: false, status: 404, message: "No such experiment." };
  if (!(accountId > 0) || row.accountId !== accountId) {
    return { ok: false, status: 403, message: "That experiment belongs to another account — select it to change it." };
  }
  if (row.status !== "open") return { ok: false, status: 409, message: "Only an open experiment can be set aside." };
  db.update(clinicExperiments).set({ status: "abandoned" }).where(and(eq(clinicExperiments.id, id), eq(clinicExperiments.status, "open"))).run();
  const [experiment] = checkedExperiments([{ ...stored(row), status: "abandoned" }], null, todayIstIso());
  return { ok: true, experiment };
}

function stored(r: typeof clinicExperiments.$inferSelect): StoredExperiment {
  return { id: r.id, accountId: r.accountId, cellKey: r.cellKey, cellLabel: r.cellLabel, hypothesis: r.hypothesis, startedAt: r.startedAt, targetN: r.targetN, status: r.status, checkedAt: r.checkedAt };
}

// ── The page read ───────────────────────────────────────────────────────────

/**
 * What every page reads (D3). NEVER calls `edgeClinic`: one projection read, one
 * stringify + sha256, one cache-row read. `fresh` = same digest; `stale` = a row
 * with another digest (its report shown with its computedAt); `missing` = no row
 * from this engine version. The full report is in here — a page hands a FREE copy
 * `clinicStateFor(state, false)` (the contract file), never this object.
 */
export function getClinicState(): ClinicState {
  const inputs = clinicInputs();
  const cached = readCache(inputs.scopeKey);
  const status: ClinicState["status"] = !cached ? "missing" : cached.digest === inputs.digest ? "fresh" : "stale";
  const report = cached?.report ?? null;
  const experiments = checkedExperiments(experimentRows(inputs.accountId), inputs, inputs.opts.today);
  const openKeys = new Set(experiments.filter((e) => e.status === "open").map((e) => e.cellKey));
  return {
    status,
    scopeKey: inputs.scopeKey,
    digest: inputs.digest,
    computedAt: cached?.computedAt ?? null,
    report,
    teaser: report ? teaser(report) : null,
    note: report ? weeklyNote(report, openKeys) : null,
    experiments,
    canStartExperiment: inputs.accountId > 0,
  };
}

// ── The compute (route handler only) ────────────────────────────────────────

export interface ComputeResult {
  status: "fresh" | "computed";
  scopeKey: string;
  computedAt: string;
}

const INFLIGHT_KEY = "__vyuhaClinicInflight";
type Inflight = Map<string, Promise<ComputeResult>>;
function inflight(): Inflight {
  const g = globalThis as unknown as Record<string, Inflight | undefined>;
  return (g[INFLIGHT_KEY] ??= new Map());
}

/**
 * Recompute the selected scope's report if its digest moved (D3). Returns early
 * when fresh. A concurrent second call for the same scope awaits the first (the
 * `globalThis` in-flight map — the bhavcopy-backfill pattern). The stored digest
 * is the digest of the exact array the engine was handed (review change 7). Then
 * the experiment checks run over each experiment's own account.
 *
 * KNOWN LIMIT (recorded, D3): the engine runs on the request's event loop —
 * ≈ 7.5 s on the 25,001-row perf book, once per book change per scope; real books
 * take well under a second. A worker thread is a later option.
 */
export function computeClinic(): Promise<ComputeResult> {
  const inputs = clinicInputs();
  const map = inflight();
  const running = map.get(inputs.scopeKey);
  if (running) return running;
  const p = (async (): Promise<ComputeResult> => {
    await Promise.resolve();
    const cached = readCache(inputs.scopeKey);
    if (cached && cached.digest === inputs.digest) {
      runExperimentChecks(inputs);
      return { status: "fresh", scopeKey: inputs.scopeKey, computedAt: cached.computedAt };
    }
    const report = edgeClinic(inputs.trades, inputs.opts);
    const computedAt = new Date().toISOString();
    db.insert(clinicCache)
      .values({ scopeKey: inputs.scopeKey, digest: inputs.digest, engineVersion: ENGINE_VERSION, reportJson: JSON.stringify(report), computedAt })
      .onConflictDoUpdate({
        target: clinicCache.scopeKey,
        set: { digest: inputs.digest, engineVersion: ENGINE_VERSION, reportJson: JSON.stringify(report), computedAt },
      })
      .run();
    runExperimentChecks(inputs);
    return { status: "computed", scopeKey: inputs.scopeKey, computedAt };
  })().finally(() => map.delete(inputs.scopeKey));
  map.set(inputs.scopeKey, p);
  return p;
}

// ── The journal dialog's one line ───────────────────────────────────────────

/**
 * The trade's `segment|setup:<tag>` cell from the CACHED report of the selected
 * scope — no compute. Null when the trade is unknown, outside the
 * `getSelectedAccountId()` scope, or no cached report / cell exists. (The route
 * returns null for a free copy before this is reached.)
 */
export function getTradeCellLine(tradeId: number): TradeCellLine | null {
  if (!Number.isInteger(tradeId) || tradeId <= 0) return null;
  const accountId = getSelectedAccountId();
  const t = db
    .select({ accountId: trades.accountId, segment: trades.segment, setupTag: trades.setupTag })
    .from(trades)
    .where(eq(trades.id, tradeId))
    .get();
  if (!t) return null;
  if (accountId > 0 && t.accountId !== accountId) return null;
  const cached = readCache(scopeKeyOf(accountId));
  if (!cached) return null;
  const key = `${t.segment}|setup:${t.setupTag ?? "untagged"}`;
  const cell = cached.report.cells.find((c) => c.key === key);
  if (!cell) return null;
  return { key, label: cell.label, grade: cell.grade, nWithR: cell.nWithR, headline: cell.copy.headline, computedAt: cached.computedAt };
}

