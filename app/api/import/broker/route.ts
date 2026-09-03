import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { brokerConnections, settings } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { exchangeKiteRequestToken, kiteImportSource, kiteLoginUrl, toParsedFile as kiteToParsedFile } from "@/lib/import/api/kite";
import { dhanImportSource, dhanTotpEnrolled, jwtExpiresAt, toParsedFile as dhanToParsedFile } from "@/lib/import/api/dhan";
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
import { AccountRequiredError, getWriteAccountId } from "@/lib/queries/accounts";
import { todayIstIso } from "@/lib/domain/trading-day";
import { listBrokerConnections } from "@/lib/queries/broker-connections";
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
 *  vault-encrypted JSON blob in auth_json, packed by the broker's own entry in
 *  `packAuth` below (per-broker dispatch — this used to be hard-coded to Angel
 *  One's field trio). A pack may return `tokenOptional: true` when the extras
 *  it stored replace the pasted token (Dhan PIN+TOTP, Zerodha api_secret). */
const API_BROKERS: Record<string, { label: string; keyLabel: string; note: string; needsToken: boolean; extraFields?: readonly string[] }> = {
  zerodha: {
    label: "Zerodha (Kite Connect)",
    keyLabel: "API key",
    note: "Paste the day's access token, or save the API secret once — then each pull day is one browser login + request_token paste and Vyuha does the exchange. Either way the session dies daily around 6 AM IST by regulation.",
    needsToken: true,
    extraFields: ["apiSecret"],
  },
  dhan: {
    label: "Dhan (DhanHQ v2)",
    keyLabel: "Client ID",
    note: "Two modes: paste a token from web.dhan.co → DhanHQ Trading APIs (valid 24 hours), or save your PIN + TOTP secret once and Vyuha mints the day's token itself at pull time — nothing expires on you.",
    needsToken: true,
    extraFields: ["pin", "totpSecret"],
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

/** Mask an account/user id down to its last two characters — enough to
 *  recognise your own id, not enough to leak someone else's. */
const maskId = (s: string) => (s.length <= 2 ? "••" : `${"•".repeat(s.length - 2)}${s.slice(-2)}`);

/**
 * The Dhan PIN+TOTP consent version the save handler stamps into auth_json as
 * `totpAckVersion`. MUST equal DHAN_TOTP_CONSENT_VERSION exported next to the
 * consent copy in components/import/broker-connect.tsx — the route cannot
 * import that "use client" module, so tests/broker-auth-gate.test.ts pins the
 * two to the same number instead. An auth_json blob without this field is a
 * legacy enrollment saved before the server-side gate existed and is treated
 * as NOT enrolled (dhanTotpEnrolled).
 */
const DHAN_TOTP_ACK_VERSION = 1;

/** One OpenAlgo instance fronts ONE broker, and a user can run several — so
 *  each is its own connection row, `openalgo:<underlying>` (see the adapter).
 *  Every openalgo:* id shares the single "openalgo" spec. */
const specOf = (broker: string) => API_BROKERS[isOpenAlgoConnectionId(broker) ? "openalgo" : broker];

type PackedAuth =
  | { ok: true; authPlain: string | null; tokenOptional?: boolean }
  | { ok: false; message: string };

const str = (v: unknown) => String(v ?? "").trim();

/**
 * The stored auth_json blob, read in ONE place with three honest states.
 *
 * "unreadable" covers both a vault that cannot decrypt the row and a blob that
 * decrypts to something that is not a JSON object. Every reader used to hide
 * that case behind a bare `catch {}` and fall back to pasted-token mode — so a
 * user whose PIN+TOTP enrolment had rotted saw pulls quietly start failing on
 * the 24-hour token, with no hint that the enrolment was the thing broken.
 * Now GET reports it (`authUnreadable`) and a pull refuses with the same flag.
 */
type AuthBlobRead =
  | { state: "none" }
  | { state: "ok"; value: Record<string, unknown> }
  | { state: "unreadable"; reason: string };

function readAuthBlob(stored: string | null | undefined): AuthBlobRead {
  if (stored == null || stored === "") return { state: "none" };
  const read = readSecret(stored);
  if (!read.ok) return { state: "unreadable", reason: read.reason };
  if (!read.value) return { state: "none" };
  try {
    const v = JSON.parse(read.value) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return { state: "ok", value: v as Record<string, unknown> };
    return { state: "unreadable", reason: "the stored auth blob is not a JSON object" };
  } catch {
    return { state: "unreadable", reason: "the stored auth blob is not valid JSON" };
  }
}

/** The typed warning the GET projection carries (`authWarning`) and every
 *  pull refusal repeats when the stored enrolment cannot be read. */
const AUTH_UNREADABLE_WARNING = "enrolment stored but unreadable — remove the enrolment and re-enrol";

/**
 * Per-broker packing of the auth_json extras (OpenAlgo has its own branch in
 * the save handler because it also rewrites the connection id). Each entry
 * validates AT SAVE, with a message naming the field — not at tomorrow's pull
 * as a cryptic broker rejection.
 */
const packAuth: Record<string, (body: Record<string, unknown>) => PackedAuth> = {
  angelone: (body) => {
    // Angel One's extras: client code + PIN + TOTP SECRET — all three required.
    const clientCode = str(body.clientCode);
    const pin = str(body.pin);
    const totpSecret = str(body.totpSecret);
    if (!clientCode || !pin || !totpSecret) {
      return { ok: false, message: "Client code, PIN and TOTP secret are all required." };
    }
    // Catch the classic paste error AT SAVE, with a message.
    if (!looksLikeTotpSecret(totpSecret)) {
      return {
        ok: false,
        message:
          "That does not look like a TOTP secret. Paste the base32 SECRET shown at SmartAPI 2FA enrollment (behind the QR code) — not the 6-digit code it generates.",
      };
    }
    return { ok: true, authPlain: JSON.stringify({ clientCode, pin, totpSecret }) };
  },
  dhan: (body) => {
    // Dhan's extras are OPTIONAL: PIN + TOTP secret enable unattended minting;
    // absent both, the pasted 24h token mode remains exactly as it was.
    const pin = str(body.pin);
    const totpSecret = str(body.totpSecret);
    if (!pin && !totpSecret) return { ok: true, authPlain: null };
    if (!pin || !totpSecret) {
      return {
        ok: false,
        message: "PIN and TOTP secret go together — fill both to enable unattended auth, or neither to stay on pasted tokens.",
      };
    }
    if (!looksLikeTotpSecret(totpSecret)) {
      return {
        ok: false,
        message:
          "That does not look like a TOTP secret. Paste the base32 SECRET from Dhan's TOTP enrollment (behind the QR code) — not the 6-digit code it generates.",
      };
    }
    // The SERVER-side consent gate (the OpenAlgo/Telegram house rule: a hidden
    // tab — or here, a client-side checkbox — is never the only defence).
    // Anyone can POST; storing a permanent second factor without the explicit
    // acknowledgement in the request is refused outright, and the ack VERSION
    // is stored alongside the credential so a legacy blob is distinguishable.
    if (body.dhanTotpConsent !== true) {
      return {
        ok: false,
        message:
          "Storing a Dhan PIN + TOTP secret makes Vyuha a second factor for your Dhan account, and needs the explicit consent acknowledgement — tick the consent checkbox and save again.",
      };
    }
    return {
      ok: true,
      authPlain: JSON.stringify({ pin, totpSecret, totpAckVersion: DHAN_TOTP_ACK_VERSION }),
      tokenOptional: true,
    };
  },
  zerodha: (body) => {
    // Zerodha's extra is OPTIONAL: the api_secret enables the official daily
    // session exchange (request_token paste); absent, raw token paste remains.
    const apiSecret = str(body.apiSecret);
    if (!apiSecret) return { ok: true, authPlain: null };
    return { ok: true, authPlain: JSON.stringify({ apiSecret }), tokenOptional: true };
  },
};

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
  // Scoping, the legacy openalgo → openalgo:<underlying> rename and account
  // names all live in the query module — the aggregate view lists EVERY
  // account's connections (invariant 8), it never collapses to account 1.
  const { aggregate, rows } = listBrokerConnections();
  const gate = currentOpenAlgoGate();
  return NextResponse.json({
    // CONTRACT: the Import UI reads `openalgo.available` to decide whether to
    // render the OpenAlgo tab at all, and shows `openalgo.reason` when it is
    // false. Shape is fixed — `reason` is present only when closed.
    openalgo: gate.allowed ? { available: true } : { available: false, reason: gate.reason },
    ok: true,
    /** True when the listing spans every account (the All-accounts view) —
     *  the client uses it to label each connection with its account. */
    aggregate,
    connections: rows.map((r) => {
      // Decrypt only to mask — the plaintext never leaves this handler. An
      // unreadable secret masks as bullets rather than leaking ciphertext.
      const key = readSecret(r.apiKey);
      const auth = readAuthBlob(r.authJson);
      const a = auth.state === "ok" ? auth.value : null;
      // The stored token is decoded ONLY for its own `exp` claim — the value
      // itself never leaves this handler. An encrypted empty token (token-less
      // brokers) does not read back, which is correctly "no token".
      const tokenPeek = readSecret(r.accessToken);
      const tokenPlain = tokenPeek.ok ? tokenPeek.value : "";
      const totpMode =
        a != null &&
        (r.broker === "dhan"
          ? dhanTotpEnrolled(a as { pin?: string; totpSecret?: string; totpAckVersion?: number })
          : r.broker === "angelone"
            ? Boolean(a.pin && a.totpSecret)
            : false);
      const out: Record<string, unknown> = {
        broker: r.broker,
        accountId: r.accountId,
        accountName: r.accountName,
        apiKeyMasked: key.ok && key.value ? mask(key.value) : "••••",
        // Whether a READABLE auth_json blob is stored (PIN+TOTP, api_secret,
        // OpenAlgo config) — a boolean only, so the UI can offer "remove
        // enrollment" without the contents ever leaving this handler. A blob
        // that is stored but cannot be read is reported as exactly that
        // (hasAuth false + authUnreadable true), never as a working enrolment.
        hasAuth: auth.state === "ok",
        authUnreadable: auth.state === "unreadable",
        authWarning: auth.state === "unreadable" ? AUTH_UNREADABLE_WARNING : null,
        // CONTRACT for the mode label: "totp" = the enrolment mints its own
        // token; "token" = a pasted/cached token is stored; "none" = nothing.
        authMode: totpMode ? "totp" : tokenPlain ? "token" : "none",
        // The stored token's own `exp` (seconds or milliseconds, normalised),
        // as ISO — so the UI can say when a pasted token dies; null when there
        // is no token or it is not a decodable JWT.
        tokenExpiresAt: tokenPlain ? jwtExpiresAt(tokenPlain) : null,
        lastPullAt: r.lastPullAt,
        updatedAt: r.updatedAt,
      };
      // OpenAlgo's host and underlying broker are CONFIG, not credentials —
      // they ride encrypted in auth_json but the UI must show them back, or a
      // reloaded page renders the default host over a saved one and an
      // innocent "Update connection" silently repoints the pull at a
      // different OpenAlgo instance (found live, 2026-08-26). An unreadable
      // blob is reported through authUnreadable above; the UI keeps defaults.
      if (isOpenAlgoConnectionId(r.broker) && a) {
        out.openalgoHost = (a.host as string | undefined) ?? null;
        out.openalgoUnderlyingBroker = (a.underlyingBroker as string | undefined) ?? null;
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
  // Writes need a real account — 0 is a view, not a place (invariant 9). The
  // client sends the connection row's own accountId for pulls/disconnects and
  // the picker's choice (`savePick`) for saves; getWriteAccountId validates an
  // explicit id against the accounts table and THROWS — no lowest-id fallback
  // since v3.8 — when the body names 0 or nothing while All accounts is the
  // selection. That is a 400 with a stable code, not a guess.
  let accountId: number;
  try {
    accountId = getWriteAccountId(typeof body.accountId === "number" ? body.accountId : null);
  } catch (e) {
    if (e instanceof AccountRequiredError) {
      return NextResponse.json({ ok: false, code: e.code, message: e.message }, { status: 400 });
    }
    throw e;
  }

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

    // DELIBERATE removal of the stored auth extras (Dhan PIN+TOTP, Zerodha
    // api_secret) without retyping the credentials: `clearAuth: true` with no
    // new key/token nulls auth_json on the existing row and touches nothing
    // else. Restricted to the two brokers whose extras are optional — for
    // Angel One and OpenAlgo the blob IS the connection, and clearing it would
    // just break the row.
    const clearAuth = body.clearAuth === true;
    if (clearAuth && !apiKey && !accessToken) {
      if (broker !== "dhan" && broker !== "zerodha") {
        return NextResponse.json(
          { ok: false, message: "Only Dhan (PIN + TOTP) and Zerodha (API secret) enrollments can be removed this way — use Disconnect for the rest." },
          { status: 400 },
        );
      }
      const existing = db
        .select({ id: brokerConnections.id })
        .from(brokerConnections)
        .where(and(eq(brokerConnections.accountId, accountId), eq(brokerConnections.broker, broker)))
        .all()[0];
      if (!existing) {
        return NextResponse.json({ ok: false, message: "No saved connection to remove the enrollment from." }, { status: 400 });
      }
      db.update(brokerConnections)
        .set({ authJson: null, updatedAt: new Date().toISOString() })
        .where(eq(brokerConnections.id, existing.id))
        .run();
      recordAudit({
        entity: "settings",
        action: "update",
        summary: `Broker connection ${broker}: stored auth extras removed`,
        before: { broker, hadAuth: true },
        after: { broker, hadAuth: false },
      });
      return NextResponse.json({
        ok: true,
        message:
          broker === "dhan"
            ? "PIN + TOTP enrollment removed — pulls fall back to pasted 24-hour tokens, and auto-pull no longer includes Dhan."
            : "API secret removed — pulls need the day's pasted access token again.",
      });
    }

    // Broker-specific extras, one encrypted blob in auth_json — packed by the
    // broker's own `packAuth` entry (OpenAlgo keeps its branch here because it
    // also rewrites the connection id). Packed BEFORE the token check: for
    // Dhan and Zerodha the extras can legitimately replace the pasted token.
    let authPlain: string | null = null;
    let tokenOptional = false;
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
    } else if (packAuth[broker]) {
      const packed = packAuth[broker](body as Record<string, unknown>);
      if (!packed.ok) return NextResponse.json({ ok: false, message: packed.message }, { status: 400 });
      authPlain = packed.authPlain;
      tokenOptional = Boolean(packed.tokenOptional && authPlain);
    }

    // The row this save would upsert, if any — read once, used twice below:
    // to carry over the stored Client ID / API key when the box was left
    // empty, and to carry over the stored auth extras when none were sent.
    const existing = db
      .select({ apiKey: brokerConnections.apiKey, authJson: brokerConnections.authJson })
      .from(brokerConnections)
      .where(and(eq(brokerConnections.accountId, accountId), eq(brokerConnections.broker, broker)))
      .all()[0];

    // An EMPTY key with a saved row means "keep the stored one" (owner ruling
    // 2026-09-04): the client clears its key box after every save and GET
    // returns only a mask, so retyping the Client ID just to refresh a token
    // was the only way to re-save — and a typo there silently rebound the
    // connection to another client. A non-empty key still replaces it.
    if ((!apiKey && !existing) || (spec.needsToken && !tokenOptional && !accessToken)) {
      const message =
        broker === "dhan"
          ? "Client ID plus either a pasted access token or PIN + TOTP secret are required."
          : broker === "zerodha"
            ? "API key plus either the day's access token or the API secret are required."
            : `${spec.keyLabel}${spec.needsToken ? " and access token are" : " is"} required.`;
      return NextResponse.json({ ok: false, message }, { status: 400 });
    }

    // Encrypted at rest (v2.99.80). A broken vault REFUSES the save rather
    // than quietly storing a live credential in plaintext. A kept key is the
    // stored CIPHERTEXT carried over byte-for-byte — never decrypted here.
    let encKey: string, encToken: string, encAuth: string | null;
    try {
      encKey = apiKey ? encryptSecret(apiKey) : existing!.apiKey;
      encToken = encryptSecret(accessToken || "");
      encAuth = authPlain ? encryptSecret(authPlain) : null;
    } catch (e) {
      return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "The secrets vault is unavailable." }, { status: 500 });
    }
    // A re-save that carries NO extras must not silently wipe stored ones: a
    // token-only "Update connection" used to null auth_json and destroy the
    // Dhan PIN+TOTP enrollment / Zerodha api_secret the user could no longer
    // see (the client clears its fields after save). Absent extras now mean
    // "keep what is stored" — the stored ciphertext is carried over untouched —
    // and removal is only ever the explicit `clearAuth: true`.
    if (!authPlain && !clearAuth && existing?.authJson) encAuth = existing.authJson;
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
      summary: `Broker connection saved: ${broker} (key ${apiKey ? mask(apiKey) : "kept"})`,
      before: null,
      after: { broker, apiKey: apiKey ? mask(apiKey) : "kept" }, // never audit the token
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
    // Dhan (PIN+TOTP) and Zerodha (api_secret) may hold that same encrypted
    // empty token when their auth_json extras replace it — so for them, token
    // readability is only load-bearing when there is NO auth blob to mint or
    // exchange from.
    const authBlob = readAuthBlob(conn.authJson);
    const hasAuthBlob = authBlob.state === "ok";
    if (!keyRead.ok || (needsToken && !tokenRead.ok && !hasAuthBlob)) {
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
        if (authBlob.state !== "ok") {
          return NextResponse.json(
            {
              ok: false,
              authUnreadable: authBlob.state === "unreadable",
              message: "The saved OpenAlgo settings cannot be read — re-enter the API key, host and broker.",
            },
            { status: 400 },
          );
        }
        const auth = authBlob.value as { host: string; underlyingBroker: Broker };
        openAlgoBroker = auth.underlyingBroker;
        const creds = { apiKey: keyRead.value, host: auth.host, broker: openAlgoBroker };
        const today = todayIstIso();
        // normalize is called DIRECTLY rather than through fetchTrades: the
        // `repaired` / `refused` counts are what become the user-facing
        // warnings, and fetchTrades returns only the trades. The quantity
        // repair is the whole reason those warnings exist — see the adapter
        // header — so it must not be dropped on the way to the screen.
        const result = normalizeOpenAlgoTrades(await fetchOpenAlgoTradebook(creds), openAlgoBroker, today);
        parsed = openAlgoToParsedFile(openAlgoBroker, result);
      } else if (broker === "angelone") {
        // The extras live in auth_json as one encrypted JSON blob.
        if (authBlob.state !== "ok") {
          return NextResponse.json(
            {
              ok: false,
              authUnreadable: authBlob.state === "unreadable",
              message: "The saved Angel One credentials cannot be read — re-enter the API key, client code, PIN and TOTP secret.",
            },
            { status: 400 },
          );
        }
        const auth = authBlob.value as { clientCode: string; pin: string; totpSecret: string };
        const creds = { apiKey: keyRead.value, clientCode: auth.clientCode, pin: auth.pin, totpSecret: auth.totpSecret };
        const { jwtToken } = await angelOneLogin(creds);
        const today = todayIstIso();
        const { trades, refused } = normalizeAngelTrades(await fetchAngelTradeBook(creds, jwtToken), today);
        parsed = angelToParsedFile(trades, refused);
      } else if (broker === "dhan") {
        // apiKey holds the Dhan CLIENT ID; the column is named for Kite, which
        // came first. Renaming it would need a migration for no behavioural gain.
        // PIN + TOTP secret (when enrolled) ride in auth_json; the adapter
        // mints the day's token from them and falls back to the pasted token.
        let pin: string | undefined;
        let totpSecret: string | undefined;
        let legacyUnacked = false;
        // An enrolment that is STORED but cannot be read is refused outright —
        // never silently downgraded to pasted-token mode (owner ruling
        // 2026-09-04). The user asked for unattended minting; a pull that
        // quietly ran on a 24-hour token instead would fail tomorrow with a
        // hint pointing at the wrong thing.
        if (authBlob.state === "unreadable") {
          return NextResponse.json(
            {
              ok: false,
              authUnreadable: true,
              message: `Dhan PIN + TOTP ${AUTH_UNREADABLE_WARNING} (${authBlob.reason}). Nothing was pulled — the pasted-token fallback is not used for an enrolment that cannot be read; remove the enrolment or re-save with PIN + TOTP.`,
            },
            { status: 400 },
          );
        }
        if (authBlob.state === "ok") {
          const a = authBlob.value as { pin?: string; totpSecret?: string; totpAckVersion?: number };
          // pin + totpSecret feed the mint ONLY when the blob also carries
          // the recorded consent (totpAckVersion). A legacy-shaped blob —
          // saved before the server-side consent gate existed — is treated
          // as NOT enrolled: the pull falls back to the pasted token.
          if (dhanTotpEnrolled(a)) {
            pin = a.pin || undefined;
            totpSecret = a.totpSecret || undefined;
          } else if (a.pin && a.totpSecret) {
            legacyUnacked = true;
          }
        }
        if (!(pin && totpSecret) && !accessTokenPlain) {
          // A legacy or half-saved connection with nothing usable: say which
          // two ways fix it instead of failing inside the fetch.
          return NextResponse.json(
            {
              ok: false,
              message: legacyUnacked
                ? "Dhan PIN + TOTP are saved but without the recorded consent this build requires — re-save the connection (ticking the consent checkbox) to re-enroll, or paste a fresh 24-hour token."
                : "No Dhan access token saved and no PIN + TOTP secret to mint one — reconnect Dhan with either a fresh 24-hour token or PIN + TOTP.",
            },
            { status: 400 },
          );
        }
        const source = dhanImportSource(
          {
            clientId: keyRead.value,
            accessToken: accessTokenPlain || undefined,
            pin,
            totpSecret,
          },
          // PERSIST a freshly minted token: Dhan mints at most one per 2
          // minutes (live-verified 2026-09-02), so preview → commit inside
          // that window MUST reuse the stored token instead of re-minting.
          // Same vault path as a pasted token; a vault refusal only costs the
          // cache — the in-flight pull already holds the token in memory.
          (minted) => {
            try {
              db.update(brokerConnections)
                .set({ accessToken: encryptSecret(minted), updatedAt: new Date().toISOString() })
                .where(eq(brokerConnections.id, conn.id))
                .run();
            } catch {
              /* cache miss only — tomorrow's first pull mints again */
            }
          },
        );
        parsed = dhanToParsedFile(await source.fetchTrades({}));
      } else if (broker === "upstox") {
        // apiKey holds the year-long read-only Analytics token. normalize is
        // called directly so the unparseable-symbol notes reach the screen.
        const today = todayIstIso();
        parsed = upstoxToParsedFile(normalizeUpstoxTrades(await fetchUpstoxTrades({ accessToken: keyRead.value }), today));
      } else {
        // Zerodha. With an api_secret saved (auth_json), the daily ritual is
        // the OFFICIAL session exchange (decision #3, NO enctoken): the user
        // logs in via their Kite Connect URL, pastes the request_token, and
        // Vyuha does checksum + /session/token. Honest framing: one browser
        // click + one paste per day — better than pasting a raw token, not
        // unattended (SEBI-mandated ~6 AM IST session invalidation).
        let apiSecret: string | undefined;
        let storedKiteUserId: string | undefined;
        // Same rule as Dhan: a stored api_secret blob that cannot be read is
        // refused, not silently downgraded to raw-paste mode — the user-id
        // binding lives in that blob too, and skipping it would let a session
        // for the wrong Zerodha account import into this journal.
        if (authBlob.state === "unreadable") {
          return NextResponse.json(
            {
              ok: false,
              authUnreadable: true,
              message: `Zerodha API secret ${AUTH_UNREADABLE_WARNING} (${authBlob.reason}). Nothing was pulled — remove the stored secret or re-save it.`,
            },
            { status: 400 },
          );
        }
        if (authBlob.state === "ok") {
          const a = authBlob.value as { apiSecret?: string; kiteUserId?: string };
          apiSecret = a.apiSecret || undefined;
          storedKiteUserId = a.kiteUserId || undefined;
        }
        let kiteToken = accessTokenPlain;
        const requestToken = String(body.requestToken ?? "").trim();
        if (requestToken && apiSecret) {
          const { accessToken, userId } = await exchangeKiteRequestToken({ apiKey: keyRead.value, apiSecret, requestToken });
          // WHOSE session did we just mint? The exchange states it (user_id).
          // A mismatch against the id this connection is bound to means the
          // user logged into a DIFFERENT Zerodha account — proceeding would
          // import someone else's tradebook into this journal, so the pull
          // refuses before the token is cached or a single trade is fetched.
          if (userId && storedKiteUserId && userId !== storedKiteUserId) {
            return NextResponse.json(
              {
                ok: false,
                kiteUserMismatch: true,
                message: `This connection is bound to Zerodha ID ${maskId(storedKiteUserId)}, but today's login was for a different Zerodha ID (${maskId(userId)}). Nothing was pulled — log in with the account this connection belongs to, or disconnect and reconnect for the other account.`,
              },
              { status: 409 },
            );
          }
          kiteToken = accessToken;
          // First successful exchange for a connection with no stored id
          // (including legacy rows saved before the check existed): stamp the
          // session's user_id into auth_json so every later exchange can be
          // compared. A vault refusal only costs the stamp, never the pull.
          if (userId && !storedKiteUserId) {
            try {
              db.update(brokerConnections)
                .set({
                  authJson: encryptSecret(JSON.stringify({ apiSecret, kiteUserId: userId })),
                  updatedAt: new Date().toISOString(),
                })
                .where(and(eq(brokerConnections.accountId, accountId), eq(brokerConnections.broker, broker)))
                .run();
            } catch {
              /* stamp miss only */
            }
          }
          // Cache the day's token through the same vault path a save uses, so
          // later pulls today skip the prompt. A vault refusal only costs the
          // cache — the in-memory token still serves THIS pull.
          try {
            db.update(brokerConnections)
              .set({ accessToken: encryptSecret(accessToken), updatedAt: new Date().toISOString() })
              .where(and(eq(brokerConnections.accountId, accountId), eq(brokerConnections.broker, broker)))
              .run();
          } catch {
            /* cache miss only */
          }
        }
        const needsLoginResponse = () =>
          NextResponse.json(
            {
              ok: false,
              needsRequestToken: true,
              loginUrl: kiteLoginUrl(keyRead.value),
              message:
                "Zerodha needs today's login: Kite sessions are invalidated around 6 AM IST every day by regulation, so this stays one browser click + one paste daily — not unattended. Open your Kite Connect login URL, sign in, and paste the request_token from the redirect.",
            },
            { status: 409 },
          );
        if (!kiteToken) {
          if (apiSecret) return needsLoginResponse();
          return NextResponse.json(
            { ok: false, message: "No Kite access token saved — paste the day's token, or save the API secret to switch to the request_token flow." },
            { status: 400 },
          );
        }
        const source = kiteImportSource({ apiKey: keyRead.value, accessToken: kiteToken });
        try {
          parsed = kiteToParsedFile(await source.fetchTrades({}));
        } catch (e) {
          // A dead session with an api_secret on file is not an error — it is
          // the daily prompt.
          if (apiSecret && (e as Error & { kiteStatus?: number }).kiteStatus === 403) return needsLoginResponse();
          throw e;
        }
      }
    } catch (e) {
      return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 502 });
    }

    const today = todayIstIso();
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
      // Dedup is per (account, broker), so preview and commit must both run
      // against the connection's own account, not the selected view.
      const pre = previewParsedFile(parsed, null, accountId, fileName);
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
        const result = commitParsedFile(parsed, fileName, null, accountId);
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
