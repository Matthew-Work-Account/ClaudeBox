<#
.SYNOPSIS
    ClaudeBox WSL shim - delegates to claudebox.sh via WSL.

.DESCRIPTION
    Thin wrapper that translates Windows paths and forwards all commands
    to the bash implementation running inside WSL. Preserves the same
    CLI interface (init/stop/destroy/ref/prune/help/config/empty=resume).
    Supports init flags: --rebuild, --no-start.

.PARAMETER Subcommand
    The command to run (init, stop, destroy, ref, prune, config, help, or empty for resume).
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Position=0, ValueFromRemainingArguments=$true)]
    [string[]]$Arguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Check WSL availability
try {
    $wslStatus = wsl.exe --status 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "WSL is not available or not properly configured. Please install WSL: https://learn.microsoft.com/en-us/windows/wsl/install"
        exit 1
    }
} catch {
    Write-Error "WSL is not available. Please install WSL: https://learn.microsoft.com/en-us/windows/wsl/install"
    exit 1
}

function ConvertTo-WslPath {
    param([string]$WindowsPath)
    if ($WindowsPath -match '^([A-Za-z]):\\(.*)') {
        $drive = $Matches[1].ToLower()
        $rest = $Matches[2] -replace '\\','/'
        return "/mnt/$drive/$rest"
    }
    return $WindowsPath -replace '\\','/'
}

# Discover claudebox.sh via well-known WSL install path
$claudeboxSh = (wsl.exe -- bash -c 'echo ~/.local/share/claudebox/claudebox.sh').Trim()
wsl.exe -- test -f "$claudeboxSh"
if ($LASTEXITCODE -ne 0) {
    Write-Error "claudebox.sh not found at $claudeboxSh in WSL. Please run install.sh first to install ClaudeBox."
    exit 1
}

# Convert current directory for WSL
$cwd = (Get-Location).Path
$wslCwd = ConvertTo-WslPath $cwd

# Build argument list, converting any path-like arguments
$wslArgs = @()
foreach ($arg in $Arguments) {
    if ($arg -match '^[A-Za-z]:\\') {
        $wslArgs += ConvertTo-WslPath $arg
    } else {
        $wslArgs += $arg
    }
}

# Execute via WSL
$allArgs = @($claudeboxSh) + $wslArgs
wsl.exe bash -c "cd '$wslCwd' && $($allArgs -join ' ')"
