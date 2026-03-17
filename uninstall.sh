#!/usr/bin/env bash
# ClaudeBox uninstaller for bash/Linux/macOS.
# Removes ~/.local/share/claudebox, ~/.local/bin/claudebox, and PATH entries
# added to .bashrc/.zshrc by install.sh. Prompts before removing ~/.claudebox/ config.
# Docker containers and volumes are left in place; see final output for cleanup command.
set -euo pipefail

CLAUDEBOX_HOME="${HOME}/.local/share/claudebox"
LAUNCHER="${HOME}/.local/bin/claudebox"
CONFIG_DIR="${HOME}/.claudebox"

echo "ClaudeBox Uninstaller"
echo "====================="

# --- Step 1: Remove CLAUDEBOX_HOME and launcher ---
echo ""
if [[ -d "$CLAUDEBOX_HOME" ]]; then
    rm -rf "$CLAUDEBOX_HOME"
    echo "Removed $CLAUDEBOX_HOME"
else
    echo "No install found at $CLAUDEBOX_HOME (already removed)"
fi

if [[ -f "$LAUNCHER" ]]; then
    rm -f "$LAUNCHER"
    echo "Removed $LAUNCHER"
else
    echo "No launcher found at $LAUNCHER (already removed)"
fi

# --- Step 2: Remove PATH lines from shell rc files ---
echo ""
remove_path_lines() {
    local rc_file="$1"
    if [[ -f "$rc_file" ]]; then
        if sed --version 2>/dev/null | grep -q GNU; then
            sed -i '/# Added by ClaudeBox installer/{N;d}' "$rc_file"
        else
            sed -i '' '/# Added by ClaudeBox installer/{N;d}' "$rc_file"
        fi
        echo "Removed ClaudeBox PATH entries from $rc_file"
    fi
}

remove_path_lines "${HOME}/.bashrc"
remove_path_lines "${HOME}/.zshrc"

# --- Step 3: Prompt before removing config ---
echo ""
if [[ -d "$CONFIG_DIR" ]]; then
    read -r -p "Remove config directory $CONFIG_DIR? [y/N] " config_prompt </dev/tty
    if [[ "$config_prompt" =~ ^[Yy] ]]; then
        rm -rf "$CONFIG_DIR"
        echo "Removed $CONFIG_DIR"
    else
        echo "Config at $CONFIG_DIR was NOT removed."
    fi
else
    echo "No config directory found at $CONFIG_DIR"
fi

echo ""
echo "Docker containers and volumes were NOT removed."
echo "To clean up: docker ps -a --filter name=claudebox- | xargs docker rm -f"
echo ""
echo "Uninstall complete. Restart your shell to apply PATH changes."
