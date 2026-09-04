/**
 * DhanHQ v2 API — the ONLY source that states MTF outright.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Every Dhan *file* is silent about margin funding. A P&L statement has no
 * product column at all; a Global Transaction Report has one implicitly, in the
 * charge rates — but MTF and delivery attract identical STT and stamp duty, and
 * financing interest is a LEDGER entry that never appears on a contract note.
 * So from files alone, "was this MTF?" is unanswerable and Vyuha has to ask.
 *
 * The API answers it. `GET /v2/positions` returns a `productType` enum whose
 * values are CNC, INTRADAY, MARGIN, **MTF**, CO and BO. That is a stated fact
 * from the broker's own books — no inference, no confirmation dialog.
 *
 * ── What it can and cannot cover ──────────────────────────────────────────
 *
 * `/v2/positions` is the CURRENT day's book plus carry-forward quantities, not
 * a historical tradebook. So this is the daily pull that keeps open MTF
 * positions honest; the long history still arrives by file. The same shape as
 * the Kite integration, deliberately — one seam, two brokers.
 *
 * `normalizeDhanPositions` is pure and unit-tested; the fetch wrapper is a thin
 * authenticated GET.
 */

import { todayIstIso } from "@/lib/domain/trading-day";
import type { NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ApiImportSource, ParsedFile } from "@/lib/import/types";
import { totp } from "@/lib/totp";

/** One row from GET /v2/positions (the fields we consume). */
export interface DhanPositionRow {
  dhanClientId?: string;
  tradingSymbol: string;
  securityId?: string;
  positionType: string; // LONG | SHORT | CLOSED
  exchangeSegment: string; // NSE_EQ | BSE_EQ | NSE_FNO | MCX_COMM | …
  productType: string; // CNC | INTRADAY | MARGIN | MTF | CO | BO
  buyAvg: number;
  buyQty: number;
  sellAvg: number;
  sellQty: number;
  netQty: number;
  realizedProfit?: number;
  unrealizedProfit?: number;
  drvExpiryDate?: string | null;
  drvOptionType?: string | null;
  drvStrikePrice?: number | null;
}

/** One row from GET /v2/holdings. */
export interface DhanHoldingRow {
  exchange: string;
  tradingSymbol: string;
  securityId?: string;
  isin?: string | null;
  totalQty: number;
  availableQty?: number;
  collateralQty?: number;
  avgCostPrice: number;
}

/**
 * Map Dhan's product type onto Vyuha's hint.
 *
 * MTF is the whole point of this integration — it is the one product no Dhan
 * file can express. MARGIN (the F&O/commodity carry-forward product) returns
 * null on purpose: the classifier reads the segment off the SYMBOL, and a hint
 * would only get in the way.
 */
export function productHintOf(productType: string): ProductHint {
  switch (String(productType).toUpperCase()) {
    case "MTF":
      return "mtf";
    case "CNC":
      return "delivery";
    case "INTRADAY":
    case "CO": // cover order — always intraday
    case "BO": // bracket order — always intraday
      return "intraday";
    default:
      return null; // MARGIN and anything new: let the symbol decide
  }
}

/** `NSE_EQ` → `NSE`. Null when the segment is unrecognised, so the classifier
 *  falls back to its own default rather than trusting a bad guess. */
export function exchangeOf(segment: string): Exchange | null {
  const s = String(segment).toUpperCase();
  if (s.startsWith("NSE")) return "NSE";
  if (s.startsWith("BSE")) return "BSE";
  if (s.startsWith("MCX")) return "MCX";
  return null;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-29 14:30:00" → "2026-09-29". Dhan's equity rows carry the sentinel
 *  "0001-01-01", which is a non-date and returns null. */
function drvExpiryIso(v: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "").trim());
  if (!m) return null;
  if (Number(m[1]) < 1980) return null; // "0001-01-01" sentinel on non-derivatives
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** A derivative segment as Dhan names it. Currency segments are deliberately
 *  NOT included: Vyuha has no currency segment vocabulary, so those rows keep
 *  their raw symbol and the equity fallback until that vocabulary exists. */
function isDerivativeSegment(segment: string): boolean {
  const s = String(segment).toUpperCase();
  return s.endsWith("_FNO") || s === "MCX_COMM";
}

/**
 * Canonicalise a derivative name from Dhan's STATED drv* fields.
 *
 * The API's `tradingSymbol` is hyphenated (`SENSEX-Aug2026-78200-CE`) — a shape
 * `parseInstrumentName` does not read, so every F&O position used to fall
 * through to the equity branch and be charged at equity STT (found on the first
 * real-fills pull, 2026-08-26). Dhan states expiry, strike and option type
 * outright in `drvExpiryDate` / `drvStrikePrice` / `drvOptionType`, so the
 * canonical `OPT <SYM> <DD Mon YYYY> <STRIKE> <CE|PE>` / `FUT <SYM> <DD Mon YYYY>`
 * name is BUILT from those facts — the same convention as the Angel One tax-P&L
 * parser — never parsed out of the symbol's shape.
 *
 * Returns null when the row is not a derivative, or when the stated fields are
 * incomplete (the caller then keeps the raw symbol and says so).
 */
export function canonicalDerivativeName(r: DhanPositionRow): string | null {
  if (!isDerivativeSegment(r.exchangeSegment)) return null;
  const underlying = String(r.tradingSymbol ?? "").split("-")[0]!.trim().toUpperCase();
  const iso = drvExpiryIso(r.drvExpiryDate);
  if (!underlying || !iso) return null;
  const [y, m, d] = iso.split("-");
  const date = `${d} ${MON[Number(m) - 1]} ${y}`;

  const ot = String(r.drvOptionType ?? "").toUpperCase();
  const strike = Number(r.drvStrikePrice) || 0;
  const optionType = ot === "CALL" || ot === "CE" ? "CE" : ot === "PUT" || ot === "PE" ? "PE" : null;
  if (optionType && strike > 0) return `OPT ${underlying} ${date} ${String(strike)} ${optionType}`;
  if (!optionType || ot === "NA") return `FUT ${underlying} ${date}`;
  return null; // an option type with no strike — incomplete, refuse to guess
}

/**
 * The current mark of an OPEN position, derived from Dhan's own numbers.
 *
 * The payload has no LTP field, but it states `unrealizedProfit`, and
 * entry ± unrealised/qty IS the broker's mark (verified against Dhan's UI on
 * the real 2026-08-26 book: 1.30 / 2.90 / 38.25 reproduced exactly). This is
 * algebra on two stated facts, not an invented price — without it every open
 * position imports unvalued and asks the user for a number Dhan already sent.
 */
export function markOf(r: DhanPositionRow): number | null {
  const netQty = Number(r.netQty) || 0;
  const u = Number(r.unrealizedProfit);
  if (netQty === 0 || !Number.isFinite(u)) return null;
  return netQty > 0
    ? r2((Number(r.buyAvg) || 0) + u / netQty)
    : r2((Number(r.sellAvg) || 0) - u / Math.abs(netQty));
}

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Turn today's positions into normalized trades.
 *
 * A position with `netQty === 0` was opened and closed today, so it is a
 * completed round trip; anything else is still open and is imported as such.
 * Gross P&L is taken from Dhan's own `realizedProfit` when it is present —
 * the broker's arithmetic beats ours — and derived from the legs otherwise.
 */
export function normalizeDhanPositions(rows: DhanPositionRow[], today: string): NormalizedTrade[] {
  const out: NormalizedTrade[] = [];

  for (const r of rows) {
    const buyQty = Number(r.buyQty) || 0;
    const sellQty = Number(r.sellQty) || 0;
    if (buyQty === 0 && sellQty === 0) continue; // nothing happened

    const buyValue = r2(buyQty * (Number(r.buyAvg) || 0));
    const sellValue = r2(sellQty * (Number(r.sellAvg) || 0));
    const closed = buyQty === sellQty && buyQty > 0;

    const gross =
      r.realizedProfit != null && Number.isFinite(Number(r.realizedProfit))
        ? r2(Number(r.realizedProfit))
        : closed
          ? r2(sellValue - buyValue)
          : 0;

    // Derivatives get the canonical OPT/FUT name built from Dhan's stated drv*
    // fields; a derivative row whose facts are incomplete keeps its raw symbol
    // and SAYS SO rather than silently classifying as equity.
    const canonical = canonicalDerivativeName(r);
    const unclassifiable = !canonical && isDerivativeSegment(r.exchangeSegment);
    const notes: string[] = [];
    if (productHintOf(r.productType) === "mtf") notes.push("Product stated by the Dhan API as MTF — not inferred.");
    if (unclassifiable)
      notes.push(
        `Dhan marked ${r.tradingSymbol} as F&O but stated no usable expiry/strike — imported with its raw name; check its segment.`,
      );

    out.push({
      broker: "dhan",
      tradingsymbol: canonical ?? r.tradingSymbol,
      isin: null,
      buyQty,
      avgBuyPrice: r2(Number(r.buyAvg) || 0),
      buyValue,
      sellQty,
      avgSellPrice: r2(Number(r.sellAvg) || 0),
      sellValue,
      // The broker's own mark for an open position (entry ± unrealised/qty);
      // null for closed rows and when Dhan states no unrealised figure.
      closingPrice: markOf(r),
      grossPnl: gross,
      unrealisedPnl: r2(Number(r.unrealizedProfit) || 0),
      // Positions are the CURRENT day's book, so today is the honest date.
      buyDate: buyQty > 0 ? today : null,
      sellDate: closed ? today : null,
      productHint: productHintOf(r.productType),
      exchangeHint: exchangeOf(r.exchangeSegment),
      sourceFile: "dhan-api",
      // The positions endpoint carries no fill times — only aggregates.
      entryTime: null,
      exitTime: null,
      importNotes: notes.length ? notes : null,
    });
  }

  return out;
}

export interface DhanCredentials {
  /** Dhan client ID (stored in broker_connections.api_key). */
  clientId: string;
  /** A pasted 24h JWT from the Dhan developer console — the fallback mode,
   *  and the only mode for legacy connections saved before PIN+TOTP existed. */
  accessToken?: string;
  /** Unattended-auth extras (one encrypted JSON blob in auth_json, the Angel
   *  One pattern): when BOTH are present, the day's token is MINTED at pull
   *  time from PIN + a freshly computed TOTP code. */
  pin?: string;
  totpSecret?: string;
}

/**
 * The Dhan PIN+TOTP consent version the save route stamps into auth_json as
 * `totpAckVersion`, and the version an enrolment must MEET to count as
 * enrolled. It lives here, next to `dhanTotpEnrolled`, so that bumping it
 * actually invalidates older acknowledgements: the check used to be the
 * literal `>= 1`, so raising the route's copy of the constant left every v1
 * blob "enrolled" and the re-consent never happened. MUST equal
 * DHAN_TOTP_CONSENT_VERSION exported next to the consent copy in
 * components/import/broker-connect.tsx (a "use client" module this one cannot
 * import — tests/broker-auth-gate.test.ts pins the two to the same number).
 */
export const DHAN_TOTP_ACK_VERSION = 1;

/**
 * Is this auth_json blob a COMPLETE Dhan unattended-auth enrollment?
 *
 * Complete means pin + totpSecret + a recorded consent (`totpAckVersion`,
 * stamped by the save route only when the user sent the explicit
 * `dhanTotpConsent` acknowledgement — components/import/broker-connect.tsx
 * exports the consent copy and DHAN_TOTP_CONSENT_VERSION). A legacy-shaped
 * blob with pin + totpSecret but NO ack is treated as NOT enrolled: the mint
 * path is skipped (pulls fall back to the pasted token) and auto-pull calls it
 * ineligible — a credential stored without its recorded consent must not keep
 * working as if the consent existed.
 */
export function dhanTotpEnrolled(
  auth: { pin?: string; totpSecret?: string; totpAckVersion?: number } | null | undefined,
  required: number = DHAN_TOTP_ACK_VERSION,
): boolean {
  return Boolean(auth?.pin && auth?.totpSecret && Number(auth.totpAckVersion) >= required);
}

/** The generateAccessToken URL, built pure so tests can pin its shape.
 *  The endpoint takes everything as query parameters and no auth headers. */
export function dhanAuthUrl(clientId: string, pin: string, totpCode: string): string {
  const q = new URLSearchParams({ dhanClientId: clientId, pin, totp: totpCode });
  return `https://auth.dhan.co/app/generateAccessToken?${q.toString()}`;
}

/**
 * The `exp` claim of a JWT as epoch MILLISECONDS, or null when the token is
 * not a decodable JWT or carries no finite exp (refuse to guess).
 *
 * RFC 7519 says `exp` is seconds, but a millisecond `exp` is a common issuer
 * slip and the old `exp * 1000` comparison read one as alive for ~50,000
 * years — a revoked token then looked reusable forever. Any `exp` above 1e11
 * (seconds would put that in the year 5138) is treated as milliseconds.
 */
function jwtExpMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp)) return null;
    return exp > 1e11 ? exp : exp * 1000;
  } catch {
    return null;
  }
}

/** The JWT's own expiry as an ISO timestamp, for display ("pasted token ·
 *  expires …"); null when unreadable. Never returns any other claim. */
export function jwtExpiresAt(token: string): string | null {
  const ms = jwtExpMs(token);
  return ms == null ? null : new Date(ms).toISOString();
}

/** Does this JWT's own `exp` claim say it is still alive? Used only to decide
 *  whether a stored pasted token is worth FALLING BACK on after a failed mint —
 *  an unreadable token counts as expired (refuse to guess). */
export function jwtLooksUnexpired(token: string, nowMs: number = Date.now()): boolean {
  const ms = jwtExpMs(token);
  return ms != null && ms > nowMs;
}

/**
 * Mint a fresh 24h access token from PIN + TOTP (the code is computed HERE, at
 * call time, from the enrolled secret — lib/totp.ts, no dependency).
 *
 * LIVE-VERIFIED 2026-09-02 on the owner's real account (API-key mode active
 * at web.dhan.co): mint → preview → cached-token commit all succeeded, 5
 * trades landed. Two behaviors Dhan's docs never state, found on that run:
 * auth failures arrive as HTTP 200 with {"message","status":"error"}, and
 * minting is limited to once per 2 minutes — hence the reuse-first resolver
 * below. Whether the flow also works with API-key mode OFF remains untested
 * (irrelevant in practice; the generic-400 hint stays for that case).
 */
export async function mintDhanAccessToken(creds: { clientId: string; pin: string; totpSecret: string }): Promise<string> {
  const code = totp(creds.totpSecret);
  const res = await fetch(dhanAuthUrl(creds.clientId, creds.pin, code), { method: "POST", cache: "no-store" });
  const json = (await res.json().catch(() => null)) as
    | { accessToken?: string; errorMessage?: string; message?: string }
    | null;
  if (!res.ok) {
    const msg = json?.errorMessage ?? json?.message ?? `HTTP ${res.status}`;
    const hint = /totp|otp/i.test(msg)
      ? " (TOTP rejected — check the enrolled secret and that this machine's clock is right; a drifted clock produces valid-looking wrong codes.)"
      : /pin/i.test(msg)
        ? " (PIN rejected — the Dhan login PIN, not the account password.)"
        : res.status === 400
          ? " (Dhan refused the request — if the PIN and TOTP secret are right, check that Trading APIs are enabled for this account at web.dhan.co; whether that toggle is required for token minting is unverified.)"
          : "";
    throw new Error(`Dhan generateAccessToken: ${msg}${hint}`);
  }
  const token = json?.accessToken;
  if (!token) {
    // LIVE-VERIFIED 2026-09-02 on the owner's account: Dhan answers auth
    // failures as HTTP 200 with {"message": "...", "status": "error"} — an
    // error-in-200 envelope ("Invalid TOTP", "Token can be generated once
    // every 2 minutes."). Surface that message with the matching hint; for
    // anything shapeless, echo the body (it is Dhan's own response and cannot
    // contain the user's PIN or secret).
    const msg = json?.errorMessage ?? json?.message;
    if (msg) {
      const hint = /once every|minute/i.test(msg)
        ? " (Dhan mints at most one token per 2 minutes — Vyuha reuses the day's token once minted, so this clears on its own; retry shortly.)"
        : /totp|otp/i.test(msg)
          ? " (TOTP rejected — check the enrolled secret and that this machine's clock is right; a drifted clock produces valid-looking wrong codes.)"
          : /pin/i.test(msg)
            ? " (PIN rejected — the Dhan login PIN, not the account password.)"
            : "";
      throw new Error(`Dhan generateAccessToken: ${msg}${hint}`);
    }
    const body = json ? JSON.stringify(json).slice(0, 300) : "(not JSON)";
    throw new Error(`Dhan generateAccessToken: HTTP ${res.status} but no accessToken in the response — body: ${body}`);
  }
  return token;
}

/**
 * The access token a pull should use, in order of honesty:
 *
 *   1. PIN + TOTP secret present → MINT a fresh 24h token (stateless, per
 *      pull — at one pull a day, caching the minted JWT in the DB buys
 *      nothing; if pull frequency ever rises, cache it with its expiryTime
 *      in broker_connections.access_token instead).
 *
 *   ^ That comment aged fast. LIVE-VERIFIED 2026-09-02: Dhan rate-limits
 *   generateAccessToken to ONCE PER 2 MINUTES ("Token can be generated once
 *   every 2 minutes.", in an error-in-200 envelope) — and preview → commit is
 *   always inside that window, so mint-per-call broke commit on the first
 *   real run. The order is therefore:
 *
 *   1. A stored token whose own `exp` says it is alive → USE IT (it is either
 *      today's minted token or a user-pasted one; both die within 24h and
 *      jwtLooksUnexpired reads the JWT itself).
 *   2. PIN + TOTP secret present → mint, and return `minted: true` so the
 *      caller PERSISTS it into broker_connections.access_token (the route
 *      owns that write via the vault) — the very next call then takes path 1.
 *   3. Mint failed → throw with guidance naming both ways out.
 */
export async function resolveDhanAccessToken(creds: DhanCredentials): Promise<{ token: string; minted: boolean }> {
  const canMint = Boolean(creds.pin && creds.totpSecret);
  // Paste-only mode returns the stored token UNTOUCHED even when unreadable —
  // Dhan's own 401 (with the 24-hour hint) is the honest judge there, exactly
  // as before the caching change. Mint mode reuses only a token whose own
  // `exp` says it is alive.
  if (creds.accessToken && (jwtLooksUnexpired(creds.accessToken) || !canMint)) {
    return { token: creds.accessToken, minted: false };
  }
  if (!canMint) {
    throw new Error("Dhan: no access token saved and no PIN + TOTP secret to mint one — reconnect Dhan with either.");
  }
  try {
    const token = await mintDhanAccessToken({ clientId: creds.clientId, pin: creds.pin!, totpSecret: creds.totpSecret! });
    return { token, minted: true };
  } catch (e) {
    throw new Error(
      `${(e as Error).message} No unexpired stored token to fall back on — fix the PIN/TOTP secret, or paste a fresh 24-hour token from web.dhan.co → DhanHQ Trading APIs.`,
    );
  }
}

/**
 * Does the REFUSAL itself name an authentication failure?
 *
 * 401 always does. A 403 does NOT by itself: Dhan answers a permissions
 * problem (a segment or data API the account is not subscribed to) with 403
 * too, and treating that as "token expired" burned the one mint allowed per 2
 * minutes on a token that was never the problem — and then told the user to
 * check a token that was fine. So a 403 counts only when the body states one
 * of Dhan's own authentication error codes (DH-901 Invalid_Authentication,
 * DH-902 Invalid_Access) or the matching errorType.
 */
function namesAuthFailure(status: number, json: unknown): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  const o = json as { errorCode?: unknown; internalErrorCode?: unknown; errorType?: unknown } | null;
  const code = String(o?.errorCode ?? o?.internalErrorCode ?? "").toUpperCase();
  const type = String(o?.errorType ?? "").toLowerCase();
  return /^DH-?90[12]$/.test(code) || /invalid[_ -]?(authentication|access)\b/.test(type);
}

/** The auth hint, shared by the first refusal and the post-retry one. It is
 *  attached only when the refusal actually names an authentication failure —
 *  a bare permissions 403 gets Dhan's own message and no token advice. */
function dhanApiError(status: number, json: unknown): Error {
  const msg =
    (json as { errorMessage?: string; message?: string } | null)?.errorMessage ??
    (json as { message?: string } | null)?.message ??
    `HTTP ${status}`;
  return new Error(
    `Dhan API: ${msg}${
      namesAuthFailure(status, json)
        ? " (access token expired or wrong? Pasted Dhan tokens from web.dhan.co → DhanHQ Trading APIs last 24 hours; with PIN + TOTP saved, Vyuha mints a fresh one at every pull instead.)"
        : status === 403
          ? " (Dhan refused this request as forbidden without naming an authentication failure — check that this account is enabled for the data/segment being pulled; the access token is not necessarily the problem.)"
          : ""
    }`,
  );
}

async function dhanGetRaw(path: string, accessToken: string): Promise<{ res: Response; json: unknown }> {
  const res = await fetch(`https://api.dhan.co/v2${path}`, {
    headers: {
      "Content-Type": "application/json",
      "access-token": accessToken,
    },
    cache: "no-store",
  });
  const json = (await res.json().catch(() => null)) as unknown;
  return { res, json };
}

/**
 * One authenticated GET, with the token resolved reuse-first (see
 * resolveDhanAccessToken) and ONE retry on a refusal that NAMES an
 * authentication failure (401, or a 403 carrying DH-901/DH-902 — see
 * namesAuthFailure; a bare permissions 403 must not spend the mint):
 *
 * A stored token can be REVOKED while its own `exp` still says alive (the user
 * regenerated it at web.dhan.co, or Dhan invalidated the session). Reuse-first
 * then sends a dead token and, before this retry existed, the whole pull
 * failed with the 24-hour hint even though PIN + TOTP could have minted a live
 * one. So: when the request used a REUSED token and the enrolment is present,
 * drop that token, mint once, persist the mint (`onMinted`), and retry once.
 * A 401 on the freshly minted token, or on the retry, surfaces the hint as
 * before. Paste-only mode never mints — Dhan's own 401 stays the judge there.
 */
async function dhanGet<T>(path: string, creds: DhanCredentials, onMinted?: (token: string) => void): Promise<T> {
  const { token, minted } = await resolveDhanAccessToken(creds);
  if (minted) {
    creds.accessToken = token; // the in-process cache — the next call reuses instead of re-minting
    onMinted?.(token);
  }
  let r = await dhanGetRaw(path, token);
  const rejected = namesAuthFailure(r.res.status, r.json);
  const canMint = Boolean(creds.pin && creds.totpSecret);
  if (!r.res.ok && rejected && !minted && canMint) {
    let fresh: string;
    try {
      fresh = await mintDhanAccessToken({ clientId: creds.clientId, pin: creds.pin!, totpSecret: creds.totpSecret! });
    } catch (e) {
      throw new Error(`${dhanApiError(r.res.status, r.json).message} Re-minting after that rejection also failed: ${(e as Error).message}`);
    }
    creds.accessToken = fresh;
    onMinted?.(fresh);
    r = await dhanGetRaw(path, fresh);
  }
  if (!r.res.ok) throw dhanApiError(r.res.status, r.json);
  // Dhan returns a bare array on success for these endpoints.
  return r.json as T;
}

/**
 * `onMinted` fires when the call had to mint a fresh token (PIN+TOTP mode —
 * including the one-shot re-mint after a 401 on a reused token) so the caller
 * can PERSIST it — Dhan mints at most one token per 2 minutes
 * (live-verified 2026-09-02), so an unpersisted mint breaks the very next
 * call (preview → commit). The route stores it encrypted via the vault.
 */
export async function fetchDhanPositions(creds: DhanCredentials, onMinted?: (token: string) => void): Promise<DhanPositionRow[]> {
  const data = await dhanGet<DhanPositionRow[] | null>("/positions", creds, onMinted);
  return Array.isArray(data) ? data : [];
}

export async function fetchDhanHoldings(creds: DhanCredentials, onMinted?: (token: string) => void): Promise<DhanHoldingRow[]> {
  const data = await dhanGet<DhanHoldingRow[] | null>("/holdings", creds, onMinted);
  return Array.isArray(data) ? data : [];
}

export function dhanImportSource(creds: DhanCredentials, onMinted?: (token: string) => void): ApiImportSource {
  return {
    id: "dhan-api",
    label: "Dhan API (today's positions, states MTF outright)",
    broker: "dhan",
    kind: "api",
    async fetchTrades() {
      const today = todayIstIso();
      return normalizeDhanPositions(await fetchDhanPositions(creds, onMinted), today);
    },
  };
}

/** Wrap an API pull in the ParsedFile shape the preview/commit pipeline expects. */
export function toParsedFile(trades: NormalizedTrade[]): ParsedFile {
  const mtf = trades.filter((t) => t.productHint === "mtf").length;
  const warnings: string[] = [];

  if (trades.length === 0) {
    warnings.push(
      "Dhan returned no positions — /v2/positions covers the current trading day's book, so it is empty outside market hours with nothing carried forward.",
    );
  } else if (mtf > 0) {
    warnings.push(
      `${mtf} position${mtf === 1 ? " is" : "s are"} MTF according to Dhan itself. This is the one product no Dhan file can identify, so these need no confirmation.`,
    );
  } else {
    warnings.push(
      "No MTF positions in today's book. Product types here are stated by the broker, not inferred from charges.",
    );
  }

  return { sourceId: "dhan-api", broker: "dhan", format: "api", trades, warnings };
}
