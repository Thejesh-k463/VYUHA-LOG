import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { brokerConnections, settings } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { kiteImportSource, toParsedFile as kiteToParsedFile } from "@/lib/import/api/kite";
import { dhanImportSource, toParsedFile as dhanToParsedFile } from "@/lib/import/api/dhan";
import { angelOneLogin, fetchAngelTradeBook, normalizeAngelTrades, toParsedFile as angelToParsedFile } from "@/lib/import/api/angelone";
import { toParsedFile as upstoxToParsedFile, normalizeUpstoxTrades, fetchUpstoxTrades } from "@/lib/import/api/upstox";
import {
  assertOpenAlgoBroker,
  fetchOpenAlgoTradebook,
  isOpenAlgoConnectionId,
  normalizeHost,
  normalizeOpenAlgoTrades,
  openAlgoConnectionId,
  toParsedFile as openAlgoToParsedFile,
} from "@/lib/import/api/openalgo";
import { openAlgoGate } from "@/lib/domain/openalgo-disclosure";
import type { Broker } from "@/lib/domain/constants";
import { looksLikeTotpSecret } from "@/lib/totp";
import { previewParsedFile, commitParsedFile } from "@/lib/import/commit";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { encryptSecret, readSecret, sweepPlaintextSecrets } from "@/lib/vault";

export const runtime = "nodejs";

// Broker-API auto-import. Supports Zerodha (Kite Connect) and Dhan (DhanHQ v2).
// The pull reuses the exact file-import pipeline: normalize → preview/commit.
//
// Dhan matters for one specific reason: its API is the ONLY Dhan source that
// states MTF. Every Dhan file is silent about margin funding — a P&L export has
// no product column, and in a transaction report MTF is indistinguishable from
// delivery because the two carry identical STT and stamp duty while financing
// interest lives in the ledger. `productType: "MTF"` ends that guessing.

/** Brokers with a working API pull, and what each needs.
 *  `needsToken` brokers use the two classic columns; `extraFields` land as one
 *  vault-encrypted JSON blob in auth_json. */
const API_BROKERS: Record<string, { label: string; keyLabel: string; note: string; needsToken: boolean; extraFields?: readonly string[] }> = {
  zerodha: {
    label: "Zerodha (Kite Connect)",
    keyLabel: "API key",
    note: "Kite access tokens expire daily — re-paste after each login.",
    needsToken: true,
  },
  dhan: {
    label: "Dhan (DhanHQ v2)",
    keyLabel: "Client ID",
    note: "Dhan access tokens are issued from web.dhan.co → DhanHQ Trading APIs and are valid for 24 hours by default.",
    needsToken: true,
  },
  angelone: {
    label: "Angel One (SmartAPI)",
    keyLabel: "API key",
    note: "Login is unattended: the TOTP secret mints the day's code at pull time, so nothing expires on you.",
    needsToken: false,
    extraFields: ["clientCode", "pin", "totpSecret"],
  },
  upstox: {
    label: "Upstox (Analytics token)",
    keyLabel: "Analytics token",
    note: "The Analytics token lasts a year and is read-only by design. Upstox answers only from the IPv4 address registered under Apps → Static IPs.",
    needsToken: false,
  },
  openalgo: {
    label: "OpenAlgo (self-hosted)",
    keyLabel: "OpenAlgo API key",
    note: "Your OpenAlgo instance must be running on the configured host at the moment you pull — there is no queue and no retry.",
    needsToken: false,
    extraFields: ["host", "underlyingBroker"],
  },
};

const mask = (s: string) => (s.length <= 4 ? "••••" : `${s.slice(0, 4)}…${"•".repeat(4)}`);

/** One OpenAlgo instance fronts ONE broker, and a user can run several — so
 *  each is its own connection row, `openalgo:<underlying>` (see the adapter).
 *  Every openalgo:* id shares the single "openalgo" spec. */
const specOf = (broker: string) => API_BROKERS[isOpenAlgoConnectionId(broker) ? "openalgo" : broker];

/**
 * The SERVER's copy of the OpenAlgo gate (lib/domain/openalgo-disclosure.ts).
 *
 * The Import UI hides the tab when this is closed; that is a courtesy. This is
 * the thing that actually refuses — hiding a button must never be the only
 * thing standing between an unread disclosure and a stored credential or a
 * live pull. The rule itself is never re-implemented here: both halves
 * (switch on AND acceptance current) live in the pure function.
 */
function currentOpenAlgoGate() {
  const row = db
    .select({ enabled: settings.openalgoEnabled, ackVersion: settings.openalgoAckVersion })
    .from(settings)
    .limit(1)
    .get();
  return openAlgoGate({ enabled: row?.enabled ?? false, ackVersion: row?.ackVersion ?? null });
}

export async function GET() {
  sweepPlaintextSecrets(); // upgrade any pre-vault plaintext rows (v2.99.80)
  const selected=getSelectedAccountId(); const accountId=selected||1;
  let rows = db.select().from(brokerConnections).where(eq(brokerConnections.accountId,accountId)).all();
  // Legacy single-instance id: a row saved as bare "openalgo" is renamed to
  // `openalgo:<underlying>` on read (same GET-time-migration pattern as the
  // plaintext sweep above), so multiple instances can coexist from here on.
  for (const r of rows) {
    if (r.broker !== "openalgo") continue;
    const auth = readSecret(r.authJson);
    if (!auth.ok || !auth.value) continue;
    try {
      const a = JSON.parse(auth.value) as { underlyingBroker?: string };
      if (a.underlyingBroker) {
        db.update(brokerConnections)
          .set({ broker: openAlgoConnectionId(a.underlyingBroker as Broker) })
          .where(and(eq(brokerConnections.accountId, accountId), eq(brokerConnections.broker, "openalgo")))
          .run();
        rows = db.select().from(brokerConnections).where(eq(brokerConnections.accountId, accountId)).all();
      }
    } catch {
      /* unreadable blob — leave the legacy row as it is */
    }
    break;
  }
  const gate = currentOpenAlgoGate();
  return NextResponse.json({
    // CONTRACT: the Import UI reads `openalgo.available` to decide whether to
    // render the OpenAlgo tab at all, and shows `openalgo.reason` when it is
    // false. Shape is fixed — `reason` is present only when closed.
    openalgo: gate.allowed ? { available: true } : { available: false, reason: gate.reason },
    ok: true,
    connections: rows.map((r) => {
      // Decrypt only to mask — the plaintext never leaves this handler. An
      // unreadable secret masks as bullets rather than leaking ciphertext.
      const key = readSecret(r.apiKey);
      const out: Record<string, unknown> = {
        broker: r.broker,
        apiKeyMasked: key.ok && key.value ? mask(key.value) : "••••",
        lastPullAt: r.lastPullAt,
        updatedAt: r.updatedAt,
      };
      // OpenAlgo's host and underlying broker are CONFIG, not credentials —
      // they ride encrypted in auth_json but the UI must show them back, or a
      // reloaded page renders the default host over a saved one and an
      // innocent "Update connection" silently repoints the pull at a
      // different OpenAlgo instance (found live, 2026-08-26).
      if (isOpenAlgoConnectionId(r.broker)) {
        const auth = readSecret(r.authJson);
        if (auth.ok && auth.value) {
          try {
            const a = JSON.parse(auth.value) as { host?: string; underlyingBroker?: string };
            out.openalgoHost = a.host ?? null;
            out.openalgoUnderlyingBroker = a.underlyingBroker ?? null;
          } catch {
            /* unreadable blob — the UI keeps its defaults */
          }
        }
      }
      return out;
    }),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }
  const selected=getSelectedAccountId(); const accountId=selected||1;

  if (body.action === "save") {
    let broker = String(body.broker ?? "");
    const apiKey = String(body.apiKey ?? "").trim();
    const accessToken = String(body.accessToken ?? "").trim();
    const spec = specOf(broker);
    if (!spec) {
      return NextResponse.json(
        { ok: false, message: `Unsupported broker. Available: ${Object.values(API_BROKERS).map((b) => b.label).join(", ")}.` },
        { status: 400 },
      );
    }
    // The gate goes FIRST, before any field is even looked at: a refusal must
    // not depend on the shape of the body, and nothing may be stored on the
    // way to discovering the disclosure was never accepted.
    if (isOpenAlgoConnectionId(broker)) {
      const gate = currentOpenAlgoGate();
      if (!gate.allowed) return NextResponse.json({ ok: false, message: gate.reason }, { status: 403 });
    }

    if (!apiKey || (spec.needsToken && !accessToken)) {
      return NextResponse.json({ ok: false, message: `${spec.keyLabel}${spec.needsToken ? " and access token are" : " is"} required.` }, { status: 400 });
    }

    // Broker-specific extras, one encrypted blob in auth_json.
    let authPlain: string | null = null;
    if (isOpenAlgoConnectionId(broker)) {
      // OpenAlgo's extras: WHERE the instance is, and WHICH broker sits behind
      // it. The broker is load-bearing — it selects the charge profile — so it
      // is stored, never guessed from the payload at pull time.
      const host = String(body.host ?? "").trim();
      const underlyingBroker = String(body.underlyingBroker ?? "").trim();
      if (!host || !underlyingBroker) {
        return NextResponse.json(
          { ok: false, message: "The OpenAlgo host and the broker your instance is connected to are both required." },
          { status: 400 },
        );
      }
      // Both are validated AT SAVE, with the adapter's own message. A typo in
      // either would otherwise surface as a failed pull tomorrow, by which
      // point the user has no idea which field was wrong.
      let normalizedHost: string;
      try {
        assertOpenAlgoBroker(underlyingBroker as Broker);
        normalizedHost = normalizeHost(host);
      } catch (e) {
        return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 400 });
      }
      authPlain = JSON.stringify({ host: normalizedHost, underlyingBroker });
      // The stored identity is the instance's underlying broker, so several
      // instances (one per broker) coexist as separate rows; saving the same
      // underlying again UPDATES that instance via the (account, broker) upsert.
      broker = openAlgoConnectionId(underlyingBroker as Broker);
    } else if (spec.extraFields) {
      // Angel One's extras: client code + PIN + TOTP SECRET.
      const clientCode = String(body.clientCode ?? "").trim();
      const pin = String(body.pin ?? "").trim();
      const totpSecret = String(body.totpSecret ?? "").trim();
      if (!clientCode || !pin || !totpSecret) {
        return NextResponse.json({ ok: false, message: "Client code, PIN and TOTP secret are all required." }, { status: 400 });
      }
      // Catch the classic paste error AT SAVE, with a message — not at
      // tomorrow's pull as a cryptic broker rejection.
      if (!looksLikeTotpSecret(totpSecret)) {
        return NextResponse.json(
          { ok: false, message: "That does not look like a TOTP secret. Paste the base32 SECRET shown at SmartAPI 2FA enrollment (behind the QR code) — not the 6-digit code it generates." },
          { status: 400 },
        );
      }
      authPlain = JSON.stringify({ clientCode, pin, totpSecret });
    }

    // Encrypted at rest (v2.99.80). A broken vault REFUSES the save rather
    // than quietly storing a live credential in plaintext.
    let encKey: string, encToken: string, encAuth: string | null;
    try {
      encKey = encryptSecret(apiKey);
      encToken = encryptSecret(accessToken || "");
      encAuth = authPlain ? encryptSecret(authPlain) : null;
    } catch (e) {
      return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "The secrets vault is unavailable." }, { status: 500 });
    }
    db.insert(brokerConnections)
      .values({ accountId, broker, apiKey: encKey, accessToken: encToken, authJson: encAuth })
      .onConflictDoUpdate({
        target: [brokerConnections.accountId, brokerConnections.broker],
        set: { apiKey: encKey, accessToken: encToken, authJson: encAuth, updatedAt: new Date().toISOString() },
      })
      .run();
    recordAudit({
      entity: "settings",
      action: "update",
      summary: `Broker connection saved: ${broker} (key ${mask(apiKey)})`,
      before: null,
      after: { broker, apiKey: mask(apiKey) }, // never audit the token
    });
    return NextResponse.json({ ok: true, message: `Connection saved. ${spec.note}` });
  }

  if (body.action === "disconnect") {
    const broker = String(body.broker ?? "");
    db.delete(brokerConnections).where(and(eq(brokerConnections.accountId,accountId),eq(brokerConnections.broker, broker))).run();
    recordAudit({ entity: "settings", action: "delete", summary: `Broker connection removed: ${broker}`, before: { broker }, after: null });
    return NextResponse.json({ ok: true, message: "Disconnected." });
  }

  if (body.action === "pull") {
    const broker = String(body.broker ?? "zerodha");
    const mode = body.mode === "commit" ? "commit" : "preview";

    // Same gate, same position: before the connection is even looked up. A
    // credential saved while the gate was open must not keep pulling after the
    // user turns the integration off or the disclosure changes under them.
    if (isOpenAlgoConnectionId(broker)) {
      const gate = currentOpenAlgoGate();
      if (!gate.allowed) return NextResponse.json({ ok: false, message: gate.reason }, { status: 403 });
    }

    const conn = db.select().from(brokerConnections).where(and(eq(brokerConnections.accountId,accountId),eq(brokerConnections.broker, broker))).all()[0];
    if (!conn) {
      return NextResponse.json(
        {
          ok: false,
          message:
            isOpenAlgoConnectionId(broker)
              ? "No saved OpenAlgo connection — save the API key, host and broker first."
              : "No saved connection — save the API key + access token first.",
        },
        { status: 400 },
      );
    }

    // Decrypted only here, at the moment of use. Pre-vault plaintext rows
    // still read (the sweep upgrades them); an unreadable vault asks for the
    // credential again instead of failing cryptically inside the fetch.
    const keyRead = readSecret(conn.apiKey);
    const tokenRead = readSecret(conn.accessToken);
    // A `needsToken: false` broker (Angel One, OpenAlgo) stores an ENCRYPTED
    // EMPTY STRING in access_token, and that value does not read back:
    // AES-GCM over "" is zero bytes, so the envelope is `venc:1:<iv>::<tag>`
    // and parseVaultString rejects an empty ciphertext segment — correctly, it
    // cannot tell that shape from a truncated row. Requiring it to be readable
    // therefore refused every such pull with "the stored secret is malformed",
    // which is a lie: there is no token, and none is needed. So the token is
    // only load-bearing for the brokers whose spec says it is.
    const needsToken = specOf(broker)?.needsToken ?? true;
    if (!keyRead.ok || (needsToken && !tokenRead.ok)) {
      const reason = !keyRead.ok ? (keyRead as { reason: string }).reason : (tokenRead as { reason: string }).reason;
      const keyLabel = specOf(broker)?.keyLabel ?? "API key";
      return NextResponse.json(
        { ok: false, message: `The saved credentials cannot be read: ${reason}. Re-enter the ${keyLabel} and access token.` },
        { status: 400 },
      );
    }
    /** "" for the token-less brokers, which never read it. */
    const accessTokenPlain = tokenRead.ok ? tokenRead.value : "";

    let parsed;
    /** Which broker sat behind the OpenAlgo instance — names the commit file. */
    let openAlgoBroker: Broker | null = null;
    try {
      if (isOpenAlgoConnectionId(broker)) {
        // host + underlyingBroker live in auth_json as one encrypted blob.
        const authRead = readSecret(conn.authJson);
        if (!authRead.ok || !authRead.value) {
          return NextResponse.json(
            { ok: false, message: "The saved OpenAlgo settings cannot be read — re-enter the API key, host and broker." },
            { status: 400 },
          );
        }
        const auth = JSON.parse(authRead.value) as { host: string; underlyingBroker: Broker };
        openAlgoBroker = auth.underlyingBroker;
        const creds = { apiKey: keyRead.value, host: auth.host, broker: openAlgoBroker };
        const today = new Date().toISOString().slice(0, 10);
        // normalize is called DIRECTLY rather than through fetchTrades: the
        // `repaired` / `refused` counts are what become the user-facing
        // warnings, and fetchTrades returns only the trades. The quantity
        // repair is the whole reason those warnings exist — see the adapter
        // header — so it must not be dropped on the way to the screen.
        const result = normalizeOpenAlgoTrades(await fetchOpenAlgoTradebook(creds), openAlgoBroker, today);
        parsed = openAlgoToParsedFile(openAlgoBroker, result);
      } else if (broker === "angelone") {
        // The extras live in auth_json as one encrypted JSON blob.
        const authRead = readSecret(conn.authJson);
        if (!authRead.ok || !authRead.value) {
          return NextResponse.json(
            { ok: false, message: "The saved Angel One credentials cannot be read — re-enter the API key, client code, PIN and TOTP secret." },
            { status: 400 },
          );
        }
        const auth = JSON.parse(authRead.value) as { clientCode: string; pin: string; totpSecret: string };
        const creds = { apiKey: keyRead.value, clientCode: auth.clientCode, pin: auth.pin, totpSecret: auth.totpSecret };
        const { jwtToken } = await angelOneLogin(creds);
        const today = new Date().toISOString().slice(0, 10);
        const { trades, refused } = normalizeAngelTrades(await fetchAngelTradeBook(creds, jwtToken), today);
        parsed = angelToParsedFile(trades, refused);
      } else if (broker === "dhan") {
        // apiKey holds the Dhan CLIENT ID; the column is named for Kite, which
        // came first. Renaming it would need a migration for no behavioural gain.
        const source = dhanImportSource({ clientId: keyRead.value, accessToken: accessTokenPlain });
        parsed = dhanToParsedFile(await source.fetchTrades({}));
      } else if (broker === "upstox") {
        // apiKey holds the year-long read-only Analytics token. normalize is
        // called directly so the unparseable-symbol notes reach the screen.
        const today = new Date().toISOString().slice(0, 10);
        parsed = upstoxToParsedFile(normalizeUpstoxTrades(await fetchUpstoxTrades({ accessToken: keyRead.value }), today));
      } else {
        const source = kiteImportSource({ apiKey: keyRead.value, accessToken: accessTokenPlain });
        parsed = kiteToParsedFile(await source.fetchTrades({}));
      }
    } catch (e) {
      return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 502 });
    }

    const today = new Date().toISOString().slice(0, 10);
    // "kite" is kept for Zerodha so source_file naming stays continuous with
    // every existing import; Angel One used to fall into the kite name too,
    // which mislabelled its commits — it now files under its own name.
    const fileName =
      isOpenAlgoConnectionId(broker) && openAlgoBroker
        ? `openalgo-${openAlgoBroker}-${today}`
        : `${broker === "zerodha" ? "kite" : broker}-api-${today}`;

    // The classify → charges pipeline THROWS rather than invent a rate (e.g. a
    // corrupted symbol classifying into a segment/exchange pair no charge
    // profile can exist for). That refusal is correct — but it must reach the
    // user as a message naming the problem, not as a bare HTTP 500.
    try {
      // Preview runs in BOTH modes: it carries the cross-source collision
      // report (rows that would slip past the exact-hash dedup — e.g. the same
      // trades pulled once natively and once through OpenAlgo, a paisa apart)
      // and the same-day cross-broker note. A RISKY collision blocks a commit
      // until the user explicitly confirms — a silent double-count is exactly
      // the wrong default for a journal.
      const pre = previewParsedFile(parsed, null, undefined, fileName);
      const warnings = [...parsed.warnings];
      if (pre.crossSource?.message) warnings.push(pre.crossSource.message);
      if (pre.crossBroker) warnings.push(pre.crossBroker);

      if (mode === "commit") {
        // Every row already in the journal → committing would add nothing.
        // Said in a dialog, not a green one-liner: a user who just pulled the
        // same day through a second path (native vs OpenAlgo) deserves to see
        // plainly that the journal is unchanged — and no empty import batch
        // is created for a no-op. (Found live 2026-08-28: the native Upstox
        // pull exact-deduped 5/5 against the OpenAlgo rows, silently.)
        if (pre.summary.total > 0 && pre.summary.newCount === 0 && body.force !== true) {
          return NextResponse.json(
            {
              ok: false,
              nothingNew: true,
              // The rows themselves, so the dialog can SHOW what matched
              // instead of only counting it.
              duplicates: pre.rows
                .filter((r) => r.isDuplicate)
                .map((r) => ({
                  symbol: r.tradingsymbol,
                  segment: r.segment,
                  buyQty: r.buyQty,
                  sellQty: r.sellQty,
                  grossPnl: r.grossPnl,
                })),
              message: `All ${pre.summary.total} trade${pre.summary.total === 1 ? " is" : "s are"} already in your journal — nothing new to commit. The journal is unchanged.`,
            },
            { status: 409 },
          );
        }
        if (pre.crossSource?.risky && body.force !== true) {
          return NextResponse.json(
            {
              ok: false,
              needsForce: true,
              // Structured for the confirmation dialog; message kept for any
              // older client that only prints text.
              collisions: pre.crossSource.collisions,
              symbols: pre.crossSource.symbols,
              message:
                `${pre.crossSource.message} Nothing was committed. If these really are different trades, click Pull & commit again to commit anyway.`,
            },
            { status: 409 },
          );
        }
        const result = commitParsedFile(parsed, fileName);
        db.update(brokerConnections)
          .set({ lastPullAt: new Date().toISOString() })
          .where(and(eq(brokerConnections.accountId,accountId),eq(brokerConnections.broker, broker)))
          .run();
        revalidatePath("/trades");
        revalidatePath("/");
        return NextResponse.json({ ok: true, mode, result, warnings });
      }

      return NextResponse.json({ ok: true, mode, preview: pre, warnings });
    } catch (e) {
      return NextResponse.json(
        { ok: false, message: `Import refused: ${(e as Error).message}` },
        { status: 422 },
      );
    }
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
