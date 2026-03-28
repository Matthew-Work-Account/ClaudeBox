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
    local base='{"language":"auto","claude_config_path":"","extra_domains":[],"extra_suffixes":[],"extra_volumes":{},"extra_apt_packages":[],"extra_commands":[],"modules":[],"extra_env":[],"env_profile":"","env_profiles":{},"default_env_profile":"","extra_hosts":[]}'

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
            .extra_commands = (($g.extra_commands // []) + ($l.extra_commands // [])) |
            .extra_env = (($g.extra_env // []) + ($l.extra_env // [])) |
            .modules = (($g.modules // []) + ($l.modules // [])) |
            .extra_hosts = (($g.extra_hosts // []) + ($l.extra_hosts // []))
        ' <(echo "$global_json") "$local_config" > "$CB_MERGED_CONFIG"
    else
        echo "$global_json" > "$CB_MERGED_CONFIG"
    fi

    cb_resolve_modules "$project_dir"
}

# cb_find_module -- Locate a module JSON file by name.
# Search order: builtin -> user (~/.claudebox/modules/) -> project (.claudebox/modules/)
# Built-ins take precedence intentionally: user and project scopes can add new modules
# but cannot silently override built-ins. This ensures all users of a named built-in
# get consistent, tested behavior regardless of local config. If you need to customize
# a built-in, create a module with a different name and list both in 'modules'.
cb_find_module() {
    local name="$1"
    local project_dir="${2:-$(pwd)}"
    local builtin_path="${CLAUDEBOX_HOME}/modules/${name}.json"
    local user_path="${HOME}/.claudebox/modules/${name}.json"
    local project_path="${project_dir}/.claudebox/modules/${name}.json"
    if [[ -f "$builtin_path" ]]; then echo "$builtin_path"; return 0; fi
    if [[ -f "$user_path" ]]; then echo "$user_path"; return 0; fi
    if [[ -f "$project_path" ]]; then echo "$project_path"; return 0; fi
    return 1
}

cb_resolve_modules() {
    local project_dir="${1:-.}"

    local module_names
    module_names=$(jq -r '.modules[]?' "$CB_MERGED_CONFIG" 2>/dev/null || true)
    [[ -z "$module_names" ]] && return 0

    while IFS= read -r name; do
        [[ -z "$name" ]] && continue

        local module_file=""
        if ! module_file=$(cb_find_module "$name" "$project_dir"); then
            echo "Warning: Module '${name}' not found (searched built-in, user, and project paths)" >&2
            continue
        fi

        local merged
        merged=$(jq -s '
            .[0] as $cfg | .[1] as $mod |
            $cfg |
            .extra_domains = (($cfg.extra_domains // []) + ($mod.extra_domains // [])) |
            .extra_suffixes = (($cfg.extra_suffixes // []) + ($mod.extra_suffixes // [])) |
            .extra_apt_packages = (($cfg.extra_apt_packages // []) + ($mod.extra_apt_packages // [])) |
            .extra_commands = (($cfg.extra_commands // []) + ($mod.extra_commands // [])) |
            .extra_env = (($cfg.extra_env // []) + ($mod.extra_env // [])) |
            .env = (($cfg.env // {}) + ($mod.env // {}))
        ' "$CB_MERGED_CONFIG" "$module_file")
        echo "$merged" > "$CB_MERGED_CONFIG"
    done <<< "$module_names"
}

cb_resolve_env_profile() {
    local active_profile
    active_profile=$(jq -r '.env_profile // empty' "$CB_MERGED_CONFIG" 2>/dev/null || true)

    if [[ -z "$active_profile" ]]; then
        active_profile=$(jq -r '.default_env_profile // empty' "$CB_MERGED_CONFIG" 2>/dev/null || true)
    fi

    [[ -z "$active_profile" ]] && return 0

    jq -r --arg p "$active_profile" \
        '.env_profiles[$p] // {} | to_entries[] | "\(.key)=\(.value)"' \
        "$CB_MERGED_CONFIG" 2>/dev/null || true
}

cb_config_get() {
    local key="$1"
    jq -r ".${key} // empty" "$CB_MERGED_CONFIG"
}

cb_config_get_array() {
    local key="$1"
    jq -r ".${key}[]? // empty" "$CB_MERGED_CONFIG"
}
