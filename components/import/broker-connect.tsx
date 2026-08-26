"use client";

// "Connect broker" card: save API credentials locally, then pull through the
// normal preview → commit pipeline.
//
// Three direct brokers, for three different reasons. Zerodha's Kite gives
// today's executions with fill times. Dhan's API gives something no Dhan FILE
// can: `productType: "MTF"`. A Dhan P&L export has no product column at all,
// and in a transaction report MTF is indistinguishable from delivery —
// identical STT, identical stamp duty, and financing interest booked to the
// ledger rather than the contract note. The API is the only place margin
// funding is stated. Angel One's SmartAPI logs in unattended from a TOTP secret.
//
// A FOURTH tab, OpenAlgo, appears ONLY when the server says the disclosure gate
// is open (`GET /api/import/broker` → `openalgo.available`). Until then nothing
// about it is rendered — no greyed tab, no teaser — because it asks the user to
// run a second program and hand IT their broker credentials, and that offer is
// not made until they have read the disclosure in Settings → Integrations.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { OPENALGO_DEFAULT_HOST, isLocalOpenAlgoHost } from "@/lib/domain/openalgo-disclosure";
import { isOpenAlgoConnectionId, openAlgoBrokerOptions, openAlgoUnderlyingOf } from "@/lib/import/api/openalgo";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TriangleAlert } from "lucide-react";

interface ConnStatus {
  broker: string;
  apiKeyMasked: string;
  lastPullAt: string | null;
  /** OpenAlgo only — saved config echoed back so the form shows what is
   *  actually connected instead of defaults (host/broker are not secrets). */
  openalgoHost?: string | null;
  openalgoUnderlyingBroker?: string | null;
}

/** One suspected duplicate from the server's cross-source check (409 body). */
interface CollisionLite {
  symbol: string;
  kind: string;
  detail: string;
  incoming: { buyQty: number; sellQty: number; buyValue: number; sellValue: number };
  existing: { id: number; buyQty: number; sellQty: number; sourceFile: string | null };
}

interface PullResult {
  added?: number;
  skipped?: number;
  total?: number;
  rows?: number;
}

type BrokerId = "zerodha" | "dhan" | "angelone" | "openalgo";

/** OpenAlgo's supported list, straight from the adapter — never re-typed here. */
const OPENALGO_OPTIONS = openAlgoBrokerOptions();

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
  openalgo: {
    label: "OpenAlgo",
    tab: "OpenAlgo (self-hosted)",
    keyLabel: "OpenAlgo API key",
    keyPlaceholder: "from OpenAlgo → API Key",
    needsToken: false,
    blurb: (
      <>
        Pulls <span className="font-medium">today&apos;s executions</span> from an OpenAlgo instance you run
        yourself — the same-day path for Groww, Upstox, Paytm Money and Kotak, which have none of their own.{" "}
        <b>Your broker credentials go into OpenAlgo, not Vyuha</b>, and charges are computed here rather than
        stated by the API. The full disclosure is in Settings → Integrations.
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
  // OpenAlgo's extras — the host it runs on and WHICH broker sits behind it
  // (that id selects the charge profile, so it is asked, never guessed).
  const [host, setHost] = useState(OPENALGO_DEFAULT_HOST);
  const [underlyingBroker, setUnderlyingBroker] = useState("");
  // The gate, as the SERVER sees it. Nothing about OpenAlgo renders until this
  // is true; it is re-read after every request so a gate closed mid-session
  // takes the tab away rather than leaving a button that 403s.
  const [openalgoAvailable, setOpenalgoAvailable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** A 409'd commit awaiting the user's decision in the collision dialog. */
  const [collisionPrompt, setCollisionPrompt] = useState<{
    brokerId: string;
    collisions: CollisionLite[];
  } | null>(null);

  // Derived, not synced: if the gate closes while the OpenAlgo tab is selected,
  // fall back to Zerodha at render time. (AGENTS.md — never reset state in an
  // effect keyed on other state.)
  const active: BrokerId = broker === "openalgo" && !openalgoAvailable ? "zerodha" : broker;
  const spec = BROKERS[active];
  const conn = conns.find((c) => c.broker === active) ?? null;
  /** Every saved OpenAlgo instance (`openalgo:<broker>` rows) — a user with
   *  accounts at several brokers runs one instance per broker, each on its own
   *  port, and each pulls independently. */
  const openAlgoConns = conns.filter((c) => isOpenAlgoConnectionId(c.broker));
  const visibleBrokers = (Object.keys(BROKERS) as BrokerId[]).filter(
    (b) => b !== "openalgo" || openalgoAvailable,
  );
  const hostIsRemote = host.trim() !== "" && !isLocalOpenAlgoHost(host);
  const underlyingNote = OPENALGO_OPTIONS.find((o) => o.broker === underlyingBroker)?.note;

  /** Prefill the OpenAlgo form fields from the SAVED connection — but never
   *  over something the user has already typed. Without this, a reloaded page
   *  showed the default host over a saved one, and an innocent "Update
   *  connection" would have silently repointed the pull at a different
   *  OpenAlgo instance (found live 2026-08-26, two instances on one machine). */
  function adoptSavedOpenAlgo(connections: ConnStatus[]) {
    // Only with exactly ONE instance is "the saved config" unambiguous — with
    // several, the instance list below shows each one's host and broker.
    const list = connections.filter((c) => isOpenAlgoConnectionId(c.broker));
    if (list.length !== 1) return;
    const oa = list[0]!;
    if (oa.openalgoHost) {
      setHost((prev) => (prev === OPENALGO_DEFAULT_HOST || !prev.trim() ? oa.openalgoHost! : prev));
    }
    if (oa.openalgoUnderlyingBroker) {
      setUnderlyingBroker((prev) => (prev === "" ? oa.openalgoUnderlyingBroker! : prev));
    }
  }

  async function refresh() {
    try {
      const res = await fetch("/api/import/broker");
      const data = await res.json();
      if (data.ok) {
        setConns(data.connections ?? []);
        setOpenalgoAvailable(Boolean(data.openalgo?.available));
        adoptSavedOpenAlgo(data.connections ?? []);
      }
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
        if (!alive || !d.ok) return;
        setConns(d.connections ?? []);
        setOpenalgoAvailable(Boolean(d.openalgo?.available));
        adoptSavedOpenAlgo(d.connections ?? []);
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
      // A gate refusal can arrive without a parseable body; keep the status
      // rather than falling into the catch and losing it.
      const data = await res
        .json()
        .catch(() => ({ ok: false, message: `Request failed (HTTP ${res.status}).` }));
      return { res, data };
    } catch (e) {
      return { res: null, data: { ok: false, message: (e as Error).message } };
    } finally {
      setBusy(null);
    }
  }

  /**
   * Show what the server said and, on a 403, re-read availability: that status
   * means the OpenAlgo gate closed since this page loaded (switched off in
   * Settings, or the disclosure was bumped), so the tab should go away rather
   * than stay as a button that keeps failing.
   */
  async function fail(res: Response | null, data: { message?: string }, fallback: string) {
    setMsg({ ok: false, text: data.message ?? fallback });
    if (res?.status === 403) await refresh();
  }

  async function save() {
    const { res, data } = await post(
      {
        action: "save",
        broker: active,
        apiKey,
        accessToken,
        ...(active === "angelone" ? { clientCode, pin, totpSecret } : {}),
        ...(active === "openalgo" ? { host, underlyingBroker } : {}),
      },
      "save",
    );
    if (!data.ok) {
      await fail(res, data, "Could not save the connection.");
      return;
    }
    setMsg({ ok: true, text: data.message ?? "" });
    setApiKey("");
    setAccessToken("");
    setClientCode("");
    setPin("");
    setTotpSecret("");
    // host and underlyingBroker are not secrets and are tedious to retype, so
    // they survive a save — only the credentials are cleared.
    await refresh();
  }

  async function pull(mode: "preview" | "commit", brokerId: string = active, force = false) {
    // A 409 from the server means the pull collides with trades already in the
    // journal (same trades from another source, hashes a paisa apart). Nothing
    // was committed; the collision dialog shows the details, and only its
    // "Commit anyway" re-posts with force:true — an explicit human decision,
    // never a default.
    const { res, data } = await post({ action: "pull", broker: brokerId, mode, ...(force ? { force: true } : {}) }, mode);
    if (!data.ok) {
      if (res?.status === 409 && data.needsForce) {
        setCollisionPrompt({ brokerId, collisions: (data.collisions ?? []) as CollisionLite[] });
        setMsg(null);
        return;
      }
      await fail(res, data, "Pull failed");
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

  async function disconnect(brokerId: string = active) {
    const { res, data } = await post({ action: "disconnect", broker: brokerId }, "disconnect");
    if (!data.ok) await fail(res, data, "Could not disconnect.");
    else setMsg({ ok: true, text: data.message ?? "" });
    await refresh();
  }

  function switchBroker(b: BrokerId) {
    setBroker(b);
    setApiKey("");
    setAccessToken("");
    setClientCode("");
    setPin("");
    setTotpSecret("");
    setHost(OPENALGO_DEFAULT_HOST);
    setUnderlyingBroker("");
    setMsg(null);
    setCollisionPrompt(null);
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>
          Connect broker (API) — Zerodha, Dhan &amp; Angel One
          {openalgoAvailable && <> + OpenAlgo</>}
        </CardTitle>
        {conn && <Badge variant="secondary">key {conn.apiKeyMasked}</Badge>}
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Say plainly which brokers this list covers, not all of them. The
            panel used to sit under a bare "Connect broker (API)" heading, which
            read as though the rest were missing rather than simply not
            offering a trade-history API Vyuha has integrated. The sentence
            changes when the OpenAlgo tab is visible: leaving "every other
            broker imports by file" beside a live Groww/Upstox/Paytm/Kotak pull
            would make the copy false. */}
        <p className="rounded-md border border-border bg-card-hover/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="text-foreground">Zerodha</span>, <span className="text-foreground">Dhan</span> and{" "}
          <span className="text-foreground">Angel One</span> are wired for live API pulls
          {openalgoAvailable ? (
            <>
              {" "}
              directly, and <span className="text-foreground">Groww, Upstox, Paytm Money and Kotak</span> through
              your own OpenAlgo instance.{" "}
              <span className="text-foreground">Everything else imports by file</span>
            </>
          ) : (
            <>
              . <span className="text-foreground">Every other broker imports by file</span>
            </>
          )}{" "}
          — drop a CSV or XLSX above; if Vyuha does not recognise the layout it will ask you to match the columns
          once, then remember it.
        </p>
        <div className="flex flex-wrap gap-2">
          {visibleBrokers.map((b) => {
            const connected = b === "openalgo" ? openAlgoConns.length > 0 : conns.some((c) => c.broker === b);
            return (
              <button
                key={b}
                type="button"
                onClick={() => switchBroker(b)}
                className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                  active === b
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
          file alone carries nothing usable — and they are sent nowhere except{" "}
          {active === "openalgo" ? "your own OpenAlgo instance" : "the broker itself"}.
        </p>

        {active === "openalgo" && openAlgoConns.length > 0 && (
          <div className="space-y-2">
            {/* One row per instance: a user with several broker accounts runs
                one OpenAlgo per broker, each on its own port, each pulling on
                its own. The row IS the display of what is saved — host and
                broker included — so a stale form can never misrepresent it. */}
            {openAlgoConns.map((c) => {
              const underlying = c.openalgoUnderlyingBroker ?? openAlgoUnderlyingOf(c.broker) ?? "?";
              const label = OPENALGO_OPTIONS.find((o) => o.broker === underlying)?.label ?? underlying;
              return (
                <div key={c.broker} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2">
                  <div className="text-xs">
                    <span className="font-medium">{label}</span>
                    <span className="text-muted-foreground"> — {c.openalgoHost ?? "host unknown"} · key {c.apiKeyMasked}</span>
                    {c.lastPullAt && (
                      <span className="text-muted-foreground"> · last pull {c.lastPullAt.slice(0, 16).replace("T", " ")}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => pull("preview", c.broker)} disabled={busy != null}>
                      {busy === "preview" ? "Pulling…" : "Preview pull"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => pull("commit", c.broker)} disabled={busy != null}>
                      {busy === "commit" ? "Committing…" : "Pull & commit"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => disconnect(c.broker)} disabled={busy != null}>
                      Disconnect
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

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
          {active === "openalgo" && (
            <>
              <div className="space-y-1">
                <Label>OpenAlgo host</Label>
                <Input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder={OPENALGO_DEFAULT_HOST}
                  autoComplete="off"
                  spellCheck={false}
                />
                {/* Said BEFORE the save, not after: the default address is this
                    computer, and the moment it is not, the trade data leaves. */}
                {hostIsRemote && (
                  <p className="text-[0.6875rem] text-warning" data-testid="openalgo-remote-host">
                    That is not this computer — your trade data will travel to that machine on every pull.
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Broker behind OpenAlgo</Label>
                <Select value={underlyingBroker} onChange={(e) => setUnderlyingBroker(e.target.value)}>
                  <option value="">Which broker is it connected to?</option>
                  {OPENALGO_OPTIONS.map((o) => (
                    <option key={o.broker} value={o.broker}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                {underlyingNote && <p className="text-[0.6875rem] text-muted-foreground">{underlyingNote}</p>}
              </div>
            </>
          )}
          {active === "angelone" && (
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
              (active === "openalgo"
                ? !host.trim() || !underlyingBroker
                : spec.needsToken
                  ? !accessToken
                  : !clientCode || !pin || !totpSecret)
            }
          >
            {busy === "save"
              ? "Saving…"
              : active === "openalgo"
                ? openAlgoConns.some((c) => (c.openalgoUnderlyingBroker ?? openAlgoUnderlyingOf(c.broker)) === underlyingBroker)
                  ? "Update instance"
                  : "Add instance"
                : conn
                  ? "Update connection"
                  : "Save connection"}
          </Button>
          {active !== "openalgo" && (
            <>
              <Button variant="outline" onClick={() => pull("preview")} disabled={busy != null || !conn}>
                {busy === "preview" ? "Pulling…" : "Preview pull"}
              </Button>
              <Button variant="outline" onClick={() => pull("commit")} disabled={busy != null || !conn}>
                {busy === "commit" ? "Committing…" : "Pull & commit"}
              </Button>
              {conn && (
                <Button variant="ghost" onClick={() => disconnect()} disabled={busy != null}>
                  Disconnect
                </Button>
              )}
              {conn?.lastPullAt && (
                <span className="text-[0.6875rem] text-muted-foreground">last pull {conn.lastPullAt.slice(0, 16).replace("T", " ")}</span>
              )}
            </>
          )}
        </div>

        {msg && <p className={`text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>{msg.text}</p>}

        {/* Blocked-commit dialog: the server refused (409) because these rows
            look like trades already in the journal from another source. The
            details are laid out per trade so the decision is informed, and
            committing anyway is a button press INSIDE this dialog only. */}
        <Dialog
          open={collisionPrompt != null}
          onOpenChange={(open) => {
            if (!open) {
              setCollisionPrompt(null);
              setMsg({ ok: true, text: "Commit cancelled — nothing was committed." });
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <TriangleAlert className="size-4 text-warning" />
                These trades may already be in your journal
              </DialogTitle>
              <DialogDescription>
                Nothing has been committed. Different sources state the same trade slightly differently — a
                position aggregate and a fill-by-fill pull can differ by a paisa — so the exact duplicate check
                cannot vouch for these {collisionPrompt?.collisions.length === 1 ? "this row" : "rows"}.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              {(collisionPrompt?.collisions ?? []).map((c, i) => (
                <div key={i} className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{c.symbol}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {c.kind === "same-quantity" ? "same quantity" : c.kind === "same-value" ? "same value" : "partial overlap"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{c.detail}</p>
                  <p className="mt-1 font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
                    incoming {c.incoming.buyQty || c.incoming.sellQty} qty · already recorded{" "}
                    {c.existing.buyQty || c.existing.sellQty} qty
                    {c.existing.sourceFile ? ` from ${c.existing.sourceFile}` : ""}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              If this pull is the <b>same trades from another source</b>, cancel — the journal already has them.
              Commit anyway only if you are sure these are <b>different trades</b> (nothing is ever merged
              automatically).
            </p>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  setCollisionPrompt(null);
                  setMsg({ ok: true, text: "Commit cancelled — nothing was committed." });
                }}
              >
                Cancel — keep the journal as it is
              </Button>
              <Button
                variant="destructive"
                disabled={busy != null}
                onClick={() => {
                  const target = collisionPrompt?.brokerId;
                  setCollisionPrompt(null);
                  if (target) void pull("commit", target, true);
                }}
              >
                Commit anyway
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
