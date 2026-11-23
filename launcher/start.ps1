# Pioneer Planner launcher: starts the planner in the background (if it is not running yet)
# and opens it in its own app window. Used by the desktop shortcut and "Pioneer Planner.cmd".
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:SFP_PORT) { [int]$env:SFP_PORT } else { 5178 }
$url = "http://127.0.0.1:$port/"   # not "localhost": Windows PowerShell tries IPv6 first and times out
Add-Type -AssemblyName PresentationFramework

function Show-Message([string]$text, [string]$icon = 'Information', [string]$buttons = 'OK') {
  return [System.Windows.MessageBox]::Show($text, 'Pioneer Planner', $buttons, $icon)
}

function Test-Running {
  try { return (Invoke-WebRequest -Uri ($url + 'api/saves') -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}

function Get-Health {
  try { return (Invoke-RestMethod -Uri ($url + 'api/health') -TimeoutSec 2).data } catch { return $null }
}

# an older copy still running (e.g. after an update): restart it so the new version opens
if (Test-Running) {
  $health = Get-Health
  $newest = (Get-ChildItem -Path (Join-Path $root 'src') -Recurse -File | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
  $started = if ($health) { [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$health.started).UtcDateTime } else { [datetime]::MinValue }
  if ($newest -gt $started) {
    & (Join-Path $PSScriptRoot 'stop.ps1') -Quiet
    if ($health) { Stop-Process -Id ([int]$health.pid) -Force -ErrorAction SilentlyContinue }
    # copies from before the health check: stop the node process that holds the planner's port
    $owner = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($owner -and (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName -eq 'node') { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 20 -and (Test-Running); $i++) { Start-Sleep -Milliseconds 250 }
    if (Test-Running) {
      Show-Message "An older Pioneer Planner is still running and could not be closed, so you may see the old version.`n`nRestart your PC (or end 'Node.js' in Task Manager) and start Pioneer Planner again." 'Warning' | Out-Null
    }
  }
}

if (-not (Test-Running)) {
  # 1. Node.js is the only thing the planner needs
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    Show-Message "Pioneer Planner needs Node.js (free).`n`nThe download page opens now: install the LTS version with the default options, then double-click Pioneer Planner again." 'Warning' | Out-Null
    Start-Process 'https://nodejs.org/en/download'
    exit 1
  }
  $major = [int]((& $node --version).TrimStart('v').Split('.')[0])
  if ($major -lt 20) {
    Show-Message "Your Node.js is too old (version $major). Please install the current LTS version from nodejs.org, then try again." 'Warning' | Out-Null
    Start-Process 'https://nodejs.org/en/download'
    exit 1
  }

  # 2. first start only: download the libraries (visible window so you can see it working)
  if (-not (Test-Path (Join-Path $root 'node_modules\@modelcontextprotocol'))) {
    $setup = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'title Pioneer Planner - first-time setup (about a minute) && npm install --omit=dev --no-fund --no-audit' -WorkingDirectory $root -Wait -PassThru
    if ($setup.ExitCode -ne 0) {
      Show-Message 'First-time setup failed while downloading libraries. Check your internet connection and try again.' 'Error' | Out-Null
      exit 1
    }
  }

  # 3. start the planner hidden in the background (it stops when you log off or shut down)
  Start-Process -FilePath $node -ArgumentList 'src/web/server.js' -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 60 -and -not (Test-Running); $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Running)) {
    Show-Message "The planner did not start. Open a terminal in`n$root`nand run: npm run web   to see what went wrong." 'Error' | Out-Null
    exit 1
  }

  # 4. once: offer a Desktop + Start menu shortcut
  $marker = Join-Path $root 'cache\.shortcuts-offered'
  $desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Pioneer Planner.lnk'
  if (-not (Test-Path $marker) -and -not (Test-Path $desktopLink)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $marker) | Out-Null
    Set-Content -Path $marker -Value (Get-Date -Format s)
    if ((Show-Message "Add Pioneer Planner to your Desktop and Start menu?`n`nThen you can start it with one click any time." 'Question' 'YesNo') -eq 'Yes') {
      & (Join-Path $PSScriptRoot 'make-shortcuts.ps1') -Quiet
    }
  }
}

# open as its own app window (Edge / Chrome app mode); otherwise the default browser
$browsers = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) }
if ($browsers) { Start-Process -FilePath $browsers[0] -ArgumentList "--app=$url", '--window-size=1400,950' }
else { Start-Process $url }
