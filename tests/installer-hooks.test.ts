import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tauri's stock uninstaller draws a "Delete the application data" checkbox
 * that names neither the journal nor the licence key, and it also appears
 * mid-upgrade because the installer runs the OLD uninstaller interactively.
 * The owner's own database and lifetime key were wiped that way (v3.8 WS6).
 * src-tauri/installer-hooks.nsh now warns, copies the raw database files and
 * attachments to Documents\Vyuha-backup-<date>, and lets Cancel end the
 * uninstall with nothing touched. Nothing in the suite executes NSIS, so this
 * pins the source: the hook is only compiled at release, by the orchestrator.
 */

const root = process.cwd();
const nsh = readFileSync(path.join(root, "src-tauri/installer-hooks.nsh"), "utf8");
const tauriConf = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));

/** Body of a `!macro NAME … !macroend` block. */
function macroBody(name: string): string {
  const m = nsh.match(new RegExp(`^!macro ${name}\\r?\\n([\\s\\S]*?)^!macroend`, "m"));
  expect(m, `!macro ${name} not found in installer-hooks.nsh`).not.toBeNull();
  return m![1];
}

/** The MessageBox line only (the copy lines carry the same words, and must not vouch for it). */
function messageBox(body: string): string {
  const line = body.split(/\r?\n/).find((l) => /^\s*MessageBox\b/.test(l));
  expect(line, "pre-uninstall hook has no MessageBox").toBeDefined();
  return line!;
}

describe("installer-hooks.nsh pre-uninstall guard", () => {
  const body = macroBody("NSIS_HOOK_PREUNINSTALL");

  it("still stops the sidecar first, before the copy", () => {
    const kill = body.indexOf("!insertmacro VYUHA_KILL_SIDECAR");
    const copy = body.indexOf("CopyFiles");
    expect(kill).toBeGreaterThanOrEqual(0);
    expect(copy).toBeGreaterThan(kill);
  });

  it("warns with an OK/Cancel box that names the journal database, the licence key and their folder", () => {
    const box = messageBox(body);
    expect(box).toMatch(/MB_OKCANCEL/);
    expect(box).toMatch(/journal database/i);
    expect(box).toMatch(/licen[cs]e key/i);
    expect(box).toMatch(/\$APPDATA\\\$\{BUNDLEID\}/);
    expect(box, "the box must say where the copy goes ($7 holds the Documents target)").toMatch(/\$7/);
  });

  it("Cancel ends the uninstall with exit code 1 before anything is copied or removed", () => {
    const box = messageBox(body);
    expect(box).toMatch(/\/SD IDOK IDOK \+3\s*$/);
    const after = body.slice(body.indexOf(box) + box.length);
    // The two instructions OK jumps over, in order, then the copy.
    expect(after).toMatch(/^\s*SetErrorLevel 1\s*\r?\n\s*Quit\s*\r?\n\s*CreateDirectory/);
  });

  it("copies the raw *.sqlite* files (wal/shm/journal siblings included) to Documents\\Vyuha-backup-<date>", () => {
    expect(body).toMatch(/\$\{GetTime\} "" "L" \$0 \$1 \$2/);
    expect(body).toMatch(/StrCpy \$7 "\$DOCUMENTS\\Vyuha-backup-\$2-\$1-\$0"/);
    expect(body).toMatch(/CreateDirectory "\$7"/);
    expect(body).toMatch(/CopyFiles \/SILENT "\$APPDATA\\\$\{BUNDLEID\}\\\*\.sqlite\*" "\$7"/);
  });

  it("copies the sidecar's pre-migration backups folder too", () => {
    // scripts/desktop-server.mjs writes them to $APPDATA\<bundle>\backups\
    // and the install guide points buyers at them.
    expect(body).toMatch(/\$\{If\} \$\{FileExists\} "\$APPDATA\\\$\{BUNDLEID\}\\backups\\\*\.\*"/);
    expect(body).toMatch(/CreateDirectory "\$7\\backups"/);
    expect(body).toMatch(/CopyFiles \/SILENT "\$APPDATA\\\$\{BUNDLEID\}\\backups\\\*\.sqlite" "\$7\\backups"/);
  });

  it("copies the attachments folder recursively beside the database", () => {
    expect(body).toMatch(/CopyFiles \/SILENT "\$APPDATA\\\$\{BUNDLEID\}\\attachments\\\*\.\*" "\$7\\attachments"/);
  });

  it("copies whether or not the delete-app-data box is ticked, and never in update mode", () => {
    // The copy is not nested inside a $DeleteAppDataCheckboxState condition:
    // the only use of that state is to word the message.
    const stateUses = [...body.matchAll(/\$DeleteAppDataCheckboxState/g)].length;
    expect(stateUses).toBe(1);
    expect(body).toMatch(/\$\{If\} \$UpdateMode <> 1/);
    // Shell-var context is forced per-user for the copy and restored after.
    expect(body).toMatch(/SetShellVarContext current/);
    expect(body).toMatch(/!insertmacro SetContext/);
  });

  // ── The copy must be PROVEN before anything is removed ────────────────────
  // CopyFiles /SILENT reports failure only through the NSIS error flag (full
  // disk, an unhydratable OneDrive placeholder, a locked -wal sibling). Until
  // 2026-09-04 nothing read it, so the template's RmDir ran even when the
  // "safety copy" the docs promise had silently produced nothing.

  it("clears the error flag immediately before every CopyFiles", () => {
    const lines = body.split(/\r?\n/).map((l) => l.trim());
    const copies = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith("CopyFiles"));
    expect(copies.length).toBeGreaterThanOrEqual(3);
    for (const [line, i] of copies) {
      const before = lines.slice(0, i).filter((l) => l && !l.startsWith(";"));
      expect(before.at(-1), `no ClearErrors immediately before: ${line}`).toBe("ClearErrors");
    }
  });

  it("reads the flag after every CopyFiles instead of dropping it", () => {
    const lines = body.split(/\r?\n/).map((l) => l.trim());
    for (const [i, line] of lines.entries()) {
      if (!line.startsWith("CopyFiles")) continue;
      const after = lines.slice(i + 1).filter((l) => l && !l.startsWith(";"));
      expect(after[0], `the error flag is dropped after: ${line}`).toBe("${If} ${Errors}");
    }
  });

  it("confirms vyuha.sqlite actually arrived, independently of the flag", () => {
    expect(body).toMatch(/\$\{IfNot\} \$\{FileExists\} "\$7\\vyuha\.sqlite"/);
  });

  it("a failed copy stops the uninstall with exit code 1 before the macro ends", () => {
    // The guard is the LAST thing the macro does, so no removal can follow it.
    const tail = body.slice(body.lastIndexOf("${IfNot} ${FileExists}"));
    const stop = tail.match(/MessageBox[^\n]*\n\s*SetErrorLevel 1\s*\r?\n\s*Quit/);
    expect(stop, "no MessageBox + SetErrorLevel 1 + Quit after the arrival check").not.toBeNull();
    const box = stop![0].split(/\r?\n/)[0];
    expect(box, "the failure box must say nothing was removed").toMatch(/NOTHING has been removed/);
    expect(box, "and must name the two things that cause it").toMatch(/disk space/i);
    expect(box).toMatch(/OneDrive/i);
    expect(box, "a failure box the user cannot dismiss into a delete").toMatch(/MB_OK\b/);
    // Nothing but the guard may follow the last CopyFiles-bearing branch.
    expect(tail.indexOf("CopyFiles"), "a copy runs after the failure guard").toBe(-1);
  });

  it("the guard cites the tauri CLI whose template it was verified against", () => {
    const installed = JSON.parse(
      readFileSync(path.join(root, "node_modules/@tauri-apps/cli/package.json"), "utf8"),
    ).version as string;
    expect(nsh, `hook comment cites a tauri CLI other than the installed ${installed}`).toContain(
      `@tauri-apps/cli ${installed}`,
    );
  });

  it("the install-side hooks are untouched: preinstall only kills the sidecar", () => {
    expect(macroBody("NSIS_HOOK_PREINSTALL").trim()).toBe("!insertmacro VYUHA_KILL_SIDECAR");
  });
});

describe("tauri.conf.json wires the hooks file", () => {
  it("bundle.windows.nsis.installerHooks still points at installer-hooks.nsh", () => {
    expect(tauriConf.bundle?.windows?.nsis?.installerHooks).toBe("installer-hooks.nsh");
  });

  it("does not silently opt into deleteAppDataOnUninstall", () => {
    expect(tauriConf.bundle?.windows?.nsis?.deleteAppDataOnUninstall).toBeUndefined();
  });
});
