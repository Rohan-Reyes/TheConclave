$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:4777'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$log = Join-Path $root 'data\restart-when-idle.log'

function Log($msg) {
  "$(Get-Date -Format o) $msg" | Add-Content -Path $log
}

Log "watcher started, pid=$PID"
$idleCount = 0
for ($i = 0; $i -lt 360; $i++) {
  Start-Sleep -Seconds 5
  try {
    $threads = Invoke-RestMethod -Uri "$base/api/threads" -TimeoutSec 4
    $running = @($threads | Where-Object { $_.running })
    if ($running.Count -eq 0) {
      $idleCount++
      Log "idle check $idleCount/2"
      if ($idleCount -ge 2) {
        $conn = Get-NetTCPConnection -LocalPort 4777 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) {
          Log "stopping old server pid=$($conn.OwningProcess)"
          Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 1
        }
        $p = Start-Process -FilePath 'node' -ArgumentList '--no-warnings','server.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru
        Log "started new server pid=$($p.Id)"
        exit 0
      }
    } else {
      $idleCount = 0
    }
  } catch {
    Log "poll error: $($_.Exception.Message)"
  }
}
Log "watcher timed out without idle window"
