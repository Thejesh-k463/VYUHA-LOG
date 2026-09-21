#!/usr/bin/env node
/**
 * Build docs/client/BROKER_API_SETUP_GUIDE.docx — the Word twin of
 * docs/client/BROKER_API_SETUP_GUIDE.html, for buyers who want the direct
 * broker-API guide as a printable / annotatable document.
 *
 * Rendering and zipping live in scripts/docx-render.mjs (shared with the
 * OpenAlgo guide). The CONTENT array below is the single source this document
 * is rendered from — edit copy there, then re-run `npm run client:docx`. Keep
 * its wording in step with the HTML guide (same facts, same troubleshooting
 * rows verbatim).
 *
 * Copy rules for anything user-facing (same as the HTML guide): no outcome
 * claims, no "guarantee", no version strings, nothing about invite-only chart
 * tooling, and never a claim that Vyuha can act on an order —
 * tests/broker-api-guide.test.ts and tests/no-indicators-in-client-docs.test.ts
 * hold the HTML twin to exactly this list.
 */
import { writeDocx } from "./docx-render.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(root, "docs", "client", "BROKER_API_SETUP_GUIDE.docx");

const CONTENT = [
  { t: "title", x: "Connecting your broker's own API" },
  { t: "sub", x: "Vyuha · broker connections · As of Sep 2026 · Windows · read-only pull · credentials encrypted on this computer" },
  { t: "p", x: ["Plain-language setup for the four brokers Vyuha talks to directly — ", { b: "Angel One" }, ", ", { b: "Dhan" }, ", ", { b: "Upstox" }, " and ", { b: "Zerodha" }, ". What each form asks for, what to paste where in Vyuha, and what to do when something is refused. No programming knowledge assumed."] },

  { t: "h1", x: "0 · Which door do I use?" },
  { t: "p", x: [{ b: "A file from your broker." }, " Every broker publishes exports. You download one, drag it onto Journal → Import, Vyuha reads it, recomputes the charges from your own rate card and shows you a preview before anything is written. This path needs no keys, no forms and no permissions, and it is the only one that reaches back into last year. If you are here because you want your old trades in, this is your door."] },
  { t: "p", x: [{ b: "Your broker's own API." }, " Four brokers let Vyuha ask them, over the internet, for what you traded today. You fill in one form on your broker's developer site, paste a few values into Vyuha once, and after that a pull is one click. It replaces the download-and-drag ritual for each new day; it does not replace the file import for history, because these endpoints only state the current trading day (Dhan additionally lets Vyuha fill in the days you missed). This is what the rest of this guide covers."] },
  { t: "p", x: [{ b: "The OpenAlgo bridge." }, " If your broker is not one of the four — Groww, Paytm Money, Kotak Neo, and thirty more — a free open-source program called OpenAlgo can sit between your broker and Vyuha, on your own computer. It is more to set up and it holds your broker credentials itself, so it earns its place only when your broker has no direct connection. The full walkthrough ships in this same package as OPENALGO_SETUP_GUIDE.html (and OPENALGO_SETUP_GUIDE.docx)."] },
  { t: "note", x: ["You can use all three at once. A file import, an API pull and an OpenAlgo pull all land through the same preview, the same charge computation and the same duplicate check — the same trade arriving twice is recognised and skipped."] },

  { t: "h1", x: "1 · What an API key is, in one minute" },
  { t: "p", x: ["An ", { b: "API key" }, " is a long password that you give to a program instead of to a person. Your broker's website is for you; the API is the same account with the screens taken away, so another program can ask questions in a form a program understands. Creating one does not change your account, your holdings or your fees — it only creates a second way in, which you can close again at any time."] },
  { t: "h2", x: "What Vyuha does" },
  { t: "li", x: [{ b: "Asks your broker what you traded, and nothing else." }, " Angel One: today's trade book. Zerodha: today's executions. Upstox: today's fills. Dhan: today's positions — the one source that states MTF outright — plus its dated trade history, so a pull you skipped for four days is not lost."] },
  { t: "li", x: [{ b: "Imports it exactly like a file." }, " Preview first, charges computed from your rate card, duplicates detected and skipped. A pull that adds nothing says so."] },
  { t: "li", x: [{ b: "Keeps the credentials on this computer" }, ", encrypted at rest with a key bound to this machine. They are sent nowhere except to that broker itself."] },
  { t: "h2", x: "What Vyuha never does" },
  { t: "note", x: [{ b: "Vyuha never places, modifies or cancels an order." }, " The code that talks to a broker exports a login and a read of your trades, and nothing else — there is no order function in it to call, and an automated check refuses any change that would add one. It also never transfers funds, never changes any setting in your broker account, and never sends your credentials, your trades or your journal to us or to anyone else."] },
  { t: "h2", x: "The only outside addresses involved" },
  { t: "table", header: ["Broker", "Address Vyuha contacts"], rows: [
    ["Angel One", "apiconnect.angelone.in"],
    ["Dhan", "api.dhan.co, and auth.dhan.co for the PIN + TOTP sign-in"],
    ["Upstox", "api.upstox.com"],
    ["Zerodha", "api.kite.trade"],
  ] },
  { t: "p", x: "Each is the broker's own address. PRIVACY.md in this package states the full list of moments Vyuha ever uses the network, and what each request carries." },

  { t: "h1", x: "2 · Angel One (SmartAPI) — the form, field by field" },
  { t: "p", x: "Free — SmartAPI has no subscription. Nothing expires on you. Pulls today's trade book. Once set up, there is no daily token to paste and no browser login to complete: Vyuha signs itself in at pull time from a six-digit code it works out on your own machine." },
  { t: "h2", x: "Step A — turn on TOTP for your Angel One account" },
  { t: "step", x: ["Open smartapi.angelone.in/enable-totp in your browser."] },
  { t: "step", x: ["Enter your Angel One ", { b: "client ID" }, " and your trading password or PIN."] },
  { t: "step", x: ["Enter the one-time password Angel One sends to your registered email and mobile."] },
  { t: "step", x: ["A ", { b: "QR code" }, " appears. Scan it with any authenticator app — that app will now show a fresh 6-digit code every 30 seconds."] },
  { t: "step", x: [{ b: "Also copy the long text string shown with the QR code, and keep it." }, " That string is the TOTP secret — the one value Vyuha needs. Angel One's own moderators state it plainly: “The string which you need to pass in the TOTP is the one generated below the QR code in TOTP Generation”, and it “is not the secret key generated along with the API key in the app”."] },
  { t: "note", x: [{ b: "The TOTP secret is NOT the 6-digit code." }, " The 6-digit number in your authenticator app changes every 30 seconds and is useless to paste anywhere permanent. The secret is the long block of capital letters and digits shown with the QR code at enrollment — it never changes, and it is what lets Vyuha work out today's 6-digit code by itself. If you paste a 6-digit number into Vyuha's TOTP secret box, every pull will be refused."] },
  { t: "p", x: "If you scanned the QR code and closed the page without copying the string, you cannot read it back later — run the enrollment at smartapi.angelone.in/enable-totp again and copy it this time. Re-enrolling replaces the previous one, so re-scan the new QR code into your authenticator app as well." },

  { t: "h2", x: "Step B — create the app (the “Add App” form)" },
  { t: "p", x: "Sign in at smartapi.angelone.in and choose Add App. This is the form in front of you, field by field:" },
  { t: "li", x: [{ b: "App Name" }, " — anything you like; it is a label for you, not a setting. “Vyuha Journal” is as good as any."] },
  { t: "li", x: [{ b: "Redirect URL (required)" }, " — this field belongs to a different way of logging in, the kind where your browser is sent to a web page and bounced back. Vyuha does not use it: it signs in with your client code, your PIN and a code from your TOTP secret, so no address here is ever visited on your behalf. Angel One still makes the field compulsory, and its moderators state the rule: “only URLs secured with HTTPS are allowed in the redirect URL. HTTP, localhost, IPs are not allowed as redirect URL anymore.”"] },
  { t: "note", x: [{ b: "Observed on the form itself (21 September 2026):" }, " typing https://127.0.0.1 is refused in red with “Localhost is not allowed”. Do not type 127.0.0.1 or localhost — nor any numeric address — however tempting it looks for a program that runs on your own computer. The form wants a real, public https:// web address. Angel One publishes no guidance for an app that never redirects, so there is no official “correct” value to give you: any real public https:// address you are comfortable naming satisfies the form, for example https://www.angelone.in. If your entry is refused, contact Angel One support and ask what they want in that field for an app that signs in with client code, PIN and TOTP."] },
  { t: "li", x: [{ b: "Post back URL (optional)" }, " — an address Angel One would notify when an order's status changes. Vyuha never places an order, so there is nothing to be notified about. Leave it empty."] },
  { t: "li", x: [{ b: "Primary Static IP (required)" }, " — a “static IP” is an internet address that does not change. Angel One added this field to comply with SEBI's rules on client-side trading programs, and what it governs is order placement, not reading. Angel One's own announcement: “Effective from 01-Apr-2026, API order execution will only be accepted if it originates from your registered primary static IP” — and on the SmartAPI forum: “For APIs other than Orders & GTT, using a static IP is not mandatory.” Vyuha only ever reads your trade book, so it falls on the “not mandatory” side. The form still insists on a value: enter the address you have (any “what is my IP” website shows today's). If reading ever stops because that address changed, Angel One says the mapped static IP may be updated “as needed, but not more than once a calendar week” from the same SmartAPI dashboard. If your provider will not give you a fixed address and Angel One refuses the app, contact Angel One support and ask what they require for read-only use; use the file import in the meantime."] },
  { t: "li", x: [{ b: "Secondary Static IP (optional)" }, " — a backup address, for people who run their program from two places. Leave it empty."] },
  { t: "p", x: "Submit the form. Angel One shows you an API key (and a separate app “secret”, which Vyuha does not use and you do not need). Copy the API key." },

  { t: "h2", x: "Step C — what to paste into Vyuha" },
  { t: "p", x: "In Vyuha: Journal → Import → Connect broker, tab Angel One (SmartAPI)." },
  { t: "table", header: ["Vyuha field", "What to paste", "Where it came from"], rows: [
    ["API key", "The SmartAPI app key", "The app you just created at smartapi.angelone.in"],
    ["Client code", "Your Angel One client ID, e.g. A123456", "The one you log in to Angel One with"],
    ["Login PIN", "Your Angel One app PIN — not your password", "The PIN you unlock the Angel One app with"],
    ["TOTP secret", "The long string from enrollment — not the 6-digit code", "Step A, shown with the QR code"],
  ] },
  { t: "p", x: "Pick the account this connection belongs to if you keep more than one book, then Save." },
  { t: "h2", x: "How to know it worked" },
  { t: "li", x: ["The connection appears as a saved row with the mode “no token needed” — Angel One is the one broker of the four that never asks you for a daily token."] },
  { t: "li", x: ["Press Preview pull on a day you traded, after the close. It shows what would land — trades aggregated per contract, charges computed from your rate card — and writes nothing."] },
  { t: "li", x: ["Then Pull & commit. Pulling twice is safe: the second pull recognises the same executions and skips them."] },
  { t: "li", x: ["An empty pull on a day you did not trade is correct, not broken. The trade book covers the current trading day only — your history still comes in by file."] },
  { t: "h2", x: "Common errors" },
  { t: "table", header: ["What you see", "What it usually is"], rows: [
    ["The sign-in is refused, or the TOTP is rejected", "Three usual causes: a 6-digit code was pasted into the TOTP secret box instead of the long enrollment string; the app's API “secret” from the Add App page was pasted instead of the TOTP secret; or this computer's clock has drifted — these codes are derived from the time, so a clock a minute out produces a code Angel One will not accept (Windows Settings → Time & language → Date & time → Sync now)."],
    ["Vyuha stops trying and asks you to re-save", "After three refused sign-ins Vyuha stops rather than hammering your account. Fix the cause, re-save the credentials (or restart Vyuha) and it resumes."],
    ["The Angel One row in Settings → Live feed is greyed out", "That row stays unavailable until the client code, PIN and TOTP secret are saved under Import → Connect broker. Save them there first, then pick Angel One as the price source."],
    ["Nothing arrives, and the day was a trading day", "Pull after you have finished trading. The trade book is the current day's, and it is empty before your first fill."],
  ] },

  { t: "h1", x: "3 · Dhan (DhanHQ v2)" },
  { t: "p", x: "Free. Pulls today's positions — and Dhan is the only source of any kind that says outright whether a position was MTF (margin-funded). No Dhan file can: a P&L export has no product column, and in a transaction report an MTF position carries exactly the same STT and stamp duty as delivery, while the financing interest sits in the ledger." },
  { t: "step", x: ["Log in at web.dhan.co. Dhan's own documentation gives the path as My Profile → “Access DhanHQ APIs” (the same screens are labelled DhanHQ Trading APIs in places)."] },
  { t: "step", x: ["Generate an access token. Dhan states it is valid for 24 hours from generation — so on this path you paste a fresh one each day you want to pull."] },
  { t: "step", x: ["Note your Client ID — the number you log in to Dhan with."] },
  { t: "h2", x: "The better path: connect once with PIN + TOTP" },
  { t: "p", x: "Dhan also offers a sign-in that mints the day's token for you, which removes the daily paste altogether. Dhan's documentation states you may generate a token by sending your client ID, PIN and a TOTP code, “if TOTP is enabled for your account” — so enable TOTP in your Dhan account first, exactly the way section 2 describes for Angel One, and keep the enrollment secret." },
  { t: "note", x: [{ b: "Storing your Dhan PIN and TOTP secret makes Vyuha a second factor for your Dhan account." }, " Vyuha says so on screen and asks you to agree before it will store them — that consent is recorded in the Audit Log. If you would rather not, the 24-hour token paste above keeps working. Either way the sign-in call goes only to Dhan's own address, auth.dhan.co."] },
  { t: "h2", x: "What to paste into Vyuha" },
  { t: "p", x: "Journal → Import → Connect broker, tab Dhan (DhanHQ v2)." },
  { t: "table", header: ["Vyuha field", "What to paste"], rows: [
    ["Client ID", "Your Dhan client ID"],
    ["Access token", "The 24-hour token from Dhan — optional if you use the PIN + TOTP mode"],
    ["PIN", "Your Dhan PIN (connect-once mode)"],
    ["TOTP secret", "The enrollment string from Dhan's TOTP setup — not the 6-digit code (connect-once mode)"],
  ] },
  { t: "p", x: "How to know it worked: Preview pull shows today's positions, with the product — CNC, intraday, MARGIN or MTF — stated rather than guessed. A pasted token that has aged past its 24 hours is reported as expired, with the time it expired, rather than failing vaguely." },

  { t: "h1", x: "4 · Upstox (Analytics token)" },
  { t: "p", x: "The simplest of the four to keep running, and the only one whose credential cannot place an order even in principle: Upstox issues the Analytics token as a read-only credential, and its write endpoints reject it. It lasts about a year, so there is no daily ritual at all." },
  { t: "step", x: ["At account.upstox.com → Apps → Analytics, generate the Analytics token and copy it. Keep it somewhere private — it is a password."] },
  { t: "step", x: ["On the same Apps screen, under Static IPs, register the IPv4 address your internet connection currently uses. Upstox answers account requests only from a registered address; this is Upstox's rule, and unlike Angel One's it applies to reading too."] },
  { t: "note", x: [{ b: "If pulls suddenly fail with a 401 after months of working, your connection's address changed." }, " Most home connections are handed a new one from time to time. Re-register the new address under Apps → Static IPs and the pull resumes. Nothing about the token itself has gone wrong."] },
  { t: "p", x: "What to paste into Vyuha: Journal → Import → Connect broker, tab Upstox (Analytics token) — one field, Analytics token. Save, then Preview pull." },
  { t: "note", x: [{ b: "One token, two jobs." }, " The same token can price the Live Desk (section 6) — no second credential and no second login. And generating a fresh Analytics token at Upstox revokes the old one, so a regeneration stops the import and the price feed at the same moment. Paste the new token back under Import → Connect broker and both work again."] },

  { t: "h1", x: "5 · Zerodha (Kite Connect)" },
  { t: "p", x: "Zerodha's API is called Kite Connect, and it differs from the other three in two ways worth knowing before you start." },
  { t: "li", x: [{ b: "It is a paid service." }, " Zerodha's own API page listed ₹500 a month per app when this guide was written (September 2026) — check zerodha.com/products/api for the current figure before you commit. The other three connections in this guide cost nothing."] },
  { t: "li", x: [{ b: "Its sessions are invalidated every trading day, by regulation" }, " — around 6 AM IST. There is no way around this: every Kite Connect user logs in again each day."] },
  { t: "h2", x: "Set it up" },
  { t: "step", x: ["Create a Kite Connect app at developers.kite.trade. It gives you an API key and an API secret."] },
  { t: "step", x: ["The app asks for a redirect URL. Unlike Angel One, Kite genuinely uses it: your daily login ends by sending your browser there, carrying a one-time request token in the web address. Use an address you can read the result from. If you are unsure what Zerodha wants there, ask Zerodha support rather than guessing."] },
  { t: "step", x: ["In Vyuha, Journal → Import → Connect broker, tab Zerodha (Kite Connect): paste the API key, and — this is the part that saves you time — also paste the API secret in the optional field below. With the secret saved, the daily ritual becomes one login plus one short paste, instead of hunting down a raw token."] },
  { t: "h2", x: "The daily login" },
  { t: "p", x: "When a pull finds the session dead, Vyuha shows you the Kite login link and one box. You open the link, log in to Zerodha, and the page you land on carries request_token=… in its address bar. Copy that value into the box; Vyuha exchanges it with Zerodha for the day's session using the official mechanism, and the pull continues. If you did not save the API secret, paste the day's access token instead." },
  { t: "p", x: "How to know it worked: Preview pull lists today's executions with fill times. A pull after the session has expired says so and asks for the day's request token — it does not fail silently." },

  { t: "h1", x: "6 · Live prices on the Live Desk" },
  { t: "p", x: "From v4.2, two of these connections can do a second job: pricing your open positions on the Live Desk, with no second credential and no second login — Upstox (reusing the Analytics token) and Angel One (reusing the client code, PIN and TOTP secret, signing itself in)." },
  { t: "p", x: "Turn it on in Settings → Live feed: pick the source and accept its disclosure. Each row stays greyed out until that broker's credentials are saved on the Import screen — that is the normal state, not a fault. The request carries the trading symbols or instrument keys of the open positions of the selected account and nothing else about them: no quantity, no entry price, no profit or loss, no account name. Equities only in this release; futures and options rows show the position's recorded close, or a dash, and say so on the row. Prices refresh on screen — one mark per position per day is what reaches your journal." },

  { t: "h1", x: "7 · Troubleshooting" },
  { t: "table", header: ["Symptom", "Cause and fix"], rows: [
    ["Angel One: “invalid TOTP” or a refused sign-in", "A 6-digit code was pasted instead of the enrollment secret; or the app's API “secret” was pasted instead of the TOTP secret; or this computer's clock has drifted — sync it in Windows Settings → Time & language."],
    ["Upstox: worked for months, now every pull is refused (401)", "Your connection's IPv4 address changed. Re-register it at account.upstox.com → Apps → Static IPs."],
    ["Upstox: the import AND the Live Desk feed stopped at the same moment", "An Analytics token was regenerated, which revokes the previous one. Paste the new token under Import → Connect broker; both recover."],
    ["Zerodha: the pull asks for a request token", "Normal. Kite sessions are invalidated around 6 AM IST every trading day. Open the login link, and paste the request_token from the address you land on."],
    ["Dhan: “the pasted access token expired”", "Dhan tokens last 24 hours. Generate a new one, or switch to the connect-once PIN + TOTP mode so Vyuha mints the day's token itself."],
    ["A broker's row in Settings → Live feed cannot be selected", "Its credentials are not saved yet under Import → Connect broker, or its disclosure has not been accepted. Do both, in that order."],
    ["The pull returns nothing on a day you traded", "Pull after you have finished trading — these endpoints state the current trading day. For an older day, import the broker's file instead."],
    ["The same trades look like they arrived twice", "They did not. Re-pulls are matched and skipped, and a pull that adds nothing lists what it matched. Check the preview before committing if you are unsure."],
    ["A form on the broker's site refuses what you entered", "Contact that broker's support. Only the broker can say what its own form requires, and a guessed value is worse than a question."],
  ] },

  { t: "h1", x: "8 · Safety — and how to switch it off" },
  { t: "li", x: [{ b: "Never share your TOTP secret or your API key with anyone — including us." }, " Support will never need them. If you send us a screenshot, cover those boxes first."] },
  { t: "li", x: [{ b: "They live on this computer only" }, ", encrypted at rest with a key bound to this machine, and are sent nowhere except to that broker."] },
  { t: "li", x: [{ b: "Vyuha never places, modifies or cancels an order" }, ", never moves funds, and never changes a setting in your broker account."] },
  { t: "li", x: [{ b: "You can revoke at any time, from the broker's side" }, ", without Vyuha's help: delete or regenerate the app at smartapi.angelone.in (Angel One), generate a new Analytics token or remove the app at account.upstox.com → Apps (Upstox, which revokes the old token), revoke the API access from web.dhan.co (Dhan), or delete the app at developers.kite.trade (Zerodha). A revoked credential simply stops working — nothing in your journal is affected."] },
  { t: "li", x: [{ b: "And from Vyuha's side" }, ", remove the saved connection on Import → Connect broker. Your imported trades stay; only the ability to fetch new ones goes."] },
  { t: "li", x: ["If you ever suspect a credential has been seen by someone else, revoke it at the broker first, then create a new one. That is the fastest way to be certain."] },

  { t: "p", x: "Vyuha — trade journal & analytics · record-keeping, not investment advice · Broker API setup guide · As of Sep 2026" },
];

const bytes = writeDocx(outPath, CONTENT);
console.log(`✓ Wrote ${path.relative(root, outPath)} (${bytes} bytes, ${CONTENT.length} content blocks)`);
