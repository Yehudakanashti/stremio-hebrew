# PC job for the "דיבוב עברית מלא" row: AllDebrid blocks datacenter IPs, so the audio-track proof must run from home.
# Reads the key from C:\Users\hod45\StremioHebrew\alldebrid.key (outside the repo), scans in chunks and pushes each chunk.
# Usage: powershell -File dubs_job.ps1 [-Total 400] [-Chunk 40]
param([int]$Total = 400, [int]$Chunk = 40)
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
Remove-Item Env:PYTHONPATH, Env:PYTHONHOME -ErrorAction SilentlyContinue
$log = Join-Path $PSScriptRoot "dubs_job.log"
$lock = Join-Path $PSScriptRoot "dubs_job.lock"
$key = Join-Path (Split-Path -Parent $PSScriptRoot) "alldebrid.key"
if (-not (Test-Path $key) -or ((Get-Content $key -Raw).Trim().Length -lt 10)) { "=== $(Get-Date -Format s) no key in $key" | Out-File $log -Append -Encoding utf8; exit 1 }
if ((Test-Path $lock) -and ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalHours -lt 6) { "=== $(Get-Date -Format s) skipped, lock held" | Out-File $log -Append -Encoding utf8; exit }
New-Item -ItemType File -Path $lock -Force | Out-Null
try {
  "=== $(Get-Date -Format s) start total=$Total chunk=$Chunk" | Out-File $log -Append -Encoding utf8
  git pull --rebase -q 2>&1 | Out-File $log -Append -Encoding utf8
  $n = 0
  while ($n -lt $Total) {
    node dubscan.js --limit $Chunk 2>&1 | Select-String -Pattern "FOUND|DROP|done:|movies |fail |delete " | ForEach-Object { $_.Line } | Out-File $log -Append -Encoding utf8
    git add docs/dub.json 2>&1 | Out-Null
    git -c core.autocrlf=false commit -q -m "dubs $(Get-Date -Format yyyy-MM-ddTHH:mm)" 2>&1 | Out-Null
    git pull --rebase -q 2>&1 | Out-File $log -Append -Encoding utf8
    git push -q 2>&1 | Out-File $log -Append -Encoding utf8
    $n += $Chunk
    "pushed after $n $(Get-Date -Format s)" | Out-File $log -Append -Encoding utf8
  }
  "=== $(Get-Date -Format s) end" | Out-File $log -Append -Encoding utf8
} finally { Remove-Item $lock -ErrorAction SilentlyContinue }
