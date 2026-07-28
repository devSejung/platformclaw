param(
  [switch]$Apply,
  [string]$Path = (Join-Path $env:LOCALAPPDATA "Docker\wsl\disk\docker_data.vhdx")
)

$ErrorActionPreference = "Stop"
$resolved = [System.IO.Path]::GetFullPath($Path)
$expectedRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Docker"))
$expectedPrefix = $expectedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolved.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
    [System.IO.Path]::GetExtension($resolved) -ne ".vhdx" -or
    -not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
  throw "Refusing unexpected VHDX path: $resolved"
}

function Assert-NoReparsePoint([string]$Candidate) {
  $current = Get-Item -LiteralPath $Candidate -Force
  while ($null -ne $current -and
         $current.FullName.StartsWith($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing VHDX path containing a reparse point: $($current.FullName)"
    }
    if ($current.FullName -eq $expectedRoot) { break }
    $current = $current.Parent
  }
}

Assert-NoReparsePoint $resolved

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class PlatformClawPathDeleteGuard : IDisposable {
  private const uint OPEN_EXISTING = 3;
  private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(
    string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

  private readonly SafeFileHandle handle;

  public PlatformClawPathDeleteGuard(string path) {
    // Share reads and writes needed by Optimize-VHD, but not deletion/rename.
    handle = CreateFileW(path, 0, 1u | 2u, IntPtr.Zero, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), path);
  }

  public void Dispose() { handle.Dispose(); }
}
"@

$before = (Get-Item -LiteralPath $resolved).Length
Write-Host ("Docker VHDX: {0:N2} GB - {1}" -f ($before / 1GB), $resolved)
if (-not $Apply) {
  Write-Host "Preview only. Re-run from an elevated PowerShell with -Apply. Docker Desktop and WSL will stop."
  exit 0
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) { throw "VHDX compaction requires an elevated PowerShell" }
if (-not (Get-Command Optimize-VHD -ErrorAction SilentlyContinue)) {
  throw "Optimize-VHD is unavailable. Enable the Windows Hyper-V PowerShell feature first."
}

& docker desktop stop
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop did not stop cleanly; quit it manually and retry"
}
& wsl.exe --shutdown
if ($LASTEXITCODE -ne 0) { throw "wsl --shutdown failed ($LASTEXITCODE)" }
$guards = [System.Collections.Generic.List[System.IDisposable]]::new()
try {
  $guardPath = $expectedRoot
  $guards.Add([PlatformClawPathDeleteGuard]::new($guardPath))
  foreach ($component in $resolved.Substring($expectedPrefix.Length).Split([System.IO.Path]::DirectorySeparatorChar)) {
    $guardPath = Join-Path $guardPath $component
    $guards.Add([PlatformClawPathDeleteGuard]::new($guardPath))
  }
  # Held handles deny rename/delete for every validated path component.
  Assert-NoReparsePoint $resolved
  Optimize-VHD -Path $resolved -Mode Full
} finally {
  for ($index = $guards.Count - 1; $index -ge 0; $index--) { $guards[$index].Dispose() }
}
$after = (Get-Item -LiteralPath $resolved).Length
Write-Host ("Compacted: {0:N2} GB -> {1:N2} GB" -f ($before / 1GB), ($after / 1GB))
Write-Host "Start Docker Desktop when needed."
