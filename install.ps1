<#
.SYNOPSIS
    ClaudeBox Windows installer.

.DESCRIPTION
    Installs claudebox.ps1 to %LOCALAPPDATA%\ClaudeBox\, adds the claudebox
    function to the PowerShell profile, and runs install.sh in WSL to set up
    the bash side.
#>
#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'ClaudeBox'
$ScriptSource = Join-Path $PSScriptRoot 'claudebox.ps1'
$ProfilePath = $PROFILE

Write-Host "ClaudeBox Windows Installer" -ForegroundColor Cyan
Write-Host "==========================" -ForegroundColor Cyan
Write-Host ""

# --- Step 1: Copy claudebox.ps1 to %LOCALAPPDATA%\ClaudeBox ---
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir | Out-Null
}

Write-Host "Copying claudebox.ps1 to $InstallDir..."
Copy-Item -Path $ScriptSource -Destination (Join-Path $InstallDir 'claudebox.ps1') -Force

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
        Write-Host "  cd $(ConvertTo-WslPath $PSScriptRoot) && bash install.sh" -ForegroundColor Yellow
    } else {
        $repoWsl = "/mnt/$($PSScriptRoot.Substring(0,1).ToLower())/$($PSScriptRoot.Substring(3) -replace '\\','/')"
        wsl.exe bash -c "cd '$repoWsl' && bash install.sh"
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
