// BROKER PULL DISCLOSURES (PURE — data + one gate rule, no DB, no React).
//
// v4.7.0 wave C6 (design D9, review R6): Fyers, Kotak Neo and Nuvama get a
// native read-only pull, and each stores a different set of secrets and calls a
// different host at a different time. So each has ONE consent sheet with ONE
// ack version, in the house pattern of lib/domain/openalgo-disclosure.ts and
// lib/domain/telegram-disclosure.ts:
//
//   1. The connect card, the consent sheet and the server-side check read the
//      SAME sentences — copy written twice drifts.
//   2. The SAVE route stamps the ack only when the client sends the version it
//      SHOWED and that version equals the server constant (Dhan's pattern), and
//      the pull refuses a stale ack — `pullAckCurrent()` is that comparison.
//   3. Bump a `version` ONLY when that broker's statement materially changes,
//      or a sentence already accepted stops being true. v4.7.0 is unreleased,
//      so until it ships these v1 sheets may be amended without a bump.
//
// Voice rule: state what happens, plainly. Nothing here describes what a trade
// "would have" made — a pull reads what happened, nothing else.

/** The label every unverified pull carries until the owner's first live pull is
 *  recorded (ruling B2 for Kotak; owner answer Q4 for Fyers and Nuvama). The
 *  three pull modules put it in every pulled trade's notes — one string. */
export const PULL_UNVERIFIED_LABEL = "documented, not yet verified with a real account";

/** Owner answer Q5 (DECISIONS 2026-10-04) — on every pulled Kotak trade. */
export const KOTAK_TRADE_API_BROKERAGE_NOTE =
  "If you placed this order through Kotak's Trade API, Kotak charged ₹0 brokerage; Vyuha cannot tell from the fill, so your plan's brokerage is shown.";

export interface BrokerPullDisclosure {
  version: number;
  title: string;
  items: readonly string[];
}

export type BrokerPullDisclosureId = "fyers" | "kotakneo" | "nuvama";

/** The pulls still carrying `PULL_UNVERIFIED_LABEL`. A broker leaves this list
 *  in the patch that records the owner's first live pull — and only then is it
 *  counted in the marketed "N broker-API pulls" (landing page, pricing
 *  comparison; DECISIONS 2026-10-04 "v4.7.0 wave C6 BUILT": an unverified pull
 *  is offered in the app, never advertised). */
export const UNVERIFIED_PULL_BROKERS: readonly string[] = ["fyers", "kotakneo", "nuvama"];

export const BROKER_PULL_DISCLOSURES = {
  fyers: {
    version: 1,
    title: "Before you connect Fyers",
    items: [
      "Stored on this machine: your Fyers App ID and App Secret, encrypted with a key bound to this computer. On a day you pull, the day's access token is kept the same way until Fyers ends it at the close of that day.",
      "A browser login on each day you pull; nothing else is stored. Your Fyers password and PIN are typed into Fyers' own page, never into Vyuha.",
      "Vyuha calls api-t1.fyers.in only when you pull — never in the background, and never at launch.",
      "What comes back is today's fills only. Vyuha stores the trades it reads from them, never the raw response.",
      "The pull only reads. Vyuha's Fyers code contains no order, modify or funds call.",
      `Fyers' trade-book format is ${PULL_UNVERIFIED_LABEL}: check the first pulls against your contract note.`,
    ],
  },
  kotakneo: {
    version: 1,
    title: "Before you connect Kotak Neo",
    items: [
      "Stored on this machine: your Neo Trade API access token, mobile number, UCC, MPIN and TOTP secret, encrypted with a key bound to this computer. Storing the TOTP secret and MPIN is what lets a pull log in without you — so pulls run unattended.",
      "Each pull logs in afresh at mis.kotaksecurities.com and reads the trade book from the address Kotak names for that session (always a kotaksecurities.com host; Vyuha refuses any other). Nothing from the session is kept.",
      "Vyuha calls Kotak only when you pull — and, if you switch on the once-a-day auto-pull, once at launch.",
      "What comes back is today's fills only. Vyuha stores the trades it reads from them, never the raw response.",
      KOTAK_TRADE_API_BROKERAGE_NOTE,
      "The pull only reads. Vyuha's Kotak code contains no order, modify or funds call.",
      `Kotak Neo's trade-book format is ${PULL_UNVERIFIED_LABEL}: check the first pulls against your contract note.`,
    ],
  },
  nuvama: {
    version: 1,
    title: "Before you connect Nuvama",
    items: [
      "Stored on this machine: your Nuvama API key and API secret, encrypted with a key bound to this computer. After a login, the session Nuvama returns is kept the same way until it ends.",
      "The API secret is sent to Nuvama as a password field over HTTPS at each login, as Nuvama's own SDK does.",
      "A browser login when your Nuvama session has ended; you paste back the address Nuvama sends you to.",
      "Vyuha calls nc.nuvamawealth.com only when you pull — never in the background, and never at launch.",
      "Nuvama's documentation marks a static IP as mandatory and does not exempt read-only calls — a pull from a home connection may be refused.",
      "Vyuha does not look up or send your public IP address; it adds no service to find it.",
      "What comes back is today's fills only. Vyuha stores the trades it reads from them, never the raw response.",
      "The pull only reads. Vyuha's Nuvama code contains no order, modify or funds call.",
      `Nuvama's trade-book format is ${PULL_UNVERIFIED_LABEL}: check the first pulls against your contract note.`,
    ],
  },
} as const satisfies Record<BrokerPullDisclosureId, BrokerPullDisclosure>;

/** True when a stored ack covers this broker's sheet AS IT READS TODAY (`===`,
 *  so a stored older version, a string, null or an unknown broker are all false). */
export function pullAckCurrent(broker: string, version: unknown): boolean {
  if (!Object.prototype.hasOwnProperty.call(BROKER_PULL_DISCLOSURES, broker)) return false;
  return typeof version === "number" && version === BROKER_PULL_DISCLOSURES[broker as BrokerPullDisclosureId].version;
}
