# Stops the Pioneer Planner background process (it also stops by itself when you log off or shut down).
param([switch]$Quiet)
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]web[\\/]server\.js' }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if (-not $Quiet) {
  Add-Type -AssemblyName PresentationFramework
  $msg = if ($procs) { 'Pioneer Planner stopped.' } else { 'Pioneer Planner was not running.' }
  [System.Windows.MessageBox]::Show($msg, 'Pioneer Planner') | Out-Null
}
