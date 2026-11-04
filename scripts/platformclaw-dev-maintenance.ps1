param(
  [ValidateSet("Run", "Install", "Uninstall", "Status")]
  [string]$Action = "Run"
)

$ErrorActionPreference = "Stop"
$taskName = "PlatformClaw Home Dev Cleanup"
$repoRoot = Split-Path -Parent $PSScriptRoot
$cleanupScript = Join-Path $PSScriptRoot "platformclaw-dev-cleanup.mjs"
$cleanupArgs = @(
  "--apply", "--skip-final-images", "--skip-archives",
  "--cache-max", "20gb", "--cache-reserved", "5gb", "--cache-min-free", "20gb"
)

if ($Action -eq "Run") {
  & node $cleanupScript @cleanupArgs
  if ($LASTEXITCODE -ne 0) { throw "PlatformClaw cleanup failed ($LASTEXITCODE)" }
  exit 0
}

if ($Action -eq "Install") {
  if ((Get-Item -LiteralPath (Join-Path $repoRoot ".git") -Force).PSIsContainer -eq $false) {
    throw "Install maintenance from the primary checkout after updating it, not from a removable linked worktree."
  }
  $node = (Get-Command node -ErrorAction Stop).Source
  $arguments = '"{0}" {1}' -f $cleanupScript, ($cleanupArgs -join " ")
  $taskAction = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $repoRoot
  $trigger = New-ScheduledTaskTrigger -Daily -At 3am
  # Daily triggers do not expose repetition parameters, but accept the same
  # scheduler repetition pattern as a once trigger. Renew it every day.
  $repeating = New-ScheduledTaskTrigger -Once -At 3am -RepetitionInterval (New-TimeSpan -Hours 4) -RepetitionDuration (New-TimeSpan -Days 1)
  $trigger.Repetition = $repeating.Repetition
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings -Description "Every-four-hour bounded cleanup for PlatformClaw development resources" -Force | Out-Null
  Write-Host "Installed every-four-hour task: $taskName"
  exit 0
}

if ($Action -eq "Uninstall") {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed task: $taskName"
  exit 0
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
  Write-Host "Not installed: $taskName"
  exit 0
}
$info = $task | Get-ScheduledTaskInfo
[pscustomobject]@{
  TaskName = $task.TaskName
  State = $task.State
  LastRunTime = $info.LastRunTime
  LastTaskResult = $info.LastTaskResult
  NextRunTime = $info.NextRunTime
  Description = $task.Description
}
