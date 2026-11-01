# Dev helper: screenshot pages with headless Edge.
# Usage: powershell -File scripts\snap.ps1 -Out <dir> -Pages "home=,chats=chats" [-Size 1400,900]
param([string]$Out, [string]$Pages, [string]$Size = '1400,900')
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
foreach ($pair in $Pages.Split(',')) {
  $name, $route = $pair.Split('=', 2)
  $file = Join-Path $Out "$name.png"
  Remove-Item $file -ErrorAction SilentlyContinue
  $profile = Join-Path $Out ("edge-snap-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  & $edge --headless=new --disable-gpu --hide-scrollbars "--user-data-dir=$profile" "--window-size=$Size" `
    --virtual-time-budget=5000 "--screenshot=$file" "http://127.0.0.1:4777/?snap#/$route" 2>&1 | Out-Null
  for ($i = 0; $i -lt 20 -and -not (Test-Path $file); $i++) { Start-Sleep -Milliseconds 500 }
  if (Test-Path $file) { "ok: $name" } else { "missing: $name" }
}
