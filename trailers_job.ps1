# Nightly PC job (YouTube blocks datacenter IPs, so this cannot run in GitHub Actions):
# 1) find_trailers.py: verified Hebrew-subtitled trailers on YouTube for titles TMDB has none for
# 2) trailer_subs.py: Hebrew .vtt (YouTube track or machine translation) for the rest
# 3) commit + push docs/yt.json, docs/subs
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
$log = Join-Path $PSScriptRoot "trailers_job.log"
$lock = Join-Path $PSScriptRoot "trailers_job.lock"
if ((Test-Path $lock) -and ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalHours -lt 12) { "=== $(Get-Date -Format s) skipped, another run holds the lock" | Out-File $log -Append -Encoding utf8; exit }
New-Item -ItemType File -Path $lock -Force | Out-Null
try {
"=== $(Get-Date -Format s) start" | Out-File $log -Append -Encoding utf8
git pull --rebase -q 2>&1 | Out-File $log -Append -Encoding utf8
py -3.10 find_trailers.py --limit 400 2>&1 | Out-File $log -Append -Encoding utf8
py -3.10 trailer_subs.py --limit 400 2>&1 | Out-File $log -Append -Encoding utf8
git add docs/yt.json docs/subs 2>&1 | Out-File $log -Append -Encoding utf8
git -c core.autocrlf=false commit -q -m "trailers $(Get-Date -Format yyyy-MM-ddTHH:mm)" 2>&1 | Out-File $log -Append -Encoding utf8
git pull --rebase -q 2>&1 | Out-File $log -Append -Encoding utf8
git push -q 2>&1 | Out-File $log -Append -Encoding utf8
"=== $(Get-Date -Format s) end" | Out-File $log -Append -Encoding utf8
} finally { Remove-Item $lock -ErrorAction SilentlyContinue }
