#!/usr/bin/env bash
# wizard.sh -- Interactive first-run configuration wizard
# Triggered when ~/.claudebox/config.json does not exist.
# Re-runnable via 'claudebox config'.
set -euo pipefail

CONFIG_DIR="${HOME}/.claudebox"
CONFIG_FILE="${CONFIG_DIR}/config.json"

cb_run_wizard() {
    echo ""
    echo "ClaudeBox Configuration Wizard"
    echo "=============================="
    echo ""

    mkdir -p "$CONFIG_DIR"

    # Load existing values if config exists
    local existing_language="" existing_claude_config_path=""
    local existing_extra_apt_raw="" existing_extra_domains_raw=""
    local existing_extra_commands_json="[]"
    if [[ -f "$CONFIG_FILE" ]]; then
        existing_language=$(jq -r '.language // "auto"' "$CONFIG_FILE")
        existing_claude_config_path=$(jq -r '.claude_config_path // ""' "$CONFIG_FILE")
        existing_extra_apt_raw=$(jq -r '(.extra_apt_packages // []) | join(",")' "$CONFIG_FILE")
        existing_extra_domains_raw=$(jq -r '(.extra_domains // []) | join(",")' "$CONFIG_FILE")
        existing_extra_commands_json=$(jq -c '.extra_commands // []' "$CONFIG_FILE")
    fi

    # ── Essential settings ────────────────────────────────────────────────────

    # Language preference
    echo "Language preference:"
    echo "  auto  - Auto-detect from project files (recommended)"
    echo "  dotnet, node, python, go, rust, java - Force specific language"
    echo ""
    read -rp "Language [${existing_language:-auto}]: " language
    language="${language:-${existing_language:-auto}}"

    # Claude config path
    echo ""
    echo "Claude config path (optional):"
    echo "  Path to a claude config repo (e.g., structured-claude-config)"
    echo "  with agents/, conventions/, output-styles/, skills/ subfolders."
    echo "  Leave empty to skip."
    echo ""
    read -rp "Claude config path [${existing_claude_config_path}]: " claude_config_path
    claude_config_path="${claude_config_path:-${existing_claude_config_path}}"

    # Validate path if provided
    if [[ -n "$claude_config_path" && ! -d "$claude_config_path" ]]; then
        echo "Warning: Directory '${claude_config_path}' does not exist." >&2
        read -rp "Use anyway? [y/N]: " confirm
        if [[ "${confirm,,}" != "y" ]]; then
            claude_config_path=""
        fi
    fi

    # ── Advanced settings gate ────────────────────────────────────────────────

    echo ""
    read -rp "Configure advanced settings? [y/N]: " configure_advanced
    configure_advanced="${configure_advanced:-n}"

    local -a extra_apt=()
    local -a extra_commands=()
    local -a extra_domains=()

    if [[ "${configure_advanced,,}" == "y" ]]; then

        # Extra apt packages
        echo ""
        echo "Extra apt packages to install in containers (comma-separated, or empty):"
        echo "  Example: vim,htop,tree"
        echo ""
        read -rp "Extra apt packages [${existing_extra_apt_raw}]: " extra_apt_raw
        extra_apt_raw="${extra_apt_raw:-${existing_extra_apt_raw}}"
        if [[ -n "$extra_apt_raw" ]]; then
            IFS=',' read -ra extra_apt <<< "$extra_apt_raw"
            for i in "${!extra_apt[@]}"; do
                extra_apt[$i]=$(echo "${extra_apt[$i]}" | xargs)
            done
        fi

        # Extra commands
        echo ""
        echo "Extra shell commands to run after language setup (one per line, empty line to finish):"
        echo "  Example: pip3 install --break-system-packages pydantic"
        if [[ "$existing_extra_commands_json" != "[]" ]]; then
            echo "  Current values:"
            jq -r '.[]' <<< "$existing_extra_commands_json" | while IFS= read -r cmd; do
                echo "    ${cmd}"
            done
        fi
        echo ""
        while true; do
            read -rp "> " cmd_line
            [[ -z "$cmd_line" ]] && break
            extra_commands+=("$cmd_line")
        done
        # If user entered nothing, restore existing commands
        if [[ ${#extra_commands[@]} -eq 0 && "$existing_extra_commands_json" != "[]" ]]; then
            while IFS= read -r cmd; do
                extra_commands+=("$cmd")
            done < <(jq -r '.[]' <<< "$existing_extra_commands_json")
        fi

        # Extra domains
        echo ""
        echo "Additional firewall domains to allow (comma-separated, or empty):"
        echo "  Example: custom-registry.example.com,my-api.example.com"
        echo ""
        read -rp "Extra domains [${existing_extra_domains_raw}]: " extra_domains_raw
        extra_domains_raw="${extra_domains_raw:-${existing_extra_domains_raw}}"
        if [[ -n "$extra_domains_raw" ]]; then
            IFS=',' read -ra extra_domains <<< "$extra_domains_raw"
            for i in "${!extra_domains[@]}"; do
                extra_domains[$i]=$(echo "${extra_domains[$i]}" | xargs)
            done
        fi

    else
        # Preserve existing advanced values when skipping advanced settings
        if [[ -f "$CONFIG_FILE" ]]; then
            if [[ -n "$existing_extra_apt_raw" ]]; then
                IFS=',' read -ra extra_apt <<< "$existing_extra_apt_raw"
                for i in "${!extra_apt[@]}"; do
                    extra_apt[$i]=$(echo "${extra_apt[$i]}" | xargs)
                done
            fi
            while IFS= read -r cmd; do
                extra_commands+=("$cmd")
            done < <(jq -r '.[]' <<< "$existing_extra_commands_json")
            if [[ -n "$existing_extra_domains_raw" ]]; then
                IFS=',' read -ra extra_domains <<< "$existing_extra_domains_raw"
                for i in "${!extra_domains[@]}"; do
                    extra_domains[$i]=$(echo "${extra_domains[$i]}" | xargs)
                done
            fi
        fi
    fi

    # ── Build JSON config with jq ─────────────────────────────────────────────
    local config
    config=$(jq -n \
        --arg lang "$language" \
        --arg ccp "$claude_config_path" \
        --argjson apt "$(printf '%s\n' "${extra_apt[@]+"${extra_apt[@]}"}" | jq -R . | jq -s '.')" \
        --argjson cmds "$(printf '%s\n' "${extra_commands[@]+"${extra_commands[@]}"}" | jq -R . | jq -s '.')" \
        --argjson domains "$(printf '%s\n' "${extra_domains[@]+"${extra_domains[@]}"}" | jq -R . | jq -s '.')" \
        '{
            language: $lang,
            claude_config_path: $ccp,
            extra_apt_packages: ($apt | map(select(. != ""))),
            extra_commands: ($cmds | map(select(. != ""))),
            extra_domains: ($domains | map(select(. != ""))),
            extra_suffixes: [],
            extra_volumes: {}
        }')

    echo "$config" > "$CONFIG_FILE"

    echo ""
    echo "Configuration saved to ${CONFIG_FILE}"
    echo ""
    echo "You can edit this file directly or run 'claudebox config' again."
}

# Auto-run wizard if sourced and config doesn't exist
cb_check_first_run() {
    if [[ ! -f "$CONFIG_FILE" ]]; then
        if [[ -t 0 ]]; then
            echo "First-run setup detected."
            cb_run_wizard
        fi
    fi
}
