# Privacy

**Last updated:** 2026-09-02 · **Applies to:** Vyuha v3.6.0 and later

Vyuha has no account, no server and no telemetry. This page exists because that
claim deserves to be written down precisely rather than asserted in a slogan —
including the parts that are not absolute.

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

## The network requests Vyuha makes

Exactly four kinds, and only one of them is automatic:

1. **At launch, once — automatic and not switchable off.** Vyuha asks GitHub
   whether a newer signed release exists, and downloads the licence-revocation
   list. Both are **download-only**: the request carries no account, no
   identifier, no machine ID and nothing about you or your trades. The same
   public files are served to everyone, and we cannot tell who fetched them. If
   you are offline it fails silently and the app carries on.
2. **End-of-day market data — only if you switch it on.** Downloads the free
   NSE/BSE bhavcopy to value open positions. Off by default.
3. **Broker API pulls — only when you start one, or when you have switched on
   the once-a-day auto-pull of your saved brokers at launch.** If you connect a
   broker (Zerodha, Dhan, Angel One or Upstox — or another broker through the
   OpenAlgo bridge you run on your own machine), Vyuha talks to *that broker's*
   API to fetch your own trades. Dhan's connect-once PIN+TOTP mode makes one
   extra sign-in call, and it goes only to Dhan's own endpoint
   (`auth.dhan.co`) — never anywhere else. Your credentials are encrypted at
   rest, bound to your machine, and sent nowhere except the broker itself. We
   never see them.
4. **The Telegram end-of-day digest — only if you switch it on, and this one
   is an upload.** It sends a summary of your own recorded numbers to a
   Telegram bot you create yourself, which means that content transits and is
   stored on Telegram's servers. It is off by default and can only be enabled
   behind a disclosure that says exactly that.

That is the complete list. There is no fifth thing.

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
