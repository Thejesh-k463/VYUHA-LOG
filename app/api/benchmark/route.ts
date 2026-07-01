import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { benchmarkPrices } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { parseBenchmarkCsv } from "@/lib/analytics/benchmark";
import { DEFAULT_BENCHMARK } from "@/lib/queries/benchmark";

export const runtime = "nodejs";

function revalidate() {
  revalidatePath("/reports/performance");
}

function symbolOf(body: Record<string, unknown>): string {
  const s = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  return s || DEFAULT_BENCHMARK;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }
  const symbol = symbolOf(body);

  if (body.action === "clear") {
    db.delete(benchmarkPrices).where(eq(benchmarkPrices.symbol, symbol)).run();
    revalidate();
    return NextResponse.json({ ok: true, message: `Cleared ${symbol} series.` });
  }

  if (body.action === "load") {
    const rows = parseBenchmarkCsv(typeof body.text === "string" ? body.text : "");
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, message: "No valid rows. Use: DATE, CLOSE (one per line)." }, { status: 400 });
    }
    db.transaction((tx) => {
      for (const r of rows) {
        tx.insert(benchmarkPrices)
          .values({ symbol, date: r.date, close: r.close })
          .onConflictDoUpdate({ target: [benchmarkPrices.symbol, benchmarkPrices.date], set: { close: r.close } })
          .run();
      }
    });
    revalidate();
    return NextResponse.json({ ok: true, message: `Loaded ${rows.length} ${symbol} close${rows.length === 1 ? "" : "s"}.` });
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
