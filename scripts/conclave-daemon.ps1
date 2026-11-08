# Conclave Background Daemon & Keep-Alive Supervisor
# Monitors the local Conclave server on port 4777 and automatically restarts it on crash or exit.
param(
  [switch]$Foreground
)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$dataDir = Join-Path $root 'data'
if (-not (Test-Path $dataDir)) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}

$logFile = Join-Path $dataDir 'daemon.log'
$pidFile = Join-Path $dataDir 'conclave.pid'
$daemonPidFile = Join-Path $dataDir 'daemon.pid'
$stopSignal = Join-Path $dataDir 'daemon-stop.signal'

# Mutex to ensure only one daemon instance runs at a time
$mutexName = 'Local\TheConclaveDaemonMutex'
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
if (-not $mutex.WaitOne(0, $false)) {
  if ($Foreground) {
    Write-Host "Another Conclave daemon is already running." -ForegroundColor Yellow
  }
  exit 0
}

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  if ($Foreground) { Write-Host $line }
  try {
    Add-Content -Path $logFile -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
  } catch {}
}

function Test-PortOpen([int]$port) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(500, $false)
    if ($ok) { $client.EndConnect($async); $client.Close(); return $true }
    $client.Close(); return $false
  } catch { return $false }
}

function Get-PortOwnerPid([int]$port) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
  } catch {}
  try {
    $line = (netstat -ano -p tcp | Select-String ":$port\s+.*LISTENING") | Select-Object -First 1
    if ($line -match '\s+(\d+)$') { return [int]$matches[1] }
  } catch {}
  return $null
}

$PID | Out-File -FilePath $daemonPidFile -Encoding ascii -Force
Log "========================================"
Log "Conclave daemon started (PID: $PID)"

$consecutiveFailures = 0

try {
  while ($true) {
    # Check if a manual stop was requested
    if (Test-Path $stopSignal) {
      Log "Manual stop signal detected. Exiting daemon."
      break
    }

    $isOpen = Test-PortOpen 4777
    $activePid = $null

    if (-not $isOpen) {
      Log "Server is down on port 4777. Launching node server.js..."
      $p = Start-Process -FilePath "node" -ArgumentList "--no-warnings","server.js" `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru

      if ($p -and $p.Id) {
        $activePid = $p.Id
        $activePid | Out-File -FilePath $pidFile -Encoding ascii -Force
        Log "Server process spawned (PID: $activePid). Waiting for port 4777..."

        # Wait up to 15 seconds for server to start listening
        $started = $false
        for ($i = 0; $i -lt 30; $i++) {
          Start-Sleep -Milliseconds 500
          if (Test-Path $stopSignal) { break }
          if (Test-PortOpen 4777) {
            $started = $true
            Log "Server is ready and listening on http://127.0.0.1:4777 (PID: $activePid)"
            break
          }
          if ($p.HasExited) { break }
        }

        if (-not $started -or $p.HasExited) {
          Log "Server process exited or failed to bind port. Retrying in 3s..."
          Start-Sleep -Seconds 3
          continue
        }
      } else {
        Log "Failed to spawn node server.js. Retrying in 5s..."
        Start-Sleep -Seconds 5
        continue
      }
    } else {
      $activePid = Get-PortOwnerPid 4777
      if ($activePid) {
        $activePid | Out-File -FilePath $pidFile -Encoding ascii -Force
        Log "Connected to running server on port 4777 (PID: $activePid)"
      }
    }

    if (-not $activePid) {
      Start-Sleep -Seconds 2
      continue
    }

    # Active supervision loop: poll every 8 seconds
    while ($true) {
      if (Test-Path $stopSignal) {
        Log "Stop signal received during supervision. Stopping server PID $activePid..."
        Stop-Process -Id $activePid -Force -ErrorAction SilentlyContinue
        break
      }

      $proc = Get-Process -Id $activePid -ErrorAction SilentlyContinue
      if (-not $proc -or $proc.HasExited) {
        Log "Server PID $activePid is no longer running."
        break
      }

      if (-not (Test-PortOpen 4777)) {
        Log "Port 4777 stopped responding."
        break
      }

      # Health check: quick HTTP ping to verify the event loop is responsive
      try {
        $res = Invoke-RestMethod -Uri "http://127.0.0.1:4777/api/members" -TimeoutSec 4 -ErrorAction Stop
        if ($res) {
          $consecutiveFailures = 0
        }
      } catch {
        $consecutiveFailures++
        Log "Health check failed ($consecutiveFailures/4): $($_.Exception.Message)"
        if ($consecutiveFailures -ge 4) {
          Log "Server unresponsive for 4 consecutive checks (32s). Killing PID $activePid to trigger fresh restart..."
          Stop-Process -Id $activePid -Force -ErrorAction SilentlyContinue
          $consecutiveFailures = 0
          break
        }
      }

      Start-Sleep -Seconds 8
    }

    if (Test-Path $stopSignal) {
      break
    }

    Log "Preparing to restart server..."
    Start-Sleep -Seconds 2
  }
} finally {
  Remove-Item -Path $daemonPidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $stopSignal -Force -ErrorAction SilentlyContinue
  Log "Conclave daemon stopped (PID: $PID)"
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
