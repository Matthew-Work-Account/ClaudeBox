#!/usr/bin/env bash
# ClaudeBox installer.
# Installs to CLAUDEBOX_HOME (~/.local/share/claudebox/) and creates a thin
# launcher at ~/.local/bin/claudebox.
# Idempotent: overwrites existing install, skips PATH if already configured.
#
# Two install modes:
#   local  -- run directly from a git clone; BASH_SOURCE[0] resolves to a file
#   remote -- piped from curl; BASH_SOURCE[0] is empty/unset or non-existent;
#             downloads a GitHub tarball to a temp dir and sets SCRIPT_DIR
#             so the copy logic below runs without modification
set -euo pipefail

CLAUDEBOX_HOME="${HOME}/.local/share/claudebox"
LAUNCHER_DIR="${HOME}/.local/bin"
CONFIG_DIR="${HOME}/.claudebox"

# --- Detect remote (curl|bash) vs local install ---
# BASH_SOURCE[0] is empty/unset when the script is piped from curl. The
# file-existence check also covers process substitution (/dev/fd/* paths).
_src="${BASH_SOURCE[0]:-}"
if [[ -z "$_src" ]] || [[ ! -f "$_src" ]]; then
    REPO="https://github.com/Matthew-Work-Account/ClaudeBox"
    TARBALL_URL="${REPO}/archive/refs/heads/main.tar.gz"
    TMPDIR_CB="$(mktemp -d)"
    trap 'rm -rf "${TMPDIR_CB}"' EXIT

    echo "ClaudeBox Installer (remote)"
    echo "============================"
    echo "Downloading ClaudeBox from GitHub..."

    TARBALL_FILE="${TMPDIR_CB}/claudebox.tar.gz"
    if ! curl -fsSL -o "${TARBALL_FILE}" "${TARBALL_URL}"; then
        echo "Failed to download ClaudeBox from GitHub -- check your network connection"
        exit 1
    fi

    # --strip-components=1 drops the top-level 'ClaudeBox-main/' directory so
    # extracted files land directly in TMPDIR_CB, matching CLAUDEBOX_HOME layout.
    if ! tar -xzf "${TARBALL_FILE}" --strip-components=1 -C "${TMPDIR_CB}"; then
        echo "Failed to extract ClaudeBox archive"
        exit 1
    fi

    SCRIPT_DIR="${TMPDIR_CB}"
else
    SCRIPT_DIR="$(cd "$(dirname "$_src")" && pwd)"

    echo "ClaudeBox Installer"
    echo "==================="
fi

# --- Check for old sed-patched layout ---
old_files_found=false
for old_path in \
    "${LAUNCHER_DIR}/claudebox-lib" \
    "${LAUNCHER_DIR}/claudebox-languages" \
    "${LAUNCHER_DIR}/claudebox-devcontainer"; do
    if [[ -e "$old_path" ]]; then
        old_files_found=true
        break
    fi
done

if $old_files_found; then
    echo ""
    echo "NOTE: Old ClaudeBox install detected in ${LAUNCHER_DIR}/."
    echo "      The following directories are no longer needed and can be removed:"
    for old_path in \
        "${LAUNCHER_DIR}/claudebox-lib" \
        "${LAUNCHER_DIR}/claudebox-languages" \
        "${LAUNCHER_DIR}/claudebox-devcontainer"; do
        [[ -e "$old_path" ]] && echo "        rm -rf ${old_path}"
    done
    echo ""
fi

# --- Create directories ---
mkdir -p "$CLAUDEBOX_HOME"
mkdir -p "$LAUNCHER_DIR"
mkdir -p "$CONFIG_DIR"

# --- Copy files into CLAUDEBOX_HOME ---
echo "Installing ClaudeBox to ${CLAUDEBOX_HOME}..."
cp "${SCRIPT_DIR}/claudebox.sh" "${CLAUDEBOX_HOME}/claudebox.sh"
chmod +x "${CLAUDEBOX_HOME}/claudebox.sh"

cp "${SCRIPT_DIR}/uninstall.sh" "${CLAUDEBOX_HOME}/uninstall.sh"
chmod +x "${CLAUDEBOX_HOME}/uninstall.sh"

cp -r "${SCRIPT_DIR}/lib" "${CLAUDEBOX_HOME}/"
cp -r "${SCRIPT_DIR}/languages" "${CLAUDEBOX_HOME}/"
cp -r "${SCRIPT_DIR}/.devcontainer" "${CLAUDEBOX_HOME}/"

# --- Save repo URL for upgrades ---
repo_url=$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || true)
if [[ -z "$repo_url" ]]; then
    repo_url="https://github.com/Matthew-Work-Account/ClaudeBox"
fi
echo "$repo_url" > "${CLAUDEBOX_HOME}/.repo-url"
echo "Saved repo URL for future upgrades: ${repo_url}"

# --- Create thin launcher ---
echo "Creating launcher at ${LAUNCHER_DIR}/claudebox..."
# Unquoted heredoc so ~ expands at creation time
cat > "${LAUNCHER_DIR}/claudebox" <<LAUNCHER
#!/usr/bin/env bash
export CLAUDEBOX_HOME=~/.local/share/claudebox
exec "\${CLAUDEBOX_HOME}/claudebox.sh" "\$@"
LAUNCHER
chmod +x "${LAUNCHER_DIR}/claudebox"

# --- PATH setup ---
add_to_path() {
    local rc_file="$1"
    if [[ -f "$rc_file" ]]; then
        if ! grep -q '\.local/bin' "$rc_file" 2>/dev/null; then
            echo "" >> "$rc_file"
            echo '# Added by ClaudeBox installer' >> "$rc_file"
            echo 'export PATH="${HOME}/.local/bin:${PATH}"' >> "$rc_file"
            echo "Added ~/.local/bin to PATH in ${rc_file}"
        else
            echo "PATH already configured in ${rc_file}"
        fi
    fi
}

current_shell=$(basename "${SHELL:-/bin/bash}")
case "$current_shell" in
    zsh)
        add_to_path "${HOME}/.zshrc"
        ;;
    bash)
        add_to_path "${HOME}/.bashrc"
        ;;
    *)
        [[ -f "${HOME}/.bashrc" ]] && add_to_path "${HOME}/.bashrc"
        [[ -f "${HOME}/.zshrc" ]] && add_to_path "${HOME}/.zshrc"
        ;;
esac

echo ""
echo "Installation complete!"
echo ""
echo "To get started:"
echo "  1. Restart your shell or run: source ~/.bashrc (or ~/.zshrc)"
echo "  2. Navigate to a project directory"
echo "  3. Run: claudebox init"
echo ""
echo "On first run, claudebox will guide you through configuration."
echo "You can also run 'claudebox config' to configure at any time."
echo ""
echo "Windows PowerShell users:"
echo "  Run install.ps1 from a git clone, or use the PowerShell one-liner:"
echo "  irm https://raw.githubusercontent.com/Matthew-Work-Account/ClaudeBox/main/install.ps1 | iex"
echo "  install.ps1 copies claudebox.ps1 to %LOCALAPPDATA%\ClaudeBox\ and adds it to your PATH."
