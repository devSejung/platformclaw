[CmdletBinding()]
param(
    [ValidateSet("Menu", "Start", "Stop", "Status", "Logs", "Reset")]
    [string]$Action = "Menu",
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "PlatformClaw\vm-preview"),
    [int]$Port = 19001,
    [ValidatePattern("^[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+$")]
    [string]$Model = "openai/gpt-5.4",
    [ValidateSet("off", "minimal", "low", "medium", "high", "xhigh")]
    [string]$Thinking = "low",
    [switch]$Rebuild,
    [switch]$AllowDirty,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$composeFile = Join-Path $repoRoot "docker\platformclaw-runtime\compose.yaml"
$smokeComposeFile = Join-Path $repoRoot "docker\platformclaw-runtime\compose.smoke.yaml"
$previewComposeFile = Join-Path $repoRoot "docker\platformclaw-runtime\compose.preview.yaml"
$projectName = "platformclaw-vm-preview"
$markerName = ".platformclaw-vm-preview"

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

function Write-Utf8NoBom {
    param([string]$Path, [string]$Value)
    [IO.File]::WriteAllText($Path, "$Value`n", (New-Object Text.UTF8Encoding($false)))
}

function New-RandomHex {
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

function New-RandomBase64 {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    return [Convert]::ToBase64String($bytes)
}

function Get-PreviewPaths {
    $resolvedRoot = [IO.Path]::GetFullPath($DataRoot)
    return @{
        Root = $resolvedRoot
        Marker = Join-Path $resolvedRoot $markerName
        Workspace = Join-Path $resolvedRoot "workspaces"
        SandboxRuntime = Join-Path $resolvedRoot "sandbox-runtime-unused"
        SandboxTar = Join-Path $resolvedRoot "platformclaw-sandbox.tar"
        SandboxImageId = Join-Path $resolvedRoot "platformclaw-sandbox.image-id"
        ImageManifest = Join-Path $resolvedRoot "image-manifest.json"
        GatewayToken = Join-Path $resolvedRoot "gateway-token"
        GatewayServiceIdentity = Join-Path $resolvedRoot "gateway-service-identity.pem"
        ExecutionToken = Join-Path $resolvedRoot "execution-service-token"
        KnoxWebhookSecret = Join-Path $resolvedRoot "knox-webhook-secret"
        KnoxServiceToken = Join-Path $resolvedRoot "knox-service-token"
        AdminIds = Join-Path $resolvedRoot "initial-admin-ids"
        CredentialKey = Join-Path $resolvedRoot "ssh-credential-master-key"
        EmployeeAuthCa = Join-Path $resolvedRoot "employee-auth-ca.pem"
    }
}

function Initialize-PreviewCa {
    param([hashtable]$Paths)
    if (Test-Path $Paths.EmployeeAuthCa) {
        return
    }
    $gitExecutable = (Get-Command git -ErrorAction Stop).Source
    $gitRoot = Split-Path (Split-Path $gitExecutable -Parent) -Parent
    $candidates = @(
        (Join-Path $gitRoot "mingw64\etc\ssl\certs\ca-bundle.crt"),
        (Join-Path $gitRoot "usr\ssl\certs\ca-bundle.crt")
    )
    $source = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $source) {
        throw "Unable to find the Git for Windows CA bundle"
    }
    Copy-Item -LiteralPath $source -Destination $Paths.EmployeeAuthCa
}

function Initialize-PreviewData {
    $paths = Get-PreviewPaths
    if ((Test-Path $paths.Root) -and -not (Test-Path $paths.Marker)) {
        $existingItems = @(Get-ChildItem -LiteralPath $paths.Root -Force)
        if ($existingItems.Count -gt 0) {
            throw "Refusing to use an existing non-empty, unmarked data root: $($paths.Root)"
        }
    }
    New-Item -ItemType Directory -Force $paths.Root, $paths.Workspace, $paths.SandboxRuntime | Out-Null
    if (-not (Test-Path $paths.Marker)) {
        Write-Utf8NoBom $paths.Marker "PlatformClaw disposable VM preview data"
    }
    if (-not (Test-Path $paths.GatewayToken)) {
        Write-Utf8NoBom $paths.GatewayToken (New-RandomHex)
    }
    if (-not (Test-Path $paths.GatewayServiceIdentity)) {
        Invoke-Checked -Command node -Arguments @(
            "-e",
            "const c=require('node:crypto'),f=require('node:fs');const k=c.generateKeyPairSync('ed25519').privateKey;f.writeFileSync(process.argv[1],k.export({type:'pkcs8',format:'pem'}),{mode:0o600});",
            $paths.GatewayServiceIdentity
        )
    }
    if (-not (Test-Path $paths.ExecutionToken)) {
        Write-Utf8NoBom $paths.ExecutionToken (New-RandomHex)
    }
    if (-not (Test-Path $paths.KnoxWebhookSecret)) {
        Write-Utf8NoBom $paths.KnoxWebhookSecret (New-RandomHex)
    }
    if (-not (Test-Path $paths.KnoxServiceToken)) {
        Write-Utf8NoBom $paths.KnoxServiceToken (New-RandomHex)
    }
    if (-not (Test-Path $paths.AdminIds)) {
        Write-Utf8NoBom $paths.AdminIds "admin.user"
    }
    if (-not (Test-Path $paths.CredentialKey)) {
        Write-Utf8NoBom $paths.CredentialKey (New-RandomBase64)
    }
    return $paths
}

function Get-ImageTags {
    $version = (Get-Content -Raw (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
    Push-Location $repoRoot
    try {
        $fullSha = (& git rev-parse HEAD).Trim()
        $shortSha = (& git rev-parse --short=12 HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $fullSha -or -not $shortSha) {
            throw "Unable to resolve the current source commit"
        }
    }
    finally {
        Pop-Location
    }
    return @{
        Runtime = "platformclaw:$shortSha"
        Sandbox = "platformclaw-sandbox:$shortSha"
        Commit = $fullSha
        Version = $version
    }
}

function Get-DockerImageId {
    param([string]$Image)
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $imageId = (& docker image inspect $Image --format "{{.Id}}" 2>$null)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        return ""
    }
    return ($imageId | Select-Object -First 1).Trim()
}

function Set-PreviewEnvironment {
    param([hashtable]$Paths, [hashtable]$Images)
    Initialize-PreviewCa $Paths
    $env:PLATFORMCLAW_IMAGE = $Images.Runtime
    $env:PLATFORMCLAW_SANDBOX_IMAGE = $Images.Sandbox
    $env:PLATFORMCLAW_RUNTIME_UID = "1000"
    $env:PLATFORMCLAW_RUNTIME_GID = "1000"
    $env:PLATFORMCLAW_DEPLOY_ROOT = "/var/lib/platformclaw"
    $env:PLATFORMCLAW_DEPLOY_HOST_ROOT = $Paths.Root
    $env:PLATFORMCLAW_CREDENTIAL_BROKER_VOLUME_NAME = "$projectName-credential-broker-1000-1000"
    $env:PLATFORMCLAW_REPO_ROOT = $repoRoot
    $env:PLATFORMCLAW_SANDBOX_DOCKER_RUNTIME_DIR = $Paths.SandboxRuntime
    $env:PLATFORMCLAW_SMOKE_WORKSPACE_DIR = $Paths.Workspace
    $env:PLATFORMCLAW_SMOKE_SANDBOX_IMAGE_TAR = $Paths.SandboxTar
    $env:PLATFORMCLAW_PUBLIC_PORT = "$Port"
    $env:PLATFORMCLAW_PUBLIC_ORIGIN = "http://127.0.0.1:$Port"
    $env:PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL = "http://127.0.0.1:18080/login"
    $env:PLATFORMCLAW_EMPLOYEE_AUTH_CA_FILE = $Paths.EmployeeAuthCa
    $env:PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE = $Paths.GatewayToken
    $env:PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_SECRET_FILE = $Paths.GatewayServiceIdentity
    $env:PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE = $Paths.ExecutionToken
    $env:PLATFORMCLAW_KNOX_CDEP_URL = "http://127.0.0.1:18081/api/v1/platformclaw/knox/outbound/send"
    $env:PLATFORMCLAW_KNOX_WEBHOOK_SECRET_SECRET_FILE = $Paths.KnoxWebhookSecret
    $env:PLATFORMCLAW_KNOX_SERVICE_TOKEN_SECRET_FILE = $Paths.KnoxServiceToken
    $env:PLATFORMCLAW_INITIAL_ADMIN_IDS_SECRET_FILE = $Paths.AdminIds
    $env:PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE = $Paths.CredentialKey
}

function Get-ComposeArguments {
    param([string[]]$Tail)
    return @(
        "compose", "--project-name", $projectName,
        "-f", $composeFile,
        "-f", $smokeComposeFile,
        "-f", $previewComposeFile
    ) + $Tail
}

function Invoke-Compose {
    param([string[]]$Arguments)
    Invoke-Checked -Command docker -Arguments (Get-ComposeArguments $Arguments)
}

function Get-RunningControlImageId {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $composeArguments = Get-ComposeArguments @("ps", "--quiet", "platformclaw-control")
        $containerLine = (& docker @composeArguments 2>$null) | Select-Object -First 1
        $containerId = if ($containerLine) { $containerLine.Trim() } else { "" }
        if ($LASTEXITCODE -ne 0 -or -not $containerId) {
            return ""
        }
        $imageLine = (& docker inspect $containerId --format "{{.Image}}" 2>$null) |
            Select-Object -First 1
        $imageId = if ($imageLine) { $imageLine.Trim() } else { "" }
        if ($LASTEXITCODE -ne 0) {
            return ""
        }
        return $imageId
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Ensure-Images {
    param([hashtable]$Images, [hashtable]$Paths, [bool]$DirtyCheckout)
    $runtimeImageId = Get-DockerImageId $Images.Runtime
    $sandboxImageId = Get-DockerImageId $Images.Sandbox
    $manifest = if (Test-Path $Paths.ImageManifest) {
        try {
            Get-Content -Raw -LiteralPath $Paths.ImageManifest | ConvertFrom-Json
        }
        catch {
            $null
        }
    }
    else {
        $null
    }
    $verifiedCache = $manifest -and
        $manifest.commit -eq $Images.Commit -and
        $manifest.runtimeImageId -eq $runtimeImageId -and
        $manifest.sandboxImageId -eq $sandboxImageId
    $needsBuild = $Rebuild -or $DirtyCheckout -or -not $verifiedCache
    if ($needsBuild) {
        Write-Step $(if ($DirtyCheckout) {
            "Building the current working tree. The first build can take a while."
        } else {
            "Building the exact current commit. The first build can take a while."
        })
        Push-Location $repoRoot
        try {
            $buildArguments = @("scripts/platformclaw-build.mjs", "--no-export")
            if ($AllowDirty) {
                $buildArguments += "--allow-dirty"
            }
            Invoke-Checked -Command node -Arguments $buildArguments
        }
        finally {
            Pop-Location
        }
        $runtimeImageId = Get-DockerImageId $Images.Runtime
        $sandboxImageId = Get-DockerImageId $Images.Sandbox
        if (-not $runtimeImageId -or -not $sandboxImageId) {
            throw "The PlatformClaw build did not produce both required images"
        }
        if (-not $DirtyCheckout) {
            $manifestJson = @{
                commit = $Images.Commit
                runtimeImageId = $runtimeImageId
                sandboxImageId = $sandboxImageId
            } | ConvertTo-Json
            Write-Utf8NoBom $Paths.ImageManifest $manifestJson
        }
    }
    $archivedImageId = if (Test-Path $Paths.SandboxImageId) {
        (Get-Content -Raw -LiteralPath $Paths.SandboxImageId).Trim()
    }
    else {
        ""
    }
    if ($Rebuild -or -not (Test-Path $Paths.SandboxTar) -or
        $archivedImageId -ne $sandboxImageId) {
        Write-Step "Preparing the sandbox image for the nested Docker daemon"
        $temporaryTar = "$($Paths.SandboxTar).tmp-$PID"
        try {
            if (Test-Path $temporaryTar) {
                Remove-Item -LiteralPath $temporaryTar -Force
            }
            Invoke-Checked -Command docker -Arguments @(
                "save", "--output", $temporaryTar, $Images.Sandbox
            )
            Move-Item -LiteralPath $temporaryTar -Destination $Paths.SandboxTar -Force
        }
        finally {
            if (Test-Path $temporaryTar) {
                Remove-Item -LiteralPath $temporaryTar -Force
            }
        }
        Write-Utf8NoBom $Paths.SandboxImageId $sandboxImageId
    }
}

function Test-Health {
    try {
        $response = Invoke-WebRequest -UseBasicParsing `
            -Uri "http://127.0.0.1:$Port/platformclaw/health" -TimeoutSec 2
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Test-PreviewEmployeeAuth {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $composeArguments = Get-ComposeArguments @(
            "exec", "-T", "platformclaw-control", "node", "-e",
            "fetch('http://127.0.0.1:18080/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        )
        & docker @composeArguments 2>$null
        return $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Test-RunningGatewayApiKey {
    $key = if ($null -eq $env:OPENAI_API_KEY) { "" } else { $env:OPENAI_API_KEY }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($key))
        $expectedHash = ([BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $composeArguments = Get-ComposeArguments @(
            "exec", "-T", "openclaw-gateway", "node", "-e",
            "const c=require('node:crypto');const h=c.createHash('sha256').update(process.env.OPENAI_API_KEY??'').digest('hex');process.exit(h===process.argv[1]?0:1)",
            $expectedHash
        )
        & docker @composeArguments 2>$null
        return $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Repair-PreviewEmployeeAuth {
    if (Test-PreviewEmployeeAuth) {
        return
    }
    # The mock shares the Control network namespace to keep HTTP loopback-only.
    # Reattach it after a Control restart so fresh browser logins keep working.
    Write-Step "Reattaching the disposable employee login mock"
    Invoke-Compose @("up", "--detach", "--force-recreate", "employee-auth-mock")
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-PreviewEmployeeAuth) {
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "The disposable employee login mock did not become reachable"
}

function Set-PreviewDefaultModel {
    Write-Step "Selecting preview model $Model with $Thinking thinking"
    Invoke-Compose @(
        "exec", "-T", "openclaw-gateway", "node", "/app/openclaw.mjs",
        "config", "set", "agents.defaults.model.primary", $Model
    )
    Invoke-Compose @(
        "exec", "-T", "openclaw-gateway", "node", "/app/openclaw.mjs",
        "config", "set", "agents.defaults.thinkingDefault", $Thinking
    )
}

function Show-TestGuide {
    param([hashtable]$Images)
    $hostKeyArguments = Get-ComposeArguments @(
        "exec", "-T", "fake-safeconnect", "cat", "/state/host-key.json"
    )
    $hostKeyText = (& docker @hostKeyArguments) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read the Fake SafeConnect host key"
    }
    $hostKey = $hostKeyText | ConvertFrom-Json
    $loginUrl = "http://127.0.0.1:$Port/platformclaw/login"

    Write-Host ""
    Write-Host "PlatformClaw VM preview is ready" -ForegroundColor Green
    Write-Host "  URL:              $loginUrl"
    Write-Host "  Administrator:    admin.user / test-password"
    Write-Host "  Employee:         person.one / test-password"
    Write-Host "  Runtime image:    $($Images.Runtime)"
    Write-Host "  Default model:    $Model"
    Write-Host "  Default thinking: $Thinking"
    if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) {
        Write-Warning "OPENAI_API_KEY is not set. The UI will connect, but OpenAI chat turns will fail authentication."
    }
    Write-Host ""
    Write-Host "Register these values as the administrator:" -ForegroundColor Yellow
    Write-Host "  Endpoint label:   Fake SafeConnect"
    Write-Host "  Endpoint host:    safeconnect.platformclaw.test"
    Write-Host "  SSH port:         44422"
    Write-Host "  AD domain:        samsungds.net"
    Write-Host "  Host algorithm:   $($hostKey.algorithm)"
    Write-Host "  Host fingerprint: $($hostKey.fingerprint)"
    Write-Host "  Host public key:  $($hostKey.publicKey)"
    Write-Host "  VM label:         Home test VM"
    Write-Host "  VM address:       10.0.0.10"
    Write-Host "  Agent ID:         person_one"
    Write-Host "  Linux account:    person_one"
    Write-Host ""
    Write-Host "Then sign in as person.one:" -ForegroundColor Yellow
    Write-Host "  Fake AD password: platformclaw-safeconnect-fixture-password"
    Write-Host "  Test: register password -> connection test -> switch to personal VM"
    Write-Host "  Reset everything: .\scripts\platformclaw-vm-preview.ps1 -Action Reset"

    if (-not $NoBrowser) {
        Start-Process $loginUrl
    }
}

function Start-Preview {
    Assert-Command docker
    Assert-Command git
    Assert-Command node
    Invoke-Checked -Command docker -Arguments @("version")
    Invoke-Checked -Command docker -Arguments @("compose", "version")
    Push-Location $repoRoot
    try {
        $changes = @(& git status --porcelain)
        $dirtyCheckout = $changes.Count -gt 0
        if ($dirtyCheckout -and -not $AllowDirty) {
            throw "The source checkout is dirty. Commit or stash it before testing the merged build."
        }
        if ($dirtyCheckout) {
            Write-Step "Testing uncommitted local changes; no transfer artifact will be created"
        }
    }
    finally {
        Pop-Location
    }
    $paths = Initialize-PreviewData
    $images = Get-ImageTags
    Set-PreviewEnvironment $paths $images
    Ensure-Images $images $paths $dirtyCheckout
    if (Test-Health) {
        $desiredImageId = Get-DockerImageId $images.Runtime
        if ((Get-RunningControlImageId) -eq $desiredImageId) {
            Write-Step "The VM preview is already running"
            if (-not (Test-RunningGatewayApiKey)) {
                Write-Step "The preview model credential changed; recreating Gateway"
                Invoke-Compose @(
                    "up", "--detach", "--force-recreate", "--wait", "--wait-timeout", "120",
                    "openclaw-gateway"
                )
            }
            Repair-PreviewEmployeeAuth
            Set-PreviewDefaultModel
            Show-TestGuide $images
            return
        }
        Write-Step "The source image changed; recreating the preview containers"
        Invoke-Compose @("down", "--remove-orphans")
    }
    Write-Step "Starting Gateway, Control, sandbox Docker, and Fake SafeConnect"
    Invoke-Compose @("up", "--detach", "--wait", "--wait-timeout", "240")
    if (-not (Test-Health)) {
        Invoke-Compose @("logs", "--no-color", "--tail", "200")
        throw "PlatformClaw did not become healthy"
    }
    Repair-PreviewEmployeeAuth
    Set-PreviewDefaultModel
    Show-TestGuide $images
}

function Invoke-ExistingPreview {
    param([ValidateSet("Stop", "Status", "Logs", "Reset")][string]$Operation)
    $paths = Get-PreviewPaths
    if (-not (Test-Path $paths.Marker)) {
        Write-Step "No VM preview data exists at $($paths.Root)"
        return
    }
    $images = Get-ImageTags
    Set-PreviewEnvironment $paths $images
    switch ($Operation) {
        "Stop" { Invoke-Compose @("down", "--remove-orphans") }
        "Status" {
            Invoke-Compose @("ps")
            Write-Host "  Browser health: $(if (Test-Health) { 'ready' } else { 'down' })"
        }
        "Logs" { Invoke-Compose @("logs", "--no-color", "--tail", "200") }
        "Reset" {
            Invoke-Compose @("down", "--volumes", "--remove-orphans")
            $resolved = [IO.Path]::GetFullPath($paths.Root)
            if ($resolved -eq [IO.Path]::GetPathRoot($resolved) -or
                -not (Test-Path (Join-Path $resolved $markerName))) {
                throw "Refusing to reset an unmarked or broad path: $resolved"
            }
            foreach ($ownedPath in @(
                $paths.Workspace,
                $paths.SandboxRuntime,
                $paths.SandboxTar,
                $paths.SandboxImageId,
                $paths.ImageManifest,
                $paths.GatewayToken,
                $paths.GatewayServiceIdentity,
                $paths.ExecutionToken,
                $paths.KnoxWebhookSecret,
                $paths.KnoxServiceToken,
                $paths.AdminIds,
                $paths.CredentialKey,
                $paths.EmployeeAuthCa,
                $paths.Marker
            )) {
                if (Test-Path $ownedPath) {
                    Remove-Item -LiteralPath $ownedPath -Recurse -Force
                }
            }
            if (@(Get-ChildItem -LiteralPath $resolved -Force).Count -eq 0) {
                Remove-Item -LiteralPath $resolved -Force
            }
            Write-Step "Removed PlatformClaw-owned disposable VM preview data from: $resolved"
        }
    }
}

if ($Action -eq "Menu") {
    Write-Host ""
    Write-Host "PlatformClaw VM preview" -ForegroundColor Green
    Write-Host "  1. Start or resume"
    Write-Host "  2. Show status"
    Write-Host "  3. Show recent logs"
    Write-Host "  4. Stop (keep test data)"
    Write-Host "  5. Reset all disposable test data"
    Write-Host "  Q. Quit"
    $choice = (Read-Host "Select").Trim().ToUpperInvariant()
    switch ($choice) {
        "1" { $Action = "Start" }
        "2" { $Action = "Status" }
        "3" { $Action = "Logs" }
        "4" { $Action = "Stop" }
        "5" { $Action = "Reset" }
        "Q" { return }
        default { throw "Unknown selection: $choice" }
    }
}

switch ($Action) {
    "Start" { Start-Preview }
    "Stop" { Invoke-ExistingPreview "Stop" }
    "Status" { Invoke-ExistingPreview "Status" }
    "Logs" { Invoke-ExistingPreview "Logs" }
    "Reset" { Invoke-ExistingPreview "Reset" }
}
