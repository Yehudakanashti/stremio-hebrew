# One-off first pass over every title without a subtitled trailer, in chunks that get pushed as they finish.
# Started detached from the Claude session on 28.10.26; trailers_job.ps1 takes over nightly afterwards.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
# a parent process may carry another Python's env (SRE module mismatch): run py -3.10 clean
Remove-Item Env:PYTHONPATH, Env:PYTHONHOME -ErrorAction SilentlyContinue
$env:PYTHONIOENCODING = "utf-8"
$log = Join-Path $PSScriptRoot "first_pass.log"
$lock = Join-Path $PSScriptRoot "trailers_job.lock"
try {
  for ($i = 1; $i -le 14; $i++) {
    New-Item -ItemType File -Path $lock -Force | Out-Null
    "=== chunk $i $(Get-Date -Format s)" | Out-File $log -Append -Encoding utf8
    py -3.10 find_trailers.py --limit 200 2>&1 | Select-String -Pattern "FOUND|done:|to search|fail" | ForEach-Object { $_.Line } | Out-File $log -Append -Encoding utf8
    py -3.10 trailer_subs.py --limit 200 2>&1 | Select-Object -Last 2 | Out-File $log -Append -Encoding utf8
    git add docs/yt.json docs/subs 2>&1 | Out-Null
    git -c core.autocrlf=false commit -q -m "trailers chunk $i $(Get-Date -Format yyyy-MM-ddTHH:mm)" 2>&1 | Out-Null
    git pull --rebase -q 2>&1 | Out-File $log -Append -Encoding utf8
    git push -q 2>&1 | Out-File $log -Append -Encoding utf8
    "pushed chunk $i $(Get-Date -Format s)" | Out-File $log -Append -Encoding utf8
  }
  "ALL CHUNKS DONE $(Get-Date -Format s)" | Out-File $log -Append -Encoding utf8
} finally { Remove-Item $lock -ErrorAction SilentlyContinue }
