<#
  ออกเวอร์ชันใหม่:  powershell -ExecutionPolicy Bypass -File scripts\release.ps1 1.1.0
  1) แก้ version.py   2) เพิ่มหัวข้อใน CHANGELOG.md (ถ้ายังไม่มี)
  3) commit + tag v1.1.0 + push  → GitHub Actions จะ build ตัวติดตั้งและสร้าง Release ให้เอง
#>
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.2.3" }
if (git tag --list "v$Version") { throw "Tag v$Version already exists" }
if (git status --porcelain -- . ':!version.py' ':!CHANGELOG.md') {
    throw "Commit your other changes first (git status shows uncommitted files)"
}

$vp = Get-Content version.py -Raw -Encoding UTF8
$vp = $vp -replace '__version__\s*=\s*"[^"]+"', "__version__ = `"$Version`""
[IO.File]::WriteAllText((Join-Path $root "version.py"), $vp, (New-Object Text.UTF8Encoding $false))

$cl = Get-Content CHANGELOG.md -Raw -Encoding UTF8
if ($cl -notmatch "## \[$([regex]::Escape($Version))\]") {
    $date = Get-Date -Format "yyyy-MM-dd"
    $cl = $cl -replace "(?m)^(## \[)", "## [$Version] - $date`n- (เขียนสิ่งที่เปลี่ยนในเวอร์ชันนี้)`n`n`$1"
    [IO.File]::WriteAllText((Join-Path $root "CHANGELOG.md"), $cl, (New-Object Text.UTF8Encoding $false))
    Write-Host "เพิ่มหัวข้อ $Version ใน CHANGELOG.md แล้ว — แก้รายละเอียด แล้วรันคำสั่งนี้อีกครั้ง"
    exit 1
}

git add version.py CHANGELOG.md
git commit -m "Release v$Version"
git tag -a "v$Version" -m "v$Version"
git push origin HEAD
git push origin "v$Version"
Write-Host "ส่ง v$Version แล้ว — ดูความคืบหน้า: https://github.com/shadow-artlap/GiGoGi/actions"
