"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { Textarea } from "@/components/ui/textarea";

function placeholderFor(symbol: string): string {
  return `One close per line:  DATE, CLOSE
30-Jun-2026, 24,000.50
01-Jul-2026, 24,120.75
(NSE "${symbol === "INDIAVIX" ? "India VIX" : "NIFTY 50"}" historical CSV pastes directly)`;
}

export function BenchmarkPanel({
  symbol,
  meta,
  purpose = "Alpha/beta regress daily portfolio returns against this index.",
}: {
  symbol: string;
  meta: { count: number; first: string | null; last: string | null };
  purpose?: string;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<"" | "load" | "clear">("");
  async function post(payload: object, kind: "load" | "clear") {
    setPending(kind);
    const res = await fetch("/api/benchmark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, ...payload }),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
    setPending("");
    if (data.ok) toast.success(data.message ?? "Done.");
    else toast.error(data.message ?? "Request failed");
    if (data.ok) {
      if (kind === "load") setText("");
      router.refresh();
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {meta.count > 0
          ? `${meta.count} ${symbol} closes loaded (${meta.first} → ${meta.last}). ${purpose}`
          : `Paste the ${symbol} daily closes. ${purpose} Offline — no feed required.`}
      </p>
      <Textarea mono value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={placeholderFor(symbol)} />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" disabled={pending !== "" || !text.trim()} onClick={() => post({ action: "load", text }, "load")}>
          {pending === "load" ? "Loading…" : "Load closes"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending !== "" || meta.count === 0}
          onClick={() => { if (confirm(`Clear the ${symbol} series?`)) post({ action: "clear" }, "clear"); }}
        >
          {pending === "clear" ? "Clearing…" : `Clear${meta.count ? ` (${meta.count})` : ""}`}
        </Button>
      </div>
    </div>
  );
}
