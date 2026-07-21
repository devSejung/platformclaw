[CmdletBinding()]
param(
    [ValidateSet("Menu", "Start", "Doctor")]
    [string]$Action = "Menu",
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "PlatformClaw\windows-main-preview"),
    [int]$EmployeeAuthPort = 18080,
    [int]$GatewayPort = 18790,
    [int]$Port = 19001,
    [string]$SourceRef = "origin/main",
    [switch]$NoFetch,
    [switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$runtimeEnvironmentNames = @(
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_GATEWAY_TOKEN",
    "PLATFORMCLAW_PUBLIC_ORIGIN",
    "PLATFORMCLAW_LISTEN_HOST",
    "PLATFORMCLAW_LISTEN_PORT",
    "PLATFORMCLAW_DATABASE_PATH",
    "PLATFORMCLAW_CONTROL_UI_ROOT",
    "PLATFORMCLAW_PERSONAL_WORKSPACE_ROOT",
    "PLATFORMCLAW_INITIAL_ADMIN_ACCOUNT_IDS_FILE",
    "PLATFORMCLAW_GATEWAY_URL",
    "PLATFORMCLAW_GATEWAY_TOKEN_FILE",
    "PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL"
)

function Write-Step {
    param([string]$Message)
    Write-Host "[PlatformClaw] $Message" -ForegroundColor Cyan
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(ValueFromRemainingArguments)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')"
    }
}

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Test-PythonCommand {
    param([hashtable]$Candidate)
    $probeArguments = @($Candidate.Prefix) + @(
        "-c",
        "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"
    )
    try {
        & $Candidate.Command @probeArguments *> $null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
}

function Get-PythonCommand {
    $candidates = @(
        @{ Name = "py"; Prefix = @("-3") },
        @{ Name = "python"; Prefix = @() }
    )
    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate.Name -ErrorAction SilentlyContinue
        if (-not $command) {
            continue
        }
        $resolved = @{ Command = $command.Source; Prefix = $candidate.Prefix }
        if (Test-PythonCommand $resolved) {
            return $resolved
        }
    }
    throw "A working Python 3.9+ interpreter is required for scripts/mock_employee_auth.py"
}

function Get-SourceSha {
    Push-Location $repoRoot
    try {
        if (-not $NoFetch -and $SourceRef -eq "origin/main") {
            Write-Step "Fetching origin/main"
            Invoke-Checked -Command git -Arguments @("fetch", "origin", "--prune")
        }
        $sha = (& git rev-parse --verify "$SourceRef`^{commit}").Trim()
        if ($LASTEXITCODE -ne 0 -or -not $sha) {
            throw "Unable to resolve source ref: $SourceRef"
        }
        return $sha
    }
    finally {
        Pop-Location
    }
}

function Show-Doctor {
    Write-Step "Environment"
    foreach ($name in @("git", "node", "corepack")) {
        Assert-Command $name
        $source = (Get-Command $name).Source
        Write-Host ("  {0,-9} {1}" -f $name, $source)
    }
    $python = Get-PythonCommand
    Write-Host ("  {0,-9} {1}" -f "python", (Get-Command $python.Command).Source)

    Push-Location $repoRoot
    try {
        $branch = (& git branch --show-current).Trim()
        $status = @(& git status --porcelain)
        $nodeVersion = (& node --version).Trim()
        $pnpmVersion = (& corepack pnpm --version).Trim()
        $mainSha = Get-SourceSha
        Write-Host ""
        Write-Host "  checkout  $repoRoot"
        Write-Host "  branch    $branch"
        Write-Host "  clean     $($status.Count -eq 0)"
        Write-Host "  node      $nodeVersion"
        Write-Host "  pnpm      $pnpmVersion (repository-pinned through Corepack)"
        Write-Host "  source    $SourceRef ($mainSha)"
        if ($SourceRef -eq "origin/main" -and $branch -ne "main") {
            Write-Host "  hint      use -SourceRef HEAD to test the current checkout" -ForegroundColor Yellow
        }
    }
    finally {
        Pop-Location
    }

    $runtimeRoot = Join-Path $DataRoot "runtime"
    $configFile = Join-Path $runtimeRoot "gateway\openclaw.json"
    Write-Host ""
    Write-Host "  data      $DataRoot"
    Write-Host "  runtime   $runtimeRoot"
    if (Test-Path $configFile) {
        try {
            $config = Get-Content -Raw -LiteralPath $configFile | ConvertFrom-Json
            $agentIds = @($config.agents.list | ForEach-Object { $_.id })
            Write-Host "  agents    $(if ($agentIds.Count -gt 0) { $agentIds -join ', ' } else { '(none)' })"
        }
        catch {
            Write-Host "  agents    config unreadable: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    else {
        Write-Host "  agents    runtime not initialized"
    }
    foreach ($endpoint in @(
        @{ Name = "auth"; Url = "http://127.0.0.1:$EmployeeAuthPort/healthz" },
        @{ Name = "gateway"; Url = "http://127.0.0.1:$GatewayPort/healthz" },
        @{ Name = "control"; Url = "http://127.0.0.1:$Port/platformclaw/health" }
    )) {
        $status = if (Test-HttpEndpoint $endpoint.Url) { "ready" } else { "down" }
        Write-Host ("  {0,-9} {1} ({2})" -f $endpoint.Name, $status, $endpoint.Url)
    }
    $logFile = Join-Path (Join-Path $env:TEMP "openclaw") "openclaw-$((Get-Date).ToString('yyyy-MM-dd')).log"
    Write-Host "  log       $logFile"
}

function New-RandomToken {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Value)
    [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}

function Initialize-SourceSnapshot {
    param([string]$Sha)

    $sourceRoot = Join-Path (Join-Path $DataRoot "sources") $Sha
    if (Test-Path (Join-Path $sourceRoot "package.json")) {
        Write-Step "Reusing main snapshot $($Sha.Substring(0, 12))"
        return $sourceRoot
    }

    Write-Step "Creating isolated main checkout $($Sha.Substring(0, 12))"
    New-Item -ItemType Directory -Force (Split-Path $sourceRoot -Parent) | Out-Null
    try {
        Invoke-Checked -Command git -Arguments @(
            "clone",
            "--shared",
            "--no-checkout",
            "--no-tags",
            $repoRoot,
            $sourceRoot
        )
        Invoke-Checked -Command git -Arguments @(
            "-C",
            $sourceRoot,
            "config",
            "core.symlinks",
            "false"
        )
        Invoke-Checked -Command git -Arguments @("-C", $sourceRoot, "checkout", "--detach", $Sha)
    }
    catch {
        if (Test-Path $sourceRoot) {
            Remove-Item -LiteralPath $sourceRoot -Recurse -Force
        }
        throw
    }
    return $sourceRoot
}

function Initialize-DependenciesAndUi {
    param([string]$SourceRoot)

    Push-Location $SourceRoot
    try {
        if (-not (Test-Path "node_modules\.modules.yaml")) {
            Write-Step "Installing dependencies with repository-pinned pnpm"
            Invoke-Checked -Command corepack -Arguments @("pnpm", "install", "--frozen-lockfile")
        }
        if ($Rebuild -or -not (Test-Path "dist\entry.js")) {
            Write-Step "Building OpenClaw Gateway"
            Invoke-Checked -Command corepack -Arguments @("pnpm", "build")
        }
        if ($Rebuild -or -not (Test-Path "dist\control-ui\platformclaw-login.html")) {
            Write-Step "Building PlatformClaw Control UI"
            Invoke-Checked -Command corepack -Arguments @("pnpm", "ui:build")
        }
    }
    finally {
        Pop-Location
    }
}

function Initialize-Runtime {
    param([string]$SourceRoot)

    $runtimeRoot = Join-Path $DataRoot "runtime"
    $gatewayRoot = Join-Path $runtimeRoot "gateway"
    $workspaceRoot = Join-Path $runtimeRoot "workspaces"
    $controlRoot = Join-Path $runtimeRoot "control"
    New-Item -ItemType Directory -Force $gatewayRoot, $workspaceRoot, $controlRoot | Out-Null

    $tokenFile = Join-Path $runtimeRoot "gateway-token"
    $adminFile = Join-Path $runtimeRoot "initial-admin-ids"
    $configFile = Join-Path $gatewayRoot "openclaw.json"
    if (-not (Test-Path $tokenFile)) {
        Write-Utf8NoBom $tokenFile (New-RandomToken)
    }
    Write-Utf8NoBom $adminFile "admin.user"

    $gatewayConfig = @'
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "auth": { "mode": "token" },
    "controlUi": { "enabled": false }
  },
  "plugins": {
    "entries": {
      "admin-http-rpc": { "enabled": true }
    }
  }
}
'@
    if (-not (Test-Path $configFile)) {
        Write-Utf8NoBom $configFile $gatewayConfig
    }

    $env:OPENCLAW_STATE_DIR = $gatewayRoot
    $env:OPENCLAW_CONFIG_PATH = $configFile
    $env:OPENCLAW_GATEWAY_TOKEN = (Get-Content $tokenFile -Raw).Trim()
    $env:PLATFORMCLAW_PUBLIC_ORIGIN = "http://127.0.0.1:$Port"
    $env:PLATFORMCLAW_LISTEN_HOST = "127.0.0.1"
    $env:PLATFORMCLAW_LISTEN_PORT = "$Port"
    $env:PLATFORMCLAW_DATABASE_PATH = Join-Path $controlRoot "platformclaw-control.sqlite"
    $env:PLATFORMCLAW_CONTROL_UI_ROOT = Join-Path $SourceRoot "dist\control-ui"
    $env:PLATFORMCLAW_PERSONAL_WORKSPACE_ROOT = $workspaceRoot
    $env:PLATFORMCLAW_INITIAL_ADMIN_ACCOUNT_IDS_FILE = $adminFile
    $env:PLATFORMCLAW_GATEWAY_URL = "ws://127.0.0.1:$GatewayPort"
    $env:PLATFORMCLAW_GATEWAY_TOKEN_FILE = $tokenFile
    $env:PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL = "http://127.0.0.1:$EmployeeAuthPort/login"
}

function Test-HttpEndpoint {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    }
    catch {
        return $false
    }
}

function Wait-HttpEndpoint {
    param([string]$Url, [string]$Name, [int]$TimeoutSeconds = 90)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpEndpoint $Url) {
            Write-Step "$Name ready"
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "$Name did not become ready. Check its PowerShell window: $Url"
}

function Assert-PortAvailable {
    param([int]$PortNumber, [string]$Name)
    $client = New-Object Net.Sockets.TcpClient
    try {
        $result = $client.BeginConnect("127.0.0.1", $PortNumber, $null, $null)
        if ($result.AsyncWaitHandle.WaitOne(300) -and $client.Connected) {
            throw "$Name port $PortNumber is already in use"
        }
    }
    finally {
        $client.Dispose()
    }
}

function Start-VisibleShell {
    param([string]$Title, [string]$SourceRoot, [string]$Command)

    $escapedTitle = $Title.Replace("'", "''")
    $escapedRoot = $SourceRoot.Replace("'", "''")
    $body = "`$Host.UI.RawUI.WindowTitle = '$escapedTitle'; Set-Location -LiteralPath '$escapedRoot'; $Command"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
    $shell = (Get-Process -Id $PID).Path
    return Start-Process -FilePath $shell -ArgumentList @("-NoExit", "-EncodedCommand", $encoded) -PassThru
}

function Start-PlatformClaw {
    Assert-Command git
    Assert-Command node
    Assert-Command corepack
    $python = Get-PythonCommand
    $sha = Get-SourceSha
    $sourceRoot = Initialize-SourceSnapshot $sha
    Initialize-DependenciesAndUi $sourceRoot
    $previousEnvironment = @{}
    foreach ($name in $runtimeEnvironmentNames) {
        $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }

    try {
        Initialize-Runtime $sourceRoot
        $loginUrl = "http://127.0.0.1:$Port/platformclaw/login"
        if (Test-HttpEndpoint "http://127.0.0.1:$Port/platformclaw/health") {
            Write-Step "PlatformClaw is already running"
            Start-Process $loginUrl
            return
        }

        Assert-PortAvailable $EmployeeAuthPort "Employee auth mock"
        Assert-PortAvailable $GatewayPort "Gateway"
        Assert-PortAvailable $Port "Control/UI"

        $pythonPrefix = ($python.Prefix | ForEach-Object { "'$_'" }) -join " "
        $pythonCommand = "& '$($python.Command)' $pythonPrefix 'scripts\mock_employee_auth.py' --bind 127.0.0.1 --port $EmployeeAuthPort"
        $auth = Start-VisibleShell "PlatformClaw - employee auth mock" $sourceRoot $pythonCommand
        Wait-HttpEndpoint "http://127.0.0.1:$EmployeeAuthPort/healthz" "Employee auth mock"

        $gateway = Start-VisibleShell "PlatformClaw - Gateway" $sourceRoot "corepack pnpm openclaw gateway --bind loopback --port $GatewayPort"
        Wait-HttpEndpoint "http://127.0.0.1:$GatewayPort/healthz" "Gateway"

        $control = Start-VisibleShell "PlatformClaw - Control/UI" $sourceRoot "corepack pnpm platformclaw:control"
        Wait-HttpEndpoint "http://127.0.0.1:$Port/platformclaw/health" "Control/UI"

        Write-Host ""
        Write-Host "PlatformClaw main preview is ready" -ForegroundColor Green
        Write-Host "  URL:      $loginUrl"
        Write-Host "  User:     person.one / test-password"
        Write-Host "  Admin:    admin.user / test-password"
        Write-Host "  Source:   $SourceRef ($sha)"
        Write-Host "  PIDs:     auth=$($auth.Id), gateway=$($gateway.Id), control=$($control.Id)"
        Write-Host "  Stop:     press Ctrl+C or close the three process windows"
        Start-Process $loginUrl
    }
    finally {
        foreach ($name in $runtimeEnvironmentNames) {
            [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
        }
    }
}

if ($Action -eq "Menu") {
    Write-Host ""
    Write-Host "PlatformClaw Windows main preview" -ForegroundColor Green
    Write-Host "  1. Start latest main"
    Write-Host "  2. Start current checkout"
    Write-Host "  3. Check environment and runtime"
    Write-Host "  4. Rebuild and start latest main"
    Write-Host "  5. Rebuild and start current checkout"
    Write-Host "  Q. Quit"
    $choice = (Read-Host "Select").Trim().ToUpperInvariant()
    switch ($choice) {
        "1" { $Action = "Start" }
        "2" { $Action = "Start"; $SourceRef = "HEAD" }
        "3" { $Action = "Doctor" }
        "4" { $Action = "Start"; $Rebuild = $true }
        "5" { $Action = "Start"; $SourceRef = "HEAD"; $Rebuild = $true }
        "Q" { return }
        default { throw "Unknown selection: $choice" }
    }
}

switch ($Action) {
    "Start" { Start-PlatformClaw }
    "Doctor" { Show-Doctor }
}
