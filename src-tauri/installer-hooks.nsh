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

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro VYUHA_KILL_SIDECAR
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
