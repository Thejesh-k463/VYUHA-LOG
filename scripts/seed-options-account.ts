/**
 * Seed the owner's OPTIONS STRATEGY trade log into a VYUHA database as its own account.
 *
 *   VYUHA_DB_PATH=<db> npx tsx scripts/seed-options-account.ts --json <options-log.json> \
 *       [--account "OPTIONS STRATEGY"] [--broker dhan] [--capital 100000] [--select] [--dry]
 *
 * Every trade goes through `commitManualTrade` — the same writer the manual Add-trade form
 * uses — so charges come from `charge_config` (invariant 3), money crosses the paise boundary
 * once (invariant 1), and the (account, broker, dedupHash) index makes a re-run a no-op.
 *
 * P&L rule: the sheet's "Net P&L" column is the strategy's booked result (it is GROSS — the
 * sheet carries no charges). For TARGET-2 rows it books +75% while the exit column shows the
 * +100% T2 price, so the exit column overstates the book by ~₹15.3K. The booked result wins:
 * avgSellPrice = entry × (1 + PnL%), a blended average exit, and VYUHA recomputes gross from
 * qty × price (never trusts a stated P&L).
 */
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

// `server-only` is a Next bundler marker, not an installed package here; vitest aliases it
// to tests/stubs/server-only.ts and this script does the same for tsx's CJS loader.
{
  const stub = path.resolve(__dirname, "..", "tests", "stubs", "server-only.ts");
  const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
  const orig = M._resolveFilename;
  M._resolveFilename = function (req: string, ...rest: unknown[]) {
    return req === "server-only" ? stub : orig.call(this, req, ...rest);
  };
}

type Row = {
  n: number; date: string; symbol: string; direction: string; tier: string; spot: number; zone: string;
  contract: string; strike: number; lot: number; entry: number; high: number; low: number; t1: number;
  t2: number; sl: number; exit: number; status: string; pnlPct: number; pnl: number; doi: number; vol: number;
};

const arg = (name: string, dflt: string | null = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dhanName(contract: string): { tradingsymbol: string; optionType: "CE" | "PE"; symbol: string } {
  // "BAJAJ-AUTO 2026-09-29 11500 PE" → "OPT BAJAJ-AUTO 29 Sep 2026 11500 PE" (classify.ts parses from the END)
  const m = /^(.+)\s+(\d{4})-(\d{2})-(\d{2})\s+(\d+(?:\.\d+)?)\s+(CE|PE)$/.exec(contract.trim());
  if (!m) throw new Error(`cannot parse contract "${contract}"`);
  const [, sym, y, mo, d, strike, ot] = m;
  return {
    symbol: sym.toUpperCase(),
    tradingsymbol: `OPT ${sym.toUpperCase()} ${d} ${MONTHS[Number(mo) - 1]} ${y} ${strike} ${ot}`,
    optionType: ot as "CE" | "PE",
  };
}

async function main() {
  if (!process.env.VYUHA_DB_PATH) throw new Error("set VYUHA_DB_PATH explicitly — this script never guesses a journal");
  const jsonPath = arg("json");
  if (!jsonPath) throw new Error("--json <options-log.json> is required");
  const accountName = arg("account", "OPTIONS STRATEGY")!;
  const broker = arg("broker", "dhan")!;
  const capital = Number(arg("capital", "100000"));
  // --lots N: size every trade at N lots instead of the log's one lot (a what-if book for a larger
  // capital base; the log itself is one lot per trade). Per-unit prices and dates are untouched.
  const lots = Number(arg("lots", "1"));
  if (!Number.isInteger(lots) || lots < 1) throw new Error("--lots must be a positive integer");
  const dry = flag("dry");

  const rows: Row[] = JSON.parse(fs.readFileSync(path.resolve(jsonPath), "utf8"));

  const { db, sqlite, schema } = await import("../lib/db/index");
  const { eq } = await import("drizzle-orm");
  const { commitManualTrade } = await import("../lib/import/commit");
  const { BROKERS } = await import("../lib/domain/constants");
  if (!(BROKERS as readonly string[]).includes(broker)) throw new Error(`unknown broker "${broker}"`);

  // --migrate: bring the file up to this checkout's schema first (the journal wrote 0071 after
  // v4.2.0 shipped; commitManualTrade reads settings columns that migration adds).
  if (flag("migrate") && !dry) {
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    migrate(db, { migrationsFolder: path.resolve(__dirname, "..", "drizzle") });
  }
  const applied = sqlite.prepare("select count(*) as n from __drizzle_migrations").get() as { n: number };
  console.log(`db ${process.env.VYUHA_DB_PATH} · migrations applied ${applied.n} · ${rows.length} rows · broker ${broker} · dry=${dry}`);

  // Account: find by name (UNIQUE) or create. Capital is set ONLY on create — a re-run never
  // silently rewrites a denominator the owner may have edited since.
  let account = db.select().from(schema.accounts).where(eq(schema.accounts.name, accountName)).get();
  if (!account) {
    if (dry) {
      console.log(`[dry] would create account "${accountName}" broker=${broker} activeCapital=${capital} equityCapital=0`);
    } else {
      account = db
        .insert(schema.accounts)
        .values({ name: accountName, broker, equityCapital: 0, activeCapital: capital, isDefault: false, archived: false })
        .returning()
        .get();
      console.log(`created account #${account!.id} "${accountName}"`);
    }
  } else {
    console.log(`account #${account.id} "${accountName}" exists (activeCapital ${account.activeCapital})`);
  }

  let inserted = 0, duplicates = 0, gross = 0, net = 0, charges = 0, sheet = 0;
  const details: string[] = [];
  const run = () => {
    for (const r of rows) {
      const { tradingsymbol, optionType } = dhanName(r.contract);
      const qty = r.lot * lots;
      const avgBuyPrice = r.entry;
      // The exit column is the real exit price wherever it reproduces the booked P&L (the
      // booked figure is PnL% rounded to 4 dp, so allow ₹3 + 0.5%). Where it does not — the
      // TARGET-2 rows, booked at +75% against a +100% exit column — use the blended average
      // exit that reproduces the booked result (see header).
      const exitDelta = Math.abs((r.exit - r.entry) * r.lot - r.pnl); // the log's P&L is per ONE lot
      const avgSellPrice = exitDelta <= 3 + Math.abs(r.pnl) * 0.005 ? r.exit : r.entry * (1 + r.pnlPct);
      const buyValue = Math.round(qty * avgBuyPrice * 100) / 100;
      const sellValue = Math.round(qty * avgSellPrice * 100) / 100;
      const grossPnl = Math.round((sellValue - buyValue) * 100) / 100;
      sheet += r.pnl;
      const status = r.status.replace(/\s*[\u{1F300}-\u{1FAFF}✅❌☀-➿]\s*$/u, "").trim();
      const notes = [
        `Options strategy log #${r.n} · ${r.tier}`,
        `Spot ${r.spot} · S/R zone ${r.zone} · Day H/L ${r.high}/${r.low}`,
        `T1 ${r.t1} · T2 ${r.t2} · SL ${r.sl} · Exit: ${status} (${(r.pnlPct * 100).toFixed(2)}%)`,
        `ΔOI ${(r.doi * 100).toFixed(2)}% (unwind) · Volume ${r.vol}`,
      ].join("\n");
      const t = {
        broker: broker as never,
        tradingsymbol,
        isin: null,
        buyQty: qty,
        avgBuyPrice,
        buyValue,
        sellQty: qty,
        avgSellPrice,
        sellValue,
        closingPrice: null,
        grossPnl,
        unrealisedPnl: 0,
        buyDate: r.date,
        sellDate: r.date,
        productHint: null,
        exchangeHint: "NSE" as never,
        sourceFile: "manual",
      };
      if (dry) {
        details.push(`#${r.n} ${tradingsymbol} ${optionType} qty ${qty} buy ${avgBuyPrice} sell ${avgSellPrice.toFixed(4)} gross ${grossPnl} (sheet ${r.pnl})`);
        gross += grossPnl;
        continue;
      }
      const res = commitManualTrade(
        t,
        {
          forcedSegment: "stock_option",
          forcedExchange: "NSE",
          setupTag: r.direction,
          notes,
          slPlanned: r.sl,
          targetPlanned: r.t1,
          daysHeld: 0,
          lotSize: r.lot,
        },
        account!.id,
      );
      if (res.duplicate) { duplicates++; continue; }
      inserted++;
      const row = db.select().from(schema.trades).where(eq(schema.trades.id, res.id!)).get()!;
      gross += row.grossPnl; net += row.netPnl; charges += row.chargesTotal;
      details.push(`#${r.n} ${row.symbol} ${row.optionType} ${row.expiry} ${row.strike} qty ${row.buyQty} gross ${row.grossPnl} charges ${row.chargesTotal} net ${row.netPnl} R ${row.rMultiple}`);
    }
  };
  if (dry) run(); else db.transaction(() => run());

  if (flag("select") && !dry && account) {
    db.update(schema.settings).set({ selectedAccountId: account.id }).run();
    console.log(`settings.selectedAccountId → ${account.id}`);
  }
  for (const d of details) console.log("  " + d);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  console.log(`inserted ${inserted} · duplicates ${duplicates} · sheet P&L ${r2(sheet)} · gross ${r2(gross)} · charges ${r2(charges)} · net ${r2(net)}`);
  sqlite.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
