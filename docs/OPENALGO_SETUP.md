# Connecting brokers through OpenAlgo — the complete setup guide

Vyuha connects natively to Zerodha, Dhan, Angel One and Upstox. For **Groww,
Paytm Money and Kotak** — brokers with no import API of their own — Vyuha can
pull today's fills through **[OpenAlgo](https://openalgo.in)**: an open-source
(AGPL-3.0), self-hosted bridge that speaks to 35+ Indian brokers and runs
entirely on **your own computer**.

## What you should know before enabling it (the honest part)

- **Your broker credentials go into OpenAlgo, not Vyuha.** Vyuha stores only
  the OpenAlgo API key and the address of your instance — both revocable from
  OpenAlgo's own screen without touching your broker account.
- **The risk is real but small, and you should understand it:** you are
  running one more program that holds a broker credential. The data itself
  only ever flows *from* your broker *to* your machine — OpenAlgo is a medium
  in between, not a service in the cloud. Keep it on `127.0.0.1` (Vyuha warns
  you before saving any non-local address, because at that moment your trade
  data would leave your computer).
- **Vyuha's pull is read-only**: it pulls trades only from `/api/v1/tradebook`, after reading
  OpenAlgo's version from `/auth/app-info` (a request that carries nothing, not even the key);
  saving the connection makes no network call at all, and the Live Desk's price feed makes a
  read-only `/api/v1/funds` check (plus the same version read) each time it connects. It
  imports through the same preview → charges → duplicate-check pipeline as
  every file, and computes charges from your rate card — it never places,
  modifies or cancels an order.
- **Vyuha needs OpenAlgo 2.0.2.6 or later** and refuses to pull from anything older, for
  every broker — see Part 4.
- Because of all of the above, the integration is **off by default**. You
  switch it on yourself in **Settings → Integrations (advanced)**, after an
  in-app disclosure that states exactly this list. Your acceptance is recorded
  in the Audit Log.

## Part 1 — set up an OpenAlgo instance (once per broker)

One OpenAlgo instance connects to ONE broker login. If you use two brokers
through OpenAlgo, run two instances on different ports — Vyuha handles
multiple instances side by side.

1. **Install** OpenAlgo per its docs (https://docs.openalgo.in — Python;
   `git clone https://github.com/marketcalls/openalgo`, create the venv, copy
   `.sample.env` to `.env`).
2. **Point the `.env` at your broker.** The three lines that matter (examples
   verified against real setups):

   *Dhan* — create an API key at web.dhan.co → DhanHQ APIs → **API Key Mode**,
   with the redirect URL matching your port:
   ```
   BROKER_API_KEY = 'your_dhan_clientid:::your_dhan_apikey'
   BROKER_API_SECRET = 'your_dhan_apisecret'
   REDIRECT_URL = 'http://127.0.0.1:5000/dhan/callback'
   ```

   *Angel One* — an app at smartapi.angelone.in (the API secret is not used;
   login is a TOTP exchange):
   ```
   BROKER_API_KEY = 'your_smartapi_key'
   REDIRECT_URL = 'http://127.0.0.1:5000/angel/callback'
   ```

   Every broker's exact lines: https://docs.openalgo.in → Connect Brokers.
3. **Running a second instance?** Give it its own ports in its `.env` and
   never share the first instance's `.env`, database or generated keys:
   ```
   FLASK_PORT=5051
   HOST_SERVER=http://127.0.0.1:5051
   WEBSOCKET_PORT=8766
   ZMQ_PORT=5556
   ```
4. **Start it and log in.** Open `http://127.0.0.1:<port>`, complete the
   broker login (client id / PIN / TOTP as your broker requires). The
   dashboard should show your broker's name and **Live Mode**.
5. **Sanity-check before touching Vyuha:** open OpenAlgo's own **Tradebook**
   page on a day you traded — your fills should be there. If they are not,
   Vyuha cannot see them either; fix the OpenAlgo side first.
6. **Copy the API key** from OpenAlgo → **API Key** (this is OpenAlgo's key,
   not your broker's).

## Part 2 — connect it to Vyuha (two minutes)

1. **Settings → Integrations (advanced)** → switch OpenAlgo on → read the
   disclosure → **Accept**. (The Import tab does not exist until you do, and
   the server refuses saves and pulls regardless of the UI — hiding a button
   is never the only defence.)
2. **Import → OpenAlgo (self-hosted)**:
   - **OpenAlgo API key** — from step 6 above
   - **Host** — `http://127.0.0.1:5000` (or your instance's port)
   - **Broker behind OpenAlgo** — the broker this instance is logged into.
     This matters: it stamps the trades and selects the charge profile.
   - **Add instance.** Saving checks the host's FORMAT and the broker, and
     makes no network call — so it works while OpenAlgo is stopped. The live
     check is **Preview pull**: press it once after saving, and a wrong key,
     port or an OpenAlgo older than 2.0.2.6 fails there with a message.
3. Repeat for a second instance — each appears as its own row with its own
   Preview / Pull & commit buttons.

## Part 3 — pulling trades

- **Preview pull** shows what would land — trades aggregated per contract,
  charges computed from your rate card — without writing anything.
- **Pull & commit** imports through the normal pipeline. Everything that
  protects a file import protects this: exact re-pulls are skipped, a pull
  that adds nothing says so and lists what matched, and a suspicious overlap
  blocks the commit until you decide.
- The tradebook covers **the current trading day only** — pull after you are
  done trading. Older history still comes in by file.
- Before every pull Vyuha reads the instance's version; below 2.0.2.6 the
  pull is refused with the upgrade steps (Part 4). A tradebook answered from
  OpenAlgo's **Analyzer (sandbox) mode** is refused whole — its fills are
  simulated. Rows on an exchange Vyuha has no charges for (`NCO` — NSE
  commodities — and `NCDEX`) are refused and named; add those from the
  contract note.

## Part 4 — OpenAlgo version and upgrading

**Minimum: OpenAlgo 2.0.2.6** (released 2026-09-22). Vyuha reads the running
version from `GET /auth/app-info` — the check OpenAlgo's own upgrade procedure
tells you to make — and refuses to pull from an older release, whichever broker
sits behind it. Why that exact release: before 2.0.2.4 the Groww plugin reported
every fill above ₹100 at one hundredth of its price; before 2.0.2.6 the Zerodha
plugin reported MCX quantity in contracts rather than units (Vyuha counts MCX in
units); and 2.0.0.6, 2.0.1.8 and 2.0.2.2 fixed security holes (the last one let
any web page place an order through your instance). A release older than 2.0.0.0
has no `/auth/app-info` at all, and is refused as older. The Live Desk keeps
pricing from an old instance but says, beside "Feed OK", that pulls are refused.

**Upgrading** (from OpenAlgo's upgrade guide, docs.openalgo.in → Upgrade):

1. Stop OpenAlgo and back up its folder — at least the `db` folder and `.env`.
2. In the OpenAlgo folder: `git pull`, then `uv sync`, then
   `uv run upgrade/migrate_all.py` (2.0.2.6 needs its database migration).
   On Windows, `install\update.bat` does the same.
3. **Never** copy `.sample.env` over an existing `.env` — that wipes your broker
   keys. If a release adds `.env` settings, copy just those lines across.
4. Start OpenAlgo, open `http://127.0.0.1:<port>/auth/app-info` — it should
   say `"version": "2.0.2.6"` or later — log into your broker, then Preview
   pull in Vyuha.

**Tested against:** W8 (v4.6.0) was built and tested against OpenAlgo
**2.0.2.6's own source and documented responses** (2026-09-25). The last LIVE
pulls through OpenAlgo were the Dhan and Upstox plugins on 2026-08-26/27, on a
release nobody recorded; a live pull on 2.0.2.6 is still owed and will be
recorded here.

## Troubleshooting (each of these was hit in real testing)

| Symptom | Cause and fix |
|---|---|
| "Cannot reach OpenAlgo at …" | The instance is not running, or the port in Vyuha's Host field is not the port in the instance's `.env`. Check the OpenAlgo console banner — it prints its real address. |
| "wrong API key?" on Preview pull | The key is the OTHER instance's, or was regenerated. Copy it again from that instance's API Key page. |
| "Your OpenAlgo is …, older than 2.0.2.6" | Upgrade it (Part 4). Nothing was pulled, so nothing needs undoing. |
| "OpenAlgo is in Analyzer (sandbox) mode" | OpenAlgo's Analyzer toggle routes the tradebook to simulated fills. Switch it back to Live mode in OpenAlgo's dashboard and pull again. |
| A pull returns no fills on a trading day | Log into the OpenAlgo web UI first — broker sessions expire daily and the tradebook is empty until the day's login. |
| A row is REFUSED with "suspect symbol" | OpenAlgo's broker plugin mislabelled a contract (it has happened: a stock option arrived named as a silver option). Vyuha refuses to book a trade under a corrupt identity — import that one trade from the broker's own file or API instead. |
| A warning says a quantity was "recovered from trade value" | Some OpenAlgo broker plugins report quantity 0 on real fills. Vyuha recovers the size from value ÷ price, tells you, and refuses any row it cannot recover. Check those against your contract note once. On MCX the value is not quantity × price, so a zero-quantity MCX row is refused instead of repaired. |
