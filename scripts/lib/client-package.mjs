/**
 * The pure half of scripts/build-client-package.mjs: the three client
 * packages' names and the START_HERE.md each one carries. No file system, so
 * tests/platform-copy.test.ts and tests/client-package-names.test.ts can pin
 * the copy without a signed installer on disk.
 *
 * Owner ruling 2026-11-19: macOS is sold openly, under the same licence and
 * price as Windows, and the Mac package is shipped SEPARATELY with a name that
 * says which machine it is for. So there is one package per kind of computer:
 *
 *   Vyuha_<ver>_Windows-x64_Client_Package.zip          Vyuha_<ver>_Windows-x64-Setup.exe (+ .sig)
 *   Vyuha_<ver>_macOS-Apple-Silicon_Client_Package.zip  Vyuha_<ver>_macOS-Apple-Silicon.dmg
 *   Vyuha_<ver>_macOS-Intel_Client_Package.zip          Vyuha_<ver>_macOS-Intel.dmg
 *
 * Only the copies INSIDE the ZIP are renamed. The GitHub release assets keep
 * Tauri's names (Vyuha_<ver>_x64-setup.exe, Vyuha_<ver>_aarch64.dmg,
 * Vyuha_<ver>_x64.dmg) because the updater and
 * scripts/verify-release-signatures.mjs match on them.
 */

export const PLATFORMS = {
  windows: {
    tag: "Windows-x64",
    label: "Windows (64-bit)",
    installerSuffix: "-Setup.exe",
    hasSignature: true,
    releaseAsset: (v) => `Vyuha_${v}_x64-setup.exe`,
  },
  "macos-apple-silicon": {
    tag: "macOS-Apple-Silicon",
    label: "Mac with Apple silicon",
    installerSuffix: ".dmg",
    hasSignature: false,
    releaseAsset: (v) => `Vyuha_${v}_aarch64.dmg`,
  },
  "macos-intel": {
    tag: "macOS-Intel",
    label: "Mac with an Intel processor",
    installerSuffix: ".dmg",
    hasSignature: false,
    releaseAsset: (v) => `Vyuha_${v}_x64.dmg`,
  },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS);

export function platformOf(id) {
  const p = PLATFORMS[id];
  if (!p) throw new Error(`--platform must be one of ${PLATFORM_IDS.join(", ")} (got "${id}").`);
  return p;
}

/** The ZIP's name, the installer's name inside it, and its .sig (Windows only). */
export function packageNames({ version, platform = "windows", licensed = false }) {
  const p = platformOf(platform);
  const installerName = `Vyuha_${version}_${p.tag}${p.installerSuffix}`;
  return {
    archiveName: `Vyuha_${version}_${p.tag}_Client_Package${licensed ? "_Licensed" : ""}.zip`,
    installerName,
    signatureName: p.hasSignature ? `${installerName}.sig` : null,
  };
}

/**
 * Refuse an installer that is not for the platform asked for: a DMG in the
 * Windows package, an .exe in a Mac one, or the other kind of Mac's DMG (the
 * Tauri names say aarch64 / x64). Returns an error message, or null when fine.
 */
export function installerMismatch(platform, fileName) {
  const p = platformOf(platform);
  const n = fileName.toLowerCase();
  if (platform === "windows") return n.endsWith(".exe") ? null : `The Windows package needs the .exe installer, not ${fileName}.`;
  if (!n.endsWith(".dmg")) return `The ${p.tag} package needs a .dmg, not ${fileName}.`;
  if (platform === "macos-apple-silicon" && /(_x64|x86_64|intel)/.test(n)) return `${fileName} is the Intel DMG; the Apple-Silicon package needs the aarch64 one.`;
  if (platform === "macos-intel" && /(aarch64|arm64|apple-silicon)/.test(n)) return `${fileName} is the Apple silicon DMG; the Intel package needs the x64 one.`;
  return null;
}

/** The block every START_HERE.md carries, so a buyer can tell which ZIP is theirs. */
export function whichPackageBlock(version) {
  const n = (platform) => packageNames({ version, platform }).archiveName.replace(/\.zip$/, "");
  return [
    "## Which package is mine?",
    "Vyuha is one licence, at one price, for Windows and macOS. There is one package per kind of computer:",
    `- **Windows PC** (Windows 10 or 11, 64-bit) → ${n("windows")}`,
    `- **Mac with Apple silicon** → ${n("macos-apple-silicon")}`,
    `- **Mac with an Intel processor** → ${n("macos-intel")}`,
    "",
    'On a Mac, open the Apple menu → About This Mac. "Chip: Apple M…" (M1, M2, M3, M4 …) means Apple-Silicon; "Processor: … Intel …" means Intel.',
    "If this is not the package for your computer, ask the vendor for the right one — your licence works in all three.",
  ];
}

const MAC_DATA = "~/Library/Application Support/in.vyuha.tradejournal";

/** The Gatekeeper sentence. Every surface that tells a buyer to install on a Mac carries it. */
export const MAC_GATEKEEPER =
  'The macOS app is not signed or notarised by Apple, so the first time you open it macOS says it cannot verify the developer. That is expected. Open System Settings → Privacy & Security, scroll to the message about Vyuha and click "Open Anyway" (on macOS 14 and earlier, Control-click the app → Open also works). You are asked once.';

/** START_HERE.md for one package. */
export function startHere({ version, platform = "windows", licensed = false }) {
  const p = platformOf(platform);
  const { installerName } = packageNames({ version, platform });
  const activation = licensed
    ? "Your individual activation key is included in LICENSE.txt. Keep it private and do not forward it."
    : "Your individual activation key is delivered separately by the vendor. Do not share it once received.";
  const mac = platform !== "windows";
  const install = mac
    ? [
        `1. Verify the checksum below, then open ${installerName} (macOS 11 or later, on a ${p.label}) and drag Vyuha into Applications.`,
        `2. Open Vyuha from Applications. ${MAC_GATEKEEPER}`,
        "3. In Vyuha, go to Settings → License.",
        `4. ${activation}`,
        "",
        `Your journal lives in ${MAC_DATA}. To uninstall, drag Vyuha from Applications to the Bin; the data folder stays until you delete it yourself.`,
      ]
    : [
        `1. Run ${installerName} on Windows 10 or 11 (64-bit).`,
        "2. If Windows SmartScreen appears, choose More info → Run anyway only after verifying the installer checksum below.",
        "3. Open Vyuha, then go to Settings → License.",
        `4. ${activation}`,
      ];
  const integrity = mac
    ? [
        "## Integrity",
        "Compare the DMG's SHA-256 below before opening it. Updates are signed with Vyuha's update key and checked by the app before they install — on macOS exactly as on Windows.",
      ]
    : [
        "## Integrity",
        "Compare the installer SHA-256 below before running it. The .sig file is the update signature for this installer and should stay alongside it when stored or published.",
      ];
  return [
    `# Vyuha ${version} — Client package (${p.tag})`,
    "",
    `This package contains the official ${mac ? `macOS installer for a ${p.label}` : "Windows installer"} only. It does not contain source code, your data, vendor signing keys, or any other customer's licence.`,
    "",
    ...whichPackageBlock(version),
    "",
    "## Install",
    ...install,
    "",
    "Connecting a broker's API? Open BROKER_API_SETUP_GUIDE.html",
    "",
    "## Licence and support",
    "One licence covers Windows and macOS, at the same price. The licence is signed by the vendor and verified locally; activation does not transmit trades or personal data. For support, quote the Key ID in Settings → License—never send the full key in a chat or screenshot.",
    "For a machine-bound licence, install first and send the Machine ID shown in Settings → License to the vendor. They will issue a key that activates on that computer only. Moving to another computer — Windows or Mac — shows a new Machine ID; send it to the vendor in the same way.",
    "",
    ...integrity,
    "",
    "## Honest security boundary",
    "This package contains no build source or vendor private keys. Signed licences deter sharing, and machine-bound keys restrict normal use to one computer. Like any offline desktop software, copying or reverse engineering cannot be made mathematically impossible.",
    "",
    "Vyuha is a record-keeping and analytics product, not investment advice.",
    "",
  ].join("\n");
}

/** CHECKSUMS.txt — names the RENAMED files, exactly as they sit in the ZIP. */
export function checksumsText(entries) {
  return ["# SHA-256 checksums", ...entries.map(({ sha, name }) => `${sha}  ${name}`), ""].join("\n");
}
