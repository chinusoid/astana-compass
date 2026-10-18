#requires -Version 7.0
<#
.SYNOPSIS
Starts the local API and web app; Ctrl+C stops only the processes started here.
.EXAMPLE
pwsh -File scripts/dev.ps1 -Mode fixture -LlmProvider none
.EXAMPLE
pwsh -File scripts/dev.ps1 -Mode live -EnvFile .env.local -ApiPort 18081 -WebPort 13000
#>
[CmdletBinding()]
param(
    [ValidateSet('fixture', 'live')][string]$Mode = 'fixture',
    [ValidateRange(1024, 65535)][int]$ApiPort = 8000,
    [ValidateRange(1024, 65535)][int]$WebPort = 3000,
    [ValidateSet('openfreemap', 'osm', 'none')][string]$MapProvider = 'openfreemap',
    [ValidateSet('none', 'openai', 'nvidia')][string]$LlmProvider,
    [string]$EnvFile,
    [switch]$SkipInstall,
    [ValidateRange(5, 300)][int]$ReadyTimeoutSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repoRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $repoRoot 'apps/web'
$ownedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "A required command failed (exit $LASTEXITCODE). See its output above."
    }
}

function Assert-FreePort {
    param([int]$Port)
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.ExclusiveAddressUse = $true
    try { $listener.Start() }
    catch { throw "Port $Port is unavailable. Choose another port; this launcher never stops existing services." }
    finally { $listener.Stop() }
}

function Start-OwnedProcess {
    param([string]$Executable, [string[]]$Arguments, [string]$Directory, [hashtable]$Environment)
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    $start.WorkingDirectory = $Directory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    foreach ($name in $Environment.Keys) { $start.Environment[$name] = $Environment[$name] }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Could not start a child process.' }
    }
    catch { $process.Dispose(); throw }
    $ownedProcesses.Add($process)
    return $process
}

function Wait-Ready {
    param([System.Diagnostics.Process]$Process, [string]$Url, [string]$Name)
    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) { throw "$Name exited before it became ready (exit $($Process.ExitCode))." }
        try {
            $response = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -MaximumRedirection 0
            if ($response.StatusCode -eq 200 -and -not $Process.HasExited) { return }
        }
        catch { # Not ready yet; do not print response bodies or environment values.
        }
        Start-Sleep -Milliseconds 500
    }
    throw "$Name did not become ready within $ReadyTimeoutSeconds seconds. Check the server output and configuration."
}

Push-Location -LiteralPath $repoRoot
try {
    if ($ApiPort -eq $WebPort) { throw 'API and web must use different ports.' }
    if (-not $IsWindows) { throw 'Use scripts/dev.sh on non-Windows hosts.' }
    $uv = (Get-Command uv -CommandType Application -ErrorAction Stop).Source
    $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    if (-not $SkipInstall) { $pnpm = (Get-Command pnpm -CommandType Application -ErrorAction Stop).Source }
    if ($EnvFile) {
        $resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
        if (-not (Test-Path -LiteralPath $resolvedEnvFile -PathType Leaf)) { throw 'EnvFile must name a file.' }
    }
    Assert-FreePort $ApiPort
    Assert-FreePort $WebPort

    if (-not $SkipInstall) {
        Invoke-Checked $uv @('sync', '--locked', '--all-packages')
        Invoke-Checked $pnpm @('--dir', $webRoot, 'install', '--frozen-lockfile')
    }
    $nextCli = Join-Path $webRoot 'node_modules/next/dist/bin/next'
    if (-not (Test-Path -LiteralPath $nextCli -PathType Leaf)) {
        throw 'Next.js is not installed. Run this launcher without -SkipInstall.'
    }
    Invoke-Checked $node @((Join-Path $webRoot 'scripts/prepare-map.mjs'))

    $apiEnvironment = @{ ASTANA_MODE = $Mode; CORS_ORIGINS = "http://127.0.0.1:$WebPort" }
    if ($PSBoundParameters.ContainsKey('LlmProvider')) { $apiEnvironment.LLM_PROVIDER = $LlmProvider }
    $apiArguments = @('run', '--locked', '--no-sync')
    if ($EnvFile) { $apiArguments += @('--env-file', $resolvedEnvFile) }
    else { $apiArguments += '--no-env-file' }
    $apiArguments += @('uvicorn', 'astana_api.app:create_app', '--factory', '--host', '127.0.0.1', '--port', "$ApiPort", '--no-access-log')
    Write-Host "Starting API in $Mode mode..."
    $api = Start-OwnedProcess $uv $apiArguments $repoRoot $apiEnvironment
    Wait-Ready $api "http://127.0.0.1:$ApiPort/v1/health/ready" 'API'

    $webEnvironment = @{
        ASTANA_API_URL = "http://127.0.0.1:$ApiPort"
        ASTANA_ALLOW_FIXTURES = if ($Mode -eq 'fixture') { 'true' } else { 'false' }
        ASTANA_MAP_PROVIDER = $MapProvider
        NEXT_TELEMETRY_DISABLED = '1'
    }
    $web = Start-OwnedProcess $node @($nextCli, 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', "$WebPort") $webRoot $webEnvironment
    Wait-Ready $web "http://127.0.0.1:$WebPort/" 'Web app'
    Write-Host "Web: http://127.0.0.1:$WebPort/"
    Write-Host "API: http://127.0.0.1:$ApiPort/docs"
    Write-Host "Managed process IDs: API $($api.Id), web $($web.Id)."
    Write-Host 'Press Ctrl+C to stop both services started by this launcher.'
    while ($true) {
        foreach ($process in $ownedProcesses) {
            if ($process.HasExited) { throw "A managed service exited (exit $($process.ExitCode)); stopping the other service." }
        }
        Start-Sleep -Milliseconds 500
    }
}
finally {
    foreach ($process in $ownedProcesses) {
        try {
            if (-not $process.HasExited) {
                $process.Kill($true)
                [void]$process.WaitForExit(5000)
            }
        }
        catch { Write-Warning 'A managed process could not be stopped cleanly.' }
        finally { $process.Dispose() }
    }
    Pop-Location
}
