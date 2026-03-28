#!/usr/bin/env bash
# detect.sh -- Project type detection from file markers
# Iterates languages/*.json, reads markers array, tests if any marker
# matches a file anywhere in the project directory (recursive).
set -euo pipefail

LANGUAGES_DIR="${CLAUDEBOX_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/languages"

cb_detect_language() {
    local project_dir="${1:-.}"

    # If config specifies a language override (not "auto"), use it.
    # language may be a plain string OR a JSON array; arrays are handled in
    # cmd_init directly — here we only need to return the primary/first entry
    # so the caller can fall back to auto-detect when the value is "auto".
    local configured
    configured=$(cb_config_get "language" 2>/dev/null || echo "auto")

    # If it's a JSON array, extract the first element for single-language callers
    if echo "$configured" | jq -e 'type == "array"' >/dev/null 2>&1; then
        configured=$(echo "$configured" | jq -r '.[0] // "auto"')
    fi

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

    # No match found -- fall back to "none" (language-agnostic container)
    if [[ -t 0 ]]; then
        # Interactive terminal: prompt user to select or accept none
        echo "Could not auto-detect project language." >&2
        echo "Available languages:" >&2
        local langs=()
        for lang_file in "${LANGUAGES_DIR}"/*.json; do
            [[ -f "$lang_file" ]] || continue
            local name
            name=$(jq -r '.name' "$lang_file")
            [[ "$name" == "none" ]] && continue
            langs+=("$name")
            echo "  ${#langs[@]}) $name" >&2
        done
        local none_idx=$(( ${#langs[@]} + 1 ))
        echo "  ${none_idx}) none (no language-specific setup)" >&2
        echo -n "Select language (1-${none_idx}) [${none_idx}]: " >&2
        local choice
        read -r choice
        choice="${choice:-${none_idx}}"
        if [[ "$choice" == "$none_idx" ]]; then
            echo "none"
            return 0
        elif [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#langs[@]} )); then
            echo "${langs[$((choice-1))]}"
            return 0
        else
            echo "Invalid selection." >&2
            return 1
        fi
    else
        echo "none"
        return 0
    fi
}
