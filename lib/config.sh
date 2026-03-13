#!/usr/bin/env bash
# config.sh -- Config loading and merging via jq
# Reads ~/.claudebox/config.json (global) and .claudebox.json (project-local),
# deep-merges them with specific semantics:
#   - Scalars: local wins
#   - Arrays: concatenated (global first, local appended)
# Writes merged result to /tmp/claudebox-config.json
set -euo pipefail

CB_MERGED_CONFIG="/tmp/claudebox-config.json"

cb_load_config() {
    local project_dir="${1:-.}"
    local global_config="${HOME}/.claudebox/config.json"
    local local_config="${project_dir}/.claudebox.json"

    # Start with empty defaults
    local base='{"language":"auto","claude_config_path":"","extra_domains":[],"extra_suffixes":[],"extra_volumes":{},"extra_apt_packages":[],"extra_commands":[]}'

    local global_json="$base"
    if [[ -f "$global_config" ]]; then
        # Merge global config onto base
        global_json=$(jq -s '
            .[0] as $base | .[1] as $global |
            $base * $global
        ' <(echo "$base") "$global_config")
    fi

    if [[ -f "$local_config" ]]; then
        # Merge local onto global with array concatenation semantics
        jq -s '
            .[0] as $g | .[1] as $l |
            ($g * $l) |
            # Override array fields with concatenation instead of replacement
            .extra_domains = (($g.extra_domains // []) + ($l.extra_domains // [])) |
            .extra_suffixes = (($g.extra_suffixes // []) + ($l.extra_suffixes // [])) |
            .extra_apt_packages = (($g.extra_apt_packages // []) + ($l.extra_apt_packages // [])) |
            .extra_commands = (($g.extra_commands // []) + ($l.extra_commands // []))
        ' <(echo "$global_json") "$local_config" > "$CB_MERGED_CONFIG"
    else
        echo "$global_json" > "$CB_MERGED_CONFIG"
    fi
}

cb_config_get() {
    local key="$1"
    jq -r ".${key} // empty" "$CB_MERGED_CONFIG"
}

cb_config_get_array() {
    local key="$1"
    jq -r ".${key}[]? // empty" "$CB_MERGED_CONFIG"
}
