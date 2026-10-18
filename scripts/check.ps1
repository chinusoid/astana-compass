#requires -Version 7.0
<#
.SYNOPSIS
Runs locked installs, Python and frontend checks, shared TypeScript, and production build.
.DESCRIPTION
Does not start long-running servers or run browser E2E/live-provider checks.
If npm is unavailable, uses pnpm dlx npm@11.6.2 for the isolated shared compiler.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repoRoot = Split-Path -Parent $PSScriptRoot
$checkEnvironment = @{
    ASTANA_MODE = 'fixture'
    LLM_PROVIDER = 'none'
    ASTANA_ALLOW_FIXTURES = 'true'
    ASTANA_MAP_PROVIDER = 'none'
    ASTANA_WEATHER_ENABLED = 'false'
    NEXT_TELEMETRY_DISABLED = '1'
    UV_NO_ENV_FILE = '1'
}
$previousEnvironment = @{}

function Invoke-Check {
    param([string]$Name, [string]$Executable, [string[]]$Arguments)
    Write-Host "Checking: $Name"
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE). Later checks were not run." }
}

Push-Location -LiteralPath $repoRoot
try {
    if (-not $IsWindows) { throw 'Use scripts/check.sh on non-Windows hosts.' }
    $uv = (Get-Command uv -CommandType Application -ErrorAction Stop).Source
    $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $pnpm = (Get-Command pnpm -CommandType Application -ErrorAction Stop).Source
    $npm = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue
    foreach ($name in $checkEnvironment.Keys) {
        $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $checkEnvironment[$name], 'Process')
    }

    Invoke-Check 'locked Python workspace' $uv @('sync', '--locked', '--all-packages')
    Invoke-Check 'Python tests' $uv @('run', '--locked', '--no-env-file', 'pytest')
    Invoke-Check 'HTTP smoke self-test' $uv @('run', '--locked', '--no-env-file', 'python', 'scripts/smoke.py', '--self-test')
    Invoke-Check 'canonical contract fixtures' $uv @('run', '--locked', '--no-env-file', 'python', 'verify_contracts.py')
    Invoke-Check 'generated artifacts' $uv @('run', '--locked', '--no-env-file', 'python', 'scripts/generate_contracts.py', '--check')
    Invoke-Check 'Python lint' $uv @('run', '--locked', '--no-env-file', 'ruff', 'check', '--select', 'E9,F', '.')
    $installCompiler = @('ci', '--prefix', '.github/typescript', '--ignore-scripts', '--no-audit', '--no-fund')
    $checkCompiler = @('run', '--prefix', '.github/typescript', 'check')
    if ($npm) {
        Invoke-Check 'locked shared TypeScript compiler' $npm.Source $installCompiler
        Invoke-Check 'shared TypeScript' $npm.Source $checkCompiler
    }
    else {
        Write-Host 'npm is not on PATH; using the pinned pnpm dlx npm@11.6.2 fallback.'
        Invoke-Check 'locked shared TypeScript compiler' $pnpm (@('dlx', 'npm@11.6.2') + $installCompiler)
        Invoke-Check 'shared TypeScript' $pnpm (@('dlx', 'npm@11.6.2') + $checkCompiler)
    }
    Invoke-Check 'sandbox JavaScript syntax' $node @('--check', 'services/api/src/astana_api/static/sandbox.js')
    Invoke-Check 'locked frontend dependencies' $pnpm @('--dir', 'apps/web', 'install', '--frozen-lockfile')
    Invoke-Check 'frontend and E2E types' $pnpm @('--dir', 'apps/web', 'typecheck')
    Invoke-Check 'frontend and E2E lint' $pnpm @('--dir', 'apps/web', 'lint')
    Invoke-Check 'frontend unit tests' $pnpm @('--dir', 'apps/web', 'test')
    Invoke-Check 'production frontend build' $pnpm @('--dir', 'apps/web', 'build')
    Write-Host 'PASS local checks. Browser E2E, HTTP server smoke, live providers and remote CI are separate checks.'
}
finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
    Pop-Location
}
