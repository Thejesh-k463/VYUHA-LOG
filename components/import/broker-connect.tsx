"use client";

// "Connect broker" card: save API credentials locally, then pull through the
// normal preview → commit pipeline.
//
// Two brokers, for two different reasons. Zerodha's Kite gives today's
// executions with fill times. Dhan's API gives something no Dhan FILE can:
// `productType: "MTF"`. A Dhan P&L export has no product column at all, and in
// a transaction report MTF is indistinguishable from delivery — identical STT,
// identical stamp duty, and financing interest booked to the ledger rather than
// the contract note. The API is the only place margin funding is stated.

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

type BrokerId = "zerodha" | "dhan" | "angelone";

const BROKERS: Record<BrokerId, {
  label: string;
  tab: string;
  keyLabel: string;
  keyPlaceholder: string;
  /** True when the broker uses the classic key + daily-token pair. Angel One
   *  does not — its session is minted at pull time from the TOTP secret. */
  needsToken: boolean;
  blurb: React.ReactNode;
}> = {
  zerodha: {
    label: "Zerodha Kite",
    tab: "Zerodha (Kite Connect)",
    keyLabel: "API key",
    keyPlaceholder: "kitexxxxxxxx",
    needsToken: true,
    blurb: (
      <>
        Pulls <span className="font-medium">today&apos;s executions</span> from Kite Connect, with fill times, through
        the normal classify → charges → dedup pipeline (re-pulls are idempotent). Needs a Kite Connect app and the
        day&apos;s access token — tokens expire every trading day.
      </>
    ),
  },
  dhan: {
    label: "Dhan",
    tab: "Dhan (DhanHQ v2)",
    keyLabel: "Client ID",
    keyPlaceholder: "1000000009",
    needsToken: true,
    blurb: (
      <>
        Pulls <span className="font-medium">today&apos;s positions</span>, and is the only Dhan source that states{" "}
        <b>MTF</b>. No Dhan file can: a P&amp;L export has no product column, and in a transaction report an MTF
        position carries exactly the same STT and stamp duty as delivery while the financing interest sits in the
        ledger. Get the token from web.dhan.co → DhanHQ Trading APIs; it lasts 24 hours by default.
      </>
    ),
  },
  angelone: {
    label: "Angel One",
    tab: "Angel One (SmartAPI)",
    keyLabel: "API key",
    keyPlaceholder: "SmartAPI app key",
    needsToken: false,
    blurb: (
      <>
        Pulls <span className="font-medium">today&apos;s fills</span> from the SmartAPI trade book — and unlike the
        other two, <b>nothing expires on you</b>: the login runs unattended from your TOTP <i>secret</i> (the base32
        string behind the enrollment QR, not the 6-digit code). All four credentials are stored encrypted on this
        machine and never leave it except to Angel One itself. Free — SmartAPI has no subscription. Register the app at
        smartapi.angelone.in.
      </>
    ),
  },
};

export function BrokerConnect() {
  const router = useRouter();
  const [broker, setBroker] = useState<BrokerId>("zerodha");
  const [conns, setConns] = useState<ConnStatus[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [accessToken, setAccessToken] = useState("");
  // Angel One's extras — client code, PIN and the TOTP SECRET.
  const [clientCode, setClientCode] = useState("");
  const [pin, setPin] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const spec = BROKERS[broker];
  const conn = conns.find((c) => c.broker === broker) ?? null;

  async function refresh() {
    try {
      const res = await fetch("/api/import/broker");
      const data = await res.json();
      if (data.ok) setConns(data.connections ?? []);
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
        if (alive && d.ok) setConns(d.connections ?? []);
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
    const { data } = await post(
      { action: "save", broker, apiKey, accessToken, ...(broker === "angelone" ? { clientCode, pin, totpSecret } : {}) },
      "save",
    );
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    if (data.ok) {
      setApiKey("");
      setAccessToken("");
      setClientCode("");
      setPin("");
      setTotpSecret("");
      await refresh();
    }
  }

  async function pull(mode: "preview" | "commit") {
    const { data } = await post({ action: "pull", broker, mode }, mode);
    if (!data.ok) {
      setMsg({ ok: false, text: data.message ?? "Pull failed" });
      return;
    }
    if (mode === "commit") {
      const r: PullResult = data.result ?? {};
      const warn = (data.warnings ?? []).join(" ");
      setMsg({ ok: true, text: `Committed — ${r.added ?? 0} added, ${r.skipped ?? 0} duplicates skipped. ${warn}`.trim() });
      await refresh();
      router.refresh();
    } else {
      const rows = data.preview?.rows?.length ?? data.preview?.summary?.total ?? 0;
      const warn = (data.warnings ?? []).join(" ");
      setMsg({ ok: true, text: `Preview: ${rows} normalized trade${rows === 1 ? "" : "s"}. ${warn}`.trim() });
    }
  }

  async function disconnect() {
    const { data } = await post({ action: "disconnect", broker }, "disconnect");
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    await refresh();
  }

  function switchBroker(b: BrokerId) {
    setBroker(b);
    setApiKey("");
    setAccessToken("");
    setClientCode("");
    setPin("");
    setTotpSecret("");
    setMsg(null);
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Connect broker (API) — Zerodha, Dhan &amp; Angel One</CardTitle>
        {conn && <Badge variant="secondary">key {conn.apiKeyMasked}</Badge>}
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Say plainly that this list is two brokers, not all of them. The
            panel used to sit under a bare "Connect broker (API)" heading, which
            read as though the other six were missing rather than simply not
            offering a trade-history API Vyuha has integrated. */}
        <p className="rounded-md border border-border bg-card-hover/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="text-foreground">Zerodha</span>, <span className="text-foreground">Dhan</span> and{" "}
          <span className="text-foreground">Angel One</span> are wired for live API pulls.{" "}
          <span className="text-foreground">Every other broker imports by file</span> — drop a CSV or XLSX above; if
          Vyuha does not recognise the layout it will ask you to match the columns once, then remember it.
        </p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(BROKERS) as BrokerId[]).map((b) => {
            const connected = conns.some((c) => c.broker === b);
            return (
              <button
                key={b}
                type="button"
                onClick={() => switchBroker(b)}
                className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                  broker === b
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {BROKERS[b].tab}
                {connected && <span className="ml-1.5 opacity-70">· connected</span>}
              </button>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground">
          {spec.blurb} Credentials are encrypted at rest with a key bound to this machine (v2.99.80) — the database
          file alone carries nothing usable — and they are sent nowhere except the broker itself.
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>{spec.keyLabel}</Label>
            <Input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={conn ? conn.apiKeyMasked : spec.keyPlaceholder}
            />
          </div>
          {spec.needsToken && (
            <div className="space-y-1">
              <Label>Access token (today&apos;s)</Label>
              <Input value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="paste after login" />
            </div>
          )}
          {broker === "angelone" && (
            <>
              <div className="space-y-1">
                <Label>Client code</Label>
                <Input value={clientCode} onChange={(e) => setClientCode(e.target.value)} placeholder="A123456" autoComplete="off" />
              </div>
              <div className="space-y-1">
                <Label>Login PIN</Label>
                <Input type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="the app PIN, not the password" autoComplete="off" />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>TOTP secret</Label>
                <Input
                  type="password"
                  value={totpSecret}
                  onChange={(e) => setTotpSecret(e.target.value)}
                  placeholder="the base32 SECRET from 2FA enrollment — not the 6-digit code"
                  autoComplete="off"
                />
              </div>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={save}
            disabled={
              busy != null || !apiKey ||
              (spec.needsToken ? !accessToken : !clientCode || !pin || !totpSecret)
            }
          >
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
            <span className="text-[0.6875rem] text-muted-foreground">last pull {conn.lastPullAt.slice(0, 16).replace("T", " ")}</span>
          )}
        </div>

        {msg && <p className={`text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>{msg.text}</p>}
      </CardContent>
    </Card>
  );
}
