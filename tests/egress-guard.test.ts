import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Egress guard — makes the privacy claim enforceable.
 *
 * lib/domain/help-content.ts ("WHAT LEAVES THE MACHINE") and
 * lib/domain/pricing.ts promise: no telemetry, and the only self-initiated
 * outbound call is the launch-time update / revocation check; everything else
 * is user-triggered. Nothing enforced that — a stray analytics `fetch()` in a
 * component would have shipped without a test going red.
 *
 * This is a SOURCE scan (the capital-fallback-guard style): it walks lib/,
 * app/, components/ and src-tauri/, extracts every outbound call site
 * (`fetch`, `new WebSocket`, `node:https`) plus every absolute-URL literal in
 * Rust and the Tauri config, and asserts each destination host — or, for
 * dynamic-URL call sites, each call-site FILE — is on the allowlist below,
 * with the reason it is allowed written next to it. Adding a fetch to a new
 * host, a WebSocket, an http-client dependency, or a `node:https` import in a
 * new file fails this test until the entry (and its WHY) is added here.
 *
 * Relative `fetch("/api/…")` is same-origin (the app's own route handlers),
 * not egress, and is deliberately not flagged.
 */

const root = process.cwd();

// ---------------------------------------------------------------------------
// The allowlist. Every entry carries its WHY — an entry without a reason is a
// review comment waiting to happen.
// ---------------------------------------------------------------------------

/** Literal destination hosts that may appear at an egress call site or in the
 *  Tauri layer. host → why it is allowed. */
const ALLOWED_HOSTS: Record<string, string> = {
  "api.dhan.co":
    "Dhan v2 tradebook pull (lib/import/api/dhan.ts) — user-triggered broker import, sends only the user's own token.",
  "auth.dhan.co":
    "Dhan PIN+TOTP token mint (lib/import/api/dhan.ts, v3.6.0 decision #2) — user-triggered; sends only the user's own client ID, PIN and a freshly computed TOTP code to Dhan's own auth host.",
  "api.kite.trade":
    "Zerodha Kite trades pull (lib/import/api/kite.ts) — user-triggered broker import.",
  "api.upstox.com":
    "Upstox trades pull (lib/import/api/upstox.ts) — user-triggered; goes over node:https family:4 for the Static-IP gate.",
  "apiconnect.angelone.in":
    "Angel One SmartAPI login + tradebook (lib/import/api/angelone.ts) — user-triggered broker import.",
  "api.telegram.org":
    "Telegram EOD digest + test alert (lib/telegram/send.ts, v3.6.0 decision #6) — consent-gated: off by default, sends only behind telegramGate (enabled AND current disclosure ack, enforced server-side in app/api/telegram/* and lib/telegram/digest-gate.ts), and carries only the user's own recorded numbers.",
  "nsearchives.nseindia.com":
    "NSE bhavcopy CSV for EOD auto-MTM (lib/jobs/auto-mtm.ts) — opt-in, disabled by default.",
  "www.nseindia.com":
    "Referer HEADER VALUE on the bhavcopy request (NSE 403s without it) — no request is ever made TO this host.",
  "github.com":
    "The one self-initiated launch call: Tauri updater manifest + licence revocation list (src-tauri/src/lib.rs, tauri.conf.json).",
  "schema.tauri.app":
    "JSON $schema editor hint inside the Tauri config files — tooling metadata, never fetched at runtime.",
};

/** Loopback is the app talking to itself (sidecar server, local OpenAlgo). */
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[?::1\]?|0\.0\.0\.0)$/;

/** Files allowed to call fetch() with a NON-literal URL (a variable, or a
 *  template starting with an interpolation). The host cannot be read off the
 *  call, so the SITE is allowlisted — and every absolute-URL literal in these
 *  files is still checked against ALLOWED_HOSTS, so the constants that feed
 *  the call stay pinned. file → why. */
const DYNAMIC_URL_CALL_SITES: Record<string, string> = {
  "components/system/command-palette.tsx":
    "Search v1 (v3.8) fetches searchUrl(q, cats) from use-search-session.ts — a SAME-ORIGIN relative path pinned to the literal /api/search prefix by tests/search-palette.test.ts; no host, no egress.",
  "lib/jobs/auto-mtm.ts":
    "builds the bhavcopy URL from the NSE_ARCHIVE constant (nsearchives.nseindia.com) — the literal is checked below.",
  "lib/import/api/angelone.ts":
    "prefixes paths with the BASE constant (apiconnect.angelone.in) — the literal is checked below.",
  "lib/import/api/openalgo.ts":
    "the OpenAlgo host is USER-CONFIGURED by design (self-hosted instance, default 127.0.0.1) — no fixed host exists to pin.",
  "lib/import/api/dhan.ts":
    "the token-mint URL is built by dhanAuthUrl (auth.dhan.co) so tests can pin its shape — every URL literal in the file is still checked below.",
};

/** Files allowed to import node:https / node:http. Their literal `host:`
 *  options are checked against ALLOWED_HOSTS. file → why. */
const NODE_HTTPS_CALL_SITES: Record<string, string> = {
  "lib/import/api/upstox.ts":
    "api.upstox.com is dual-stack and the Static-IP gate matches IPv4 only; node:https with family:4 is the fix (2026-08-28).",
};

/** Http-client packages that would create egress this scan cannot see. None
 *  are allowed; the allowlist exists so an exception must be written down. */
const HTTP_CLIENT_PACKAGES = /^(?:axios|node-fetch|undici|got|ky|superagent|request|needle|phin)$/;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// Strip block and line comments while preserving "://" inside string URLs —
// the tests/capital-fallback-guard.test.ts pattern, hardened: a block strip
// must not start inside an Accept-header MIME wildcard ("text/csv,star-slash-
// star" contains the two characters that open a block comment, and the naive
// strip ate from there to the next close, swallowing real code — found live in
// lib/jobs/auto-mtm.ts). A comment opener is never preceded by a word char,
// comma or star; those three are exactly the MIME-wildcard shapes.
function stripComments(src: string): string {
  return src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Host of an absolute URL string, or null if it is not absolute. Returns
 *  "${dynamic}" when the host itself is interpolated. */
function hostOf(url: string): string | null {
  const m = url.match(/^(?:https?|wss?):\/\/([^/:?#"'`\s]*)/i);
  if (!m) return null;
  return m[1].includes("${") ? "${dynamic}" : m[1].toLowerCase();
}

interface Violation {
  file: string;
  problem: string;
}

/** Audit one JS/TS source for egress. Exported into the self-test below. */
function auditJsSource(file: string, raw: string): Violation[] {
  const out: Violation[] = [];
  const src = stripComments(raw);
  const allowedDynamic = file in DYNAMIC_URL_CALL_SITES;

  // fetch(...) and new WebSocket(...) call sites.
  const call = /\b(?:fetch|new\s+WebSocket)\s*\(\s*(["'`])?/g;
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const quote = m[1];
    if (!quote) {
      // Variable URL — the host is unknowable statically.
      if (!allowedDynamic) {
        out.push({ file, problem: "calls fetch/WebSocket with a non-literal URL and is not in DYNAMIC_URL_CALL_SITES" });
      }
      continue;
    }
    const rest = src.slice(m.index + m[0].length);
    const url = rest.slice(0, rest.indexOf(quote) === -1 ? rest.length : rest.indexOf(quote));
    if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) continue; // same-origin
    const host = hostOf(url);
    if (host === null || host === "${dynamic}") {
      // Template starting with `${…}` or a host that interpolates — dynamic.
      if (url.startsWith("${") || host === "${dynamic}") {
        if (!allowedDynamic) {
          out.push({ file, problem: `fetch/WebSocket URL "${url.slice(0, 60)}" has a dynamic host and the file is not in DYNAMIC_URL_CALL_SITES` });
        }
      }
      // Other non-absolute literals ("api/x", "data:…") are same-origin-ish; ignored.
      continue;
    }
    if (!LOOPBACK.test(host) && !(host in ALLOWED_HOSTS)) {
      out.push({ file, problem: `fetches unlisted host "${host}"` });
    }
  }

  // Dynamic-site files: every absolute-URL literal anywhere in them must
  // still resolve to an allowlisted host, so the constant feeding the call
  // cannot drift.
  if (allowedDynamic) {
    for (const um of src.matchAll(/(?:https?|wss?):\/\/[^"'`\s)]+/gi)) {
      const host = hostOf(um[0]);
      if (host && host !== "${dynamic}" && !LOOPBACK.test(host) && !(host in ALLOWED_HOSTS)) {
        out.push({ file, problem: `URL literal names unlisted host "${host}"` });
      }
    }
  }

  // node:https / node:http imports outside the allowlisted sites.
  if (/(?:from\s*|require\s*\(\s*)["'](?:node:)?https?["']/.test(src) && !(file in NODE_HTTPS_CALL_SITES)) {
    out.push({ file, problem: "imports node:https/node:http and is not in NODE_HTTPS_CALL_SITES" });
  }

  // Literal host options handed to node:https in allowlisted files.
  if (file in NODE_HTTPS_CALL_SITES) {
    for (const hm of src.matchAll(/\bhost(?:name)?\s*:\s*["'`]([^"'`]+)["'`]/g)) {
      const host = hm[1].toLowerCase();
      if (!LOOPBACK.test(host) && !(host in ALLOWED_HOSTS)) {
        out.push({ file, problem: `node:https host option names unlisted host "${host}"` });
      }
    }
  }

  // Http-client packages this scan cannot see through.
  for (const im of src.matchAll(/(?:from\s*|require\s*\(\s*)["']([a-z0-9@/_.-]+)["']/gi)) {
    if (HTTP_CLIENT_PACKAGES.test(im[1])) {
      out.push({ file, problem: `imports http client "${im[1]}" — egress through it is invisible to this guard` });
    }
  }

  return out;
}

/** Audit Rust / Tauri-config text: every absolute URL host must be listed. */
function auditUrlLiterals(file: string, raw: string): { violations: Violation[]; hosts: string[] } {
  const src = stripComments(raw);
  const violations: Violation[] = [];
  const hosts: string[] = [];
  for (const um of src.matchAll(/(?:https?|wss?):\/\/[^"'`\s)\\]+/gi)) {
    const host = hostOf(um[0]);
    if (!host || host === "${dynamic}") continue;
    hosts.push(host);
    if (!LOOPBACK.test(host) && !(host in ALLOWED_HOSTS)) {
      violations.push({ file, problem: `URL literal names unlisted host "${host}"` });
    }
  }
  return { violations, hosts };
}

// ---------------------------------------------------------------------------
// File walk
// ---------------------------------------------------------------------------

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "target" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, acc);
    else if (exts.some((x) => e.name.endsWith(x))) acc.push(p);
  }
  return acc;
}

const rel = (p: string) => path.relative(root, p).replaceAll("\\", "/");

describe("egress guard — the zero-telemetry claim is enforced, not asserted", () => {
  it("every outbound call in lib/, app/, components/ goes to an allowlisted host (or an allowlisted dynamic site)", () => {
    const files = ["lib", "app", "components"].flatMap((d) =>
      walk(path.join(root, d), [".ts", ".tsx", ".js", ".mjs"]),
    );
    expect(files.length, "the walk found the web source tree").toBeGreaterThan(100);
    const violations = files.flatMap((f) => auditJsSource(rel(f), readFileSync(f, "utf8")));
    expect(
      violations,
      violations.map((v) => `${v.file}: ${v.problem}`).join("\n") +
        "\nNew egress must be added to the allowlist in tests/egress-guard.test.ts WITH its reason — see the privacy copy in lib/domain/help-content.ts.",
    ).toEqual([]);
  });

  it("the Tauri layer talks only to allowlisted hosts", () => {
    const files = [
      ...walk(path.join(root, "src-tauri", "src"), [".rs"]),
      path.join(root, "src-tauri", "tauri.conf.json"),
      path.join(root, "src-tauri", "tauri.signed.conf.json"),
    ];
    const violations: Violation[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      const r = auditUrlLiterals(rel(f), readFileSync(f, "utf8"));
      violations.push(...r.violations);
      r.hosts.forEach((h) => seen.add(h));
    }
    expect(violations, violations.map((v) => `${v.file}: ${v.problem}`).join("\n")).toEqual([]);
    // The launch-time updater/revocation endpoint is the ONE self-initiated
    // call the copy admits to — it must still exist, or the copy now overstates.
    expect([...seen], "the updater/revocation endpoint went missing").toContain("github.com");
  });

  it("the known broker hosts are still where the map says they are (scan is not vacuous)", () => {
    // If a refactor moves or renames these call sites, this test forces the
    // map — and the allowlist WHYs pointing at file paths — to be re-verified.
    const expectHostIn: Array<[string, string]> = [
      ["lib/import/api/dhan.ts", "api.dhan.co"],
      ["lib/import/api/dhan.ts", "auth.dhan.co"],
      ["lib/import/api/kite.ts", "api.kite.trade"],
      ["lib/import/api/angelone.ts", "apiconnect.angelone.in"],
      ["lib/import/api/upstox.ts", "api.upstox.com"],
      ["lib/jobs/auto-mtm.ts", "nsearchives.nseindia.com"],
      ["lib/telegram/send.ts", "api.telegram.org"],
    ];
    for (const [file, host] of expectHostIn) {
      const src = stripComments(readFileSync(path.join(root, file), "utf8"));
      expect(src, `${file} no longer names ${host} — update the egress map`).toContain(host);
    }
  });

  it("every allowlist entry is still earned — no stale hosts linger", () => {
    // Both directions, the metric-help style: an entry nothing references any
    // more is an egress permission nobody is using, which is how scope creeps.
    const allSrc = ["lib", "app", "components"]
      .flatMap((d) => walk(path.join(root, d), [".ts", ".tsx", ".js", ".mjs"]))
      .concat(walk(path.join(root, "src-tauri", "src"), [".rs"]))
      .concat([path.join(root, "src-tauri", "tauri.conf.json"), path.join(root, "src-tauri", "tauri.signed.conf.json")])
      .map((f) => stripComments(readFileSync(f, "utf8")))
      .join("\n");
    const stale = Object.keys(ALLOWED_HOSTS).filter((h) => !allSrc.includes(h));
    expect(stale, `allowlisted hosts no source references: ${stale.join(", ")}`).toEqual([]);
  });
});

describe("the guard itself catches what it claims to (fixture self-test)", () => {
  it("flags a fetch to an unlisted host", () => {
    const v = auditJsSource("scratch/rogue.ts", `await fetch("https://telemetry.evil.example/v1/track", { method: "POST" });`);
    expect(v.map((x) => x.problem).join()).toContain('unlisted host "telemetry.evil.example"');
  });

  it("flags a template-literal fetch whose host is literal but unlisted", () => {
    const v = auditJsSource("scratch/rogue2.ts", "await fetch(`https://collector.example.com/e?id=${id}`);");
    expect(v.map((x) => x.problem).join()).toContain('unlisted host "collector.example.com"');
  });

  it("flags a variable-URL fetch in a file not allowlisted as a dynamic site", () => {
    const v = auditJsSource("components/rogue3.tsx", "const r = await fetch(endpoint);");
    expect(v.map((x) => x.problem).join()).toContain("non-literal URL");
  });

  it("flags a WebSocket and an http-client import", () => {
    const ws = auditJsSource("scratch/ws.ts", `const s = new WebSocket("wss://stream.example.io/feed");`);
    expect(ws.map((x) => x.problem).join()).toContain('unlisted host "stream.example.io"');
    const ax = auditJsSource("scratch/ax.ts", `import axios from "axios";`);
    expect(ax.map((x) => x.problem).join()).toContain('http client "axios"');
  });

  it("flags a node:https import outside the allowlisted sites", () => {
    const v = auditJsSource("lib/rogue-https.ts", `import { request } from "node:https";`);
    expect(v.map((x) => x.problem).join()).toContain("NODE_HTTPS_CALL_SITES");
  });

  it("does NOT flag same-origin fetches, allowlisted hosts, loopback, or commented-out egress", () => {
    const clean = [
      `await fetch("/api/settings", { method: "POST" });`,
      "await fetch(`/api/trades/${id}`);",
      "await fetch(`https://api.dhan.co/v2${p}`);",
      `await fetch("http://127.0.0.1:5000/api/v1/ping");`,
      `// await fetch("https://telemetry.evil.example/v1/track")`,
    ].join("\n");
    expect(auditJsSource("scratch/clean.ts", clean)).toEqual([]);
  });
});
