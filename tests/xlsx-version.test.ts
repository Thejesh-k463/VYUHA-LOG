import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

/**
 * SheetJS is vendored, not pulled from the npm registry.
 *
 * `xlsx@0.18.5` on registry.npmjs.org is the abandoned copy — SheetJS stopped
 * publishing there, so the registry version can never receive a fix. The CDN
 * build is the maintained one; it is committed as `vendor/xlsx-<ver>.tgz` and
 * referenced as `file:vendor/…` so `npm ci` is reproducible and CI never dials
 * cdn.sheetjs.com. This test is the pin: it fails if anything drags the
 * dependency back to a registry range or an older build.
 */

const root = process.cwd();
const require_ = createRequire(import.meta.url);

const VENDOR_TARBALL = "vendor/xlsx-0.20.3.tgz";
/** sha256 of the bytes downloaded from cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz on 2026-09-05. */
const VENDOR_SHA256 = "8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8";
const VENDOR_BYTES = 2_409_319;

function parts(v: string): number[] {
  return v.split(".").map((n) => Number.parseInt(n, 10));
}

/** true when `v` >= `min`, comparing major.minor.patch numerically. */
function atLeast(v: string, min: string): boolean {
  const a = parts(v);
  const b = parts(min);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

describe("xlsx is the maintained SheetJS build", () => {
  it("the resolved runtime version is >= 0.20.0", () => {
    const version = (require_("xlsx") as { version: string }).version;
    expect(atLeast(version, "0.20.0"), `xlsx resolved to ${version}`).toBe(true);
  });

  it("the installed package.json agrees with the runtime version", () => {
    // Read by path, not `require("xlsx/package.json")`: 0.20.x publishes an
    // `exports` map that does not expose the manifest as a subpath.
    const installed = JSON.parse(
      fs.readFileSync(path.join(root, "node_modules", "xlsx", "package.json"), "utf8"),
    ) as { version: string };
    expect(atLeast(installed.version, "0.20.0"), `node_modules/xlsx is ${installed.version}`).toBe(true);
  });

  it("package.json points at the vendored tarball, not the registry", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.xlsx).toBe(`file:${VENDOR_TARBALL}`);
  });

  it("the lockfile resolves xlsx from the vendored file, not registry.npmjs.org", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; resolved?: string }>;
    };
    const entry = lock.packages["node_modules/xlsx"];
    expect(entry?.resolved).toBe(`file:${VENDOR_TARBALL}`);
    expect(atLeast(entry?.version ?? "0.0.0", "0.20.0")).toBe(true);
  });

  it("the vendored tarball is the exact bytes that were fetched from the CDN", () => {
    const bytes = fs.readFileSync(path.join(root, VENDOR_TARBALL));
    expect(bytes.length).toBe(VENDOR_BYTES);
    expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(VENDOR_SHA256);
  });
});
