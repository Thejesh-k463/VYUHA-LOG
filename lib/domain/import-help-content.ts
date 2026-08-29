// IMPORT HELP CONTENT (PURE — data only).
//
// One card per import path. The file-format rows are BUILT from
// `lib/import/registry-meta.ts` — the client-safe leaf of the parser registry —
// so this screen can never advertise a format the app does not read (the same
// promise `tests/import-registry.test.ts` pins for the dropzone). NEVER import
// `lib/import/detect.ts` here: it statically imports every parser and drags
// papaparse and the 399 KB xlsx module into the client bundle.
//
// The download steps and API notes are hand-written and dated ("as of Aug
// 2026"), the way docs/BROKER_FORMATS.md dates its verifications. Voice rules
// as everywhere else: say what each path does, name its honesty rules, never
// oversell — `tests/import-help-content.test.ts` holds the copy to the same
// banned-claims list as the demo video.
//
// The per-broker OpenAlgo sections state which paths Vyuha has exercised LIVE
// (Dhan and Upstox, Aug 2026) and which are documented from OpenAlgo's own
// docs but not yet exercised — the same honesty rule as everywhere else: a
// verified fact is dated, an unverified one is labelled.

import { IMPORT_SOURCES, type ImportSourceMeta } from "@/lib/import/registry-meta";

export type ImportChannel = "files" | "api" | "openalgo";

export interface ImportHelpCard {
  id: string;
  title: string;
  /** One line shown while the card is collapsed. */
  summary: string;
  /** Which paths this card offers — rendered as chips. */
  channels: ImportChannel[];
  /** File formats Vyuha reads — pulled from the registry, never hand-written. */
  formats: ImportSourceMeta[];
  /** Where to download / how to set up, hand-written and dated. */
  steps: string[];
  /** The API connection, reusing the verified copy from the connect card. */
  api?: string[];
  /** This broker's OpenAlgo delta — the .env lines and portal steps that
   *  differ per broker, each labelled verified-live or documented-only. */
  openalgo?: string[];
  /** Honesty notes and field-tested troubleshooting. */
  notes?: string[];
  /** Pointer to the step-by-step guide in the client package. Rendered as
   *  selectable text naming the files — never a link: desktop-webview anchors
   *  are inert, and the files live in the buyer's own download, not on a URL. */
  guide?: { intro: string; files: string[] };
}

/** Resolve registry entries by id — throws on a typo so a card can never
 *  silently describe zero formats. */
function sources(...ids: string[]): ImportSourceMeta[] {
  return ids.map((id) => {
    const s = IMPORT_SOURCES.find((x) => x.sourceId === id);
    if (!s) throw new Error(`unknown import source: ${id}`);
    return s;
  });
}

/** Every OpenAlgo-relevant card ends at the same two client-package files. */
const OPENALGO_GUIDE: NonNullable<ImportHelpCard["guide"]> = {
  intro:
    "The full OpenAlgo walkthrough — every portal page, every .env line, per broker — ships inside your client package as:",
  files: ["OPENALGO_SETUP_GUIDE.html", "OPENALGO_SETUP_GUIDE.docx"],
};

export const IMPORT_HELP_CARDS: ImportHelpCard[] = [
  {
    id: "zerodha",
    title: "Zerodha",
    summary: "Tradebook and Console P&L by file; today's executions over Kite Connect or OpenAlgo.",
    channels: ["files", "api", "openalgo"],
    formats: sources("zerodha"),
    steps: [
      "As of Aug 2026: log in at console.zerodha.com → Reports → Tradebook, pick the segment and date range, and download the file. The P&L statement is under Reports → P&L.",
      "The tradebook carries no charge columns — charges come from the Console P&L or a contract note, and Vyuha computes them from your rate card either way.",
    ],
    api: [
      "Kite Connect pulls today's executions, with fill times, through the normal classify → charges → dedup pipeline (re-pulls are idempotent).",
      "Needs a Kite Connect app and the day's access token — tokens expire every trading day, so this is a per-day paste, not a set-and-forget.",
      "The credentials are stored encrypted at rest with a machine-bound key and sent nowhere except to Zerodha itself.",
    ],
    openalgo: [
      "As of Aug 2026: OpenAlgo drives Zerodha through the same kind of Kite Connect app (developers.kite.trade) — its key and secret go into the instance's .env, with the app's redirect URL pointed at your instance.",
      "Kite's daily request-token redirect still happens — but inside OpenAlgo's own login page, once a day on the dashboard, instead of a token paste into Vyuha.",
      "Documented but not yet exercised by Vyuha: this path follows OpenAlgo's own broker docs. Vyuha's live OpenAlgo pulls have run against Dhan and Upstox (Aug 2026); for Zerodha, the Kite Connect path above is the one Vyuha has verified.",
    ],
    guide: OPENALGO_GUIDE,
  },
  {
    id: "dhan",
    title: "Dhan",
    summary: "Transaction report and P&L by file; today's positions — and MTF, stated — over the API or OpenAlgo.",
    channels: ["files", "api", "openalgo"],
    formats: sources("dhan-gtr", "dhan-csv"),
    steps: [
      "As of Aug 2026: web.dhan.co → Statements & Reports — the Global Transaction Report and the P&L report both download as CSV. Dhan ledger files import separately on the Cash & Ledger screen, including the broker's weekly MTF interest postings.",
    ],
    api: [
      "Pulls today's positions with your Client ID and an access token from web.dhan.co → DhanHQ Trading APIs; the token lasts 24 hours by default.",
      "The API is the only Dhan source that states MTF. No Dhan file can: a P&L export has no product column, and in a transaction report an MTF position carries exactly the same STT and stamp duty as delivery while the financing interest sits in the ledger.",
      "The credentials are stored encrypted at rest with a machine-bound key and sent nowhere except to Dhan itself.",
    ],
    openalgo: [
      "As of Aug 2026: Dhan's .env line is a composite — BROKER_API_KEY is your Dhan client id and API key joined as clientid:::apikey (three colons, one value). The key itself appears on web.dhan.co only after you switch your profile to API-Key Mode.",
      "Verified live by Vyuha (Aug 2026): a Dhan OpenAlgo instance was set up and pulled end to end. If you already use the native Dhan API above, OpenAlgo adds nothing for Dhan — it earns its keep when one bridge serves several brokers.",
    ],
    guide: OPENALGO_GUIDE,
  },
  {
    id: "groww",
    title: "Groww",
    summary: "Stocks P&L and order history by file; same-day pulls only through OpenAlgo.",
    channels: ["files", "openalgo"],
    formats: sources("groww-xlsx", "groww-orders"),
    steps: [
      "As of Aug 2026: Groww (app or web) → your account → Reports → Stocks — the Stocks P&L statement and the Order History both download as XLSX.",
      "The order history has no price column (price is derived as value ÷ quantity) and no charges at all — charges come from the P&L statement or a contract note.",
    ],
    openalgo: [
      "As of Aug 2026: Groww issues its API credentials as a generated token pair from its own portal — there is no developer app to create. The pair goes straight into the instance's .env.",
      "Groww additionally requires a STATIC IP registered with them before the tokens work at all. On a home connection whose address changes, the OpenAlgo login fails until the new IP is registered — that is Groww's rule, not a bug in the bridge.",
      "Documented but not yet exercised by Vyuha: this path follows OpenAlgo's own broker docs. Vyuha's live OpenAlgo pulls have run against Dhan and Upstox (Aug 2026).",
    ],
    notes: [
      "Groww has no import API of its own — the same-day pull runs through OpenAlgo. See the two OpenAlgo cards below.",
      "No Groww file states MTF, so MTF is asked at import, never guessed.",
    ],
    guide: OPENALGO_GUIDE,
  },
  {
    id: "angelone",
    title: "Angel One",
    summary: "Tradebook and Tax P&L by file; unattended same-day pulls over SmartAPI, or through OpenAlgo.",
    channels: ["files", "api", "openalgo"],
    formats: sources("angelone", "angelone-taxpnl"),
    steps: [
      "As of Aug 2026: Angel One (web or app) → Reports → Tradebook / P&L for the regular exports; the Tax P&L (XLSX) is under the tax reports.",
      "The Tax P&L carries an explicit MTF Qty column — the only examined broker file that states MTF directly, so a stated figure is read, not inferred.",
    ],
    api: [
      "SmartAPI pulls today's fills from the trade book — and nothing expires on you: the login runs unattended from your TOTP secret (the base32 string behind the enrollment QR, not the 6-digit code).",
      "Register an app at smartapi.angelone.in. You need four things: the API key, your client code, your PIN and the TOTP secret. Free — SmartAPI has no subscription.",
      "All four credentials are stored encrypted at rest with a machine-bound key and never leave this machine except to Angel One itself.",
    ],
    openalgo: [
      "As of Aug 2026: the instance's .env takes your SmartAPI key as BROKER_API_KEY — and BROKER_API_SECRET is genuinely UNUSED for Angel One, because the login exchanges your TOTP instead of a secret. The redirect callback path is \"angel\".",
      "Documented but not yet exercised by Vyuha: this path follows OpenAlgo's own broker docs. Vyuha's live OpenAlgo pulls have run against Dhan and Upstox (Aug 2026); for Angel One, the SmartAPI path above is the one Vyuha has verified.",
    ],
    guide: OPENALGO_GUIDE,
  },
  {
    id: "upstox",
    title: "Upstox",
    summary: "Trade report and realised P&L by file; a year-long read-only Analytics token for the API, or OpenAlgo.",
    channels: ["files", "api", "openalgo"],
    formats: sources("upstox"),
    steps: [
      "As of Aug 2026: account.upstox.com → Reports — the trade report and the realised P&L download as XLSX. The filenames name no broker; Vyuha recognises the files by the legal name inside them.",
    ],
    api: [
      "Pulls today's fills using the Analytics token — it lasts a year and is read-only by design (it cannot place orders, even in principle).",
      "Two one-time steps at account.upstox.com → Apps: generate the Analytics token, and register your current IPv4 address under Static IPs — Upstox answers account APIs only from that address, so if pulls ever start failing with a 401, your connection's IP changed: re-register it there.",
      "The token is stored encrypted at rest with a machine-bound key and sent nowhere except to Upstox itself.",
    ],
    openalgo: [
      "As of Aug 2026: OpenAlgo needs its own Upstox developer app, created at account.upstox.com — the Analytics token above will not do. Set the app's redirect URL to your instance's /upstox/callback and put the app's key and secret in the .env.",
      "Verified live by Vyuha (Aug 2026): an Upstox OpenAlgo instance — the second instance on the same machine — was set up and pulled end to end against a real account.",
    ],
    notes: [
      "Honesty note: the file layouts are verified against real exports (2026-08-20), but those files carried no data rows — so value behaviour is inferred until a populated export is seen. Check your first file import against a contract note.",
    ],
    guide: OPENALGO_GUIDE,
  },
  {
    id: "paytm",
    title: "Paytm Money",
    summary: "The richest tradebook of the examined brokers by file; same-day pulls only through OpenAlgo.",
    channels: ["files", "openalgo"],
    formats: sources("paytm-tradebook"),
    steps: [
      "As of Aug 2026: Paytm Money (web or app) → Statements & Reports → Tradebook — downloads as Tradebook_EQ.xlsx.",
      "It carries per-execution rows AND the full per-trade charge breakdown — verified against a real 414-execution export and Paytm's own Realized P&L Detail (2026-08-20). Scrip codes are numeric; Vyuha resolves the symbol from the ISIN at commit.",
    ],
    openalgo: [
      "As of Aug 2026: create a developer app on Paytm Money's developer portal with Product Type \"Trading Bridge\". The credentials appear only after the app reaches Active status — an app still in review shows nothing to paste, which looks broken and is only pending.",
      "Documented but not yet exercised by Vyuha: this path follows OpenAlgo's own broker docs. Vyuha's live OpenAlgo pulls have run against Dhan and Upstox (Aug 2026).",
    ],
    notes: [
      "Paytm Money has no import API of its own — the same-day pull runs through OpenAlgo. See the two OpenAlgo cards below.",
    ],
    guide: OPENALGO_GUIDE,
  },
  {
    id: "generic",
    title: "Any other broker — map the columns",
    summary: "Kotak Neo, Sahi and anything unrecognised route here: you say whose file it is.",
    channels: ["files", "openalgo"],
    formats: sources("generic-table", "pdf"),
    steps: [
      "Kotak Neo and Sahi have published no verified export format, so their files go through the column mapper: you match the columns and say whose file it is. No parser is promised for a format nobody has published — a question is always better than a confident wrong answer.",
      "Same-day pulls for Kotak run through OpenAlgo (see the cards below). Sahi has no MTF at all, so there is nothing to tag on its trades.",
    ],
    openalgo: [
      "Kotak Neo, as of Aug 2026: the instance's .env takes your 5-character UCC (client code) as BROKER_API_KEY and the access token from the Kotak Neo developer dashboard as BROKER_API_SECRET; the redirect callback path is \"kotak\".",
      "Documented but not yet exercised by Vyuha: this path follows OpenAlgo's own broker docs. Vyuha's live OpenAlgo pulls have run against Dhan and Upstox (Aug 2026).",
    ],
    notes: [
      "The mapper refuses a row it cannot read rather than coercing a bad cell to 0 — a trade for zero shares at zero rupees is worse than no trade.",
      "The PDF source reads the text out of a statement so you can check figures against your journal — it does not import trades, because no broker PDF layout has been calibrated.",
    ],
    guide: OPENALGO_GUIDE,
  },
  {
    id: "openalgo-setup",
    title: "Set up an OpenAlgo instance",
    summary: "Run the open-source bridge on your own machine — one instance per broker login.",
    channels: ["openalgo"],
    formats: [],
    steps: [
      "OpenAlgo is open-source (AGPL-3.0), self-hosted software that speaks to 35+ Indian brokers and runs entirely on your own computer. There is NO pip package and NO installer — the cloned folder IS the install.",
      "As of Aug 2026 the install is three commands: install Python 3.12+ and \"pip install uv\", then \"git clone https://github.com/marketcalls/openalgo\", then \"uv run app.py\" from inside the folder — uv builds the environment on first run. The web UI comes up at http://127.0.0.1:5000.",
      "Point the .env at your broker — copy .sample.env to .env, then set BROKER_API_KEY, BROKER_API_SECRET and a REDIRECT_URL matching your port. Every broker's exact lines are at docs.openalgo.in → Connect Brokers, and each broker card above states its own delta (Dhan's composite key, Angel One's unused secret, Groww's static IP…).",
      "A second broker means a second cloned folder, never a second login in the same one. As of Aug 2026 OpenAlgo ships an official multi-instance.ps1 that sets this up: one folder per broker, each on its own ports (5000, 5001, …) with its own .env and its own databases. Never share the first instance's .env, database or generated keys.",
      "Log in at http://127.0.0.1:5000 (or your instance's port), completing the broker login (client id / PIN / TOTP as your broker requires). The dashboard should show your broker's name and Live Mode.",
      "Sanity-check before touching Vyuha: open OpenAlgo's own Tradebook page on a day you traded — your fills should be there. If they are not, Vyuha cannot see them either; fix the OpenAlgo side first.",
    ],
    notes: [
      "The daily login is mandatory, not optional: broker sessions expire around 3 AM IST every day, and the tradebook stays empty until you log in through the OpenAlgo dashboard again. An empty pull before the day's login is normal, not broken.",
      "\"Cannot reach OpenAlgo at …\" — the instance is not running, or the port in Vyuha's Host field is not the port in the instance's .env. The OpenAlgo console banner prints its real address.",
      "\"wrong API key?\" on save — the key is the other instance's, or was regenerated. Copy it again from that instance's API Key page.",
      "A row refused with \"suspect symbol\" — OpenAlgo's broker plugin mislabelled a contract (it has happened). Vyuha refuses to book a trade under a corrupt identity; import that one trade from the broker's own file or API instead.",
      "A quantity \"recovered from trade value\" — some OpenAlgo broker plugins report quantity 0 on real fills. Vyuha recovers the size from value ÷ price, tells you, and refuses any row it cannot recover. Check those against your contract note once.",
      "Honesty: Vyuha has exercised the OpenAlgo path live against Dhan and Upstox (Aug 2026). The other brokers' OpenAlgo connections are documented from OpenAlgo's own docs but not yet exercised by Vyuha — each broker card above says which is which.",
    ],
    guide: OPENALGO_GUIDE,
  },
  {
    id: "openalgo-connect",
    title: "Get the API key & connect to Vyuha",
    summary: "Accept the disclosure first — then two minutes of key, host and broker.",
    channels: ["openalgo"],
    formats: [],
    steps: [
      "First: Settings → Integrations (advanced) → switch OpenAlgo on → read the disclosure → Accept. The Import tab's OpenAlgo section does not exist until you do — and the server refuses saves and pulls regardless of the UI, because hiding a button is never the only defence. Your acceptance is recorded in the Audit Log.",
      "As of Aug 2026 the OpenAlgo API key lives on the instance's /apikey page (the dashboard's API Key entry) — a 64-character hex string. It never expires on its own; it only stops working if you regenerate it, at which point the old one is dead and Vyuha needs the new one. This is OpenAlgo's key, not your broker's.",
      "Then Import → OpenAlgo (self-hosted): paste that key; the host is http://127.0.0.1:5000, or your instance's port; and you pick the broker behind OpenAlgo — that choice stamps the trades and selects the charge profile, so it is asked, never guessed.",
      "Saving fires a live check against the instance, so a wrong key or port fails right there with a message — not tomorrow at pull time. A second instance appears as its own row with its own Preview / Pull & commit buttons.",
      "The tradebook covers the current trading day only — pull after you are done trading, and after the day's OpenAlgo dashboard login (broker sessions expire ~3 AM IST; an empty pull before that login is normal). Older history still comes in by file.",
    ],
    notes: [
      "The honest part: your broker credentials go into OpenAlgo, not Vyuha. Vyuha stores only the OpenAlgo API key — encrypted at rest with a machine-bound key, sent nowhere except your own instance — and the address it runs on; both are revocable from OpenAlgo's own screen without touching your broker account.",
      "The risk is real but small, and you should understand it: you are running one more program that holds a broker credential. The data itself only ever flows from your broker to your machine — OpenAlgo is a medium in between, not a service in the cloud. Keep it on 127.0.0.1; Vyuha warns before saving any non-local address, because at that moment your trade data would leave your computer.",
      "Vyuha's pull is read-only: it calls one endpoint (/api/v1/tradebook) and never places, modifies or cancels an order.",
    ],
    guide: OPENALGO_GUIDE,
  },
];
