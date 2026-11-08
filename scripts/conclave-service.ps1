# Conclave Service & Always-On Manager
# Usage:
#   powershell -File scripts/conclave-service.ps1 -Action status
#   powershell -File scripts/conclave-service.ps1 -Action start
#   powershell -File scripts/conclave-service.ps1 -Action stop
#   powershell -File scripts/conclave-service.ps1 -Action restart
#   powershell -File scripts/conclave-service.ps1 -Action install
#   powershell -File scripts/conclave-service.ps1 -Action uninstall

param(
  [ValidateSet('status', 'start', 'stop', 'restart', 'install', 'uninstall')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$taskName = 'TheConclave'
$dataDir = Join-Path $root 'data'
$daemonPs = Join-Path $PSScriptRoot 'conclave-daemon.ps1'
$silentVbs = Join-Path $PSScriptRoot 'start-daemon-silent.vbs'
$daemonPidFile = Join-Path $dataDir 'daemon.pid'
$serverPidFile = Join-Path $dataDir 'conclave.pid'
$stopSignal = Join-Path $dataDir 'daemon-stop.signal'
$daemonLog = Join-Path $dataDir 'daemon.log'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'TheConclave.lnk'

function Test-PortOpen([int]$port = 4777) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(500, $false)
    if ($ok) { $client.EndConnect($async); $client.Close(); return $true }
    $client.Close(); return $false
  } catch { return $false }
}

function Get-PortOwnerPid([int]$port = 4777) {
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

function Get-DaemonProcess {
  if (Test-Path $daemonPidFile) {
    try {
      $id = [int](Get-Content $daemonPidFile -ErrorAction Stop).Trim()
      $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($proc -and ($proc.ProcessName -match 'powershell|pwsh')) {
        return $proc
      }
    } catch {}
  }
  return $null
}

function Show-Status {
  Write-Host "=== Conclave Always-On Status ===" -ForegroundColor Cyan
  
  $isOpen = Test-PortOpen 4777
  $ownerPid = Get-PortOwnerPid 4777

  if ($isOpen -and $ownerPid) {
    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    $memMb = if ($proc) { [math]::Round($proc.WorkingSet64 / 1MB, 1) } else { 0 }
    $uptime = if ($proc) { (Get-Date) - $proc.StartTime } else { [TimeSpan]::Zero }
    $upStr = "{0}d {1}h {2}m {3}s" -f $uptime.Days, $uptime.Hours, $uptime.Minutes, $uptime.Seconds
    Write-Host "Server:       ONLINE (http://127.0.0.1:4777)" -ForegroundColor Green
    Write-Host "  PID:        $ownerPid"
    Write-Host "  Memory:     $memMb MB"
    Write-Host "  Uptime:     $upStr"
  } else {
    Write-Host "Server:       OFFLINE (port 4777 not listening)" -ForegroundColor Yellow
  }

  $daemon = Get-DaemonProcess
  if ($daemon) {
    Write-Host "Supervisor:   ACTIVE (PID: $($daemon.Id))" -ForegroundColor Green
  } else {
    Write-Host "Supervisor:   INACTIVE" -ForegroundColor Yellow
  }

  # Scheduled Task
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    Write-Host "Task Status:  INSTALLED ($($task.State))" -ForegroundColor Green
    Write-Host "  Last Run:   $($info.LastRunTime)"
  } else {
    Write-Host "Task Status:  NOT INSTALLED (Run: conclave-service.ps1 -Action install)" -ForegroundColor Gray
  }

  # Startup Shortcut
  if (Test-Path $startupLnk) {
    Write-Host "Startup Link: INSTALLED ($startupLnk)" -ForegroundColor Green
  } else {
    Write-Host "Startup Link: NOT INSTALLED" -ForegroundColor Gray
  }

  # Recent daemon logs
  if (Test-Path $daemonLog) {
    Write-Host "`n--- Recent Daemon Log (last 6 lines) ---" -ForegroundColor DarkGray
    Get-Content $daemonLog -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object {
      Write-Host "  $_" -ForegroundColor DarkGray
    }
  }
}

function Start-ServiceSilent {
  # Clear stop signal if present
  Remove-Item -Path $stopSignal -Force -ErrorAction SilentlyContinue

  $daemon = Get-DaemonProcess
  if (-not $daemon) {
    Write-Host "Starting Conclave background supervisor..." -ForegroundColor Cyan
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
      Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    } else {
      wscript.exe //B //Nologo $silentVbs
    }
  } else {
    Write-Host "Supervisor is already running (PID: $($daemon.Id))." -ForegroundColor Gray
  }

  # Wait up to 10 seconds for server to be reachable
  Write-Host "Waiting for Conclave server on port 4777..." -NoNewline
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    Write-Host "." -NoNewline
    if (Test-PortOpen 4777) {
      $ready = $true
      break
    }
  }
  Write-Host ""
  if ($ready) {
    $pidNow = Get-PortOwnerPid 4777
    Write-Host "Conclave is ready at http://127.0.0.1:4777 (PID: $pidNow)" -ForegroundColor Green
  } else {
    Write-Host "Server is still starting or check data/daemon.log for errors." -ForegroundColor Yellow
  }
}

function Stop-ServiceSilent {
  Write-Host "Stopping Conclave service..." -ForegroundColor Cyan
  
  # Set stop signal so the daemon loop terminates cleanly without restarting node
  if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
  "stop" | Out-File -FilePath $stopSignal -Encoding ascii -Force

  # Terminate daemon process
  $daemon = Get-DaemonProcess
  if ($daemon) {
    Stop-Process -Id $daemon.Id -Force -ErrorAction SilentlyContinue
    Write-Host "Supervisor (PID $($daemon.Id)) terminated." -ForegroundColor Gray
  }
  Remove-Item -Path $daemonPidFile -Force -ErrorAction SilentlyContinue

  # Terminate node server
  $ownerPid = Get-PortOwnerPid 4777
  if ($ownerPid) {
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    Write-Host "Server (PID $ownerPid) stopped." -ForegroundColor Gray
  }
  Remove-Item -Path $serverPidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $stopSignal -Force -ErrorAction SilentlyContinue

  Write-Host "Conclave stopped." -ForegroundColor Green
}

function Install-Service {
  Write-Host "Installing Conclave Always-On Service..." -ForegroundColor Cyan

  # 1. Register Scheduled Task with dual triggers:
  #    a) Immediate start at user logon (explicitly bound to current user)
  #    b) Recurring 5-minute watchdog to recover after unattended update/reboot
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive
  $tLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
  $tWatchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5)
  $triggers = @($tLogon, $tWatchdog)
  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //Nologo `"$silentVbs`"" -WorkingDirectory $root
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable

  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
    Write-Host "✓ Windows Scheduled Task '$taskName' registered (Runs at Logon + 5-min update watchdog)." -ForegroundColor Green
  } catch {
    Write-Host "! Scheduled Task registration note: $($_.Exception.Message)" -ForegroundColor Yellow
  }

  # 2. Create Startup Folder Shortcut as secondary guarantee
  try {
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($startupLnk)
    $shortcut.TargetPath = "wscript.exe"
    $shortcut.Arguments = "//B //Nologo `"$silentVbs`""
    $shortcut.WorkingDirectory = $root
    $shortcut.Description = "Starts Conclave Always-On Background Daemon"
    $shortcut.Save()
    Write-Host "✓ Windows Startup Folder shortcut created." -ForegroundColor Green
  } catch {
    Write-Host "! Startup shortcut note: $($_.Exception.Message)" -ForegroundColor Yellow
  }

  # 3. Start immediately
  Start-ServiceSilent
  Write-Host "`nAlways-On setup completed! Conclave will stay running and start automatically on boot/login." -ForegroundColor Green
}

function Uninstall-Service {
  Write-Host "Uninstalling Conclave Always-On Service..." -ForegroundColor Cyan

  Stop-ServiceSilent

  # 1. Unregister Scheduled Task
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "✓ Windows Scheduled Task '$taskName' removed." -ForegroundColor Green
  }

  # 2. Remove Startup Folder Shortcut
  if (Test-Path $startupLnk) {
    Remove-Item -Path $startupLnk -Force -ErrorAction SilentlyContinue
    Write-Host "✓ Windows Startup Folder shortcut removed." -ForegroundColor Green
  }

  Write-Host "Conclave service uninstalled." -ForegroundColor Green
}

switch ($Action) {
  'status'    { Show-Status }
  'start'     { Start-ServiceSilent }
  'stop'      { Stop-ServiceSilent }
  'restart'   { Stop-ServiceSilent; Start-Sleep -Milliseconds 800; Start-ServiceSilent }
  'install'   { Install-Service }
  'uninstall' { Uninstall-Service }
}
