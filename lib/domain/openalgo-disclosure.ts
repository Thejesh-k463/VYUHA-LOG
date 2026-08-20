// OPENALGO DISCLOSURE (PURE — data + one gate rule, no DB, no React).
//
// The OpenAlgo integration is the first thing in Vyuha that asks the user to
// run a SECOND piece of software and hand IT their broker credentials. That is
// a bigger ask than any import path, so it is off until the user reads what it
// is, what it does and what it costs them, and accepts explicitly.
//
// Everything the user is shown lives here, versioned, for three reasons:
//
//   1. The Settings card, the disclosure dialog and the Import panel all read
//      the SAME sentences — copy that is written twice drifts, and a risk
//      statement that drifts is worse than none (the import dropzone hint had
//      exactly this bug: two literal strings, five parsers, one wrong number).
//   2. The SERVER can apply the same gate the UI applies (`openAlgoGate`), so
//      hiding a button is never the only thing standing between an unread
//      disclosure and a live pull.
//   3. Consent is recorded against a VERSION. If the risks materially change,
//      bump `OPENALGO_DISCLOSURE_VERSION` and every install re-prompts instead
//      of inheriting an acceptance of an older, different statement.
//
// Voice rule, same as the rest of the product: state the refusals as design.
// Nothing here may claim accuracy the adapter does not deliver — the pull
// computes statutory charges, it does not receive them, and it covers one day.

/**
 * Bump ONLY when the risk statement materially changes — a typo fix is not a
 * new disclosure, a new risk is. Bumping re-prompts every install that had
 * accepted an older version, and until they accept, the gate is closed.
 */
export const OPENALGO_DISCLOSURE_VERSION = "1";

/** Where the user gets OpenAlgo. Shown as text, never auto-opened. */
export const OPENALGO_SITE = "https://openalgo.in";
export const OPENALGO_DOCS = "https://docs.openalgo.in";

/** The default a fresh install offers — the loopback address OpenAlgo binds. */
export const OPENALGO_DEFAULT_HOST = "http://127.0.0.1:5000";

export interface DisclosureItem {
  title: string;
  body: string;
}

/** What OpenAlgo IS. Plain, and explicit that Vyuha did not write it. */
export const OPENALGO_WHAT_IT_IS: DisclosureItem[] = [
  {
    title: "It is separate software, not part of Vyuha",
    body:
      "OpenAlgo is an open-source (AGPL-3.0) server built by a third party. You install it, run it and update it yourself, usually on this same computer. Vyuha is not affiliated with it, does not ship it, and cannot support it.",
  },
  {
    title: "It speaks to your broker so Vyuha does not have to",
    body:
      "One OpenAlgo instance is connected to one broker account. Vyuha then asks that instance for your executed trades over a normal web request to your own machine — the same shape as the Zerodha, Dhan and Angel One pulls Vyuha already does directly.",
  },
  {
    title: "Why it is worth the trouble",
    body:
      "Vyuha has direct API pulls for Zerodha, Dhan and Angel One only. Through OpenAlgo, Groww, Upstox, Paytm Money and Kotak also get a same-day pull, with no broker-specific code. Sahi has no OpenAlgo plugin and stays on file import.",
  },
];

/** What a pull actually DOES, so nobody expects a backfill. */
export const OPENALGO_WHAT_IT_DOES: DisclosureItem[] = [
  {
    title: "Pulls today's executed trades, on demand",
    body:
      "Nothing runs on a schedule and nothing happens until you press Preview or Pull. The trades go through the same classify → charges → de-duplicate → commit pipeline as a file import, so pulling twice cannot double a trade.",
  },
  {
    title: "Preview first, always",
    body:
      "Preview shows what would be imported without writing anything. Commit is a second, separate press.",
  },
  {
    title: "Vyuha stores only the OpenAlgo key and host",
    body:
      "Both are encrypted at rest with a key bound to this machine, and both are revocable from OpenAlgo's own settings without touching your broker account. Vyuha never holds a broker token for these pulls.",
  },
];

/**
 * The risks. Every one of these is a real, observed property — the quantity
 * item is OpenAlgo's own documented sample response, not a hypothetical.
 */
export const OPENALGO_RISKS: DisclosureItem[] = [
  {
    title: "Your broker credentials go into OpenAlgo, not Vyuha",
    body:
      "To use this you give OpenAlgo your broker's API access. That is a second program holding the keys to your trading account, and its security is not something Vyuha can vouch for. Read its documentation and decide for yourself.",
  },
  {
    title: "Sizes can arrive as zero, and are repaired",
    body:
      "OpenAlgo's own documented response shows a filled trade with quantity 0. Vyuha recovers the size from trade value ÷ average price, counts every repair and tells you the count — and refuses any row it cannot recover rather than importing a zero-size trade. Check repaired sizes against your contract note before you commit.",
  },
  {
    title: "Charges are computed here, not stated by the API",
    body:
      "The response carries no charge breakdown, so Vyuha's own engine computes the statutory charges. A file import that carries the broker's own figures — Paytm Money's tradebook, Dhan's transaction report — remains the more accurate source for costs.",
  },
  {
    title: "Today only — this is not a backfill",
    body:
      "The endpoint returns the current trading day. History comes from file imports; a day you forget to pull cannot be pulled later.",
  },
  {
    title: "If OpenAlgo is not running, the pull fails",
    body:
      "There is no queue and no retry. Vyuha says it could not reach the host and nothing is imported.",
  },
  {
    title: "A non-local host sends your trade data off this machine",
    body:
      "The default address is this computer, so nothing leaves it. If you point Vyuha at another machine, your trade data travels to that machine — Vyuha will say so beside the field, but it cannot stop you.",
  },
];

/** Non-negotiable, stated so the offer is not read as more than it is. */
export const OPENALGO_REFUSALS: string[] = [
  "Vyuha does not install, update, configure or support OpenAlgo.",
  "Vyuha never places, modifies or cancels an order — this reads your executed trades and nothing else.",
  "Turning this off leaves your journal exactly as it is; imported trades stay.",
];

/** True when a stored acknowledgement covers the CURRENT disclosure. */
export function isAckCurrent(ackVersion: string | null | undefined): boolean {
  return typeof ackVersion === "string" && ackVersion === OPENALGO_DISCLOSURE_VERSION;
}

export interface OpenAlgoGateState {
  enabled: boolean;
  ackVersion: string | null | undefined;
}

export interface OpenAlgoGateResult {
  allowed: boolean;
  /** Why not, in the user's words — safe to show or return as an API message. */
  reason?: string;
}

/**
 * THE gate. Both halves must hold: the switch is on AND the acceptance covers
 * the disclosure as it reads today.
 *
 * Requiring both is what makes a restored backup safe. Consent columns are
 * machine state (SETTINGS_MACHINE_COLUMNS), so a restore leaves this closed —
 * and if a future change ever let `enabled` travel, an unaccepted install
 * would still be refused here rather than pulling on someone else's consent.
 */
export function openAlgoGate(state: OpenAlgoGateState): OpenAlgoGateResult {
  if (!state.enabled) {
    return {
      allowed: false,
      reason: "The OpenAlgo integration is off. Turn it on in Settings → Integrations after reading what it does.",
    };
  }
  if (!isAckCurrent(state.ackVersion)) {
    return {
      allowed: false,
      reason:
        "The OpenAlgo disclosure has changed since you accepted it. Open Settings → Integrations and read it again to continue.",
    };
  }
  return { allowed: true };
}

/**
 * Is this host on this machine? Drives the warning beside the host field.
 *
 * Deliberately conservative: anything that is not plainly loopback counts as
 * remote, including a LAN IP. Over-warning costs a sentence; under-warning
 * would let "nothing leaves your computer" become false without anyone saying
 * so, and that promise is the product.
 */
export function isLocalOpenAlgoHost(host: string): boolean {
  const raw = String(host ?? "").trim();
  if (!raw) return false;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  // 127.0.0.0/8 — the whole loopback block, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}
