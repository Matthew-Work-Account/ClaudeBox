<#
.SYNOPSIS
    ClaudeBox Windows uninstaller.

.DESCRIPTION
    Removes claudebox.ps1 from %LOCALAPPDATA%\ClaudeBox\, removes the claudebox
    function from the PowerShell profile, and removes the WSL install.
#>
#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'ClaudeBox'
$ProfilePath = $PROFILE

Write-Host "ClaudeBox Uninstaller" -ForegroundColor Cyan
Write-Host "=====================" -ForegroundColor Cyan
Write-Host ""

# --- Step 1: Remove %LOCALAPPDATA%\ClaudeBox ---
if (Test-Path $InstallDir) {
    Remove-Item -Path $InstallDir -Recurse -Force
    Write-Host "Removed $InstallDir"
} else {
    Write-Host "No install found at $InstallDir (already removed)"
}

# --- Step 2: Remove claudebox function from profile ---
if (Test-Path $ProfilePath) {
    $lines = Get-Content $ProfilePath
    $filtered = $lines | Where-Object { $_ -notmatch '^\s*function claudebox\s' }
    if ($filtered.Count -lt $lines.Count) {
        Set-Content -Path $ProfilePath -Value $filtered
        Write-Host "Removed claudebox function from $ProfilePath"
    } else {
        Write-Host "No claudebox function found in $ProfilePath"
    }
} else {
    Write-Host "No PowerShell profile found at $ProfilePath"
}

# --- Step 3: Remove WSL install ---
Write-Host ""
try {
    $wslStatus = wsl.exe --status 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Removing WSL install..."
        wsl.exe bash -c "rm -rf ~/.local/share/claudebox && rm -f ~/.local/bin/claudebox"
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Removed ~/.local/share/claudebox and ~/.local/bin/claudebox from WSL"
        }
    }
} catch {
    Write-Host "Could not reach WSL. Manually remove in WSL:" -ForegroundColor Yellow
    Write-Host "  rm -rf ~/.local/share/claudebox ~/.local/bin/claudebox" -ForegroundColor Yellow
}

# --- Note about config ---
Write-Host ""
Write-Host "Note: Your config at ~/.claudebox/ (in WSL) was NOT removed." -ForegroundColor Yellow
Write-Host "To remove it: wsl bash -c 'rm -rf ~/.claudebox'" -ForegroundColor Yellow
Write-Host ""
Write-Host "Docker containers and volumes were NOT removed." -ForegroundColor Yellow
Write-Host "To clean up: docker ps -a --filter name=claudebox- | docker rm -f" -ForegroundColor Yellow
Write-Host ""
Write-Host "Uninstall complete. Restart PowerShell to finish." -ForegroundColor Green
