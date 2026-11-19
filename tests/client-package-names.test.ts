import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_IDS, installerMismatch, packageNames, startHere, checksumsText } from "../scripts/lib/client-package.mjs";

/**
 * Owner ruling 2026-11-19: macOS is sold openly under the same licence, and the
 * Mac package ships SEPARATELY, named so a buyer can tell which ZIP is theirs.
 * Three packages, one per kind of computer. These names are what the vendor
 * attaches and what the buyer reads in the download — a regression to the old
 * single `Vyuha_<ver>_Client_Package.zip` (which said nothing about the machine)
 * fails here. The GitHub release ASSET names stay Tauri's; only the copies inside
 * the ZIP are renamed.
 */

const V = "9.8.7";

describe("the three client packages", () => {
  it("are exactly windows, macos-apple-silicon and macos-intel", () => {
    expect(PLATFORM_IDS).toEqual(["windows", "macos-apple-silicon", "macos-intel"]);
  });

  it("name the archive and the installer inside it by machine type", () => {
    expect(packageNames({ version: V, platform: "windows" })).toEqual({
      archiveName: "Vyuha_9.8.7_Windows-x64_Client_Package.zip",
      installerName: "Vyuha_9.8.7_Windows-x64-Setup.exe",
      signatureName: "Vyuha_9.8.7_Windows-x64-Setup.exe.sig",
    });
    expect(packageNames({ version: V, platform: "macos-apple-silicon" })).toEqual({
      archiveName: "Vyuha_9.8.7_macOS-Apple-Silicon_Client_Package.zip",
      installerName: "Vyuha_9.8.7_macOS-Apple-Silicon.dmg",
      signatureName: null,
    });
    expect(packageNames({ version: V, platform: "macos-intel" })).toEqual({
      archiveName: "Vyuha_9.8.7_macOS-Intel_Client_Package.zip",
      installerName: "Vyuha_9.8.7_macOS-Intel.dmg",
      signatureName: null,
    });
  });

  it("keep the _Licensed suffix when a key travels inside", () => {
    expect(packageNames({ version: V, platform: "macos-intel", licensed: true }).archiveName).toBe(
      "Vyuha_9.8.7_macOS-Intel_Client_Package_Licensed.zip",
    );
    expect(packageNames({ version: V, licensed: true }).archiveName).toBe("Vyuha_9.8.7_Windows-x64_Client_Package_Licensed.zip");
  });

  it("refuse an unknown platform and the other machine's installer", () => {
    expect(() => packageNames({ version: V, platform: "linux" })).toThrow(/--platform must be one of/);
    expect(installerMismatch("windows", "Vyuha_9.8.7_x64-setup.exe")).toBeNull();
    expect(installerMismatch("windows", "Vyuha_9.8.7_aarch64.dmg")).toMatch(/needs the \.exe/);
    expect(installerMismatch("macos-apple-silicon", "Vyuha_9.8.7_aarch64.dmg")).toBeNull();
    expect(installerMismatch("macos-apple-silicon", "Vyuha_9.8.7_x64.dmg")).toMatch(/Intel DMG/);
    expect(installerMismatch("macos-intel", "Vyuha_9.8.7_x64.dmg")).toBeNull();
    expect(installerMismatch("macos-intel", "Vyuha_9.8.7_aarch64.dmg")).toMatch(/Apple silicon DMG/);
    expect(installerMismatch("macos-intel", "Vyuha_9.8.7_x64-setup.exe")).toMatch(/needs a \.dmg/);
  });

  it("CHECKSUMS names the renamed files", () => {
    const { installerName, signatureName } = packageNames({ version: V });
    expect(checksumsText([{ sha: "AA", name: installerName }, { sha: "BB", name: signatureName }])).toBe(
      "# SHA-256 checksums\nAA  Vyuha_9.8.7_Windows-x64-Setup.exe\nBB  Vyuha_9.8.7_Windows-x64-Setup.exe.sig\n",
    );
  });
});

describe("every START_HERE.md says which package is whose", () => {
  for (const platform of PLATFORM_IDS as string[]) {
    it(`${platform}: the "Which package is mine?" block names all three ZIPs and how to tell a Mac's chip`, () => {
      const t = startHere({ version: V, platform });
      expect(t).toContain("## Which package is mine?");
      expect(t).toContain("**Windows PC** (Windows 10 or 11, 64-bit) → Vyuha_9.8.7_Windows-x64_Client_Package");
      expect(t).toContain("**Mac with Apple silicon** → Vyuha_9.8.7_macOS-Apple-Silicon_Client_Package");
      expect(t).toContain("**Mac with an Intel processor** → Vyuha_9.8.7_macOS-Intel_Client_Package");
      expect(t).toContain('Apple menu → About This Mac. "Chip: Apple M…"');
      expect(t).toContain('"Processor: … Intel …" means Intel');
      expect(t).toContain("One licence covers Windows and macOS, at the same price.");
      expect(t).toContain(`# Vyuha 9.8.7 — Client package (${packageNames({ version: V, platform }).archiveName.split("_")[2]})`);
      // The install step names the RENAMED installer that sits beside START_HERE.md.
      expect(t).toContain(packageNames({ version: V, platform }).installerName);
    });
  }

  it("Windows keeps the SmartScreen step; a Mac gets drag-to-Applications, Open Anyway and its data folder", () => {
    const win = startHere({ version: V, platform: "windows" });
    expect(win).toContain("1. Run Vyuha_9.8.7_Windows-x64-Setup.exe on Windows 10 or 11 (64-bit).");
    expect(win).toContain("More info → Run anyway");
    expect(win).not.toMatch(/Open Anyway/);
    for (const platform of ["macos-apple-silicon", "macos-intel"]) {
      const mac = startHere({ version: V, platform });
      expect(mac).toContain("macOS 11 or later");
      expect(mac).toContain("drag Vyuha into Applications");
      expect(mac).toContain("not signed or notarised by Apple");
      expect(mac).toContain('"Open Anyway"');
      expect(mac).toContain("~/Library/Application Support/in.vyuha.tradejournal");
      expect(mac).not.toMatch(/SmartScreen|\.sig file/);
    }
  });
});

describe("the builder uses the shared names", () => {
  it("imports them rather than spelling its own", () => {
    const builder = readFileSync(path.join(process.cwd(), "scripts", "build-client-package.mjs"), "utf8");
    expect(builder).toContain('from "./lib/client-package.mjs"');
    expect(builder).toContain("--platform");
    expect(builder).toContain("--installer");
    expect(builder).not.toMatch(/_Client_Package\$\{/); // the old single archive name
  });
});
