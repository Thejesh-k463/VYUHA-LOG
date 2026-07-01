"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, CheckCircle2, AlertCircle } from "lucide-react";

interface Result {
  ok: boolean;
  message: string;
  format: string;
  date: string | null;
  parsed: number;
  equityHeld: number;
  priced: number;
  derivativesSkipped: number;
  unmatched: string[];
}

export function BhavcopyMtm() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [res, setRes] = useState<Result | null>(null);

  async function run() {
    setPending(true);
    setRes(null);
    const r = await fetch("/api/mtm/bhavcopy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = (await r.json().catch(() => ({ ok: false, message: "Request failed" }))) as Result;
    setPending(false);
    setRes(data);
    if (data.ok) router.refresh();
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload className="size-3.5" /> Choose bhavcopy CSV
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setText(await f.text());
            e.target.value = "";
          }}
        />
        <span className="text-[10px] text-muted-foreground">or paste below — NSE/BSE EOD bhavcopy</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={"SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,...\nRELIANCE,EQ,2900,2950,2890,2940.5,..."}
        className="w-full rounded-md border border-border bg-input p-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={pending || !text.trim()} onClick={run}>
          {pending ? "Marking…" : "Auto-MTM open positions"}
        </Button>
        {res && (
          <span className={`flex items-center gap-1.5 text-xs ${res.ok ? "text-profit" : "text-loss"}`}>
            {res.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
            {res.message}
          </span>
        )}
      </div>
      {res?.ok && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <Badge variant="secondary">{res.format}</Badge>
          {res.date ? <Badge variant="secondary">as of {res.date}</Badge> : null}
          <Badge variant="secondary">{res.parsed} prices in file</Badge>
          <Badge variant="profit">{res.priced} priced</Badge>
          {res.derivativesSkipped ? <Badge variant="warning">{res.derivativesSkipped} derivatives skipped</Badge> : null}
          {res.unmatched.length > 0 ? (
            <span className="text-muted-foreground">unmatched: {res.unmatched.slice(0, 6).join(", ")}{res.unmatched.length > 6 ? "…" : ""}</span>
          ) : null}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground">
        Marks open <strong>equity</strong> positions to the bhavcopy close in one step (offline — the file you downloaded
        from NSE/BSE). Option/future positions are skipped (their mark is a premium). Then refresh Portfolio Risk.
      </p>
    </div>
  );
}
