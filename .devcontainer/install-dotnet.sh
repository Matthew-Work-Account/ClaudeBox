#!/bin/bash
# install-dotnet.sh -- .NET SDK auto-installer for claudebox containers
# Scans /workspace and /deps for .csproj files, extracts TargetFramework
# monikers, and installs only the required SDK channels via dotnet-install.sh.
# Runs at container startup after init-firewall.sh. (ref: DL-003, DL-008, DL-010)
#
# SDK versions cannot be baked into the image because they depend on which
# project is mounted, which varies per invocation. (ref: DL-008)
#
# Recognized monikers: net6.0, net7.0, net8.0, net9.0, netcoreapp2.1, netcoreapp3.1
# Unrecognized monikers (netstandard2.0, net48, etc.) are skipped with a warning.
# Falls back to .NET 8.0 LTS when no recognized monikers are found. (ref: DL-012)
#
# sdk_installed() checks dotnet --list-sdks to avoid re-downloading already
# present SDKs (named volume claudebox-dotnet persists across container recreations).
set -euo pipefail

DOTNET_INSTALL_SCRIPT="/home/node/dotnet-install.sh"

# Download the install script if not already present
if [[ ! -f "$DOTNET_INSTALL_SCRIPT" ]]; then
    echo "Downloading dotnet-install.sh..."
    if ! curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$DOTNET_INSTALL_SCRIPT" 2>/dev/null; then
        echo "Primary URL failed, trying GitHub mirror..."
        curl -fsSL https://raw.githubusercontent.com/dotnet/install-scripts/main/src/dotnet-install.sh -o "$DOTNET_INSTALL_SCRIPT"
    fi
    chmod +x "$DOTNET_INSTALL_SCRIPT"
fi

WORKSPACE="/workspace"
DEPS_DIR="/deps"
DEFAULT_FALLBACK_CHANNEL="8.0"

map_framework_to_channel() {
    local framework="$1"
    # net6.0, net7.0, net8.0, net9.0, net10.0, etc.
    if [[ "$framework" =~ ^net([0-9]+\.[0-9]+)$ ]]; then
        echo "${BASH_REMATCH[1]}"
    # netcoreapp2.1, netcoreapp3.1, etc.
    elif [[ "$framework" =~ ^netcoreapp([0-9]+\.[0-9]+)$ ]]; then
        echo "${BASH_REMATCH[1]}"
    else
        echo ""
    fi
}

DOTNET_CMD="${DOTNET_INSTALL_DIR:-/home/node/.dotnet}/dotnet"

sdk_installed() {
    local channel="$1"
    local major_minor
    major_minor=$(echo "$channel" | cut -d. -f1-2)
    if "$DOTNET_CMD" --list-sdks 2>/dev/null | grep -q "^${major_minor}\."; then
        return 0
    fi
    return 1
}

declare -A CHANNELS_NEEDED
declare -A WARNINGS

scan_dir() {
    local dir="$1"
    [ -d "$dir" ] || return 0
    while IFS= read -r csproj; do
        while IFS= read -r line; do
            if echo "$line" | grep -qiE '<TargetFrameworks?>'; then
                value=$(echo "$line" | sed -E 's|.*<TargetFrameworks?>(.*)</TargetFrameworks?>.*|\1|i')
                IFS=';' read -ra frameworks <<< "$value"
                for fw in "${frameworks[@]}"; do
                    fw=$(echo "$fw" | tr -d ' \t\r\n')
                    [ -z "$fw" ] && continue
                    channel=$(map_framework_to_channel "$fw")
                    if [ -n "$channel" ]; then
                        CHANNELS_NEEDED["$channel"]=1
                    else
                        WARNINGS["$fw"]=1
                    fi
                done
            fi
        done < "$csproj"
    done < <(find "$dir" -name "*.csproj" 2>/dev/null)
}

echo "Scanning $WORKSPACE and $DEPS_DIR for .csproj files..."
scan_dir "$WORKSPACE"
scan_dir "$DEPS_DIR"

for fw in "${!WARNINGS[@]}"; do
    echo "WARN: Skipping unrecognized TargetFramework moniker: $fw (not a Linux-installable SDK)"
done

if [ ${#CHANNELS_NEEDED[@]} -eq 0 ]; then
    echo "No recognized .NET SDK monikers found. Installing default fallback SDK ${DEFAULT_FALLBACK_CHANNEL} (LTS)..."
    CHANNELS_NEEDED["$DEFAULT_FALLBACK_CHANNEL"]=1
fi

for channel in "${!CHANNELS_NEEDED[@]}"; do
    if sdk_installed "$channel"; then
        echo "SDK $channel already installed, skipping."
    else
        echo "Installing .NET SDK channel $channel..."
        "$DOTNET_INSTALL_SCRIPT" --channel "$channel" --install-dir "$DOTNET_INSTALL_DIR"
        echo "SDK $channel installed."
    fi
done

echo "Done. Installed SDKs:"
"$DOTNET_CMD" --list-sdks 2>/dev/null || echo "  (none)"
