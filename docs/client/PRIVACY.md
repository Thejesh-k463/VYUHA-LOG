# Privacy

**Last updated:** 2026-09-07 · **Applies to:** Vyuha v4.2.0 and later

Vyuha Desktop has no account, no server and no telemetry. This page exists because that
claim deserves to be written down precisely rather than asserted in a slogan —
including the parts that are not absolute. It describes the desktop app; a web
platform is in development and will get its own statement here.

## What we collect about you

**Nothing.** There is no analytics SDK, no crash reporter, no usage tracking, no
device fingerprint sent anywhere, and no account to create. We cannot see your
trades, your P&L, your broker, your symbols, or whether you ever opened the app.

## Where your data lives

One SQLite database file on your own computer, plus a folder of any screenshots
you attached:

```
%APPDATA%\in.vyuha.tradejournal\vyuha.sqlite
```

Copy that file and you have backed up your entire trading history. Delete it and
it is gone — including from us, because we never had it.

Ticking the uninstaller's "Delete the application data" checkbox erases that folder, so
before it can, a non-update uninstall first writes an unencrypted copy of the journal and
licence key to `Documents\Vyuha-backup-<date>` — still on your own machine, but a Documents
folder redirected to OneDrive (or any other sync client) will sync that copy along with
everything else, so move or delete it if you would rather it did not.

## The network requests Vyuha Desktop makes

Exactly four kinds, and only one of them is automatic:

1. **At launch, once — automatic and not switchable off.** Vyuha asks GitHub
   whether a newer signed release exists, and downloads the licence-revocation
   list. Both are **download-only**: the request carries no account, no
   identifier, no machine ID and nothing about you or your trades. The same
   public files are served to everyone, and we cannot tell who fetched them. If
   you are offline it fails silently and the app carries on.
2. **End-of-day market data — only if you switch it on.** Downloads the free
   NSE/BSE bhavcopy to value open positions, and to compute the Market Atlas
   from bars kept on this machine. Off by default. Two shapes, one public
   archive (`nsearchives.nseindia.com`), and nothing is uploaded:
   *the daily file* — one download per trading day, only while end-of-day
   auto-MTM is on; and *the history backfill* — up to 252 past daily files,
   one every 1.5 seconds, and only when you press the button and confirm it.
   The backfill is never automatic, it can be stopped at any point, and
   whatever it has already saved is kept. These files are the same public
   market data served to everyone: they carry no account, no identifier and
   nothing about you or your trades. If you would rather download nothing at
   all, you can drop bhavcopy files you already have straight into Atlas
   instead — that path makes no network request whatsoever.
3. **Broker API pulls and the Live Desk price poll — only when you start one,
   when you have switched on the once-a-day auto-pull of your saved brokers at
   launch, or when you have chosen the bridge, Upstox or Angel One as the Live
   Desk's price source.** If you connect a broker (Zerodha, Dhan, Angel One or Upstox — or
   another broker through the OpenAlgo bridge you run on your own machine),
   Vyuha talks to *that broker's* API to fetch your own trades. Dhan's
   connect-once PIN+TOTP mode makes one extra sign-in call, and it goes only to
   Dhan's own endpoint (`auth.dhan.co`) — never anywhere else.
   That same bridge can also price your open positions: while the Live Desk is
   open and in the foreground, Vyuha asks it once every 1–5 seconds, at the interval you set in
   Settings → Live feed, and each request carries the trading symbols and
   exchanges of the positions you have open and nothing else about them — no
   quantity, no entry price, no P&L, no account — plus one `/funds` request
   each time you check the connection and each time the desk opens or its price
   stream reconnects, to the same bridge with the same key, keeping nothing from
   the answer but that it replied and how long it took. It is off until you
   switch the integration on, accept the disclosure and pick that source, it
   goes to your own machine
   (`http://127.0.0.1:5000`) unless you enter another address, and the prices
   it shows are never written to your journal as ticks: one mark per position
   per day is saved — written by the app itself once the desk reconnects at
   15:31 IST while it is open, or the next time you open it that day, and never
   at the weekend or on an exchange holiday. A price you type yourself is that day's mark: the automatic close-of-session mark does
   not overwrite it, and typing after the close replaces the
   automatic one; any bhavcopy applied for that day — the Auto-MTM job if you have switched it on, a file you drop or paste yourself, or the history backfill — replaces it with the exchange close.
   Upstox can price the desk instead, on the same terms and behind the same
   switch: the poll then goes to Upstox's own API host (`api.upstox.com`) and
   reuses the read-only Analytics token you already saved under Import →
   Brokers — the same token the trade import uses, which Upstox issues for
   about a year, so there is no daily sign-in to do. It carries the instrument
   keys of the open positions of the selected account, at most 500 of them,
   once every 1–5 seconds while the desk is open, and nothing else about
   them — no quantity, no entry price, no P&L, no account. Equities only in
   this release: futures and options rows keep the mark already stored and say
   so. The prices stay on this machine: never uploaded, never resold.
   Angel One can price the desk instead, on the same terms and behind the same
   switch, from the client code, PIN and TOTP secret you already saved under
   Import → Brokers. Angel One clears every API session at 5 AM IST, so
   Vyuha signs in once a day to Angel One's own API host
   (`apiconnect.angelone.in`) — the host the Angel One trade pull already
   uses, so this adds no new one — generating the one-time password itself
   from the secret you enrolled, with nothing for you to click. Against that
   same host it looks up, once per symbol, the token Angel One prices by, and
   keeps that mapping on this machine. It then asks for prices in batches of at
   most 50 symbols, at most one request a second, every 3, 5 or 10 seconds
   depending on how many positions you hold, and only for the open positions of
   the selected account, at most 500 of them, and for nothing else about them —
   no quantity, no entry price, no P&L, no account. Equities only in this
   release: futures and options rows keep the mark already stored and say so.
   The prices stay on this machine: never uploaded, never resold.
   Your credentials are encrypted at rest, bound to your
   machine, and sent nowhere except the broker itself. We never see them.
4. **The Telegram end-of-day digest — only if you switch it on, and this one
   is an upload.** It sends a summary of your own recorded numbers to a
   Telegram bot you create yourself, which means that content transits and is
   stored on Telegram's servers. It is off by default and can only be enabled
   behind a disclosure that says exactly that.

<!--
  Item 3, second paragraph — every claim and the code that performs it:
  (Line numbers drift; each carries the identifier it points at, so grep the name.)
    • 1–5 s, user-set interval  lib/quotes/openalgo.ts:59-71 (REFRESH_SECONDS_MIN/MAX/
                                  DEFAULT + clampRefreshSeconds), :419 (subscribe()'s
                                  `const timer = setInterval(() => void poll(), periodMs)`),
                                  :420-427 (`const stop: Unsubscribe` → clearInterval(timer)
                                  on the signal abort — stopped with the desk's stream)
    • only while the desk is open  app/api/live/stream/route.ts (the SSE route is
                                  what starts and aborts the subscription)
    • symbols + exchange, nothing else
                                  lib/quotes/openalgo.ts:357-361 (snapshot()'s
                                  `symbols` array → post(…, "multiquotes", { symbols })),
                                  :325 (the whole body: `JSON.stringify({ apikey:
                                  creds.apiKey, ...extra })`), openPositionKeys() in
                                  app/api/live/stream/route.ts (open positions of the
                                  selected account, capped at MAX_KEYS = 500 in that same
                                  file — identifiers, not line numbers, they move)
    • /funds on a check AND on    lib/quotes/openalgo.ts:450 (health()'s
                                  `await post(gate.creds, "funds", {})`), answer discarded
                                  :459-460 (`Math.max(0, now() - started)` and nothing else);
      every desk/stream connect   called by provider.health() in app/api/live/feed/route.ts
                                  and by provider.health() in app/api/live/stream/route.ts
                                  and in components/live/load-desk.ts (every desk render)
    • the close-of-session mark   app/api/live/stream/route.ts writes it through
                                  shouldPersistMark()/persistDailyMarks() when the desk's stream
                                  connects at or after 15:30 IST; the desk reconnects once
                                  at 15:31 IST. Already-marked is per symbol per IST day.
    • loopback default            lib/domain/openalgo-disclosure.ts OPENALGO_DEFAULT_HOST,
                                  isLocalOpenAlgoHost(); the poll's only host is
                                  normalizeHost(creds.host), lib/quotes/openalgo.ts:317-320
                                  (post(): `const base = normalizeHost(creds.host)` → the
                                  one doFetch of `${base}/api/v1/${path}`)
    • opt-in, behind the disclosure
                                  openAlgoGate() + isAckCurrent(), applied server-side in
                                  lib/quotes/openalgo.ts:156-162 (readGateFromDb(): the
                                  settings select → `if (!gate.allowed) return
                                  { state: "disabled" … }`)
    • no tick is written          lib/quotes/openalgo.ts:392-428 (subscribe(), whose poll()
                                  only calls onTick) writes nothing;
                                  lib/quotes/persist-mark.ts writes ONE row per position
                                  per IST day into mtm_prices
  This is the SAME kind of request as the pull above — the user's own broker
  bridge, only when they switched it on — so the four-kinds claim below is
  unchanged and still literally true.

  Item 3, third paragraph (v4.2) — the Upstox poll, and where each claim is
  enforced. Identifiers, not line numbers, because they move:
    • one host, api.upstox.com  the Upstox quote provider's `egressDescription`
                                in lib/quotes/* names api.upstox.com and no
                                other host, and tests/quotes-egress-guard.test.ts
                                refuses any provider that names a host THIS file
                                does not disclose. The host is already the one
                                the Upstox trade pull uses.
    • the saved Analytics token the same credential as that pull
                                (lib/import/api/upstox.ts), read from the
                                encrypted broker credentials — no second login,
                                and Upstox's own token type is read-only
    • 500 keys, every 1–5 s     openPositionKeys() and MAX_KEYS in
                                app/api/live/stream/route.ts (the same cap and
                                the same clamped interval as the bridge)
    • equities only             futures and options rows keep the mark already
                                stored, and the desk says so on the row
  Still the same KIND of request — the user's own broker, only when they
  switched it on and picked it — so "four kinds" is unchanged again.

  Item 3, fourth paragraph (v4.2) — the Angel One poll. Identifiers, not line
  numbers, because they move:
    • NO NEW HOST                 apiconnect.angelone.in is already the host the
                                  Angel One trade pull signs in to and reads
                                  from. The desk poll adds VOLUME to a disclosed
                                  host, not a host — which is why "four kinds"
                                  is unchanged a third time. The Angel One quote
                                  provider's `egressDescription` names that host
                                  and no other, and
                                  tests/quotes-egress-guard.test.ts refuses any
                                  provider naming a host THIS file does not
                                  disclose.
    • the once-a-day sign-in      Angel One flushes every session at 5 AM IST;
                                  the next one is opened from the client code,
                                  PIN and the TOTP secret already in the
                                  encrypted broker credentials, with no human
                                  step. Nothing new is asked of the user and no
                                  second credential is stored.
    • the token look-up           Angel One prices by its own instrument token,
                                  so each symbol is resolved once against the
                                  same host and the mapping is kept locally.
    • 50 to a batch, 1 req/s,     the tiers in lib/quotes/types.ts
      3 / 5 / 10 s                (angelOneCadenceSeconds: 50 or fewer → 3 s,
                                  51–200 → 5 s, 201–500 → 10 s) and the rate
                                  guard in lib/quotes/rate-guard.ts
    • 500 keys, selected account  openPositionKeys() / MAX_POSITION_KEYS in
                                  lib/quotes/persist-mark.ts (invariant 8)
    • equities only               futures and options rows keep the mark already
                                  stored, and the desk says so on the row
-->

That is the complete list for Vyuha Desktop. There is no fifth thing.

## Your credentials and licence key

Broker API credentials, TOTP secrets and your licence key are stored
**encrypted**, with a key bound to your machine and your OS user profile. A copy
of the database file alone — synced, shared or stolen — carries nothing usable.

Backups deliberately **exclude** your licence key and broker credentials, so
sharing a backup file never shares a credential.

## What we know about buyers

Only what you tell us during the purchase conversation: the email address your
licence is issued to, and whatever payment reference you send. That is kept in a
private file on the owner's machine so a lost key can be reissued and support
requests can be matched to a purchase. It is not uploaded, not shared, and not
used for marketing.

Your **Key ID** (the short `A1B2-C3D4-E5` code) identifies a licence without
exposing it — that is why support asks for the Key ID and never the key itself.

## The honest limits

- The launch check tells GitHub your IP address, the same as visiting any
  website would. We do not receive it or see it.
- If you connect a broker, that broker knows what you asked for. Their privacy
  policy governs that, not ours. The same goes for Telegram if you enable the
  digest.
- Rolling back to an older version after using v3.6 features leaves rows the
  old version does not manage — capital goals and brought-forward loss entries
  stay in the database untouched, but the old version cannot show or edit them.
- Nothing here protects a compromised computer. Encryption at rest defends the
  file, not a machine someone else is already running code on.

## Questions

The WhatsApp number and email on your invoice.
