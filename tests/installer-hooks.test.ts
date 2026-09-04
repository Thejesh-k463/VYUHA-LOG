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
 *
 * The first version of this file pinned SHAPE (the lines exist, in order) and
 * not the DECISION: deleting `${If} $9 != ""` (always stop) or inverting it to
 * `== ""` (stop only when the copy worked) passed 15/15. The block-structure
 * assertions below read the nesting, so each instruction is checked for the
 * condition it actually sits under.
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

/** A source line with the LogicLib conditions it is nested under, outermost first. */
type Nested = { line: string; stack: string[] };

/**
 * Walk the macro tracking `${If…}` / `${IfNot…}` / `${Unless…}` blocks. An
 * `${Else}` branch is recorded as `NOT(<condition>)`. Comments and blanks are
 * dropped so nothing can hide a condition inside one.
 */
function nest(body: string): Nested[] {
  const out: Nested[] = [];
  const stack: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    if (/^\$\{(If|IfNot|Unless)\b/.test(line)) {
      stack.push(line);
      continue;
    }
    if (/^\$\{(EndIf|EndUnless)\}/.test(line)) {
      expect(stack.length, `unbalanced ${line}`).toBeGreaterThan(0);
      stack.pop();
      continue;
    }
    if (/^\$\{Else/.test(line)) {
      expect(stack.length, `${line} outside any block`).toBeGreaterThan(0);
      stack[stack.length - 1] = `NOT(${stack[stack.length - 1]})`;
      continue;
    }
    out.push({ line, stack: [...stack] });
  }
  expect(stack, "macro ends inside an open block").toEqual([]);
  return out;
}

const JOURNAL_GATE = '${If} ${FileExists} "$APPDATA\\${BUNDLEID}\\vyuha.sqlite"';
const BACKUPS_GATE = '${If} ${FileExists} "$APPDATA\\${BUNDLEID}\\backups\\*.sqlite"';
const FAILURE_GATE = '${If} $9 != ""';
const ARRIVAL_CHECK = '${IfNot} ${FileExists} "$7\\vyuha.sqlite"';

describe("installer-hooks.nsh pre-uninstall guard", () => {
  const body = macroBody("NSIS_HOOK_PREUNINSTALL");
  const nested = nest(body);

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

  it("copies the sidecar's pre-migration backups folder too, gated on a .sqlite being there", () => {
    // scripts/desktop-server.mjs writes them to $APPDATA\<bundle>\backups\
    // and the install guide points buyers at them. The gate names the files
    // copied: `backups\*.*` is true for an EMPTY folder, and an empty copy
    // sets the error flag that stops the uninstall.
    const copy = nested.find((n) => n.line === 'CopyFiles /SILENT "$APPDATA\\${BUNDLEID}\\backups\\*.sqlite" "$7\\backups"');
    expect(copy, "no backups CopyFiles").toBeDefined();
    expect(copy!.stack.at(-1), "the backups copy must sit directly under its own .sqlite gate").toBe(BACKUPS_GATE);
    expect(body).toMatch(/CreateDirectory "\$7\\backups"/);
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

  // ── Nothing to protect → nothing to guard ─────────────────────────────────
  // The first guard gated on `$APPDATA\${BUNDLEID}\*.*`, which is TRUE for an
  // empty folder (a crashed first launch, a stray log). With no vyuha.sqlite
  // the copy matched nothing, the flag went up, the arrival check failed, and
  // the STOP box + exit 1 fired on every attempt, /S included: the app could
  // never be uninstalled. Second audit, 2026-09-04.

  it("the whole copy-and-guard is gated on vyuha.sqlite existing, never on the folder", () => {
    expect(body, "the empty-folder gate is back").not.toContain('${FileExists} "$APPDATA\\${BUNDLEID}\\*.*"');
    // Every copy, both boxes, the arrival check's body and the failure guard's
    // body — i.e. everything that can fail or stop — must sit under the gate.
    const guarded = nested.filter(
      (n) =>
        n.line.startsWith("CopyFiles") ||
        n.line.startsWith("MessageBox") ||
        n.stack.includes(FAILURE_GATE) ||
        n.stack.includes(ARRIVAL_CHECK),
    );
    expect(guarded.length, "3 copies + the OK/Cancel box + STOP box, SetErrorLevel, Quit under the failure gate + 1 under the arrival check").toBe(8);
    for (const n of guarded) {
      expect(n.stack, `not under the journal gate: ${n.line.slice(0, 60)}`).toContain(JOURNAL_GATE);
    }
    // And the journal gate sits inside the update-mode gate, not around it.
    const gate = nested.find((n) => n.stack.at(-1) === JOURNAL_GATE);
    expect(gate?.stack, "journal gate must be nested inside `$UpdateMode <> 1`").toContain("${If} $UpdateMode <> 1");
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

  it("reads the flag after every CopyFiles, and every ${If} ${Errors} body records WHY in $9", () => {
    const lines = body.split(/\r?\n/).map((l) => l.trim());
    for (const [i, line] of lines.entries()) {
      if (!line.startsWith("CopyFiles")) continue;
      const after = lines.slice(i + 1).filter((l) => l && !l.startsWith(";"));
      expect(after[0], `the error flag is dropped after: ${line}`).toBe("${If} ${Errors}");
    }
    // A `${If} ${Errors}` whose body does not assign $9 reads the flag and
    // then throws it away — the failure never reaches the guard.
    const errorBodies = nested.filter((n) => n.stack.at(-1) === "${If} ${Errors}");
    const errorBlocks = nested.filter((n) => n.stack.includes("${If} ${Errors}")).length;
    expect(errorBlocks, "no ${If} ${Errors} block has a body").toBeGreaterThan(0);
    expect(body.match(/\$\{If\} \$\{Errors\}/g)?.length, "one ${If} ${Errors} per CopyFiles").toBe(
      lines.filter((l) => l.startsWith("CopyFiles")).length,
    );
    const assigns = errorBodies.filter((n) => /^StrCpy \$9 "[^"]+"$/.test(n.line)).length;
    expect(assigns, "every ${If} ${Errors} body must set $9 to a non-empty reason").toBe(
      body.match(/\$\{If\} \$\{Errors\}/g)!.length,
    );
  });

  it("confirms vyuha.sqlite actually arrived, independently of the flag, and records the miss in $9", () => {
    const check = nested.find((n) => n.stack.at(-1) === ARRIVAL_CHECK);
    expect(check, "no body under the arrival check").toBeDefined();
    expect(check!.line).toMatch(/^StrCpy \$9 "[^"]+"$/);
  });

  it("the STOP box, SetErrorLevel 1 and Quit sit INSIDE `${If} $9 != \"\"` — stop on failure, and only then", () => {
    // Deleting the condition stops every uninstall; inverting it stops only
    // the ones whose copy WORKED. Both passed the shape-only version.
    const stop = nested.filter((n) => n.stack.at(-1) === FAILURE_GATE);
    expect(stop.map((n) => n.line.split(" ")[0]), "exactly these three, in this order, under the failure gate").toEqual([
      "MessageBox",
      "SetErrorLevel",
      "Quit",
    ]);
    expect(stop[1].line).toBe("SetErrorLevel 1");
    const box = stop[0].line;
    expect(box).toMatch(/MB_ICONSTOP/);
    expect(box, "the failure box must say nothing was removed").toMatch(/NOTHING has been removed/);
    expect(box, "and must name the two things that cause it").toMatch(/disk space/i);
    expect(box).toMatch(/OneDrive/i);
    expect(box, "a failure box the user cannot dismiss into a delete").toMatch(/MB_OK\b/);
    expect(box, "a silent uninstall must still take the exit-1 path").toMatch(/\/SD IDOK/);
    // No other MB_ICONSTOP / Quit lives anywhere else under a different condition.
    const strays = nested.filter((n) => /MB_ICONSTOP/.test(n.line) && n.stack.at(-1) !== FAILURE_GATE);
    expect(strays).toEqual([]);
    // The guard is the LAST thing the macro does under the journal gate, so
    // no copy — and no removal — can follow it.
    const tail = body.slice(body.lastIndexOf(FAILURE_GATE));
    expect(tail.indexOf("CopyFiles"), "a copy runs after the failure guard").toBe(-1);
  });

  it("pins the CLI-version comment: on a @tauri-apps/cli bump, RE-VERIFY the template facts the hook relies on and update it", () => {
    // The comment lists what the hook borrows from the generated installer.nsi
    // (LogicLib order, $9 untouched, /SD defaults, /UPDATE skipping the
    // uninstaller). Nothing here checks those facts against the template — a
    // bump makes this red so a human re-reads the template before the comment
    // is edited to match.
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
