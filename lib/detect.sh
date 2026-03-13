#!/usr/bin/env bash
# detect.sh -- Project type detection from file markers
# Iterates languages/*.json, reads markers array, tests if any marker
# matches a file anywhere in the project directory (recursive).
set -euo pipefail

LANGUAGES_DIR="${CLAUDEBOX_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/languages"

cb_detect_language() {
    local project_dir="${1:-.}"

    # If config specifies a language override (not "auto"), use it
    local configured
    configured=$(cb_config_get "language" 2>/dev/null || echo "auto")
    if [[ "$configured" != "auto" && -n "$configured" ]]; then
        # Validate that the language definition exists
        if [[ -f "${LANGUAGES_DIR}/${configured}.json" ]]; then
            echo "$configured"
            return 0
        else
            echo "Error: configured language '${configured}' has no definition in ${LANGUAGES_DIR}/" >&2
            return 1
        fi
    fi

    # Auto-detect by scanning markers
    for lang_file in "${LANGUAGES_DIR}"/*.json; do
        [[ -f "$lang_file" ]] || continue
        local lang_name
        lang_name=$(jq -r '.name' "$lang_file")

        local markers
        markers=$(jq -r '.markers[]' "$lang_file")

        while IFS= read -r marker; do
            [[ -z "$marker" ]] && continue
            # Search recursively for marker files
            if find "$project_dir" -maxdepth 3 -name "$marker" -print -quit 2>/dev/null | grep -q .; then
                echo "$lang_name"
                return 0
            fi
        done <<< "$markers"
    done

    # No match found
    if [[ -t 0 ]]; then
        # Interactive terminal: prompt user to select
        echo "Could not auto-detect project language." >&2
        echo "Available languages:" >&2
        local langs=()
        for lang_file in "${LANGUAGES_DIR}"/*.json; do
            [[ -f "$lang_file" ]] || continue
            local name
            name=$(jq -r '.name' "$lang_file")
            langs+=("$name")
            echo "  ${#langs[@]}) $name" >&2
        done
        echo -n "Select language (1-${#langs[@]}): " >&2
        local choice
        read -r choice
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#langs[@]} )); then
            echo "${langs[$((choice-1))]}"
            return 0
        else
            echo "Invalid selection." >&2
            return 1
        fi
    else
        echo "Error: could not auto-detect project language and not running interactively." >&2
        return 1
    fi
}
