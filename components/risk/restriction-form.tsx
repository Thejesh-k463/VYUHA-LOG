"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, AlertCircle } from "lucide-react";

const PLACEHOLDER = `One security per line:  SYMBOL, category, [stage/note]
RBLBANK, F&O ban, OI 96% of MWPL
IDEA, GSM, Stage 4
ZEEL, ASM, Stage II
GNFC, ban`;

export function RestrictionForm({ count }: { count: number }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState("NSE");
  const [pending, setPending] = useState<"" | "load" | "clear">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function post(payload: object, kind: "load" | "clear") {
    setPending(kind);
    setMsg(null);
    const res = await fetch("/api/restrictions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
    setPending("");
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    if (data.ok) {
      if (kind === "load") setText("");
      router.refresh();
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label className="text-xs">As of</Label>
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-8 w-36" />
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs">Source</Label>
          <Input value={source} onChange={(e) => setSource(e.target.value)} className="h-8 w-24" />
        </div>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={PLACEHOLDER}
        className="w-full rounded-md border border-border bg-input p-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p className="text-[10px] text-muted-foreground">
        Category accepts: ban / F&amp;O / MWPL, ASM, GSM, circuit / band. Loading replaces the current list. Held positions
        are matched automatically. The daily lists are published on NSE/BSE.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={pending !== "" || !text.trim()} onClick={() => post({ action: "load", text, asOfDate: asOf, source }, "load")}>
          {pending === "load" ? "Loading…" : "Load list"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending !== "" || count === 0}
          onClick={() => post({ action: "clear" }, "clear")}
        >
          {pending === "clear" ? "Clearing…" : `Clear${count ? ` (${count})` : ""}`}
        </Button>
        {msg && (
          <span className={`flex items-center gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
            {msg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
