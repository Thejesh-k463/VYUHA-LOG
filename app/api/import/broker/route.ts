import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { brokerConnections, settings } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { exchangeKiteRequestToken, fetchKiteTrades, kiteLoginUrl, normalizeKitePull, toParsedFile as kiteToParsedFile } from "@/lib/import/api/kite";
import { currencyRefusalNote, currencyUnderlyings, strandedCurrencyNotes } from "@/lib/import/parsers/zerodha";
import {
  DHAN_TOTP_ACK_VERSION,
  catchUpAfter,
  catchUpRange,
  dhanImportSource,
  dhanTotpEnrolled,
  jwtExpiresAt,
  toParsedFile as dhanToParsedFile,
  type DhanHistoryRead,
  type DhanUnfetchedSpan,
} from "@/lib/import/api/dhan";
import { angelOneLogin, fetchAngelTradeBook, normalizeAngelTrades, toParsedFile as angelToParsedFile } from "@/lib/import/api/angelone";
import { toParsedFile as upstoxToParsedFile, normalizeUpstoxTrades, fetchUpstoxTrades } from "@/lib/import/api/upstox";
import {
  assertOpenAlgoBroker,
  assertOpenAlgoVersion,
  fetchOpenAlgoTradebook,
  isOpenAlgoConnectionId,
  normalizeHost,
  normalizeOpenAlgoStreamUrl,
  normalizeOpenAlgoTrades,
  openAlgoConnectionId,
  toParsedFile as openAlgoToParsedFile,
} from "@/lib/import/api/openalgo";
import { brokerLabel, findRivalConnection, mergeAuth } from "@/lib/import/broker-identity";
import { randomUUID } from "node:crypto";
import {
  exchangeFyersAuthCode,
  extractFyersAuthCode,
  fetchFyersProfileId,
  fetchFyersTradeBook,
  fyersLoginUrl,
  normalizeFyersTrades,
  toParsedFile as fyersToParsedFile,
} from "@/lib/import/api/fyers";
import { fetchKotakTrades, kotakLogin, normalizeKotakTrades, toParsedFile as kotakToParsedFile } from "@/lib/import/api/kotakneo";
import {
  extractNuvamaRequestId,
  fetchNuvamaTrades,
  normalizeNuvamaTrades,
  nuvamaLogin,
  nuvamaLoginUrl,
  toParsedFile as nuvamaToParsedFile,
  type NuvamaSession,
} from "@/lib/import/api/nuvama";
import { isBrokerAuthExpired } from "@/lib/import/api/broker-auth-error";
import {
  BROKER_PULL_DISCLOSURES,
  PULL_UNVERIFIED_LABEL,
  pullAckCurrent,
  UNVERIFIED_PULL_BROKERS,
  type BrokerPullDisclosureId,
} from "@/lib/domain/broker-pull-disclosure";
import type { ParsedFile } from "@/lib/import/types";
import {
  DHAN_UNFETCHED_NOTICE,
  clearUnfetchedLine,
  keepUnfetched,
  keepUnfetchedAndStamp,
  outstandingUnfetched,
  outstandingUnfetchedLines,
} from "@/lib/import/dhan-unfetched";
import { openAlgoGate } from "@/lib/domain/openalgo-disclosure";
import type { Broker } from "@/lib/domain/constants";
import { looksLikeTotpSecret } from "@/lib/totp";
import { previewParsedFile, commitParsedFile } from "@/lib/import/commit";
import { AccountRequiredError, getWriteAccountId } from "@/lib/queries/accounts";
import { istWallClockIso, todayIstIso } from "@/lib/domain/trading-day";
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
  // v4.7.0 wave C6 — native READ-ONLY pulls. `needsToken: false` for all three:
  // the access_token column is a CACHE here (Fyers' day token, Nuvama's whole
  // session), never something the user pastes.
  fyers: {
    label: "Fyers (API v3)",
    keyLabel: "App ID",
    note: `App ID and App Secret are saved once; on each day you pull, one login on Fyers' own page through the link Vyuha shows, then paste back the address it sends you to — the day's token is kept until that day ends. Fyers' trade-book format is ${PULL_UNVERIFIED_LABEL}.`,
    needsToken: false,
    extraFields: ["apiSecret"],
  },
  kotakneo: {
    label: "Kotak Neo (Trade API)",
    keyLabel: "Trade API access token",
    note: `Login is unattended: the saved TOTP secret and MPIN log in afresh at every pull, and nothing from the session is kept. Kotak Neo's trade-book format is ${PULL_UNVERIFIED_LABEL}.`,
    needsToken: false,
    extraFields: ["mobileNumber", "ucc", "mpin", "totpSecret"],
  },
  nuvama: {
    label: "Nuvama (APIConnect)",
    keyLabel: "API key",
    note: `API key and API secret are saved once; when the Nuvama session has ended, one login on Nuvama's own page through the link Vyuha shows, then paste back the address it sends you to. Nuvama's documentation marks a static IP as mandatory, so a pull from a home connection may be refused. Nuvama's trade-book format is ${PULL_UNVERIFIED_LABEL}.`,
    needsToken: false,
    extraFields: ["apiSecret"],
  },
};

/** The three C6 brokers — each has ONE consent sheet (BROKER_PULL_DISCLOSURES). */
const isPullBroker = (b: string): b is BrokerPullDisclosureId =>
  Object.prototype.hasOwnProperty.call(BROKER_PULL_DISCLOSURES, b);

/** The redirect URI the user registers on the Fyers app — Nuvama's own default,
 *  and no server answers it: the browser shows an error page whose ADDRESS the
 *  user pastes back (design D2; no callback route, the Kite precedent). */
const PULL_REDIRECT_URI = "https://127.0.0.1/";

/** The next IST calendar day of an ISO date, by date arithmetic alone. */
function nextIsoDay(isoDay: string): string {
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** A Fyers access token dies at the end of the trading day it was minted
 *  (F-A10): the cache is good until the next IST midnight. */
function fyersTokenExpiry(now = new Date()): string {
  return new Date(istWallClockIso(nextIsoDay(todayIstIso(now)), "00:00")).toISOString();
}

/** A Nuvama session ends at the SHORTER of its two stated lifetimes (R7 §4):
 *  8 hours, or the next 00:30 IST. */
function nuvamaSessionExpiry(now = new Date()): string {
  const today = todayIstIso(now);
  const tonight = Date.parse(istWallClockIso(today, "00:30"));
  const next = tonight > now.getTime() ? tonight : Date.parse(istWallClockIso(nextIsoDay(today), "00:30"));
  return new Date(Math.min(now.getTime() + 8 * 3600_000, next)).toISOString();
}

/** The C6 needs-login answers, ONE shape each (the pull's 409 vocabulary). */
function fyersNeedsAuthCode(appId: string, message?: string) {
  return NextResponse.json(
    {
      ok: false,
      needsAuthCode: true,
      loginUrl: fyersLoginUrl({ appId, redirectUri: PULL_REDIRECT_URI, state: randomUUID() }),
      message:
        message ??
        "Fyers needs today's login: open the link, sign in on Fyers' own page, then paste the whole address your browser lands on (it starts https://127.0.0.1/ and the page itself shows an error — that is expected) or the auth_code from it. A Fyers token lasts until the end of the day.",
    },
    { status: 409 },
  );
}
function nuvamaNeedsLogin(apiKey: string, message?: string) {
  return NextResponse.json(
    {
      ok: false,
      needsLogin: true,
      loginUrl: nuvamaLoginUrl(apiKey),
      message:
        message ??
        "Nuvama needs a login: open the link, sign in on Nuvama's own page, then paste the whole address your browser lands on (the page itself may show an error — that is expected) or the request id from it.",
    },
    { status: 409 },
  );
}
function needsConsentResponse(broker: BrokerPullDisclosureId, saving: boolean) {
  const { version } = BROKER_PULL_DISCLOSURES[broker];
  return NextResponse.json(
    {
      ok: false,
      needsConsent: true,
      version,
      message: saving
        ? `Read and accept what connecting ${brokerLabel(broker)} stores and calls before saving — nothing was saved.`
        : `${brokerLabel(broker)}'s pull statement has changed since you accepted it (or was never accepted) — read and accept it, then save the connection again. Nothing was pulled.`,
    },
    { status: 409 },
  );
}

/**
 * Mask a credential for the audit log: reveal a PROPORTION of it, never a
 * fixed four characters. The old fixed prefix showed 4 of an 8-character
 * Angel One API key — half the secret — while showing the same 4 of a 20
 * character one. A short credential (< 6) is written as bullets ALONE: the
 * last-two "is this mine?" tail that maskId uses is 40% of a 5-character
 * secret and 67% of a 3-character one, which is a leak, not a hint. maskId
 * keeps that tail because an account id is not a secret.
 */
const mask = (s: string) => {
  if (s.length < 6) return "••••";
  return `${s.slice(0, Math.min(4, Math.floor(s.length / 3)))}…${"•".repeat(4)}`;
};

/** Mask an account/user id down to its last two characters — enough to
 *  recognise your own id, not enough to leak someone else's. */
const maskId = (s: string) => (s.length <= 2 ? "••" : `${"•".repeat(s.length - 2)}${s.slice(-2)}`);

/**
 * The Dhan PIN+TOTP consent version the save handler stamps into auth_json as
 * `totpAckVersion` now lives in lib/import/api/dhan.ts, beside the
 * `dhanTotpEnrolled` check that must COMPARE against it — the two drifted
 * while the check was the literal `>= 1`, so bumping the constant here would
 * have re-asked for consent while leaving every v1 blob enrolled. It MUST
 * still equal DHAN_TOTP_CONSENT_VERSION exported next to the consent copy in
 * components/import/broker-connect.tsx (a "use client" module neither can
 * import; tests/broker-auth-gate.test.ts pins the two to the same number).
 */

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
 * C-6 (owner ruling "Say it plainly") — the KEPT notice for Dhan history a
 * pull never read. The store (append-only audit_log rows keyed by account),
 * why it is the audit trail, and the THROWING writers live in
 * lib/import/dhan-unfetched.ts, shared with lib/jobs/auto-pull.ts and the
 * account merge (v4.3.0 fix wave 1: R19, R27, R10).
 * tests/fix-wave-c-import.test.ts reads every writer back through GET.
 */

/** R19: the answer when the notice cannot be saved — nothing was committed and
 *  the stamp did not move, so the next pull reads the same dates again. */
function unsavedNotice(e: unknown) {
  return NextResponse.json(
    {
      ok: false,
      message: `The notice naming the Dhan history this pull did not read could not be saved (${e instanceof Error ? e.message : "unknown error"}). Nothing was committed and the last-pull time is unchanged, so the next pull reads the same dates again.`,
    },
    { status: 500 },
  );
}

/** R4a's refusal, ONE string for the save and the Zerodha exchange (R9). */
const rivalMessage = (broker: string, accountName: string) =>
  `This ${brokerLabel(broker)} client is already connected in account "${accountName}". Vyuha keeps one connection per broker client so a book is never imported twice.`;

/**
 * Per-broker packing of the auth_json extras (OpenAlgo has its own branch in
 * the save handler because it also rewrites the connection id). Each entry
 * validates AT SAVE, with a message naming the field — not at tomorrow's pull
 * as a cryptic broker rejection.
 */
const packAuth: Record<string, (body: Record<string, unknown>, stored?: Record<string, unknown> | null) => PackedAuth> = {
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
  // v4.7.0 wave C6. These three PATCH the stored blob through `mergeAuth`
  // (review R5) instead of replacing it: a field left empty keeps the stored
  // one, the stamped identity (fyId / nuvamaUserId) and a still-current consent
  // ack survive, and the cached token's expiry is dropped because a save clears
  // the cached token. The merged result must be complete. The consent stamp is
  // the save handler's, after this.
  fyers: (body, stored) => {
    const merged = mergeAuth("fyers", stored, { apiSecret: str(body.apiSecret) || undefined, tokenExpiresAt: null });
    if (!str(merged.apiSecret)) return { ok: false, message: "The Fyers App Secret is required (Fyers' API dashboard → your app)." };
    return { ok: true, authPlain: JSON.stringify(merged) };
  },
  nuvama: (body, stored) => {
    const merged = mergeAuth("nuvama", stored, { apiSecret: str(body.apiSecret) || undefined, tokenExpiresAt: null });
    if (!str(merged.apiSecret)) return { ok: false, message: "The Nuvama API secret is required (Nuvama's API Connect page → your app)." };
    return { ok: true, authPlain: JSON.stringify(merged) };
  },
  kotakneo: (body, stored) => {
    const mobileNumber = str(body.mobileNumber).replace(/[\s-]/g, "");
    const ucc = str(body.ucc).toUpperCase();
    const mpin = str(body.mpin);
    const totpSecret = str(body.totpSecret);
    // Each TYPED field is checked for its shape; an empty one keeps the stored value.
    if (mobileNumber && !/^\+?\d{10,15}$/.test(mobileNumber)) {
      return { ok: false, message: "The registered mobile number is 10 digits (optionally with its +91 code) — that entry is not." };
    }
    if (ucc && !/^[A-Z0-9]{3,12}$/.test(ucc)) {
      return { ok: false, message: "The UCC is your Kotak client code — letters and digits only, as the Neo app shows it." };
    }
    if (mpin && !/^\d{6}$/.test(mpin)) {
      return { ok: false, message: "The MPIN is the 6-digit Neo app PIN — not the account password." };
    }
    if (totpSecret && !looksLikeTotpSecret(totpSecret)) {
      return {
        ok: false,
        message:
          "That does not look like a TOTP secret. Paste the base32 SECRET shown when you enabled TOTP for Kotak Neo (behind the QR code) — not the 6-digit code it generates.",
      };
    }
    const merged = mergeAuth("kotakneo", stored, {
      mobileNumber: mobileNumber || undefined,
      ucc: ucc || undefined,
      mpin: mpin || undefined,
      totpSecret: totpSecret || undefined,
      tokenExpiresAt: null,
    });
    const missing = [
      !str(merged.mobileNumber) && "mobile number",
      !str(merged.ucc) && "UCC",
      !str(merged.mpin) && "MPIN",
      !str(merged.totpSecret) && "TOTP secret",
    ].filter(Boolean);
    if (missing.length > 0) {
      return { ok: false, message: `Kotak Neo needs all four: mobile number, UCC, MPIN and TOTP secret (missing: ${missing.join(", ")}).` };
    }
    return { ok: true, authPlain: JSON.stringify(merged) };
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
      // v4.7.0 C6: the cached token's (or session's) end as the PULL ROUTE
      // stamped it — Fyers' day token and Nuvama's session JSON carry no
      // decodable `exp` of their own. Shown only while a cache is stored.
      const cacheExpiry =
        (r.broker === "fyers" || r.broker === "nuvama") && tokenPlain && typeof a?.tokenExpiresAt === "string" ? a.tokenExpiresAt : null;
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
        tokenExpiresAt: isPullBroker(r.broker) ? cacheExpiry : tokenPlain ? jwtExpiresAt(tokenPlain) : null,
        lastPullAt: r.lastPullAt,
        updatedAt: r.updatedAt,
      };
      // v4.7.0 C6 — the consent state the card's sheet keys on (review R6:
      // `pullAckCurrent: false` re-shows the sheet), and the unverified label
      // (ruling B2 / owner Q4). Booleans only — nothing from the blob itself.
      if (isPullBroker(r.broker)) {
        out.pullAckCurrent = pullAckCurrent(r.broker, a?.pullAckVersion);
        out.unverified = UNVERIFIED_PULL_BROKERS.includes(r.broker);
      }
      // C-6, Dhan only: the kept notices, and where the NEXT pull's history
      // window starts — later than the last pull's day means the clamp will
      // leave days out, and the card's gap line says so before the pull.
      if (r.broker === "dhan") {
        // H4 (v4.3.0 fix wave 2H): one line per kept record, each with its own
        // fact. `unfetched` keeps its shape; `unfetchedConnection[i]` is line
        // i's record connection (null: carried by a merge), which the card's
        // Clear sends back so the route clears exactly that line.
        const lines = outstandingUnfetchedLines(r.accountId);
        out.unfetched = lines.map(({ from, to, reason, fact, remedy }) => ({ from, to, reason, fact, remedy }));
        out.unfetchedConnection = lines.map((l) => l.connection);
        out.catchUpFrom = catchUpRange(r.lastPullAt)?.from ?? null;
      }
      // OpenAlgo's host and underlying broker are CONFIG, not credentials —
      // they ride encrypted in auth_json but the UI must show them back, or a
      // reloaded page renders the default host over a saved one and an
      // innocent "Update connection" silently repoints the pull at a
      // different OpenAlgo instance (found live, 2026-08-26). An unreadable
      // blob is reported through authUnreadable above; the UI keeps defaults.
      if (isOpenAlgoConnectionId(r.broker) && a) {
        out.openalgoHost = (a.host as string | undefined) ?? null;
        out.openalgoUnderlyingBroker = (a.underlyingBroker as string | undefined) ?? null;
        // v4.7.0 C7: the saved streaming address, so the Import form's input
        // shows it back — a local URL, not a secret. Null = OpenAlgo's default.
        out.openalgoWsUrl = typeof a.wsUrl === "string" && a.wsUrl ? a.wsUrl : null;
      }
      return out;
    }),
  });
}

// ---------------------------------------------------------------------------
// v4.7.0 wave C6 — the three native read-only pulls (Fyers, Kotak Neo, Nuvama)
// ---------------------------------------------------------------------------

interface PullBrokerCtx {
  conn: typeof brokerConnections.$inferSelect;
  accountId: number;
  /** The decrypted key column: Fyers App ID, Kotak Trade API access token, Nuvama API key. */
  key: string;
  /** The decrypted auth_json blob (readable — the caller refused otherwise). */
  auth: Record<string, unknown>;
  /** The decrypted access_token column: Fyers' day token / Nuvama's session JSON, or "". */
  cached: string;
  body: Record<string, unknown>;
}

/**
 * THE pull-time auth_json + access_token writer for the C6 brokers (review R5):
 * `mergeAuth` over the row's CURRENT blob — re-read, so a stamp made earlier in
 * the same pull is never overwritten — and `accessToken` undefined leaves the
 * column as it is. A vault refusal costs only the stamp or the cache, never the
 * in-flight pull (the Kite rule); an unreadable stored blob is never rewritten.
 */
function writePullAuth(connId: number, broker: BrokerPullDisclosureId, patch: Record<string, unknown>, accessToken?: string) {
  try {
    const cur = readAuthBlob(
      db.select({ authJson: brokerConnections.authJson }).from(brokerConnections).where(eq(brokerConnections.id, connId)).get()?.authJson,
    );
    if (cur.state === "unreadable") return;
    const next = mergeAuth(broker, cur.state === "ok" ? cur.value : null, patch);
    db.update(brokerConnections)
      .set({
        authJson: encryptSecret(JSON.stringify(next)),
        ...(accessToken !== undefined ? { accessToken: encryptSecret(accessToken) } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(brokerConnections.id, connId))
      .run();
  } catch {
    /* stamp / cache miss only */
  }
}

/**
 * WHOSE session did this login mint? (review R7, the Kite precedent.) A stored
 * id that differs refuses the pull (409 `<broker>UserMismatch`); otherwise the
 * one-client-per-database rival check runs with the pull-time `onlyOlderThan`
 * (P10/R9). Called BEFORE the stamp, the token/session cache and the trade
 * fetch — so a refusal leaves nothing behind. Null = proceed.
 */
function refuseForeignLogin(c: PullBrokerCtx, broker: "fyers" | "nuvama", id: string): NextResponse | null {
  const idKey = broker === "fyers" ? "fyId" : "nuvamaUserId";
  const label = brokerLabel(broker);
  const stored = str(c.auth[idKey]);
  if (stored && id !== stored) {
    return NextResponse.json(
      {
        ok: false,
        [broker === "fyers" ? "fyersUserMismatch" : "nuvamaUserMismatch"]: true,
        message: `This connection is bound to ${label} ID ${maskId(stored)}, but this login was for a different ${label} ID (${maskId(id)}). Nothing was pulled — log in with the account this connection belongs to, or disconnect and reconnect for the other account.`,
      },
      { status: 409 },
    );
  }
  const rival = findRivalConnection({
    broker,
    apiKey: c.key,
    authJson: JSON.stringify(mergeAuth(broker, c.auth, { [idKey]: id })),
    accountId: c.accountId,
    onlyOlderThan: c.conn.id,
  });
  if (rival) {
    const message = rivalMessage(broker, rival.accountName);
    return NextResponse.json({ ok: false, error: message, message }, { status: 409 });
  }
  return null;
}

/** A cached token / session is used only while the pull route's own stamp says it lives. */
const cacheAlive = (c: PullBrokerCtx) =>
  Boolean(c.cached) && typeof c.auth.tokenExpiresAt === "string" && Date.parse(c.auth.tokenExpiresAt) > Date.now();

/** Fyers (D3/D3a): the day's cached token, else the pasted auth_code, else the login link. */
async function pullFyers(c: PullBrokerCtx): Promise<NextResponse | ParsedFile> {
  const secret = str(c.auth.apiSecret);
  if (!secret) {
    return NextResponse.json({ ok: false, message: "No Fyers App Secret is saved — re-save the connection with it." }, { status: 400 });
  }
  let token = cacheAlive(c) ? c.cached : "";
  /** The profile named no id: bind on the trade book's own clientId instead. */
  let bindAfterFetch = false;
  if (!token) {
    const pasted = str(c.body.authCode);
    if (!pasted) return fyersNeedsAuthCode(c.key);
    const code = extractFyersAuthCode(pasted);
    if (!code) {
      return NextResponse.json(
        {
          ok: false,
          message:
            "That paste carries no Fyers auth_code — paste the whole address your browser landed on after the Fyers login (https://127.0.0.1/?…&auth_code=…), or the auth_code value alone. Nothing was pulled.",
        },
        { status: 400 },
      );
    }
    token = (await exchangeFyersAuthCode({ appId: c.key, secret, code })).accessToken;
    // The profile is the identity's first source; its shape is the SDK's and
    // unverified with a live account, so a refusal that is NOT a session end
    // falls back to the trade book's clientId rather than failing the pull.
    let id: string | null = null;
    try {
      id = await fetchFyersProfileId(c.key, token);
    } catch (e) {
      if (isBrokerAuthExpired(e)) throw e;
    }
    if (id) {
      const refused = refuseForeignLogin(c, "fyers", id);
      if (refused) return refused;
      writePullAuth(c.conn.id, "fyers", { fyId: id, tokenExpiresAt: fyersTokenExpiry() }, token);
    } else {
      bindAfterFetch = true;
    }
  }
  const n = normalizeFyersTrades(await fetchFyersTradeBook(c.key, token), todayIstIso());
  if (bindAfterFetch) {
    // The trade book is a READ; nothing is stamped, cached or previewed before this check.
    if (n.clientId) {
      const refused = refuseForeignLogin(c, "fyers", n.clientId);
      if (refused) return refused;
    }
    writePullAuth(c.conn.id, "fyers", { fyId: n.clientId ?? undefined, tokenExpiresAt: fyersTokenExpiry() }, token);
  }
  return fyersToParsedFile(n.trades, n.refused, n.notes);
}

/** The cached Nuvama session, read back from the vault — null for anything not its shape. */
function readNuvamaSession(s: string): NuvamaSession | null {
  try {
    const v = JSON.parse(s) as Partial<NuvamaSession> | null;
    if (!v || typeof v.auth !== "string" || typeof v.sourceToken !== "string" || typeof v.userId !== "string") return null;
    return {
      auth: v.auth,
      sourceToken: v.sourceToken,
      userId: v.userId,
      appIdKey: typeof v.appIdKey === "string" ? v.appIdKey : null,
      accTyp: typeof v.accTyp === "string" ? v.accTyp : null,
    };
  } catch {
    return null;
  }
}

/** Nuvama (D5/D5a): the cached session, else the pasted requestId, else the login link. */
async function pullNuvama(c: PullBrokerCtx): Promise<NextResponse | ParsedFile> {
  const secret = str(c.auth.apiSecret);
  if (!secret) {
    return NextResponse.json({ ok: false, message: "No Nuvama API secret is saved — re-save the connection with it." }, { status: 400 });
  }
  let session = cacheAlive(c) ? readNuvamaSession(c.cached) : null;
  if (!session) {
    const pasted = str(c.body.requestId);
    if (!pasted) return nuvamaNeedsLogin(c.key);
    const reqId = extractNuvamaRequestId(pasted);
    if (!reqId) {
      return NextResponse.json(
        {
          ok: false,
          message:
            "That paste carries no Nuvama request id — paste the whole address your browser landed on after the Nuvama login, or the request id alone. Nothing was pulled.",
        },
        { status: 400 },
      );
    }
    const fresh = await nuvamaLogin({ apiKey: c.key, apiSecret: secret, reqId });
    const refused = refuseForeignLogin(c, "nuvama", fresh.userId);
    if (refused) return refused;
    // The WHOLE session as ONE vault entry, with its stated end (R8).
    writePullAuth(c.conn.id, "nuvama", { nuvamaUserId: fresh.userId, tokenExpiresAt: nuvamaSessionExpiry() }, JSON.stringify(fresh));
    session = fresh;
  }
  const rows = await fetchNuvamaTrades(session, c.key);
  // R11': an AppIdKey the answer carried replaced session.appIdKey in place —
  // re-save the session so the next pull of the same session sends it.
  writePullAuth(c.conn.id, "nuvama", {}, JSON.stringify(session));
  const n = normalizeNuvamaTrades(rows, todayIstIso());
  return nuvamaToParsedFile(n.trades, n.refused, n.notes);
}

/** Kotak Neo (D4/D4a): TOTP + MPIN login at every pull, nothing cached (Angel One's precedent). */
async function pullKotak(c: PullBrokerCtx): Promise<NextResponse | ParsedFile> {
  const creds = {
    accessToken: c.key,
    mobileNumber: str(c.auth.mobileNumber),
    ucc: str(c.auth.ucc),
    mpin: str(c.auth.mpin),
    totpSecret: str(c.auth.totpSecret),
  };
  if (!creds.accessToken || !creds.mobileNumber || !creds.ucc || !creds.mpin || !creds.totpSecret) {
    return NextResponse.json(
      { ok: false, message: "The saved Kotak Neo login is incomplete — re-save the connection with the Trade API access token, mobile number, UCC, MPIN and TOTP secret." },
      { status: 400 },
    );
  }
  const session = await kotakLogin(creds);
  const n = normalizeKotakTrades(await fetchKotakTrades(session), todayIstIso());
  return kotakToParsedFile(n.trades, n.refused, n.notes);
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
      // v4.7.0 C7 (owner answer D2'): the OPTIONAL streaming address, kept in
      // the same blob. This branch rebuilds the blob whole, so an ABSENT field
      // means "keep the stored one" (a re-save must not drop it); "" (or null)
      // clears it; anything else must be ws:/wss: on the bridge's own machine,
      // checked by the one pure rule — a kept value is re-checked against the
      // host this save ends with.
      let wsUrl: string | null = null;
      try {
        if (body.wsUrl === undefined) {
          const stored = readAuthBlob(
            db
              .select({ authJson: brokerConnections.authJson })
              .from(brokerConnections)
              .where(
                and(
                  eq(brokerConnections.accountId, accountId),
                  eq(brokerConnections.broker, openAlgoConnectionId(underlyingBroker as Broker)),
                ),
              )
              .get()?.authJson,
          );
          const kept = stored.state === "ok" && typeof stored.value.wsUrl === "string" ? stored.value.wsUrl : "";
          wsUrl = kept ? normalizeOpenAlgoStreamUrl(kept, normalizedHost) : null;
        } else if (body.wsUrl !== null && String(body.wsUrl).trim() !== "") {
          wsUrl = normalizeOpenAlgoStreamUrl(String(body.wsUrl), normalizedHost);
        }
      } catch (e) {
        return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 400 });
      }
      authPlain = JSON.stringify(wsUrl ? { host: normalizedHost, underlyingBroker, wsUrl } : { host: normalizedHost, underlyingBroker });
      // The stored identity is the instance's underlying broker, so several
      // instances (one per broker) coexist as separate rows; saving the same
      // underlying again UPDATES that instance via the (account, broker) upsert.
      broker = openAlgoConnectionId(underlyingBroker as Broker);
    } else if (isPullBroker(broker)) {
      // v4.7.0 C6 — CONSENT FIRST (review R6, Dhan's pattern): the ack is
      // stamped ONLY when the client sends the version it showed AND that is
      // the server's current version; otherwise the stored ack must already be
      // current. Neither → 409 before any field is packed or anything stored.
      const storedRead = readAuthBlob(
        db
          .select({ authJson: brokerConnections.authJson })
          .from(brokerConnections)
          .where(and(eq(brokerConnections.accountId, accountId), eq(brokerConnections.broker, broker)))
          .get()?.authJson,
      );
      const stored = storedRead.state === "ok" ? storedRead.value : null;
      const shown = (body.pullConsent as { version?: unknown } | null | undefined)?.version;
      const consentNow = pullAckCurrent(broker, shown);
      if (!consentNow && !pullAckCurrent(broker, stored?.pullAckVersion)) return needsConsentResponse(broker, true);
      const packed = packAuth[broker](body as Record<string, unknown>, stored);
      if (!packed.ok) return NextResponse.json({ ok: false, message: packed.message }, { status: 400 });
      authPlain = JSON.stringify(
        mergeAuth(broker, JSON.parse(packed.authPlain!) as Record<string, unknown>, {
          pullAckVersion: consentNow ? BROKER_PULL_DISCLOSURES[broker].version : undefined,
        }),
      );
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

    // A KEPT key must still be READABLE. Carrying the stored ciphertext over
    // byte-for-byte answered "Connection saved" over a row whose key the vault
    // can no longer decrypt — and the next pull then 400s "saved credentials
    // cannot be read", pointing at a save that had just said it worked. The
    // key is only VERIFIED here (the ciphertext is still what gets stored,
    // never a re-encryption).
    if (!apiKey) {
      const kept = readSecret(existing!.apiKey);
      if (!kept.ok || !kept.value) {
        return NextResponse.json(
          {
            ok: false,
            code: "STORED_KEY_UNREADABLE",
            message: `The saved ${spec.keyLabel} can no longer be read (${kept.ok ? "it is empty" : kept.reason}) — re-enter the ${spec.keyLabel} to save this connection.`,
          },
          { status: 400 },
        );
      }
    }

    // ONE connection per broker CLIENT (4.3.0 wave 1, owner ruling R4a). The unique
    // index is (account_id, broker), so the same Dhan Client ID could be saved
    // under two accounts — and then both pull the same tradebook into two
    // books, because the dedup hash carries no account id. The check spans
    // every account deliberately (lib/import/broker-identity.ts) and runs
    // BEFORE any write: a refusal that stored the row first would be no
    // refusal at all. The identity is the credential this save would END with
    // — the typed key, or the stored one it is keeping.
    const rival = findRivalConnection({
      broker,
      apiKey: apiKey || existing?.apiKey || null,
      authJson: authPlain ?? existing?.authJson ?? null,
      accountId,
    });
    if (rival) {
      const message = rivalMessage(broker, rival.accountName);
      // `error` is the seam's field; `message` is what every existing client
      // renders. One string, so they can never disagree.
      return NextResponse.json({ ok: false, error: message, message }, { status: 409 });
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
      // D-C7-3: the INSERT stamps the same ISO instant the UPDATE below does —
      // the column's SQLite default ("YYYY-MM-DD HH:MM:SS") sorted BELOW any
      // ISO "T" stamp, so a newer connection lost "most recently updated".
      .values({ accountId, broker, apiKey: encKey, accessToken: encToken, authJson: encAuth, updatedAt: new Date().toISOString() })
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

  // C-6: the explicit clear for a kept "not fetched" notice. A route-handler
  // write the card calls with fetch + router.refresh() (AGENTS.md — never a
  // server action). It APPENDS the clear; the record it clears is not touched.
  if (body.action === "clear-unfetched") {
    const from = str(body.from);
    const to = str(body.to);
    const reason = str(body.reason);
    // H4 (v4.3.0 fix wave 2H): the card names the line's record by its
    // connection (GET's `unfetchedConnection`; null = carried by a merge), and
    // exactly that line's records are cleared — never another client's fact the
    // card did not show. A body with NO `connection` field (an older client, any
    // other caller) keeps the behaviour below: every same-span record clears.
    if ("connection" in body) {
      const connection: unknown = body.connection;
      if (connection !== null && !(typeof connection === "number" && Number.isInteger(connection) && connection > 0)) {
        return NextResponse.json(
          { ok: false, message: "The notice's connection must be a connection id or null — nothing was changed." },
          { status: 400 },
        );
      }
      // J1 (v4.3.0 fix wave 2J): a merge-carried record names NO connection, so
      // its identity is its span AND the sentences it states (I5,
      // lib/import/dhan-unfetched.ts recordKeyOf) — two books merged into one
      // target on one span are told apart by nothing else. The card sends the
      // `fact` (with its `remedy`) of the line it showed, and it is forwarded
      // verbatim: exactly that record's line is cleared, and a sentence no open
      // record holds clears nothing (the 404 below). A body WITHOUT `fact` —
      // any older client, any other caller — is passed on unchanged, so the
      // span's first record of that connection is taken, as before.
      const named =
        typeof body.fact === "string"
          ? { fact: body.fact, remedy: typeof body.remedy === "string" ? body.remedy : null }
          : {};
      const cleared = clearUnfetchedLine(
        accountId,
        { from, to, reason, connection, ...named },
        `Dhan notice cleared by the user: fills from ${from} to ${to} were not fetched by a pull.`,
      );
      if (cleared === 0) {
        return NextResponse.json(
          { ok: false, message: "That notice is not open for this account — nothing was changed." },
          { status: 404 },
        );
      }
      return NextResponse.json({
        ok: true,
        message: `Notice cleared. Fills from ${from} to ${to} are in the journal only if a Dhan tradebook for those dates has been imported.`,
      });
    }
    const open = outstandingUnfetched(accountId).find((s) => s.from === from && s.to === to && s.reason === reason);
    if (!open) {
      return NextResponse.json(
        { ok: false, message: "That notice is not open for this account — nothing was changed." },
        { status: 404 },
      );
    }
    const connRow = db
      .select({ id: brokerConnections.id })
      .from(brokerConnections)
      .where(and(eq(brokerConnections.accountId, accountId), eq(brokerConnections.broker, "dhan")))
      .get();
    const snap = { notice: DHAN_UNFETCHED_NOTICE, broker: "dhan", accountId, from, to, reason };
    recordAudit({
      entity: "settings",
      entityId: connRow?.id ?? null,
      action: "update",
      summary: `Dhan notice cleared by the user: fills from ${from} to ${to} were not fetched by a pull.`,
      before: { ...snap, clearedAt: null },
      after: { ...snap, clearedAt: new Date().toISOString() },
      source: "ui",
    });
    return NextResponse.json({
      ok: true,
      message: `Notice cleared. Fills from ${from} to ${to} are in the journal only if a Dhan tradebook for those dates has been imported.`,
    });
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
    /** C-6: Dhan history this pull did not read — kept only if it commits. */
    let unfetched: readonly DhanUnfetchedSpan[] = [];
    /** P11: the history window an UNTRUNCATED Dhan walk read in full — the
     *  page-cap spans inside it are cleared with the stamp. Null otherwise. */
    let readWindow: { from: string; to: string } | null = null;
    /** R42: this pull's lastPullAt. Dhan's is the instant fetchTrades took
     *  just before /v2/positions (`onCutoff`); every other broker's is when
     *  the pull started. Never a post-commit clock. */
    const pulledAt = new Date().toISOString();
    let cutoff = null as string | null;
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
        // W8 (v4.6.0): the version gate runs FIRST — an instance older than
        // OPENALGO_MIN_VERSION is refused for every broker, with the upgrade
        // steps (owner ruling 2026-09-25). A sandbox answer throws inside
        // fetchOpenAlgoTradebook. Both reach the user as the 502's message.
        await assertOpenAlgoVersion(creds);
        const result = normalizeOpenAlgoTrades(await fetchOpenAlgoTradebook(creds), openAlgoBroker, today);
        // v4.7.0 Q4 / review R5 (the Kite rule): a CDS / BCD fill is refused,
        // counted and named; a refused contract still OPEN in this connection's
        // account is named too — a note, never a write.
        const refusedCcy = result.refusedCurrency ?? [];
        const ccyNotes =
          refusedCcy.length > 0
            ? [
                currencyRefusalNote(refusedCcy.length, refusedCcy, "fill"),
                ...strandedCurrencyNotes(
                  refusedCcy,
                  await db.query.trades.findMany({
                    columns: { tradingsymbol: true },
                    where: (t, { and: all, eq: is, inArray }) =>
                      all(is(t.accountId, accountId), is(t.isOpen, true), inArray(t.symbol, currencyUnderlyings(refusedCcy))),
                  }),
                ),
              ]
            : [];
        parsed = openAlgoToParsedFile(openAlgoBroker, result, ccyNotes);
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
        // v4.7.0 Q4 / review R5 (the Kite rule): a CDS / BCD fill is refused,
        // counted and named; a refused contract still OPEN in this connection's
        // account is named too — a note, never a write. A refused fill is not an
        // incoming row, so today's snapshot supersede never sees it.
        const pull = normalizeAngelTrades(await fetchAngelTradeBook(creds, jwtToken), today);
        const stranded =
          pull.refusedContracts.length > 0
            ? strandedCurrencyNotes(
                pull.refusedContracts,
                await db.query.trades.findMany({
                  columns: { tradingsymbol: true },
                  where: (t, { and: all, eq: is, inArray }) =>
                    all(is(t.accountId, accountId), is(t.isOpen, true), inArray(t.symbol, currencyUnderlyings(pull.refusedContracts))),
                }),
              )
            : [];
        parsed = angelToParsedFile(pull.trades, pull.refused, [...pull.notes, ...stranded]);
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
        // CATCH-UP (4.3.0 wave 1): `/positions` is TODAY's book, so a connection
        // last pulled days ago lost every day in between — the pull fetched
        // today, stamped lastPullAt, and the gap never came back. The stored
        // stamp becomes the window [its IST day, today], clamped to
        // DHAN_MAX_PULL_RANGE_DAYS. Null (never pulled, or pulled already
        // today) leaves this pull byte-identical to every build before.
        // C-6: a clamped window (range.unfetched) and a page-capped walk
        // (onHistory) are both NAMED in the warnings, and handed back as spans.
        // R42 (v4.3.0 fix wave 1): `after` drops the history fills the last
        // pull's /positions snapshot already stored, and this pull's stamp is
        // the instant fetchTrades took before reading /positions.
        // v4.7.0 Q4 / review R5 (the Kite rule): an NSE_CURRENCY / BSE_CURRENCY
        // row — from today's positions or the catch-up history — is refused,
        // counted and named; a refused contract still OPEN in this connection's
        // account is named too — a note, never a write. A refused row is not an
        // incoming row, so today's snapshot supersede never sees it.
        const today = todayIstIso();
        const range = catchUpRange(conn.lastPullAt, today);
        let read: DhanHistoryRead | null = null;
        const ccy = { contracts: [] as string[], notes: [] as string[] };
        const trades = await source.fetchTrades({
          ...(range
            ? {
                from: range.from,
                to: range.to,
                after: catchUpAfter(conn.lastPullAt, today),
                onHistory: (h: DhanHistoryRead) => {
                  read = h;
                },
              }
            : {}),
          onCutoff: (iso) => {
            cutoff = iso;
          },
          onCurrencyRefused: (r) => {
            ccy.contracts = r.contracts;
            ccy.notes = r.notes;
          },
        });
        const stranded =
          ccy.contracts.length > 0
            ? strandedCurrencyNotes(
                ccy.contracts,
                await db.query.trades.findMany({
                  columns: { tradingsymbol: true },
                  where: (t, { and: all, eq: is, inArray }) =>
                    all(is(t.accountId, accountId), is(t.isOpen, true), inArray(t.symbol, currencyUnderlyings(ccy.contracts))),
                }),
              )
            : [];
        const pulled = dhanToParsedFile(trades, range, read, conn.lastPullAt, [...ccy.notes, ...stranded]);
        unfetched = pulled.unfetched;
        const walked = read as DhanHistoryRead | null;
        readWindow = range && walked && !walked.truncated ? { from: range.from, to: range.to } : null;
        parsed = pulled;
      } else if (broker === "upstox") {
        // apiKey holds the year-long read-only Analytics token. normalize is
        // called directly so the unparseable-symbol notes reach the screen.
        const today = todayIstIso();
        // v4.7.0 Q4 / review R5: the refusal note rides in `notes`; a refused
        // contract still OPEN in this connection's account is named too.
        const pull = normalizeUpstoxTrades(await fetchUpstoxTrades({ accessToken: keyRead.value }), today);
        const stranded =
          pull.refusedContracts.length > 0
            ? strandedCurrencyNotes(
                pull.refusedContracts,
                await db.query.trades.findMany({
                  columns: { tradingsymbol: true },
                  where: (t, { and: all, eq: is, inArray }) =>
                    all(is(t.accountId, accountId), is(t.isOpen, true), inArray(t.symbol, currencyUnderlyings(pull.refusedContracts))),
                }),
              )
            : [];
        parsed = upstoxToParsedFile({ ...pull, notes: [...pull.notes, ...stranded] });
      } else if (isPullBroker(broker)) {
        // v4.7.0 wave C6. The blob carries the secrets AND the consent, so an
        // unreadable one refuses (never a silent downgrade), and a stale or
        // absent ack refuses with 409 needsConsent BEFORE any network call.
        if (authBlob.state !== "ok") {
          return NextResponse.json(
            {
              ok: false,
              authUnreadable: authBlob.state === "unreadable",
              message: `The saved ${brokerLabel(broker)} credentials cannot be read — disconnect and save the connection again.`,
            },
            { status: 400 },
          );
        }
        if (!pullAckCurrent(broker, authBlob.value.pullAckVersion)) return needsConsentResponse(broker, false);
        const ctx: PullBrokerCtx = { conn, accountId, key: keyRead.value, auth: authBlob.value, cached: accessTokenPlain, body };
        const out = broker === "fyers" ? await pullFyers(ctx) : broker === "nuvama" ? await pullNuvama(ctx) : await pullKotak(ctx);
        if (out instanceof NextResponse) return out;
        parsed = out;
      } else {
        // Zerodha. With an api_secret saved (auth_json), the daily ritual is
        // the OFFICIAL session exchange (decision #3, NO enctoken): the user
        // logs in via their Kite Connect URL, pastes the request_token, and
        // Vyuha does checksum + /session/token. Honest framing: one browser
        // click + one paste per day — better than pasting a raw token, not
        // unattended (the broker's ~6 AM IST session invalidation).
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
          // R9 (v4.3.0 fix wave 1): R4a's one-connection-per-client refusal, at
          // the only point the Zerodha identity is known. The save cannot know
          // it (an api_key may log in several clients, DECISIONS:4852), so a
          // second account's connection for the SAME Kite user was saved as
          // {apiSecret} and then stamped below with no rival check. Refused
          // BEFORE the stamp, the token cache and the fetch. Residual: a
          // pasted-token connection never learns a user_id and cannot be
          // refused here.
          // P10 (v4.3.0 fix wave 2): only a connection saved BEFORE this one
          // (a smaller broker_connections.id) is a rival here, so of an
          // existing duplicate pair the NEWER connection is refused — R4a's
          // "refuse the second connection" — and the original keeps pulling
          // while Data Quality flags the pair (R4b).
          if (userId) {
            const rival = findRivalConnection({
              broker,
              apiKey: keyRead.value,
              authJson: JSON.stringify({ apiSecret, kiteUserId: userId }),
              accountId,
              onlyOlderThan: conn.id,
            });
            if (rival) {
              const message = rivalMessage(broker, rival.accountName);
              return NextResponse.json({ ok: false, error: message, message }, { status: 409 });
            }
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
        try {
          // v4.7.0 Q4 / review R5: the pull the Nuvama way — a CDS / BCD fill is
          // refused, counted and named in the summary, never priced as NSE. A
          // refused contract still OPEN in this connection's account (a currency
          // BUY imported before v4.7.0) is named too — a note, never a write.
          const pull = normalizeKitePull(await fetchKiteTrades({ apiKey: keyRead.value, accessToken: kiteToken }));
          const stranded =
            pull.refusedContracts.length > 0
              ? strandedCurrencyNotes(
                  pull.refusedContracts,
                  await db.query.trades.findMany({
                    columns: { tradingsymbol: true },
                    where: (t, { and: all, eq: is, inArray }) =>
                      all(is(t.accountId, accountId), is(t.isOpen, true), inArray(t.symbol, currencyUnderlyings(pull.refusedContracts))),
                  }),
                )
              : [];
          parsed = kiteToParsedFile(pull.trades, pull.refused, [...pull.notes, ...stranded]);
        } catch (e) {
          // A dead session with an api_secret on file is not an error — it is
          // the daily prompt.
          if (apiSecret && (e as Error & { kiteStatus?: number }).kiteStatus === 403) return needsLoginResponse();
          throw e;
        }
      }
    } catch (e) {
      // v4.7.0 C6 (review R8): the broker STATED the session is over. That is
      // the daily prompt, not an outage — clear the cached token / session so
      // the next pull cannot reuse it, and answer the typed 409.
      if (isPullBroker(broker) && isBrokerAuthExpired(e)) {
        if (broker !== "kotakneo") writePullAuth(conn.id, broker, { tokenExpiresAt: null }, "");
        const loginUrl =
          broker === "fyers"
            ? fyersLoginUrl({ appId: keyRead.value, redirectUri: PULL_REDIRECT_URI, state: randomUUID() })
            : broker === "nuvama"
              ? nuvamaLoginUrl(keyRead.value)
              : undefined;
        return NextResponse.json(
          { ok: false, [e.need]: true, ...(loginUrl ? { loginUrl } : {}), message: e.message },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 502 });
    }

    const stamp = cutoff ?? pulledAt;
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
      // R43 / QS-AO (4.3.0): the three pulls that state TODAY's book re-state
      // it on every pull, so a later pull the same day replaces the earlier
      // snapshot of a changed position instead of adding a second row.
      // v4.7.0 C6: the three native pulls read TODAY's book too (design D2).
      const snapshotPull =
        broker === "dhan" || broker === "angelone" || broker === "upstox" || broker === "fyers" || broker === "kotakneo" || broker === "nuvama";
      const snapshotOpts = snapshotPull ? { supersedeSnapshot: { fileName } } : {};
      // W2b (owner ruling A1, design review revision 13) — a MANUAL pull shows
      // the same per-import toggle as a file import, default unchecked, so
      // auto-close is ON unless the user asks for separate rows on this pull.
      // The flip is here at the caller; the library default stays OFF.
      const writeOpts = { ...snapshotOpts, autoClose: body.keepSellsSeparate !== true };
      const pre = previewParsedFile(parsed, null, accountId, fileName, writeOpts);
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
        if (pre.summary.total > 0 && pre.summary.newCount === 0 && pre.summary.supersededCount === 0 && body.force !== true) {
          // R27 (v4.3.0 fix wave 1): nothing new is still a successful READ.
          // Its spans and the stamp land in ONE transaction. Unstamped, the
          // inclusive window re-read the same day on every pull and the card
          // kept printing "Pulls missed since".
          try {
            keepUnfetchedAndStamp(unfetched, { connId: conn.id, accountId, source: "import" }, stamp, readWindow);
          } catch (e) {
            return unsavedNotice(e);
          }
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
        // R19 (v4.3.0 fix wave 1): the unread spans are kept FIRST, in their
        // own transaction, with a write that THROWS. The old best-effort audit
        // write could fail silently AFTER the commit while lastPullAt still
        // moved past the dates. A failure here commits nothing and leaves the
        // stamp, so the next pull recomputes both.
        try {
          keepUnfetched(unfetched, { connId: conn.id, accountId, source: "import" });
        } catch (e) {
          return unsavedNotice(e);
        }
        const result = commitParsedFile(parsed, fileName, null, accountId, writeOpts);
        // R42: the stamp is the instant taken before /v2/positions was read.
        // P11: with it, in one transaction, the clear of every page-cap span
        // this pull's untruncated walk read in full (`conn` is this account's
        // row for this broker, so its id is the row the old update named).
        keepUnfetchedAndStamp([], { connId: conn.id, accountId, source: "import" }, stamp, readWindow);
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
