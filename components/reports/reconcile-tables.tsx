"use client";

// v3.9 "Trust the numbers" — the Broker-truth tables.
//
// PRESENTATION ONLY. Every figure printed here arrives in `books` exactly as
// `lib/queries/reference.ts#reconcile()` stated it; the sorting, filtering and
// status words come from `lib/analytics/reconcile.ts`, which is pure and
// tested. Nothing on this file's side adds, subtracts or divides a figure —
// `tests/reconcile-screen.test.ts` reads the source and fails if it does.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { inr, num } from "@/lib/format";
import {
  RECONCILE_FEEDS,
  STATUS_CLASS,
  STATUS_LABEL,
  JOIN_LABEL,
  brokerOptions,
  filterLines,
  fyOptions,
  joinedOn,
  lineStatus,
  sortByAbsDelta,
  sortReasons,
  CHARGE_FIELD,
  chargeStatus,
  type ReconChargeLine,
  type ReconHolding,
  type ReconLine,
  type SourceSummary,
} from "@/lib/analytics/reconcile";

export interface ReconcileBook {
  accountId: number;
  accountName: string;
  recon: {
    fy: ReconLine[];
    segment: ReconLine[];
    scrip: ReconLine[];
    holdings: ReconHolding[];
    charges: ReconChargeLine[];
  };
  sources: SourceSummary[];
}

const FIELD = "grossPnl";

function StatusCell({ line }: { line: ReconLine }) {
  const s = lineStatus(line);
  return <span className={STATUS_CLASS[s]}>{STATUS_LABEL[s]}</span>;
}

function Reasons({ line }: { line: ReconLine }) {
  if (line.reasons.length === 0) {
    // Invariant 6: a gap with no knowable cause is reported with no cause —
    // but it says WHICH causes were checked, so the reader is not left with a
    // bare dash on a row that is ₹thousands out. `data-checked`, never
    // `data-reason`: this is not one of the four sanctioned reason codes, and
    // the e2e whitelist would rightly reject it as an invented excuse.
    return line.checkedNote
      ? <span data-checked className="text-muted-foreground">{line.checkedNote}</span>
      : <span className="text-muted-foreground">—</span>;
  }
  return (
    <ul className="space-y-1">
      {sortReasons(line.reasons).map((r, i) => (
        <li key={i} data-reason={r.code} className="text-muted-foreground">
          {r.detail}
        </li>
      ))}
    </ul>
  );
}

/** One comparison table — the same five columns whatever the bucket is. */
function LinesTable({
  lines,
  firstHeader,
  testid,
}: {
  lines: ReconLine[];
  firstHeader: string;
  testid: string;
}) {
  return (
    <ReportTable minWidth={880}>
      <ReportThead>
        <ReportTh>{firstHeader}</ReportTh>
        <ReportTh align="right">Broker</ReportTh>
        <ReportTh align="right">Vyuha</ReportTh>
        <ReportTh align="right">Δ</ReportTh>
        <ReportTh>Status</ReportTh>
        <ReportTh>Why</ReportTh>
      </ReportThead>
      <tbody data-testid={testid}>
        {lines.map((l) => (
          <ReportTr key={`${l.scope}-${l.key}`} data-recon-key={l.key}>
            <ReportTd>
              <span className="font-medium">{l.label}</span>
              {l.scope === "scrip" && (
                <span className="ml-1.5 text-[0.6875rem] text-muted-foreground">
                  matched on {JOIN_LABEL[joinedOn(l)]}
                  {l.isin ? ` · ${l.isin}` : ""}
                </span>
              )}
              {l.broker && <span className="ml-1.5 text-[0.6875rem] uppercase text-muted-foreground">{l.broker}</span>}
            </ReportTd>
            <ReportTd align="right">{l.stated[FIELD] == null ? "—" : inr(l.stated[FIELD])}</ReportTd>
            <ReportTd align="right">{inr(l.vyuha[FIELD])}</ReportTd>
            <ReportTd align="right" data-recon-delta>
              {l.delta[FIELD] == null ? "—" : inr(l.delta[FIELD])}
            </ReportTd>
            <ReportTd><StatusCell line={l} /></ReportTd>
            {/* The reasons are sentences, so this cell opts out of the table's
                nowrap — a truncated reason is a reason nobody reads. */}
            <ReportTd className="max-w-[30rem] whitespace-normal"><Reasons line={l} /></ReportTd>
          </ReportTr>
        ))}
        {lines.length === 0 && (
          <ReportTr>
            <ReportTd colSpan={6} className="text-muted-foreground">
              No figures under this filter.
            </ReportTd>
          </ReportTr>
        )}
      </tbody>
    </ReportTable>
  );
}

function SourcesPanel({ sources }: { sources: SourceSummary[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sources</CardTitle>
      </CardHeader>
      <CardContent>
        <ReportTable minWidth={640}>
          <ReportThead>
            <ReportTh>Statement</ReportTh>
            <ReportTh>Broker</ReportTh>
            <ReportTh>Stated for</ReportTh>
            <ReportTh align="right">Figures</ReportTh>
            <ReportTh align="right">Import batch</ReportTh>
          </ReportThead>
          <tbody data-testid="reconcile-sources">
            {sources.map((s) => (
              <ReportTr key={`${s.broker}-${s.sourceId}`}>
                <ReportTd>{s.label}</ReportTd>
                <ReportTd className="uppercase">{s.broker}</ReportTd>
                <ReportTd>
                  {s.fys.length > 0 ? s.fys.join(", ") : "no FY stated"}
                  {s.asOfFrom && (
                    <span className="ml-1.5 text-muted-foreground">
                      · as of {s.asOfFrom}{s.asOfTo && s.asOfTo !== s.asOfFrom ? ` — ${s.asOfTo}` : ""}
                    </span>
                  )}
                </ReportTd>
                <ReportTd align="right">{num(s.rows, 0)}</ReportTd>
                <ReportTd align="right">{s.batches.length > 0 ? s.batches.join(", ") : "—"}</ReportTd>
              </ReportTr>
            ))}
          </tbody>
        </ReportTable>
      </CardContent>
    </Card>
  );
}

/**
 * "Charges the broker states" — the read side of `scope: "charge"`.
 *
 * Three parsers have been writing charge figures since v3.9 and, until this
 * table, NOTHING read them: help, the source registry and the CHANGELOG all
 * said DP charges feed Broker Truth while the rows sat in the database
 * unreferenced. This is the table that makes those sentences true.
 *
 * A line whose `vyuha` is null prints "no counterpart" in BOTH the Vyuha and
 * the delta cell. It is not a zero and not a gap — the book has no column for
 * that fee, and subtracting from nothing is how a fabricated delta gets on a
 * screen (invariant 6).
 */
function ChargesTable({ charges }: { charges: ReconChargeLine[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Charges the broker states</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <ReportTable minWidth={880}>
          <ReportThead>
            <ReportTh>Charge</ReportTh>
            <ReportTh align="right">Broker</ReportTh>
            <ReportTh align="right">Vyuha</ReportTh>
            <ReportTh align="right">&Delta;</ReportTh>
            <ReportTh>Status</ReportTh>
            <ReportTh>Why</ReportTh>
          </ReportThead>
          <tbody data-testid="reconcile-charges">
            {charges.map((c) => {
              const field = CHARGE_FIELD[c.kind];
              const s = chargeStatus(c);
              return (
                <ReportTr key={`${c.kind}-${c.key}`} data-charge-key={c.key}>
                  <ReportTd>
                    <span className="font-medium">{c.label}</span>
                    {c.broker && (
                      <span className="ml-1.5 text-[0.6875rem] uppercase text-muted-foreground">{c.broker}</span>
                    )}
                  </ReportTd>
                  <ReportTd align="right">
                    {c.stated[field] == null ? "—" : inr(c.stated[field])}
                  </ReportTd>
                  <ReportTd align="right">
                    {c.vyuha == null ? (
                      <span className="text-muted-foreground">no counterpart</span>
                    ) : (
                      inr(c.vyuha[field])
                    )}
                  </ReportTd>
                  <ReportTd align="right" data-charge-delta>
                    {c.delta == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      inr(c.delta[field])
                    )}
                  </ReportTd>
                  <ReportTd><span className={STATUS_CLASS[s]}>{STATUS_LABEL[s]}</span></ReportTd>
                  <ReportTd className="max-w-[30rem] whitespace-normal text-muted-foreground">{c.note}</ReportTd>
                </ReportTr>
              );
            })}
          </tbody>
        </ReportTable>
        <p className="text-[0.6875rem] text-muted-foreground">
          A DP fee is levied on a delivery SALE, so it is compared per financial year against your book&apos;s own
          DP charges on trades sold in that year. A contract note states one day&apos;s charges; a position that
          spans days carries both legs&apos; charges, and the line says so rather than calling the arithmetic a
          disagreement.
        </p>
      </CardContent>
    </Card>
  );
}

function HoldingsTable({ holdings }: { holdings: ReconHolding[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Holdings — what the demat says you hold</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <ReportTable minWidth={640}>
          <ReportThead>
            <ReportTh>Security</ReportTh>
            <ReportTh>As of</ReportTh>
            <ReportTh align="right">Broker holds</ReportTh>
            <ReportTh align="right">Vyuha open</ReportTh>
            <ReportTh align="right">Δ</ReportTh>
          </ReportThead>
          <tbody data-testid="reconcile-holdings">
            {holdings.map((h) => (
              <ReportTr key={h.key}>
                <ReportTd>
                  <span className="font-medium">{h.label}</span>
                  {h.isin && <span className="ml-1.5 text-[0.6875rem] text-muted-foreground">{h.isin}</span>}
                </ReportTd>
                <ReportTd>{h.asOf ?? "—"}</ReportTd>
                <ReportTd align="right">{num(h.brokerQty, 0)}</ReportTd>
                <ReportTd align="right">{num(h.vyuhaQty, 0)}</ReportTd>
                <ReportTd align="right" className={h.delta === 0 ? "text-profit" : "text-warning"}>
                  {num(h.delta, 0)}
                </ReportTd>
              </ReportTr>
            ))}
          </tbody>
        </ReportTable>
        <p className="text-[0.6875rem] text-muted-foreground">
          Quantities only. A demat statement values your holdings at the day&apos;s close; your book states what
          they cost. The difference between those two is unrealised P&amp;L, not a disagreement.
        </p>
      </CardContent>
    </Card>
  );
}

function Book({ book, showName }: { book: ReconcileBook; showName: boolean }) {
  const { recon } = book;
  const [fy, setFy] = useState("");
  const [broker, setBroker] = useState("");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const fys = useMemo(() => fyOptions(recon.scrip), [recon.scrip]);
  const brokers = useMemo(() => brokerOptions(recon.scrip), [recon.scrip]);
  const scrip = useMemo(
    () => sortByAbsDelta(filterLines(recon.scrip, { fy, broker }), dir),
    [recon.scrip, fy, broker, dir],
  );

  return (
    <div className="space-y-5">
      {showName && <h2 className="text-sm font-semibold">{book.accountName}</h2>}

      <SourcesPanel sources={book.sources} />

      {recon.segment.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>By segment</CardTitle>
          </CardHeader>
          <CardContent>
            <LinesTable lines={recon.segment} firstHeader="Segment" testid="reconcile-segment" />
          </CardContent>
        </Card>
      )}

      {recon.fy.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>By financial year</CardTitle>
          </CardHeader>
          <CardContent>
            <LinesTable lines={recon.fy} firstHeader="FY" testid="reconcile-fy" />
          </CardContent>
        </Card>
      )}

      {recon.scrip.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>By scrip</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Financial year"
                className="h-8 w-auto text-xs"
                value={fy}
                onChange={(e) => setFy(e.target.value)}
              >
                <option value="">All financial years</option>
                {fys.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </Select>
              <Select
                aria-label="Broker"
                className="h-8 w-auto text-xs"
                value={broker}
                onChange={(e) => setBroker(e.target.value)}
              >
                <option value="">All brokers</option>
                {brokers.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDir(dir === "desc" ? "asc" : "desc")}
              >
                {dir === "desc" ? "Biggest gap first" : "Smallest gap first"}
              </Button>
            </div>
            <LinesTable lines={scrip} firstHeader="Security" testid="reconcile-scrip" />
          </CardContent>
        </Card>
      )}

      {recon.charges.length > 0 && <ChargesTable charges={recon.charges} />}

      {recon.holdings.length > 0 && <HoldingsTable holdings={recon.holdings} />}
    </div>
  );
}

export function ReconcileTables({ books, aggregate }: { books: ReconcileBook[]; aggregate: boolean }) {
  const loaded = books.filter((b) => b.sources.length > 0);

  if (loaded.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <EmptyState
            variant="chart"
            title="No broker statement loaded yet"
            hint="This screen compares a broker's OWN stated figures against your journal. Import any of these and it fills in."
          />
          <ul className="mx-auto mt-4 max-w-xl space-y-1 text-xs text-muted-foreground">
            {RECONCILE_FEEDS.map((f) => (
              <li key={f.sourceId}>▸ {f.label}</li>
            ))}
          </ul>
          <div className="mt-4 text-center">
            <Link href="/import" className="text-xs underline underline-offset-2">
              Go to Import →
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {aggregate && (
        <p className="text-xs text-muted-foreground">
          All accounts: each book is reconciled against its own broker&apos;s statement and shown separately.
          Two brokers&apos; figures are never added together — no statement states that sum.
        </p>
      )}
      {loaded.map((b) => (
        <Book key={b.accountId} book={b} showName={aggregate || loaded.length > 1} />
      ))}
    </div>
  );
}
