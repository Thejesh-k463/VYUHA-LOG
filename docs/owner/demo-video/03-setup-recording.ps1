<#
.SYNOPSIS
  One-time setup for recording the Vyuha demo. Run from an elevated PowerShell.

.DESCRIPTION
  Does, in order, everything the guide asks you to do by hand before a session:
    1. Installs OBS Studio (winget) if absent.
    2. Installs the "Vyuha Demo" OBS profile (1080p canvas = output, 30 fps,
       mkv, x264 CRF 18, hotkeys Ctrl+Shift+F9/F10).
    3. Creates the takes folder the profile records into.
    4. Reminds you of the two things it deliberately does NOT do.

  It does NOT change your display resolution or notification settings —
  both are per-session choices and both are one click. It prints exactly where.

.NOTES
  Idempotent. Safe to re-run. Touches nothing in the Vyuha repo.
#>

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)        { Write-Host "    ✓ $msg" -ForegroundColor Green }
function Note($msg)      { Write-Host "    · $msg" -ForegroundColor DarkGray }

# ── 1. OBS ──────────────────────────────────────────────────────────────────
Step 1 "OBS Studio"
$obs = "$env:ProgramFiles\obs-studio\bin\64bit\obs64.exe"
if (Test-Path $obs) {
  Ok "already installed: $obs"
} else {
  Note "installing via winget (desktop app, not a web recorder — web recorders cap at 720p or watermark)"
  winget install --id OBSProject.OBSStudio --exact --accept-package-agreements --accept-source-agreements --silent
  if (Test-Path $obs) { Ok "installed" } else { throw "OBS did not install — run 'winget install OBSProject.OBSStudio' by hand" }
}

# ── 2. Profile ──────────────────────────────────────────────────────────────
Step 2 "OBS profile 'Vyuha Demo'"
$profilesDir = Join-Path $env:APPDATA "obs-studio\basic\profiles"
$dest = Join-Path $profilesDir "Vyuha Demo"
$src  = Join-Path $here "obs-profile\Vyuha Demo"
if (-not (Test-Path $src)) { throw "profile source missing: $src" }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $src "basic.ini")          (Join-Path $dest "basic.ini")          -Force
Copy-Item (Join-Path $src "recordEncoder.json") (Join-Path $dest "recordEncoder.json") -Force
# The committed basic.ini carries an absolute RecFilePath; point it at THIS user's takes folder
# so a hand-import on another machine does not silently record to a nonexistent path.
$ini = Join-Path $dest "basic.ini"
(Get-Content $ini) -replace '^RecFilePath=.*', "RecFilePath=$env:USERPROFILE\Videos\vyuha-demo-takes" | Set-Content $ini
Ok "installed to $dest"
Note "in OBS: Profile menu → 'Vyuha Demo'. If OBS was open, restart it to see the profile."
Note "canvas 1920x1080 = output 1920x1080 (no resample), 30 fps, mkv, x264 CRF 18, keyint 2 s"
Note "hotkeys: Ctrl+Shift+F9 start · Ctrl+Shift+F10 stop"

# ── 3. Takes folder ─────────────────────────────────────────────────────────
Step 3 "Takes folder"
$takes = Join-Path $env:USERPROFILE "Videos\vyuha-demo-takes"
New-Item -ItemType Directory -Force -Path $takes | Out-Null
Ok $takes
Note "the profile records here as vyuha-shot-<date> <time>.mkv"

# ── 4. Hardware encoder hint ────────────────────────────────────────────────
Step 4 "Encoder"
$gpu = (Get-CimInstance Win32_VideoController | Select-Object -First 1).Name
Note "GPU: $gpu"
if ($gpu -match "NVIDIA") {
  Note "NVENC available — in OBS Settings → Output → Recording, switch Video Encoder to 'NVIDIA NVENC H.264' and Rate Control to CQP 18. Fewer dropped frames than x264 while the app is busy."
} elseif ($gpu -match "Intel") {
  Note "Intel QSV may be available — same idea: Settings → Output → Recording → 'QuickSync H.264', ICQ 18."
} elseif ($gpu -match "AMD|Radeon") {
  Note "AMD HW encoder may be available — 'AMD HW H.264', CQP 18."
} else {
  Note "x264 (CPU) is configured. Fine for a desktop-app demo at 30 fps."
}

# ── 5. What you still do by hand, per session ───────────────────────────────
Step 5 "Per-session, by hand (deliberately not automated)"
$w = (Get-CimInstance Win32_VideoController | Select-Object -First 1).CurrentHorizontalResolution
$h = (Get-CimInstance Win32_VideoController | Select-Object -First 1).CurrentVerticalResolution
Note "current display: ${w}x${h}"
if ($w -ne 1920 -or $h -ne 1080) {
  Write-Host "    ! set Windows display to 1920x1080 at 100% scaling before recording:" -ForegroundColor Yellow
  Write-Host "      Settings → System → Display → Display resolution → 1920 × 1080; Scale → 100%" -ForegroundColor Yellow
  Write-Host "      (your ${w}x${h} is not 16:9; recorded as-is, text goes soft after the platform re-encodes)" -ForegroundColor Yellow
} else { Ok "display already 1920x1080" }
Write-Host "    ! Focus Assist ON: Settings → System → Notifications → Do not disturb → On" -ForegroundColor Yellow
Write-Host "    ! fresh browser profile, no extensions, bookmarks bar hidden (Ctrl+Shift+B)" -ForegroundColor Yellow
Write-Host "    ! copy tests\fixtures\zerodha-tradebook.csv to the Desktop for SHOT 3" -ForegroundColor Yellow

Write-Host "`nDone. Next: in the repo, 'npm run demo -- --fresh', then open OBS and select the 'Vyuha Demo' profile.`n" -ForegroundColor Cyan
