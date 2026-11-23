# Creates "Pioneer Planner" shortcuts on the Desktop and in the Start menu (plus "Stop Pioneer Planner" in the Start menu).
# Safe to run again: it just refreshes them (e.g. after moving the folder).
param([switch]$Quiet)
$root = Split-Path -Parent $PSScriptRoot
$icon = Join-Path $PSScriptRoot 'pioneer.ico'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shell = New-Object -ComObject WScript.Shell

function New-Link([string]$path, [string]$script, [string]$description) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $ps
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $PSScriptRoot $script)`""
  $link.WorkingDirectory = $root
  $link.WindowStyle = 7   # minimized: no console flash
  $link.Description = $description
  if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
  $link.Save()
}

$desktop = [Environment]::GetFolderPath('Desktop')
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Pioneer Planner'
New-Item -ItemType Directory -Force -Path $menu | Out-Null
New-Link (Join-Path $desktop 'Pioneer Planner.lnk') 'start.ps1' 'Open Pioneer Planner (Satisfactory factory planner)'
New-Link (Join-Path $menu 'Pioneer Planner.lnk') 'start.ps1' 'Open Pioneer Planner (Satisfactory factory planner)'
New-Link (Join-Path $menu 'Stop Pioneer Planner.lnk') 'stop.ps1' 'Stop the Pioneer Planner background process'

if (-not $Quiet) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Done! You now have 'Pioneer Planner' on your Desktop and in the Start menu.", 'Pioneer Planner') | Out-Null
}
