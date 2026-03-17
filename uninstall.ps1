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

# --- Step 1b: Remove from User PATH ---
$currentUserPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
$pathParts = ($currentUserPath -split ';') | Where-Object { $_ -ne '' -and $_ -ne $InstallDir }
$newPath = $pathParts -join ';'
if ($newPath -ne $currentUserPath) {
    [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
    Write-Host "Removed $InstallDir from User PATH"
} else {
    Write-Host "$InstallDir was not in User PATH"
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
        wsl.exe bash -c "rm -rf ~/.local/share/claudebox; rm -f ~/.local/bin/claudebox; if [ -f ~/.bashrc ]; then sed -i '/# Added by ClaudeBox installer/{N;d}' ~/.bashrc; echo cleaned .bashrc; fi; if [ -f ~/.zshrc ]; then sed -i '/# Added by ClaudeBox installer/{N;d}' ~/.zshrc; echo cleaned .zshrc; fi"
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Removed ~/.local/share/claudebox, ~/.local/bin/claudebox, and PATH entries from WSL"
        }
    }
} catch {
    Write-Host "Could not reach WSL. Manually remove in WSL:" -ForegroundColor Yellow
    Write-Host "  rm -rf ~/.local/share/claudebox ~/.local/bin/claudebox" -ForegroundColor Yellow
}

# --- Note about config ---
Write-Host ""
$configPrompt = Read-Host "Remove WSL config directory ~/.claudebox/? [y/N]"
if ($configPrompt -match '^[Yy]') {
    try {
        wsl.exe bash -c "rm -rf ~/.claudebox"
        Write-Host "Removed ~/.claudebox/" -ForegroundColor Green
    } catch {
        Write-Host "Could not remove ~/.claudebox/ -- remove it manually in WSL." -ForegroundColor Yellow
    }
} else {
    Write-Host "Config at ~/.claudebox/ (in WSL) was NOT removed." -ForegroundColor Yellow
    Write-Host "To remove it manually: wsl bash -c 'rm -rf ~/.claudebox'" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Docker containers and volumes were NOT removed." -ForegroundColor Yellow
Write-Host "To clean up: docker ps -a --filter name=claudebox- | xargs docker rm -f" -ForegroundColor Yellow
Write-Host ""
Write-Host "Uninstall complete. Restart PowerShell to finish." -ForegroundColor Green
