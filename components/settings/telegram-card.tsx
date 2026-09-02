"use client";

// Settings → Alerts: the Telegram EOD digest card (v3.6, owner decision #6).
//
// Opt-in flow, in order and enforced server-side at every step:
//   1. Consent dialog FIRST — every sentence from lib/domain/telegram-
//      disclosure.ts (the openalgo-dialog pattern: this file contributes
//      headings and buttons only). Accepting writes telegram_ack_version and
//      an audit entry via POST /api/telegram { action: "toggle" }.
//   2. Setup popup card — numbered BotFather steps, token paste, chat-id
//      auto-discovery, then Connect (which IS the test alert: nothing is
//      stored until "✅ Vyuha connected — test alert" actually arrives).
//   3. Enabled state — send time, last sent, test alert, disable, disconnect.
//
// fetch + router.refresh(), never server actions (AGENTS.md).

import * as React from "react";
import { useRouter } from "next/navigation";
import { Send, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";
import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";
import { telegramCardView } from "@/lib/telegram/card-state";

export interface TelegramCardProps {
  enabled: boolean;
  ackVersion: number | null;
  sendTime: string;
  lastSentDate: string | null;
  /** Token + chat id are on file (the token itself never reaches the client). */
  connected: boolean;
  chatId: string | null;
}

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; message?: string; chatId?: string }> {
  const res = await fetch("/api/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function TelegramCard(props: TelegramCardProps) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [token, setToken] = React.useState("");
  const [chatId, setChatId] = React.useState(props.chatId ?? "");
  const [sendTime, setSendTime] = React.useState(props.sendTime);

  // Section visibility is a pure state machine (lib/telegram/card-state.ts)
  // so the matrix — including "disconnect never needs a disclosure" — is
  // pinned by tests, not only by this JSX.
  const view = telegramCardView({ enabled: props.enabled, ackVersion: props.ackVersion, connected: props.connected });
  const ackStale = view.ackStale;

  async function run(body: Record<string, unknown>, after?: (r: { ok: boolean; message?: string; chatId?: string }) => void) {
    setPending(true);
    try {
      const r = await post(body);
      if (r.message) (r.ok ? toast.success : toast.error)(r.message);
      if (r.ok) router.refresh();
      after?.(r);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  /** ON never flips the switch directly — it opens the disclosure (the
   *  OpenAlgo rule: turning it back on shows the disclosure again regardless).
   *  OFF is immediate. */
  function toggle(next: boolean) {
    if (next) {
      setDialogOpen(true);
      return;
    }
    void run({ action: "toggle", enabled: false });
  }

  /** The only path to enabled=true — stamps the version that was read. */
  function accept() {
    void run({ action: "toggle", enabled: true, ackVersion: TELEGRAM_DISCLOSURE.version });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send className="size-4" /> Alerts — Telegram EOD digest
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3" data-testid="telegram-card">
        <div className="flex items-center justify-between rounded-md border border-border bg-card-hover/40 px-3 py-2">
          <div>
            <div className="text-sm font-medium">One end-of-day digest of your own numbers, via a bot you create</div>
            <div className="text-xs text-muted-foreground">
              Open positions, open risk, capital deployed, realised nets and plan facts — sent once per
              market day, at the first launch of the app after your chosen time. A day the app never
              runs after that time gets no digest.{" "}
              <span className="text-warning">The digest transits and is stored on Telegram&apos;s servers.</span>{" "}
              Turning it on opens the full disclosure first. Saved immediately, both ways.
            </div>
          </div>
          <Switch checked={props.enabled} onCheckedChange={(v) => toggle(Boolean(v))} data-testid="telegram-switch" />
        </div>

        {ackStale && (
          <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
            <p className="text-xs text-warning">
              The Telegram disclosure has changed since you accepted it — read it again to continue.
            </p>
            <div className="mt-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
                Read it again
              </Button>
            </div>
          </div>
        )}

        {view.showSetup && (
          <div className="space-y-3 rounded-md border border-border bg-card-hover/40 px-3 py-3" data-testid="telegram-setup">
            <div className="text-sm font-medium">Set up your bot (one time)</div>
            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
              <li>
                In Telegram, open <span className="select-all font-mono text-foreground">@BotFather</span> and send{" "}
                <span className="select-all font-mono text-foreground">/newbot</span>.
              </li>
              <li>Pick any name and username; BotFather replies with a token — paste it below.</li>
              <li>
                Open your new bot&apos;s chat and send it <span className="select-all font-mono text-foreground">/start</span>{" "}
                (that is what chat-id discovery reads).
              </li>
            </ol>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Bot token</Label>
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="123456789:AA…"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Chat id</Label>
                <div className="flex gap-2">
                  <Input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="Use Find, or paste" />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending || !token.trim()}
                    onClick={() =>
                      void run({ action: "discover-chat-id", token: token.trim() }, (r) => {
                        if (r.ok && r.chatId) {
                          setChatId(r.chatId);
                          toast.success(`Found chat id ${r.chatId}.`);
                        }
                      })
                    }
                  >
                    Find
                  </Button>
                </div>
              </div>
            </div>
            <Button
              type="button"
              disabled={pending || !token.trim() || !chatId.trim()}
              onClick={() => void run({ action: "save", token: token.trim(), chatId: chatId.trim() }, (r) => r.ok && setToken(""))}
            >
              {pending ? "Working…" : "Connect & send the test alert"}
            </Button>
            <p className="text-[0.6875rem] text-muted-foreground">
              Nothing is stored until “✅ Vyuha connected — test alert” actually arrives in your chat. The
              token is then encrypted at rest on this machine and never travels in a backup.
            </p>
          </div>
        )}

        {view.showStatus && (
          <div className="space-y-3 rounded-md border border-border bg-card-hover/40 px-3 py-3" data-testid="telegram-status">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Send time (IST, market days)</Label>
                <div className="flex gap-2">
                  <Input value={sendTime} onChange={(e) => setSendTime(e.target.value)} placeholder="15:35" className="w-24" />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending || sendTime === props.sendTime}
                    onClick={() => void run({ action: "send-time", sendTime: sendTime.trim() })}
                  >
                    Save
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Last sent</Label>
                <div className="text-sm">{props.lastSentDate ?? "never"}</div>
              </div>
              <div className="space-y-1.5">
                <Label>Chat</Label>
                <div className="font-mono text-sm">{props.chatId}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={() => void run({ action: "send-test" })}>
                Send test alert
              </Button>
              <Button type="button" variant="ghost" disabled={pending} onClick={() => void run({ action: "toggle", enabled: false })}>
                Disable
              </Button>
              <Button type="button" variant="ghost" disabled={pending} onClick={() => void run({ action: "disconnect" })}>
                Disconnect &amp; delete token
              </Button>
            </div>
            <p className="text-[0.6875rem] text-muted-foreground">
              If Telegram is unreachable at send time, the digest degrades to a note on the dashboard — a
              few quick retries, never into the night, never through a proxy.
            </p>
          </div>
        )}

        {/* Deleting a stored credential must NEVER require accepting a
            disclosure: whenever a token is on file and the status block above
            is not on screen (digest off, or the disclosure changed), the
            delete path still renders — and the server keeps `disconnect`
            outside the ack gate for the same reason. */}
        {view.showDisconnectStandalone && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card-hover/40 px-3 py-2"
            data-testid="telegram-disconnect-standalone"
          >
            <p className="text-xs text-muted-foreground">
              A bot token is still stored (encrypted) on this machine{props.chatId ? <> for chat <span className="font-mono">{props.chatId}</span></> : null}.
              Deleting it never requires reading a disclosure.
            </p>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => void run({ action: "disconnect" })}>
              Disconnect &amp; delete token
            </Button>
          </div>
        )}
      </CardContent>

      <TelegramDialog open={dialogOpen} onOpenChange={setDialogOpen} onAccept={accept} />
    </Card>
  );
}

/** The disclosure dialog — every sentence from TELEGRAM_DISCLOSURE; the
 *  openalgo-dialog shape. `onAccept` is the ONLY way out that means yes. */
function TelegramDialog({
  open,
  onOpenChange,
  onAccept,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccept: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="telegram-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-4 text-warning" />
            {TELEGRAM_DISCLOSURE.title}
          </DialogTitle>
          <DialogDescription>
            {TELEGRAM_DISCLOSURE.intro} Disclosure v{TELEGRAM_DISCLOSURE.version} — if it materially
            changes, Vyuha asks again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-xs">
          <section className="rounded-md border border-warning/40 bg-warning/5 p-3" data-testid="telegram-risks">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-warning">
              <TriangleAlert className="size-4 shrink-0" />
              What it costs you
            </h3>
            <ul className="mt-2 space-y-2.5">
              {TELEGRAM_DISCLOSURE.risks.map((risk) => (
                <li key={risk.title}>
                  <div className="font-medium text-warning">{risk.title}</div>
                  <p className="mt-0.5 text-muted-foreground">{risk.body}</p>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              What Vyuha will not do
            </h3>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {TELEGRAM_DISCLOSURE.refusals.map((line) => (
                <li key={line} className="flex gap-1.5">
                  <span aria-hidden>·</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </section>

          <p className="text-muted-foreground">
            Every digest ends with: <span className="text-foreground">“{TELEGRAM_DISCLOSURE.footer}”</span>
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button
            type="button"
            onClick={() => {
              onAccept();
              onOpenChange(false);
            }}
            data-testid="telegram-accept"
          >
            I understand — at my own risk, enable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
