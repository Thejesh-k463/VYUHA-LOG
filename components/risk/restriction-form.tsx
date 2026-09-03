"use client";

import { todayIstIso } from "@/lib/domain/trading-day";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { FileUp } from "lucide-react";

const PLACEHOLDER = `One security per line:  SYMBOL, category, [stage/note]
RBLBANK, F&O ban, OI 96% of MWPL
IDEA, GSM, Stage 4
ZEEL, ASM, Stage II
GNFC, ban`;

export function RestrictionForm({ count }: { count: number }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [asOf, setAsOf] = useState(todayIstIso());
  const [source, setSource] = useState("NSE");
  const [pending, setPending] = useState<"" | "load" | "clear" | "file">("");

  async function post(payload: object, kind: "load" | "clear" | "file") {
    setPending(kind);
    const res = await fetch("/api/restrictions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
    setPending("");
    if (data.ok) toast.success(data.message ?? "");
    else toast.error(data.message ?? "");
    if (data.ok) {
      if (kind === "load") setText("");
      router.refresh();
    }
  }

  // Reference-data upload pattern (instrument-manager precedent): the browser
  // reads the file, the route gets JSON — fileName included, because for
  // REG_IND the DATE lives in the name.
  async function onFile(file: File) {
    const content = await file.text();
    await post({ action: "file", text: content, fileName: file.name, asOfDate: asOf }, "file");
  }

  return (
    <div className="space-y-3">
      {/* ── Official NSE files — the automated path ─────────────────────── */}
      <div className="rounded-md border border-border bg-card-hover/30 p-3">
        <p className="text-xs font-medium">Upload the official NSE files</p>
        <ul className="mt-1.5 list-decimal space-y-1 pl-4 text-[0.6875rem] leading-relaxed text-muted-foreground">
          <li>
            <span className="font-mono text-foreground/90">fo_secban.csv</span> — the F&amp;O ban list.
            nseindia.com → <i>All Reports → Derivatives</i> → &ldquo;F&amp;O Security in ban period&rdquo;
            (direct: nsearchives.nseindia.com/content/fo/fo_secban.csv). Updated each evening for the next trade date.
          </li>
          <li>
            <span className="font-mono text-foreground/90">REG_INDDDMMYY.csv</span> — the Surveillance
            Indicator file: ASM (long &amp; short term), GSM and ESM stages for every listed scrip, in one file.
            nseindia.com → <i>All Reports</i> → &ldquo;Surveillance Indicator&rdquo;. Keep the original filename — the date is read from it.
          </li>
        </ul>
        <label
          className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-card-hover"
          title="Upload fo_secban.csv or REG_INDDDMMYY.csv — the category comes from the file type"
        >
          <FileUp className="size-3.5" />
          {pending === "file" ? "Reading…" : "Upload NSE file"}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            disabled={pending !== ""}
            data-testid="surveillance-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = "";
            }}
          />
        </label>
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          An upload replaces only the categories that file covers — the ban file touches F&amp;O-ban rows, the
          surveillance file touches ASM/GSM/ESM rows — so the two coexist. BSE publishes no machine-readable
          list; paste BSE rows below.
        </p>
      </div>

      {/* ── Paste — the manual path (replaces the WHOLE list) ────────────── */}
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
      <Textarea
        mono
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={PLACEHOLDER}
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
      </div>
    </div>
  );
}
