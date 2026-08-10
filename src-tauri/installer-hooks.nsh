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
