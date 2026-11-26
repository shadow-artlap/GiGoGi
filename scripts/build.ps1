<#
  Build GiGoGi Phone Control:  .exe (PyInstaller) + bundled scrcpy/adb + Setup.exe (Inno Setup) + portable .zip
  Usage:  powershell -ExecutionPolicy Bypass -File scripts\build.ps1
  Output: dist\GiGoGiPhoneControl-Setup-<version>.exe
          dist\GiGoGiPhoneControl-<version>-portable.zip
#>
param(
    [string]$ScrcpyVersion = "5.0.1"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Select-String -Path "version.py" -Pattern '__version__\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value
Write-Host "== Building GiGoGi Phone Control v$version (scrcpy $ScrcpyVersion)"

$build = Join-Path $root "build"
$dist  = Join-Path $root "dist"
$app   = Join-Path $build "dist\GiGoGiPhoneControl"
$cache = Join-Path $build "cache"
New-Item -ItemType Directory -Force $build, $dist, $cache | Out-Null

# 1) tests
python -m pip install --quiet -r requirements.txt
python -X utf8 phone_control.py --selftest
if ($LASTEXITCODE -ne 0) { throw "selftest failed" }

# 2) exe
python -m pip install --quiet --upgrade pyinstaller -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
python -m PyInstaller --noconfirm --clean --windowed --name GiGoGiPhoneControl `
    --icon (Join-Path $root "assets\icon.ico") `
    --add-data "$(Join-Path $root 'ui');ui" `
    --distpath (Join-Path $build "dist") --workpath (Join-Path $build "work") --specpath $build `
    phone_control.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

# 3) bundle scrcpy (includes adb)
function Get-File($url, $out) {
    # GitHub ขัดข้องชั่วคราวได้ ลองซ้ำสูงสุด 4 ครั้ง
    for ($i = 1; $i -le 4; $i++) {
        try {
            Invoke-WebRequest $url -OutFile "$out.part" -TimeoutSec 180
            Move-Item -Force "$out.part" $out
            return
        } catch {
            Write-Host "   download failed (try $i): $($_.Exception.Message)"
            if ($i -eq 4) { throw }
            Start-Sleep -Seconds (10 * $i)
        }
    }
}
$zipName = "scrcpy-win64-v$ScrcpyVersion.zip"
$zip = Join-Path $cache $zipName
if (-not (Test-Path $zip)) {
    Write-Host "== Downloading $zipName"
    Get-File "https://github.com/Genymobile/scrcpy/releases/download/v$ScrcpyVersion/$zipName" $zip
}
$lic = Join-Path $cache "LICENSE-scrcpy-$ScrcpyVersion.txt"
if (-not (Test-Path $lic)) {
    Get-File "https://raw.githubusercontent.com/Genymobile/scrcpy/v$ScrcpyVersion/LICENSE" $lic
}
$tmp = Join-Path $cache "scrcpy-x"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Expand-Archive $zip -DestinationPath $tmp
$inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
$toolDir = Join-Path $app "tools\scrcpy"
New-Item -ItemType Directory -Force $toolDir | Out-Null
Copy-Item (Join-Path $inner.FullName "*") $toolDir -Recurse -Force
Copy-Item $lic (Join-Path $toolDir "LICENSE-scrcpy.txt") -Force
Copy-Item "THIRD_PARTY_NOTICES.txt", "README.md" $app -Force
if (-not (Test-Path (Join-Path $toolDir "adb.exe"))) { throw "adb.exe missing from scrcpy package" }

# 4) installer
$iscc = @(
    (Get-Command iscc -ErrorAction SilentlyContinue).Source,
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 not found. Install: winget install JRSoftware.InnoSetup" }
& $iscc "/DAppVersion=$version" "/DBuildDir=$app" "installer\GiGoGi.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed" }

# 5) portable zip
$portable = Join-Path $dist "GiGoGiPhoneControl-$version-portable.zip"
if (Test-Path $portable) { Remove-Item $portable }
Compress-Archive -Path $app -DestinationPath $portable

# 6) release notes from CHANGELOG.md section "## [x.y.z]"
$notes = Join-Path $build "release-notes.md"
$text = Get-Content "CHANGELOG.md" -Raw -Encoding UTF8
$m = [regex]::Match($text, "(?ms)^## \[$([regex]::Escape($version))\][^\n]*\n(.*?)(?=^## \[|\z)")
$body = if ($m.Success) { $m.Groups[1].Value.Trim() } else { "GiGoGi Phone Control v$version" }
Set-Content -Path $notes -Value $body -Encoding UTF8

Write-Host "== Done:"
Get-ChildItem $dist | Where-Object { $_.Name -like "*$version*" } | ForEach-Object { "   {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB) }
