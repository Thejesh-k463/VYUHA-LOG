import type * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { PayoffChart } from "@/components/reports/payoff-chart";
import { LazyMount } from "@/components/ui/lazy-mount";
import { Badge } from "@/components/ui/badge";
import { StrategiesClient } from "@/components/strategies/strategies-client";
import { STRATEGY_COPY, withholdForFree, type PickerRow } from "@/components/strategies/strategy-copy";
import { getOpenOptionPositions, getOpenUnderlyingPositions } from "@/lib/queries/trades";
import { bundledIsinBySymbol, bundledSymbolByIsin } from "@/lib/import/isin-symbol";
import { getSpotMap } from "@/lib/queries/mtm";
import { getSettings } from "@/lib/queries/settings";
import { getEntitlement } from "@/lib/queries/license";
import { buildStrategies, contractMonthOf, type PositionedLeg } from "@/lib/analytics/strategies";
import { CATALOGUE, STRATEGY_IDS } from "@/lib/analytics/strategy-catalogue";
import { parseShelf } from "@/lib/domain/strategy-shelf";
import { sebiRealityLine } from "@/lib/domain/options-help";
import { SEBI_FNO_FACTS } from "@/lib/analytics/sebi-reality";
import { hasRecordedBasis } from "@/lib/analytics/data-quality";

/** The cash-equity segments a sell-only row can never be a short in (M-3). */
const DELIVERY_SEGMENTS = new Set(["eq_delivery", "eq_mtf", "eq_intraday"]);

/**
 * `/strategies` — the option structures the journal already holds (v4.3).
 *
 * FORCE-DYNAMIC because it reads the journal (AGENTS.md), and a cached open
 * position is a wrong structure on screen.
 *
 * NOT WRAPPED IN A WHOLE-PAGE GATE, deliberately (invariant 7). The user's own
 * legs, their four figures and the payoff curve are their record and stay free;
 * the Pro capability is the CATALOGUE — the named shape beyond the SIXTEEN this
 * screen has always named (`legacyFree`, not the eight of `DEFAULT_SHELF`;
 * owner ruling 2026-09-11), and the shelf and picker built on it.
 * `lib/license.ts` carries /strategies as `partial: true`, and
 * `tests/pro-gating.test.ts` holds both halves of that: this file must read
 * `getEntitlement`, and it must not carry a whole-page gate. (That guard reads
 * the RAW source, so the element's own name is deliberately not written here.)
 *
 * THE WITHHOLDING HAPPENS HERE, BEFORE THE PAYLOAD (app/live/page.tsx:21 is the
 * precedent). Handing the entitlement to the client as a prop would leave every
 * Pro name computed on the server and shipped inside the RSC payload, where a
 * locked chip on screen hides nothing at all. `withholdForFree` is pure and
 * `tests/strategies-page.test.ts` proves the absence on the SERIALISED result.
 *
 * THE PICKER'S 40 ROWS ARE SENT ONLY TO A PRO BUILD — and the honest statement
 * of what that buys is narrow. The rows are not a secret: every name is printed
 * on /help for anyone, and `strategy-copy.ts` value-imports the catalogue into
 * its client consumers, so all 40 rows sit in the client chunk of every build,
 * free included. What the free RSC payload withholds is the picker a shelf is
 * edited through and the MATCH (name and id) of the user's own structures —
 * which is exactly what the ruling asks for and no more.
 */
export const dynamic = "force-dynamic";

export default function StrategiesPage() {
  const pro = getEntitlement().pro;

  // The open/option/strike/CE-PE filter lives in SQL (getOpenOptionPositions):
  // the whole-book read mapped 25k rows to keep 673 on the 25k perf tier.
  const optionRows = getOpenOptionPositions();
  // H6 (fix wave 2H): every leg is filed under its OWN account; see the grouping below.
  const optionLegsByAccount = new Map<number, PositionedLeg[]>();
  const underlyingLegsByAccount = new Map<number, PositionedLeg[]>();
  const fileUnder = (byAccount: Map<number, PositionedLeg[]>, accountId: number, leg: PositionedLeg) => {
    const list = byAccount.get(accountId);
    if (list) list.push(leg);
    else byAccount.set(accountId, [leg]);
  };
  for (const t of optionRows) {
    const side: "long" | "short" = t.buyQty >= t.sellQty ? "long" : "short";
    const qty = Math.abs(t.buyQty - t.sellQty) || Math.max(t.buyQty, t.sellQty);
    fileUnder(optionLegsByAccount, t.accountId, {
      symbol: t.symbol,
      expiry: t.expiry,
      kind: t.optionType as "CE" | "PE",
      optionType: t.optionType as "CE" | "PE",
      strike: t.strike as number,
      side,
      qty,
      premium: side === "long" ? t.avgBuyPrice : t.avgSellPrice,
    });
  }

  // The underlying, read-only (research note Q4): without it there is no
  // covered call and no protective put. `premium` on a UL leg is its ENTRY
  // PRICE per unit — the field is named for the option case and carries the
  // same arithmetic (strategies.ts `payoffAt`).
  // R105 + P13: the leg wears the option side's ticker so it groups with them.
  // The STORED symbol, upper-cased as option symbols are, wins when an option
  // leg already wears it — a listing that names the ISIN under a newer ticker
  // (TATAMOTORS → TMPV) must not pull a holding off its own calls. The ISIN is
  // only the fallback, for a row stored under the company name.
  // N17 (fix wave 2R): that fallback names the option-side symbol that ADMITTED
  // the row — the one whose bundled ISIN the query matched — never the listing's
  // own ticker for the ISIN, which for TATAMOTORS is TMPV and split a
  // "Tata Motors Ltd" holding off its calls. Two option symbols with one ISIN:
  // the listing's ticker if it is one of them, else the first alphabetically.
  // L5 (fix wave 2G): the map is built PER ACCOUNT and a row reads its OWN
  // account's, so in All accounts (0 is a view, invariant 9) account B's ticker
  // for the same ISIN never takes account A's shares off A's calls.
  // H6 (fix wave 2H): and ONLY its own. G5b's in-scope fallback is gone: a row
  // its own account's option legs do not admit is no leg on 0, because no
  // single-account view holds it — the query admits a row only against option
  // legs in the SAME scope, so account FA alone (a holding, no option) shows no
  // card, and FA's shares covered account FB's naked call only on 0. This
  // lookup and the query's predicate admit the SAME rows in a single-account
  // view, in BOTH directions (I6, fix wave 2I): the symbol is case-folded on
  // both sides, and the ISIN is canonicalised on both — here by
  // `trim().toUpperCase()`, there by `upper(trim(trades.isin))` against the same
  // trimmed, upper-cased `bundledIsinBySymbol` candidates. So a single account
  // drops nothing, and a holding stored with a lower-case or padded ISIN is
  // found by its OWN account's read, not only on 0.
  const admittingOf = (symbols: Iterable<string>) => {
    const own = new Set([...symbols].map((s) => s.toUpperCase()));
    const byIsin = new Map<string, string>();
    for (const s of [...own].sort()) {
      const isin = bundledIsinBySymbol(s);
      if (isin && (!byIsin.has(isin) || bundledSymbolByIsin(isin) === s)) byIsin.set(isin, s);
    }
    return (upper: string, isin: string | null): string | null =>
      own.has(upper) ? upper : (isin && byIsin.get(isin.trim().toUpperCase())) || null;
  };
  const symbolsByAccount = new Map<number, string[]>();
  for (const r of optionRows) {
    const list = symbolsByAccount.get(r.accountId);
    if (list) list.push(r.symbol);
    else symbolsByAccount.set(r.accountId, [r.symbol]);
  }
  const admittedByAccount = new Map([...symbolsByAccount].map(([id, symbols]) => [id, admittingOf(symbols)] as const));

  // P5: a basis-unknown sale is never a leg. It NETS against the same
  // instrument's long in this scope, floored at zero — never a short the user
  // did not hold (invariant 6), never calls covered by shares already sold.
  // One instrument = symbol + type, and a future's own contract.
  // D3 (v4.3.0 fix wave 2, W2-FIXB): a DELIVERY-segment sell-only row reads the
  // SAME basis predicate Data Quality pairs by (`hasRecordedBasis`). Basis not
  // recorded (acquisition NULL — how v4.2.0 stored Angel One and Upstox sales —
  // or 'unknown', and no price) nets like P5's sale. A recorded basis (bonus,
  // ESOP, gift, a price) makes it a complete trade of shares acquired outside
  // the book: left out, never a short and never a reduction of a held lot. A
  // futures sell-only row is a genuine short and is read by its net side.
  // N16 (fix wave 2R): the key leads with the ACCOUNT. A sale only ever reduces
  // its own account's lots, each account floors at zero, and the All-accounts
  // view (0 is a view, invariant 9) is then the sum of those per-account nets —
  // never account B's sale taken out of account A's demat.
  const unknownSold = new Map<string, number>();
  const held: { accountId: number; key: string; leg: PositionedLeg }[] = [];
  for (const t of getOpenUnderlyingPositions()) {
    const symbol = admittedByAccount.get(t.accountId)?.(t.symbol.toUpperCase(), t.isin);
    if (!symbol) continue;
    const isFuture = t.instrumentType === "future";
    const key = `${t.accountId}|${symbol}|${t.instrumentType}|${isFuture ? (t.expiry ?? t.tradingsymbol.toUpperCase()) : ""}`;
    const deliverySale = DELIVERY_SEGMENTS.has(t.segment) && t.buyQty === 0 && t.sellQty > 0;
    if (deliverySale && hasRecordedBasis(t)) continue;
    if (deliverySale || (!isFuture && t.acquisition === "unknown")) {
      unknownSold.set(key, (unknownSold.get(key) ?? 0) + Math.max(0, t.sellQty - t.buyQty));
      continue;
    }
    const net = t.buyQty - t.sellQty;
    const side: "long" | "short" = net >= 0 ? "long" : "short";
    const qty = Math.abs(net) || Math.max(t.buyQty, t.sellQty);
    // P14: a future stored with no expiry is marked, never read as a cash
    // holding that outlives every option; its compact symbol may state a month.
    const undated = isFuture && !t.expiry;
    held.push({
      accountId: t.accountId,
      key,
      leg: {
        symbol,
        // R104: a future's own expiry; a cash holding never expires.
        expiry: isFuture ? t.expiry : null,
        ...(undated ? { expiryUnknown: true, contractMonth: contractMonthOf(t.tradingsymbol) ?? contractMonthOf(t.symbol) } : {}),
        kind: "UL" as const,
        // A UL leg has no strike. It is excluded from the strike ladder by
        // `computeStrategy`, so this is a placeholder and never a level.
        strike: 0,
        side,
        qty,
        premium: side === "long" ? t.avgBuyPrice : t.avgSellPrice,
      },
    });
  }
  const nettedLots = new Map<string, { accountId: number; lots: PositionedLeg[] }>();
  for (const { accountId, key, leg } of held) {
    if (leg.side === "long" && (unknownSold.get(key) ?? 0) > 0) {
      const netted = nettedLots.get(key);
      if (netted) netted.lots.push(leg);
      else nettedLots.set(key, { accountId, lots: [leg] });
    } else fileUnder(underlyingLegsByAccount, accountId, leg);
  }
  for (const [key, { accountId, lots }] of nettedLots) {
    const longQty = lots.reduce((s, l) => s + l.qty, 0);
    const remaining = Math.max(0, longQty - (unknownSold.get(key) ?? 0));
    // Priced from the long lots: their quantity-weighted entry price (a REAL
    // per-unit level, invariant 1), since the sale does not say which lot went.
    if (remaining > 0) {
      const entry = lots.reduce((s, l) => s + l.qty * l.premium, 0) / longQty;
      fileUnder(underlyingLegsByAccount, accountId, { ...lots[0], qty: remaining, premium: entry });
    }
  }

  // H6 (fix wave 2H, orchestrator decision): in All accounts each account's
  // cards are EXACTLY that account's single-account cards — N16's "per account,
  // then aggregate", applied to the grouping. `buildStrategies` groups by symbol
  // alone, so one call over every account's legs put account RB's RELIANCE call
  // and account RA's RELIANCE shares on one card, reading a bounded loss for a
  // call RB holds naked. It is called once per account and the cards are joined.
  // The join re-sorts with the engine's own order (nearest expiry, then symbol;
  // `buildStrategies` in lib/analytics/strategies.ts) — stable, so a single
  // account's order is unchanged and same-symbol cards follow account id.
  // The account id reaches no leg and no group field but the React KEY, and only
  // when two or more accounts contribute: two accounts' RELIANCE cards would
  // otherwise share one key, one chart slot and one React identity. A single
  // account keeps the engine's key. Legs are still built field by field.
  const accountIds = [...new Set([...optionLegsByAccount.keys(), ...underlyingLegsByAccount.keys()])].sort((a, b) => a - b);
  const keyedByAccount = accountIds.length > 1;
  const built = accountIds.flatMap((accountId) => {
    const optionLegs = optionLegsByAccount.get(accountId) ?? [];
    const underlyingLegs = underlyingLegsByAccount.get(accountId) ?? [];
    const own = buildStrategies([...optionLegs, ...underlyingLegs]);
    return keyedByAccount ? own.map((g) => ({ ...g, key: `${accountId}|${g.key}` })) : own;
  });
  built.sort((a, b) => (a.nearestExpiry ?? "").localeCompare(b.nearestExpiry ?? "") || a.symbol.localeCompare(b.symbol));
  const groups = withholdForFree(built, pro);

  // THE CHARTS ARE BUILT HERE, not inside the card, and stay MOUNTED ON
  // APPROACH. All 626 of them used to build their SVGs in one commit after
  // hydration, which was this page's entire cost (6026 → 1022 ms, v3.4.0;
  // `tests/render-windowing.test.ts` pins it to this file). 240 is
  // PayoffChart's own height, so nothing shifts when a chart arrives.
  const spotMap = getSpotMap();
  const charts: Record<string, React.ReactNode> = {};
  for (const g of groups) {
    charts[g.key] = (
      <LazyMount minHeight={240}>
        <PayoffChart data={g.payoff} breakevens={g.breakevens} spot={spotMap.get(g.symbol.toUpperCase()) ?? null} />
      </LazyMount>
    );
  }

  const shelf = parseShelf(getSettings()?.strategyShelfJson ?? null, STRATEGY_IDS);
  const picker: PickerRow[] | null = pro
    ? CATALOGUE.map((d) => ({ id: d.id, name: d.name, style: d.style, beginner: d.beginner }))
    : null;

  return (
    <>
      <PageHeader
        title={STRATEGY_COPY.title}
        description={STRATEGY_COPY.description}
        actions={
          <Badge variant="secondary">
            {groups.length} {groups.length === 1 ? "structure" : "structures"}
          </Badge>
        }
      />
      <div className="space-y-5 p-6">
        {/* The SEBI line, once, at the top — computed from SEBI_FNO_FACTS by
            B5's own function, so a revised study updates the sentence and
            cannot leave a stale literal behind. */}
        <p className="rounded-md border border-border bg-card-hover/30 p-3 text-[0.6875rem] leading-relaxed text-muted-foreground">
          {sebiRealityLine(SEBI_FNO_FACTS)}
        </p>

        <StrategiesClient groups={groups} charts={charts} shelf={shelf} picker={picker} pro={pro} />

        <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
          <span className="text-foreground">{STRATEGY_COPY.beforeCharges}</span> {STRATEGY_COPY.sttNote}
        </p>
      </div>
    </>
  );
}
