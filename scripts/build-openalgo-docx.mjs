#!/usr/bin/env node
/**
 * Build docs/client/OPENALGO_SETUP_GUIDE.docx — the Word twin of
 * docs/client/OPENALGO_SETUP_GUIDE.html, for buyers who want the broker
 * connection guide as a printable / annotatable document.
 *
 * Pure Node, zero dependencies: the OOXML parts are emitted as strings and
 * zipped with the same store/deflate writer as scripts/build-client-package.mjs.
 * The CONTENT array below is the single source the document is rendered from —
 * edit copy there, then re-run `npm run client:docx`. Keep its wording in step
 * with the HTML guide (same facts, same troubleshooting rows verbatim).
 *
 * Copy rules for anything user-facing (same as the HTML guide): no outcome
 * claims, no "guarantee", never the word "ret*rns" outside the verbatim
 * troubleshooting row, no version strings, and nothing about invite-only
 * chart tooling — tests/no-indicators-in-client-docs.test.ts walks this
 * folder (it skips the .docx binary, but the generator source is greppable).
 */
import { deflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(root, "docs", "client", "OPENALGO_SETUP_GUIDE.docx");

// ── content ─────────────────────────────────────────────────────────────────
// Block types: title, sub, h1, h2, p, li (bullet), step (numbered look),
// code (monospace block, array of lines), note (emphasised paragraph),
// table ({ header: [..], rows: [[..], ..] }).
// Inline text is a string or an array of runs: "plain", { b: "bold" },
// { c: "code/mono" }.
const CONTENT = [
  { t: "title", x: "Connecting brokers through OpenAlgo" },
  { t: "sub", x: "Vyuha · broker connections · As of Aug 2026 · Windows · self-hosted on your own computer · read-only pull" },
  { t: "p", x: ["Vyuha can pull the day's fills straight from your broker through ", { b: "OpenAlgo" }, " (openalgo.in) — an open-source (AGPL-3.0), self-hosted bridge that speaks to 35+ Indian brokers and runs entirely on your own computer."] },

  { t: "h1", x: "1 · What you should know before enabling it (the honest part)" },
  { t: "li", x: [{ b: "Your broker credentials go into OpenAlgo, not Vyuha." }, " Vyuha stores only the OpenAlgo API key and the address of your instance — both revocable from OpenAlgo's own screen without touching your broker account."] },
  { t: "li", x: [{ b: "The risk is real but small, and you should understand it:" }, " you are running one more program that holds a broker credential. The data itself only ever flows from your broker to your machine — OpenAlgo is a medium in between, not a service in the cloud. Keep it on 127.0.0.1 (Vyuha warns you before saving any non-local address, because at that moment your trade data would leave your computer)."] },
  { t: "li", x: [{ b: "Vyuha's pull is read-only" }, ": it calls one endpoint (/api/v1/tradebook), imports through the same preview → charges → duplicate-check pipeline as every file, and computes charges from your rate card — it never places, modifies or cancels an order."] },
  { t: "li", x: ["Because of all of the above, the integration is ", { b: "off by default" }, ". You switch it on yourself in Settings → Integrations (advanced), after an in-app disclosure that states exactly this list. Your acceptance is recorded in the Audit Log."] },

  { t: "h1", x: "2 · Install OpenAlgo on Windows" },
  { t: "p", x: ["One OpenAlgo instance connects to ", { b: "one broker login" }, ". If you use two brokers through OpenAlgo, run two instances on different ports — Vyuha handles multiple instances side by side (section 4)."] },
  { t: "h2", x: "What you need first" },
  { t: "li", x: [{ b: "Windows 10 or newer." }] },
  { t: "li", x: [{ b: "Python 3.12 or newer" }, ", installed with “Add python.exe to PATH” ticked."] },
  { t: "li", x: [{ b: "Git for Windows" }, " (any recent version)."] },
  { t: "h2", x: "Install and first run" },
  { t: "step", x: ["Install ", { c: "uv" }, " (the Python runner OpenAlgo uses): ", { c: "pip install uv" }] },
  { t: "step", x: ["Clone OpenAlgo into a folder of your choice: ", { c: "git clone https://github.com/marketcalls/openalgo" }, " then ", { c: "cd openalgo" }] },
  { t: "step", x: ["Create your .env: copy ", { c: ".sample.env" }, " to ", { c: ".env" }, " and fill in your broker's lines (section 3, and the per-broker deltas in section 9)."] },
  { t: "step", x: ["Start it: ", { c: "uv run app.py" }, " — the first run takes several minutes while uv downloads and builds the whole environment. Later starts are quick."] },
  { t: "step", x: ["Open the dashboard at ", { c: "http://127.0.0.1:5000" }, ", create your OpenAlgo login, and complete the broker login (client id / PIN / TOTP as your broker requires). The dashboard should show your broker's name and ", { b: "Live Mode" }, "."] },
  { t: "step", x: ["Sanity-check before touching Vyuha: open OpenAlgo's own ", { b: "Tradebook" }, " page on a day you traded — your fills should be there. If they are not, Vyuha cannot see them either; fix the OpenAlgo side first."] },
  { t: "h2", x: "Updating OpenAlgo later" },
  { t: "li", x: ["Run ", { c: "install\\update.bat" }, " from the OpenAlgo folder."] },
  { t: "li", x: ["Some upgrades also need a database migration: ", { c: "cd upgrade" }, " then ", { c: "uv run migrate_all.py" }] },
  { t: "note", x: ["Full official documentation for every step: docs.openalgo.in → Getting Started / Connect Brokers."] },

  { t: "h1", x: "3 · The .env file, decoded" },
  { t: "p", x: "Three lines connect an instance to your broker; everything else can stay at its default for a single instance:" },
  { t: "code", x: [
    "BROKER_API_KEY    = 'the key your broker's developer portal gives you'",
    "BROKER_API_SECRET = 'its secret (a few brokers do not use one)'",
    "REDIRECT_URL      = 'http://127.0.0.1:<port>/<broker>/callback'",
  ] },
  { t: "p", x: ["The <broker> segment of the redirect URL is OpenAlgo's short name for your broker (dhan, upstox, groww, paytm, kotak, angel, zerodha) — and the ", { b: "same URL must be registered on the broker's developer portal" }, ", port and all. A mismatch is the single most common setup failure."] },
  { t: "note", x: [{ b: "Never rotate APP_KEY, the pepper or the salt." }, " OpenAlgo auto-generates these encryption values in the .env on first run and uses them to protect every credential it stores. Changing them later destroys access to everything the instance has saved — logins, tokens, keys — and there is no undo. Leave them exactly as generated, and back the .env up as a whole."] },

  { t: "h1", x: "4 · Running two or more brokers (multi-instance)" },
  { t: "p", x: ["One instance, one broker login. For a second broker, run a second copy of OpenAlgo — the official way is the ", { c: "multi-instance.ps1" }, " PowerShell script from the OpenAlgo docs, which sets up separate folders on ports 5000, 5001, and so on."] },
  { t: "li", x: [{ b: "Separate folder per instance" }, " — each has its own .env, its own databases, its own auto-generated keys. Never share or copy these between instances."] },
  { t: "li", x: [{ b: "Separate ports per instance" }, " — the second instance's .env carries its own set, for example FLASK_PORT=5051, HOST_SERVER=http://127.0.0.1:5051, WEBSOCKET_PORT=8766, ZMQ_PORT=5556."] },
  { t: "li", x: [{ b: "Separate API key per instance" }, " — each instance issues its own OpenAlgo API key, and each becomes its own row in Vyuha with its own host and port."] },

  { t: "h1", x: "5 · The OpenAlgo API key" },
  { t: "p", x: ["This is ", { b: "OpenAlgo's" }, " key, not your broker's. Get it from the instance's dashboard at ", { c: "/apikey" }, " (or the API Key menu entry)."] },
  { t: "li", x: ["It is a 64-character hex string, and it ", { b: "does not expire" }, " — it stays valid until you regenerate it from the same page."] },
  { t: "li", x: "Regenerating invalidates the old key immediately; you would then paste the new one into Vyuha's instance row." },
  { t: "li", x: "Each instance has its own key. Pasting instance A's key with instance B's port is the classic mix-up — see Troubleshooting." },

  { t: "h1", x: "6 · The daily broker login" },
  { t: "note", x: [{ b: "Broker sessions die around 3 AM IST, every day." }, " Each morning (or before your evening pull), open the instance's dashboard at http://127.0.0.1:<port> and complete the broker login again — client id, PIN, TOTP, whatever your broker asks. Until you do, the tradebook is empty and a pull has nothing to read. This is a broker-side rule that applies to every broker API, not an OpenAlgo quirk."] },

  { t: "h1", x: "7 · Connecting it to Vyuha" },
  { t: "step", x: [{ b: "Settings → Integrations (advanced)" }, " → switch OpenAlgo on → read the disclosure → Accept. The Import tab entry does not exist until you do, and the server refuses saves and pulls regardless of the UI — hiding a button is never the only defence."] },
  { t: "step", x: [{ b: "Import → OpenAlgo (self-hosted)" }, ", then fill the three fields: the OpenAlgo API key (section 5); the Host (http://127.0.0.1:5000, or whatever port that instance runs on — each instance is its own host:port); and the broker behind OpenAlgo — the broker this instance is logged into. This matters: it stamps the trades and selects the charge profile. Then Add instance. Saving fires a live check against the instance, so a wrong key or port fails here with a message — not tomorrow at pull time."] },
  { t: "step", x: ["Repeat for a second instance — each appears as its own row with its own Preview / Pull & commit buttons."] },

  { t: "h1", x: "8 · Pulling trades" },
  { t: "li", x: [{ b: "Preview pull" }, " shows what would land — trades aggregated per contract, charges computed from your rate card — without writing anything."] },
  { t: "li", x: [{ b: "Pull & commit" }, " imports through the normal pipeline. Everything that protects a file import protects this: exact re-pulls are skipped, a pull that adds nothing says so and lists what matched, and a suspicious overlap blocks the commit until you decide."] },
  { t: "li", x: ["The tradebook covers ", { b: "the current trading day only" }, " — pull after you are done trading. Older history still comes in by file."] },

  { t: "h1", x: "9 · Broker-by-broker: the exact deltas" },
  { t: "p", x: ["Sections 2–8 are the same for every broker. What differs is where the API key comes from and what the daily login asks for. ", { b: "Verified live with Vyuha (Aug 2026): Dhan and Upstox" }, " — a real pull from a real account landed real trades. The other five are documented from OpenAlgo's official broker guides but not yet exercised against a live account through Vyuha."] },

  { t: "h2", x: "Dhan — verified live with Vyuha, Aug 2026" },
  { t: "li", x: ["At web.dhan.co → DhanHQ Trading APIs, switch the app to ", { b: "API Key Mode" }, " (not the default partner mode) and set the redirect URL to http://127.0.0.1:5000/dhan/callback."] },
  { t: "li", x: ["The .env key is a ", { b: "composite" }, " — your Dhan client id and the API key joined by three colons: ", { c: "BROKER_API_KEY = 'your_dhan_clientid:::your_dhan_apikey'" }] },
  { t: "li", x: "Daily login is a single click-through consent on Dhan's page." },

  { t: "h2", x: "Upstox — verified live with Vyuha, Aug 2026" },
  { t: "li", x: ["Create a ", { b: "developer app" }, " at Upstox (account.upstox.com → My Apps / Developer API). The app gives you the API key and secret."] },
  { t: "li", x: ["Set the app's redirect URL to http://127.0.0.1:<port>/upstox/callback — matching your instance's port exactly. Running Upstox as a second instance alongside another broker? Give it its own port (for example ", { c: "5050" }, ") and register http://127.0.0.1:5050/upstox/callback."] },
  { t: "li", x: "Daily login is Upstox's standard OAuth page (mobile number / TOTP / PIN)." },

  { t: "h2", x: "Groww — documented, not yet exercised with Vyuha" },
  { t: "li", x: "No app to create — Groww's execution platform portal issues a token pair (API key + secret) directly, which go into BROKER_API_KEY / BROKER_API_SECRET." },
  { t: "li", x: [{ b: "A static IP is mandatory." }, " Groww's API requires you to whitelist the IP address your requests come from, so a home connection with a changing IP will break. This is a Groww-side requirement, and it is the one broker on this page where “install and go” is not enough."] },
  { t: "li", x: ["Callback segment: ", { c: "groww" }] },

  { t: "h2", x: "Paytm Money — documented, not yet exercised with Vyuha" },
  { t: "li", x: ["Create an API app at Paytm Money's developer page and choose the ", { b: "“Trading Bridge”" }, " app type."] },
  { t: "li", x: ["The app is not usable immediately — ", { b: "wait until its status shows Active" }, " before putting its key and secret into the .env."] },
  { t: "li", x: ["Callback segment: ", { c: "paytm" }] },

  { t: "h2", x: "Kotak Neo — documented, not yet exercised with Vyuha (most step-heavy of the seven)" },
  { t: "li", x: ["The .env fields carry different things than they do elsewhere: your ", { b: "UCC (Unique Client Code)" }, " goes in as the key, and an access token generated from the ", { b: "Neo developer dashboard" }, " goes in as the secret."] },
  { t: "li", x: ["Daily login asks for the most of any broker here: mobile/UCC, ", { b: "TOTP" }, ", and your ", { b: "trading PIN" }, " — budget an extra minute each morning."] },
  { t: "li", x: ["Callback segment: ", { c: "kotak" }] },

  { t: "h2", x: "Angel One — documented, not yet exercised with Vyuha" },
  { t: "li", x: ["Create an app at smartapi.angelone.in (SmartAPI). Only the API key is used — ", { b: "the API secret is not used" }, "; login is a TOTP exchange: ", { c: "BROKER_API_KEY = 'your_smartapi_key'" }] },
  { t: "li", x: [{ b: "Enable TOTP on your Angel One account first" }, " (smartapi.angelone.in/enable-totp) — the daily login cannot complete without it."] },
  { t: "li", x: ["Note the callback segment is ", { c: "angel" }, " — not ", { c: "angelone" }] },

  { t: "h2", x: "Zerodha — documented, not yet exercised with Vyuha" },
  { t: "li", x: ["Create a ", { b: "Kite Connect" }, " app at developers.kite.trade; its API key and secret go into the .env, with redirect http://127.0.0.1:<port>/zerodha/callback."] },
  { t: "li", x: ["Daily login goes through Kite's page and exchanges a fresh ", { b: "request token" }, " each day — OpenAlgo handles the exchange; you just complete the Kite login."] },
  { t: "li", x: "Vyuha also connects to Zerodha natively (file import and its own API path) — use OpenAlgo for Zerodha only if you prefer one pull screen for every broker." },

  { t: "h1", x: "10 · What it costs" },
  { t: "p", x: ["As of Aug 2026: ", { b: "read-only tradebook pulls are free on all seven brokers." }, " Creating the developer app or API key costs nothing at Dhan, Upstox, Groww, Paytm Money, Kotak Neo, Angel One or Zerodha, and the tradebook endpoint Vyuha reads is not a paid add-on anywhere. The paid tiers some brokers advertise cover live market-data streams — not required for anything on this page."] },

  { t: "h1", x: "11 · Troubleshooting" },
  { t: "p", x: "Each of these was hit in real testing." },
  { t: "table", header: ["Symptom", "Cause and fix"], rows: [
    ["\"Cannot reach OpenAlgo at …\"", "The instance is not running, or the port in Vyuha's Host field is not the port in the instance's .env. Check the OpenAlgo console banner — it prints its real address."],
    ["\"wrong API key?\" on save", "The key is the OTHER instance's, or was regenerated. Copy it again from that instance's API Key page."],
    ["A pull returns no fills on a trading day", "Log into the OpenAlgo web UI first — broker sessions expire daily and the tradebook is empty until the day's login."],
    ["A row is REFUSED with \"suspect symbol\"", "OpenAlgo's broker plugin mislabelled a contract (it has happened: a stock option arrived named as a silver option). Vyuha refuses to book a trade under a corrupt identity — import that one trade from the broker's own file or API instead."],
    ["A warning says a quantity was \"recovered from trade value\"", "Some OpenAlgo broker plugins report quantity 0 on real fills. Vyuha recovers the size from value ÷ price, tells you, and refuses any row it cannot recover. Check those against your contract note once."],
  ] },

  { t: "p", x: "Vyuha — trade journal & analytics · record-keeping, not investment advice · OpenAlgo setup guide · As of Aug 2026" },
];

// ── OOXML rendering ─────────────────────────────────────────────────────────
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One run. props: { b, mono, size (half-points), color } */
function run(text, { b = false, mono = false, size = null, color = null } = {}) {
  const pr = [
    mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : "",
    b ? "<w:b/>" : "",
    color ? `<w:color w:val="${color}"/>` : "",
    size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : "",
  ].join("");
  return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/** Inline content (string | array of runs) → run XML, with base props. */
function runs(x, base = {}) {
  const parts = Array.isArray(x) ? x : [x];
  return parts
    .map((part) => {
      if (typeof part === "string") return run(part, base);
      if (part.b !== undefined) return run(part.b, { ...base, b: true });
      if (part.c !== undefined) return run(part.c, { ...base, mono: true, color: "0E7569" });
      throw new Error(`Unknown inline run: ${JSON.stringify(part)}`);
    })
    .join("");
}

/** One paragraph. pPr fragments passed raw. */
const para = (pPr, runXml) => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runXml}</w:p>`;
const spacing = (before, after) => `<w:spacing w:before="${before}" w:after="${after}"/>`;

let stepCounter = 0;
function blockToXml(block) {
  switch (block.t) {
    case "title":
      return para(spacing(0, 120), runs(block.x, { b: true, size: 56, color: "0E7569" }));
    case "sub":
      return para(spacing(0, 360), runs(block.x, { size: 20, color: "667788" }));
    case "h1":
      stepCounter = 0;
      return para(spacing(420, 160), runs(block.x, { b: true, size: 32, color: "0E7569" }));
    case "h2":
      stepCounter = 0;
      return para(spacing(280, 120), runs(block.x, { b: true, size: 26 }));
    case "p":
      return para(spacing(60, 120), runs(block.x));
    case "li":
      return para(`${spacing(40, 40)}<w:ind w:left="360"/>`, run("•  ", { b: true, color: "0E7569" }) + runs(block.x));
    case "step":
      stepCounter += 1;
      return para(`${spacing(60, 60)}<w:ind w:left="360"/>`, run(`${stepCounter}.  `, { b: true, color: "0E7569" }) + runs(block.x));
    case "code":
      return block.x
        .map((line, i) =>
          para(
            `${spacing(i === 0 ? 120 : 0, i === block.x.length - 1 ? 120 : 0)}<w:ind w:left="360"/><w:shd w:val="clear" w:color="auto" w:fill="F2F5F7"/>`,
            run(line, { mono: true, size: 19 }),
          ),
        )
        .join("");
    case "note":
      return para(
        `${spacing(120, 160)}<w:ind w:left="240"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D99A1D"/></w:pBdr>`,
        runs(block.x),
      );
    case "table": {
      const cell = (x, isHeader) =>
        `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF2"/>' : ""}</w:tcPr>${para(
          spacing(40, 40),
          runs(x, isHeader ? { b: true } : {}),
        )}</w:tc>`;
      const border = (edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="AABBC4"/>`;
      const rowsXml = [
        `<w:tr>${block.header.map((h) => cell(h, true)).join("")}</w:tr>`,
        ...block.rows.map((r) => `<w:tr>${r.map((c) => cell(c, false)).join("")}</w:tr>`),
      ].join("");
      return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders></w:tblPr>${rowsXml}</w:tbl>${para(spacing(0, 120), "")}`;
    }
    default:
      throw new Error(`Unknown block type: ${block.t}`);
  }
}

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${CONTENT.map(blockToXml).join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

// ── zip writer (same approach as scripts/build-client-package.mjs) ──────────
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const local = [];
  const central = [];
  const now = new Date();
  const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const deflated = deflateRawSync(raw, { level: 9 });
    const method = deflated.length < raw.length ? 8 : 0;
    const body = method === 8 ? deflated : raw;
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(method, 8);
    header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, body);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(method, 10); directory.writeUInt16LE(dosTime, 12); directory.writeUInt16LE(dosDate, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(raw.length, 24); directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralData, end]);
}

const docx = createZip([
  { name: "[Content_Types].xml", data: contentTypesXml },
  { name: "_rels/.rels", data: relsXml },
  { name: "word/document.xml", data: documentXml },
]);

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, docx);
console.log(`✓ Wrote ${path.relative(root, outPath)} (${docx.length} bytes, ${CONTENT.length} content blocks)`);
