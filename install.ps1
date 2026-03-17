<#
.SYNOPSIS
    ClaudeBox Windows installer.

.DESCRIPTION
    Installs claudebox.ps1 to %LOCALAPPDATA%\ClaudeBox\, adds that directory
    to the User PATH, adds the claudebox function to the PowerShell profile,
    and runs install.sh in WSL to set up the bash side.

    Supports two modes:
      - Local:  run from a git clone ($PSScriptRoot contains claudebox.ps1)
      - Remote: run via  irm .../install.ps1 | iex  (downloads claudebox.ps1)
#>
#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoBase = 'https://raw.githubusercontent.com/Matthew-Work-Account/ClaudeBox/main'
$InstallDir = Join-Path $env:LOCALAPPDATA 'ClaudeBox'
$ProfilePath = $PROFILE

# --- Resolve script source: local clone or remote download ---
$TempDir = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'claudebox.ps1'))) {
    $ScriptSource = Join-Path $PSScriptRoot 'claudebox.ps1'
} else {
    $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $TempDir | Out-Null
    $ScriptSource = Join-Path $TempDir 'claudebox.ps1'
    Write-Host "Downloading claudebox.ps1 from GitHub..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri "$RepoBase/claudebox.ps1" -OutFile $ScriptSource -ErrorAction Stop
    } catch {
        if ($TempDir -and (Test-Path $TempDir)) { Remove-Item -Recurse -Force $TempDir }
        Write-Error "Failed to download ClaudeBox -- check your network connection or clone the repo: https://github.com/Matthew-Work-Account/ClaudeBox"
        exit 1
    }
}

Write-Host "ClaudeBox Windows Installer" -ForegroundColor Cyan
Write-Host "==========================" -ForegroundColor Cyan
Write-Host ""

# --- Step 1: Copy claudebox.ps1 to %LOCALAPPDATA%\ClaudeBox ---
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir | Out-Null
}

Write-Host "Copying claudebox.ps1 to $InstallDir..."
Copy-Item -Path $ScriptSource -Destination (Join-Path $InstallDir 'claudebox.ps1') -Force

# Clean up temp directory from remote download
if ($TempDir -and (Test-Path $TempDir)) {
    Remove-Item -Recurse -Force $TempDir
}

# --- Step 1b: Add install dir to User PATH ---
Write-Host "Adding $InstallDir to User PATH..."
$currentUserPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
$pathParts = ($currentUserPath -split ';') | Where-Object { $_ -ne '' }
if ($pathParts -notcontains $InstallDir) {
    $newPath = ($pathParts + $InstallDir) -join ';'
    [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
    $env:PATH = "$env:PATH;$InstallDir"
    Write-Host "Added $InstallDir to User PATH"
} else {
    Write-Host "$InstallDir already in User PATH"
}

# --- Step 2: Add claudebox function to PowerShell profile ---
$FunctionLine = "function claudebox { & `"$InstallDir\claudebox.ps1`" @args }"

if (Test-Path $ProfilePath) {
    $profileContent = Get-Content $ProfilePath -Raw -ErrorAction SilentlyContinue
    if ($profileContent -and $profileContent.Contains('function claudebox')) {
        # Remove existing claudebox function line(s) and replace
        $lines = Get-Content $ProfilePath
        $filtered = $lines | Where-Object { $_ -notmatch '^\s*function claudebox\s' }
        $filtered = @($filtered) + $FunctionLine
        Set-Content -Path $ProfilePath -Value $filtered
        Write-Host "Updated existing claudebox function in $ProfilePath"
    } else {
        Add-Content -Path $ProfilePath -Value "`n$FunctionLine"
        Write-Host "Added claudebox function to $ProfilePath"
    }
} else {
    # Create profile if it doesn't exist
    $profileDir = Split-Path $ProfilePath -Parent
    if (-not (Test-Path $profileDir)) {
        New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    }
    Set-Content -Path $ProfilePath -Value $FunctionLine
    Write-Host "Created $ProfilePath with claudebox function"
}

# --- Step 3: Run install.sh in WSL ---
Write-Host ""
Write-Host "Setting up WSL side..."
try {
    $wslStatus = wsl.exe --status 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "WARNING: WSL not available. Skipping bash-side install." -ForegroundColor Yellow
        Write-Host "  Run this manually in WSL later:" -ForegroundColor Yellow
        Write-Host "  curl -fsSL $RepoBase/install.sh | bash" -ForegroundColor Yellow
    } else {
        # In remote mode ($PSScriptRoot is empty), use curl|bash inside WSL.
        # In local mode, cd to the repo and run install.sh directly.
        if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'install.sh'))) {
            $repoWsl = "/mnt/$($PSScriptRoot.Substring(0,1).ToLower())/$($PSScriptRoot.Substring(3) -replace '\\','/')"
            wsl.exe bash -c "cd '$repoWsl' && bash install.sh"
        } else {
            wsl.exe bash -c "curl -fsSL $RepoBase/install.sh | bash"
        }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "WARNING: WSL install.sh failed. You may need to run it manually." -ForegroundColor Yellow
        }
    }
} catch {
    Write-Host "WARNING: Could not run WSL install. Run install.sh manually in WSL." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Restart PowerShell (or run: . `$PROFILE)"
Write-Host "  2. Navigate to a project directory"
Write-Host "  3. Run: claudebox init"
Write-Host ""
