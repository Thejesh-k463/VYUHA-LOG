"use client";

// P2.1 — "Connect broker" card: save Kite Connect credentials locally, then
// pull today's executions through the normal preview → commit pipeline.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface ConnStatus {
  broker: string;
  apiKeyMasked: string;
  lastPullAt: string | null;
}

interface PullResult {
  added?: number;
  skipped?: number;
  total?: number;
  rows?: number;
}

export function BrokerConnect() {
  const router = useRouter();
  const [conn, setConn] = useState<ConnStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/import/broker");
      const data = await res.json();
      if (data.ok) setConn(data.connections.find((c: ConnStatus) => c.broker === "zerodha") ?? null);
    } catch {
      /* stays disconnected */
    }
  }

  useEffect(() => {
    // .then keeps every setState async (react-compiler set-state-in-effect rule)
    let alive = true;
    fetch("/api/import/broker")
      .then((r) => r.json())
      .then((d) => {
        if (alive && d.ok) setConn(d.connections.find((c: ConnStatus) => c.broker === "zerodha") ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function post(bodyObj: Record<string, unknown>, busyKey: string) {
    setBusy(busyKey);
    setMsg(null);
    try {
      const res = await fetch("/api/import/broker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj),
      });
      const data = await res.json();
      return { res, data };
    } catch (e) {
      return { res: null, data: { ok: false, message: (e as Error).message } };
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    const { data } = await post({ action: "save", broker: "zerodha", apiKey, accessToken }, "save");
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    if (data.ok) {
      setApiKey("");
      setAccessToken("");
      await refresh();
    }
  }

  async function pull(mode: "preview" | "commit") {
    const { data } = await post({ action: "pull", broker: "zerodha", mode }, mode);
    if (!data.ok) {
      setMsg({ ok: false, text: data.message ?? "Pull failed" });
      return;
    }
    if (mode === "commit") {
      const r: PullResult = data.result ?? {};
      setMsg({ ok: true, text: `Committed — ${r.added ?? 0} added, ${r.skipped ?? 0} duplicates skipped.` });
      await refresh();
      router.refresh();
    } else {
      const rows = data.preview?.trades?.length ?? data.preview?.rows ?? 0;
      const warn = (data.warnings ?? []).join(" ");
      setMsg({ ok: true, text: `Preview: ${rows} normalized trade${rows === 1 ? "" : "s"} from today's executions. ${warn}`.trim() });
    }
  }

  async function disconnect() {
    const { data } = await post({ action: "disconnect", broker: "zerodha" }, "disconnect");
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    setConn(null);
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Connect broker (API) — Zerodha Kite</CardTitle>
        {conn && <Badge variant="secondary">key {conn.apiKeyMasked}</Badge>}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Pulls <span className="font-medium">today&apos;s executions</span> from Kite Connect through the normal
          classify → charges → dedup pipeline (re-pulls are idempotent). Needs a Kite Connect app (api key) and the
          day&apos;s access token — tokens expire every trading day. Credentials are stored in your local database
          in plain text; this journal is single-user and offline.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>API key</Label>
            <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={conn ? conn.apiKeyMasked : "kitexxxxxxxx"} />
          </div>
          <div className="space-y-1">
            <Label>Access token (today&apos;s)</Label>
            <Input value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="paste after login" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} disabled={busy != null || !apiKey || !accessToken}>
            {busy === "save" ? "Saving…" : conn ? "Update connection" : "Save connection"}
          </Button>
          <Button variant="outline" onClick={() => pull("preview")} disabled={busy != null || !conn}>
            {busy === "preview" ? "Pulling…" : "Preview pull"}
          </Button>
          <Button variant="outline" onClick={() => pull("commit")} disabled={busy != null || !conn}>
            {busy === "commit" ? "Committing…" : "Pull & commit"}
          </Button>
          {conn && (
            <Button variant="ghost" onClick={disconnect} disabled={busy != null}>
              Disconnect
            </Button>
          )}
          {conn?.lastPullAt && (
            <span className="text-[11px] text-muted-foreground">last pull {conn.lastPullAt.slice(0, 16).replace("T", " ")}</span>
          )}
        </div>
        {msg && <p className={`text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>{msg.text}</p>}
      </CardContent>
    </Card>
  );
}
