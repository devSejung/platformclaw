param(
  [ValidateSet("Run", "Install", "Uninstall", "Status")]
  [string]$Action = "Run"
)

$ErrorActionPreference = "Stop"
$taskName = "PlatformClaw Home Dev Cleanup"
$repoRoot = Split-Path -Parent $PSScriptRoot
$cleanupScript = Join-Path $PSScriptRoot "platformclaw-dev-cleanup.mjs"

if ($Action -eq "Run") {
  & node $cleanupScript --apply
  if ($LASTEXITCODE -ne 0) { throw "PlatformClaw cleanup failed ($LASTEXITCODE)" }
  exit 0
}

if ($Action -eq "Install") {
  $node = (Get-Command node -ErrorAction Stop).Source
  $arguments = '"{0}" --apply' -f $cleanupScript
  $taskAction = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $repoRoot
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings -Description "Weekly bounded cleanup for PlatformClaw home development Docker data" -Force | Out-Null
  Write-Host "Installed weekly task: $taskName"
  exit 0
}

if ($Action -eq "Uninstall") {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed task: $taskName"
  exit 0
}

Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
  Select-Object TaskName, State, Description
