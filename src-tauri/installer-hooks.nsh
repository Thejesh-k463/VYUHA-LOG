; Vyuha — NSIS installer hooks
;
; ── Why this file exists ──────────────────────────────────────────────────
;
; v2.99.30 shipped a completely new app mark. The icon pipeline was correct at
; every step — icon.ico provably contained the new art, and the exe was linked
; from it — yet installed machines kept showing the OLD icon on the desktop
; shortcut.
;
; The cause is Windows, not the build. Every version of Vyuha installs to the
; SAME path (%LOCALAPPDATA%\Vyuha\vyuha.exe, overwritten in place), and
; Explorer's shell icon cache is keyed on that path. Rewriting the file at a
; path Explorer has already cached does not reliably invalidate the entry, so
; the stale icon survives a reinstall until the cache is cleared by hand.
;
; Tauri's generated installer makes this worse in one specific case: its
; CreateOrUpdateDesktopShortcut returns EARLY, before CreateShortcut, when
; $UpdateMode = 1 — the flag tauri-plugin-updater passes when it applies an
; update in the background. So a user who updates in place never gets the
; shortcut rewritten at all.
;
; NSIS_HOOK_POSTINSTALL is inserted unconditionally in Section Install — it is
; NOT inside the $UpdateMode guard — which is what makes it the one place that
; can fix both paths.
;
; ── What it does, and what it deliberately does not ───────────────────────
;
; Recreates the desktop shortcut ONLY IF ONE ALREADY EXISTS, then asks the
; shell to refresh its icon associations. The existence check is the whole
; point of the design: a user who declined a desktop shortcut (or installed
; with /NS) must not have one appear because they updated. Creating shortcuts
; nobody asked for is exactly the behaviour people uninstall software over.

; ── Stopping the sidecar before install / uninstall (2026-08-15) ──────────
;
; Uninstall + reinstall of v2.99.96 failed with
;   "Error opening file for writing: …\AppData\Local\Vyuha\server\node\node.exe"
; The app is a Node sidecar (server\node\node.exe) spawned by vyuha.exe. Tauri's
; generated installer only checks for and kills ${MAINBINARYNAME}.exe; it knows
; nothing about the child. If vyuha.exe died without reaping it (crash, task
; manager, an exit path that skipped the window-destroy handler) an orphaned
; node.exe keeps running, and Windows will not let the installer overwrite or
; delete an executable that is mapped into a live process.
;
; VYUHA_KILL_SIDECAR stops ONLY node.exe / vyuha.exe processes whose
; ExecutablePath lies under $INSTDIR. It is deliberately NOT `taskkill /IM
; node.exe`: the user may well have their own Node running (a dev server, an
; Electron app that ships one, VS Code extensions), and an installer that kills
; those would be doing far more damage than the bug it fixes.
;
; Quoting: $INSTDIR is handed to PowerShell through an environment variable
; rather than spliced into the command line, so a path with spaces, quotes or
; wildcard characters needs no escaping at all — the process's environment is
; inherited by nsExec's child. `$$` is NSIS for a literal `$`, so `$$_` and
; `$$d` reach PowerShell as `$_` and `$d`. StartsWith() rather than -like so
; `[` in a path is not read as a wildcard. Verified 2026-08-15 with -WhatIf
; against "C:\Program Files\nodejs" (matched) and a fake spaced dir (no match).
;
; The prefix ends with a backslash so "…\Vyuha" never matches "…\Vyuha2".
; Errors are swallowed on purpose: a machine without PowerShell or without WMI
; must still be able to install — the worst case is the original error.
!macro VYUHA_KILL_SIDECAR
  System::Call 'kernel32::SetEnvironmentVariable(t "VYUHA_INSTDIR", t "$INSTDIR")'
  ; Backtick-delimited NSIS string so the ' and " inside need no NSIS escaping.
  nsExec::ExecToLog `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d=$$env:VYUHA_INSTDIR.TrimEnd('\')+'\'; Get-CimInstance Win32_Process | Where-Object { ($$_.Name -eq 'node.exe' -or $$_.Name -eq '${MAINBINARYNAME}.exe') -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  ; Give the kernel a moment to release the image mapping before we write.
  Sleep 500
!macroend

; Both hooks run BEFORE the template's own CheckIfAppIsRunning, so by the time
; Tauri looks for vyuha.exe there is nothing left holding node.exe either.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro VYUHA_KILL_SIDECAR
!macroend

; ── Guarding the journal and licence at uninstall (2026-09-04) ────────────
;
; Tauri's uninstaller draws a "Delete the application data" checkbox on its
; confirm page (un.ConfirmShow in the generated installer.nsi) and, when it is
; ticked, runs `RmDir /r "$APPDATA\${BUNDLEID}"`. That folder holds
; vyuha.sqlite — the whole journal AND the licence key (settings.license_key).
; The checkbox names neither, and it also appears mid-upgrade: the installer's
; reinstall page runs the OLD uninstaller interactively (PageLeaveReinstall,
; `ExecWait '$R1 _?=$4'`, no /S). The owner's own database and lifetime key
; were wiped exactly that way. The in-app backup would not have saved the key
; either — the envelope blanks licenseKey (lib/backup-format.ts).
;
; So before anything is removed this hook (1) stops the sidecar, (2) says in
; plain words what lives in the folder and that a copy is being made — Cancel
; ends the uninstall with nothing touched — and (3) copies the raw database
; files (*.sqlite plus any -wal/-shm/-journal sibling), the sidecar's own
; backups\ folder of pre-migration snapshots, and attachments\ to
; $DOCUMENTS\Vyuha-backup-<yyyy-mm-dd>\ (the user's Documents folder). The
; copy is made even when the checkbox is left unticked: it is cheap, and the
; alternative is trusting that a label which never says "journal" was read.
; It is made ONLY when vyuha.sqlite exists — a folder with no journal has
; nothing to protect, and gating on the folder itself once made the copy
; "fail" on every run and blocked the uninstall outright (see the gate below).
;
; CopyFiles /SILENT reports failure ONLY through the NSIS error flag — a full
; disk, a OneDrive files-on-demand placeholder that cannot be hydrated, and a
; locked -wal sibling all fail quietly. Nothing read that flag until
; 2026-09-04, so "before anything can be deleted" was true only when the copy
; happened to work; the template's RmDir ran either way. Each copy is now
; bracketed by ClearErrors/${Errors}, the arrival of vyuha.sqlite is confirmed
; independently of the flag, and any failure ends the uninstall with exit
; code 1 before Section Uninstall can remove a byte.
;
; Skipped in update mode: tauri-plugin-updater runs the installer with /UPDATE,
; which never invokes the uninstaller interactively, and the template's own
; RmDir is guarded by `$UpdateMode <> 1` — nothing can delete data there, so a
; copy on every background update would only pile folders into Documents.
; A silent uninstall (/S) takes the MessageBox's /SD default of OK and copies.
; Cancel exits with error level 1, which the upgrade path reads as "user
; cancelled the uninstaller" and returns to its reinstall page (a script Abort
; would exit 2 and show "unable to uninstall", which is the wrong story).
;
; What a hook may use, verified against the installer.nsi template embedded in
; @tauri-apps/cli 2.11.4 (NSIS 3.11): the hooks file is !included AFTER
; MUI2.nsh (which pulls LogicLib), FileFunc.nsh, WordFunc.nsh, StrFunc.nsh and
; utils.nsh, so ${GetTime}, ${If}/${FileExists}, $DOCUMENTS and the template's
; own SetContext macro all resolve. FileFunc's ${GetTime} is an
; artificial-function call in NSIS 3, so it works inside the un. section
; without a separate `!insertmacro un.GetTime` (the template itself uses
; ${GetOptions} in un.onInit the same way). $DeleteAppDataCheckboxState is
; filled by un.ConfirmLeave, which runs before Section Uninstall, so the hook
; can read it; ${BUNDLEID} and $UpdateMode are defined after the !include but
; before the macro is inserted, which is when they are resolved.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro VYUHA_KILL_SIDECAR
  ${If} $UpdateMode <> 1
    ; Per-user $APPDATA / $DOCUMENTS whatever the install mode; restored below.
    SetShellVarContext current
    ; Gate on the JOURNAL, not the folder: `\*.*` is true for an EMPTY folder
    ; (a crashed first launch, a stray log), and with nothing to copy the
    ; CopyFiles below sets the error flag and the arrival check fails, so the
    ; STOP box fired on every attempt — interactive or /S — and the app could
    ; never be uninstalled (second audit, 2026-09-04). No vyuha.sqlite means
    ; there is nothing to protect: skip the copy AND the guard, silently.
    ${If} ${FileExists} "$APPDATA\${BUNDLEID}\vyuha.sqlite"
      ; $0 = dd, $1 = mm, $2 = yyyy (zero-padded by FileFunc).
      ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
      StrCpy $7 "$DOCUMENTS\Vyuha-backup-$2-$1-$0"
      StrCpy $8 "They stay in place unless you ticked 'Delete the application data'."
      ${If} $DeleteAppDataCheckboxState = 1
        StrCpy $8 "You ticked 'Delete the application data', so that folder will be ERASED once the copy is made."
      ${EndIf}
      ; OK jumps past the two cancel instructions (SetErrorLevel + Quit).
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Your journal database and your licence key live in:$\r$\n$APPDATA\${BUNDLEID}$\r$\n$\r$\n$8$\r$\n$\r$\nBefore anything is removed, Vyuha will copy the journal database (vyuha.sqlite) and your attachments to:$\r$\n$7$\r$\n$\r$\nOK continues the uninstall. Cancel keeps everything exactly as it is." /SD IDOK IDOK +3
      SetErrorLevel 1
      Quit
      CreateDirectory "$7"
      ; $9 = why the copy failed; empty means it did not. CopyFiles only SETS
      ; the error flag, never clears it, so every copy is preceded by
      ; ClearErrors and read immediately — a flag left over from an earlier
      ; copy would otherwise be reported against the wrong file.
      StrCpy $9 ""
      ClearErrors
      CopyFiles /SILENT "$APPDATA\${BUNDLEID}\*.sqlite*" "$7"
      ${If} ${Errors}
        StrCpy $9 "the journal database could not be copied"
      ${EndIf}
      ; The sidecar's own pre-migration snapshots (scripts/desktop-server.mjs
      ; keeps the newest ten in backups\pre-migrate-<stamp>.sqlite). The
      ; install guide points buyers at them, so they travel with the journal.
      ; Same trap as above: an empty backups\ satisfies `\*.*` and would make
      ; the .sqlite copy fail, so the gate names the files actually copied.
      ${If} ${FileExists} "$APPDATA\${BUNDLEID}\backups\*.sqlite"
        CreateDirectory "$7\backups"
        ClearErrors
        CopyFiles /SILENT "$APPDATA\${BUNDLEID}\backups\*.sqlite" "$7\backups"
        ${If} ${Errors}
          StrCpy $9 "the pre-migration backups could not be copied"
        ${EndIf}
      ${EndIf}
      ${If} ${FileExists} "$APPDATA\${BUNDLEID}\attachments\*.*"
        CreateDirectory "$7\attachments"
        ClearErrors
        CopyFiles /SILENT "$APPDATA\${BUNDLEID}\attachments\*.*" "$7\attachments"
        ${If} ${Errors}
          StrCpy $9 "the attachments could not be copied"
        ${EndIf}
      ${EndIf}
      ; The flag is the only signal CopyFiles gives and it is easy to lose, so
      ; the database is independently confirmed to have ARRIVED. Either way a
      ; failure stops the uninstall here, before Section Uninstall's RmDir.
      ${IfNot} ${FileExists} "$7\vyuha.sqlite"
        StrCpy $9 "the journal database did not arrive in the copy"
      ${EndIf}
      ${If} $9 != ""
        MessageBox MB_OK|MB_ICONSTOP "The safety copy failed — $9.$\r$\n$\r$\nNOTHING has been removed. Your journal and your licence key are still in:$\r$\n$APPDATA\${BUNDLEID}$\r$\n$\r$\nFree some disk space, or pause OneDrive (and any other file sync) so these files are really on this machine rather than online-only placeholders, then run the uninstaller again." /SD IDOK
        SetErrorLevel 1
        Quit
      ${EndIf}
    ${EndIf}
    !insertmacro SetContext
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    ; Delete before recreating. Overwriting the .lnk in place leaves Explorer
    ; holding its cached icon for the same target; a delete + create is what
    ; makes it re-read.
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  ${EndIf}

  ; SHCNE_ASSOCCHANGED (0x08000000) with SHCNF_IDLIST (0x0000) — the documented
  ; way to tell the shell that icon associations changed. Without it the new
  ; .lnk can still paint from the cached bitmap.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
