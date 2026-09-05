/**
 * The one live compliance gap the chart research found (02 §9.5 / open decision
 * 4, owner ruling Q26): lightweight-charts is Apache-2.0 and requires TradingView
 * to be named as the creator, with a link, on a surface the user can reach. The
 * app deliberately turns OFF the library's `attributionLogo` — Vyuha is offline
 * and zero-telemetry, and an outbound link painted on a canvas is not acceptable
 * here — so the obligation is met by a file that ships inside the artifact.
 *
 * A mention in `docs/DECISIONS.md` is not a file in the installer. This test is
 * what makes the notices file part of the build rather than part of the intent:
 * it asserts the file exists, that it says the things the licences require, that
 * it accounts for EVERY runtime dependency in `package.json` (so a new one
 * cannot ship unlisted), and that Tauri actually bundles it.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const NOTICES = "docs/client/THIRD-PARTY-NOTICES.txt";
const noticesPath = path.join(root, NOTICES);

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const tauri = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")) as {
  bundle?: { resources?: Record<string, string> | string[] };
};

describe("THIRD-PARTY-NOTICES.txt", () => {
  it("exists and is a real notices file, not a stub", () => {
    expect(existsSync(noticesPath), `${NOTICES} is missing`).toBe(true);
    expect(readFileSync(noticesPath, "utf8").length).toBeGreaterThan(4000);
  });

  it("names lightweight-charts, its Apache-2.0 licence and TradingView's copyright", () => {
    const text = readFileSync(noticesPath, "utf8");

    expect(text).toContain("lightweight-charts");
    expect(text).toMatch(/Apache License, Version 2\.0/);
    expect(text).toContain("Apache-2.0");
    // The copyright line printed in node_modules/lightweight-charts/LICENSE.
    expect(text).toContain("Copyright 2023 TradingView, Inc.");
  });

  it("names TradingView as the creator and publishes the link the licence asks for", () => {
    const text = readFileSync(noticesPath, "utf8");

    expect(text).toMatch(/TradingView is the creator/);
    expect(text).toContain("https://www.tradingview.com/");
    // The reason the on-canvas link is switched off has to travel with the file.
    expect(text).toContain("attributionLogo");
  });

  it("carries the Apache-2.0 licence text itself, not just its name", () => {
    const text = readFileSync(noticesPath, "utf8");

    expect(text).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
    expect(text).toContain('distributed under the License is distributed on an "AS IS" BASIS');
  });

  it("carries the MIT text and names recharts, the other attribution-bearing runtime dependency", () => {
    const text = readFileSync(noticesPath, "utf8");

    expect(text).toContain("recharts");
    expect(text).toContain("Copyright (c) 2015-present recharts");
    expect(text).toContain("The above copyright notice and this permission notice shall be included in all");
  });

  it("accounts for every runtime dependency — a new one cannot ship unlisted", () => {
    const text = readFileSync(noticesPath, "utf8");
    const missing = Object.keys(pkg.dependencies ?? {}).filter((d) => !text.includes(d));

    expect(missing, `not listed in ${NOTICES}: ${missing.join(", ")}`).toEqual([]);
  });

  it("states which packages publish no NOTICE file rather than inventing one", () => {
    expect(readFileSync(noticesPath, "utf8")).toContain("no NOTICE file");
  });
});

describe("the installer actually carries the file", () => {
  it("tauri.conf.json bundles it as a resource", () => {
    const resources = tauri.bundle?.resources;
    expect(resources, "src-tauri/tauri.conf.json has no bundle.resources").toBeDefined();

    const entries = Array.isArray(resources) ? resources : Object.keys(resources ?? {});
    const entry = entries.find((e) => e.includes("THIRD-PARTY-NOTICES.txt"));
    expect(entry, `bundle.resources does not include ${NOTICES}`).toBeDefined();

    // The path is relative to src-tauri/ and has to resolve to the real file —
    // Tauri fails the whole bundle on a missing resource, at release time.
    expect(existsSync(path.resolve(root, "src-tauri", entry as string))).toBe(true);
  });

  it("keeps the existing desktop-dist resource — this is an addition, not a rewrite", () => {
    const resources = tauri.bundle?.resources;
    const entries = Array.isArray(resources) ? resources : Object.keys(resources ?? {});

    expect(entries).toContain("../desktop-dist");
  });
});
