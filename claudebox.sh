#!/usr/bin/env bash
# claudebox.sh -- Universal container lifecycle manager for Claude Code
# Manages Docker dev containers with language-specific setup, firewall,
# and credential sharing.
set -euo pipefail

CLAUDEBOX_HOME="${CLAUDEBOX_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "${CLAUDEBOX_HOME}/lib/config.sh"
source "${CLAUDEBOX_HOME}/lib/detect.sh"

IMAGE_NAME="claudebox"
DOCKERFILE_DIR="${CLAUDEBOX_HOME}/.devcontainer"

# --- Utility functions ---

get_container_hash() {
    local dir="$1"
    echo -n "${dir,,}" | sha256sum | cut -c1-4
}

get_container_name() {
    local dir="$1"
    local leaf
    leaf=$(basename "$dir" | sed 's/[^a-zA-Z0-9_-]/-/g')
    local hash4
    hash4=$(get_container_hash "$dir")
    echo "claudebox-${leaf}-${hash4}"
}

find_container_by_hash() {
    local dir="$1"
    local hash4
    hash4=$(get_container_hash "$dir")
    docker ps -a --filter "name=claudebox-" --format '{{.Names}}' 2>/dev/null | grep -E "\-${hash4}$" | head -1 || true
}

check_docker() {
    if ! docker info > /dev/null 2>&1; then
        echo "Error: Docker is not running. Please start Docker and try again." >&2
        exit 1
    fi
}

# --- Claude config copy ---

cb_copy_claude_config() {
    local container_name="$1"
    local claude_config_path
    claude_config_path=$(cb_config_get "claude_config_path" 2>/dev/null || true)

    if [[ -z "$claude_config_path" ]]; then
        return 0
    fi

    if [[ ! -d "$claude_config_path" ]]; then
        echo "Warning: claude_config_path '${claude_config_path}' does not exist, skipping." >&2
        return 0
    fi

    local copied=0
    local failed=0

    for subfolder in agents conventions output-styles skills; do
        local host_path="${claude_config_path}/${subfolder}"
        if [[ ! -d "$host_path" ]]; then
            continue
        fi

        if docker exec "$container_name" mkdir -p "/home/node/.claude/${subfolder}" 2>/dev/null \
            && docker cp "${host_path}/." "${container_name}:/home/node/.claude/${subfolder}" 2>/dev/null \
            && docker exec "$container_name" chown -R node:node "/home/node/.claude/${subfolder}" 2>/dev/null; then
            echo "Copied claude config subfolder: ${subfolder}"
            (( copied++ )) || true
        else
            echo "Warning: Failed to copy claude config subfolder: ${subfolder}" >&2
            (( failed++ )) || true
        fi
    done

    if [[ $copied -gt 0 ]]; then
        echo "Claude config: ${copied} subfolder(s) copied."
    fi

    if [[ $failed -gt 0 ]]; then
        return 1
    fi

    return 0
}

# --- Subcommand: init ---

cmd_init() {
    local rebuild=false
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --rebuild) rebuild=true; shift ;;
            *) echo "Unknown option: $1" >&2; exit 1 ;;
        esac
    done

    local cwd
    cwd=$(pwd)
    local container_name
    container_name=$(get_container_name "$cwd")
    local cwd_leaf
    cwd_leaf=$(basename "$cwd")

    # Load config and detect language
    cb_load_config "$cwd"
    local language
    language=$(cb_detect_language "$cwd")
    echo "Detected language: ${language}"

    local lang_file="${LANGUAGES_DIR}/${language}.json"
    if [[ ! -f "$lang_file" ]]; then
        echo "Error: No language definition found for '${language}'" >&2
        exit 1
    fi

    # Build image if needed
    local image_exists
    image_exists=$(docker images -q "$IMAGE_NAME" 2>/dev/null || true)
    if [[ -z "$image_exists" ]] || $rebuild; then
        echo "Building Docker image '${IMAGE_NAME}'..."
        docker build -t "$IMAGE_NAME" "$DOCKERFILE_DIR"
    fi

    # Check if container already exists
    if docker inspect "$container_name" > /dev/null 2>&1; then
        echo "Container '${container_name}' already exists. Use 'claudebox' (no args) to resume, or 'claudebox destroy' first."
        exit 0
    fi

    # --- Build docker run arguments ---
    local -a mount_args=()
    local -a env_args=()

    # Project directory (read-write)
    mount_args+=(-v "${cwd}:/workspace/${cwd_leaf}")

    # Claude credentials
    local claude_dir="${HOME}/.claude"
    mkdir -p "$claude_dir"

    local settings_file="${claude_dir}/settings.json"
    if [[ -f "$settings_file" ]]; then
        mount_args+=(-v "${settings_file}:/home/node/.claude/settings.json:ro")
    else
        echo "Warning: No settings.json found at ${settings_file}" >&2
    fi

    local credentials_file="${claude_dir}/.credentials.json"
    if [[ -f "$credentials_file" ]]; then
        mount_args+=(-v "${credentials_file}:/home/node/.claude/.credentials.json:ro")
    else
        echo "Warning: No .credentials.json found at ${credentials_file}" >&2
    fi

    # Bash history persistence
    local history_dir="${HOME}/.bash_histories"
    mkdir -p "$history_dir"
    local history_file="${history_dir}/${container_name}"
    touch "$history_file"
    mount_args+=(-v "${history_file}:/home/node/.bash_history")

    # Language-specific named volumes
    local vol_names vol_paths
    vol_names=$(jq -r '.volumes | keys[]' "$lang_file" 2>/dev/null || true)
    while IFS= read -r vol_name; do
        [[ -z "$vol_name" ]] && continue
        local vol_path
        vol_path=$(jq -r ".volumes[\"${vol_name}\"]" "$lang_file")
        mount_args+=(-v "${vol_name}:${vol_path}")
    done <<< "$vol_names"

    # Extra volumes from config
    local extra_vols
    extra_vols=$(jq -r '.extra_volumes // {} | to_entries[] | "\(.key):\(.value)"' "$CB_MERGED_CONFIG" 2>/dev/null || true)
    while IFS= read -r vol_entry; do
        [[ -z "$vol_entry" ]] && continue
        mount_args+=(-v "$vol_entry")
    done <<< "$extra_vols"

    # Environment
    env_args+=(-e "HOME=/home/node")
    if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
        env_args+=(-e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")
    fi

    # Create container
    echo "Creating container '${container_name}'..."
    docker run -d \
        --name "$container_name" \
        --cap-add NET_ADMIN \
        --cap-add NET_RAW \
        --user root \
        -w "/workspace/${cwd_leaf}" \
        "${mount_args[@]}" \
        "${env_args[@]}" \
        "$IMAGE_NAME" sleep infinity

    # --- Write config files into container ---

    # Build domains JSON for firewall
    local domains_json
    domains_json=$(jq -n \
        --argjson lang_domains "$(jq '.domains' "$lang_file")" \
        --argjson lang_suffixes "$(jq '.suffixes' "$lang_file")" \
        --argjson extra_domains "$(jq '.extra_domains // []' "$CB_MERGED_CONFIG")" \
        --argjson extra_suffixes "$(jq '.extra_suffixes // []' "$CB_MERGED_CONFIG")" \
        '{domains: ($lang_domains + $extra_domains), suffixes: ($lang_suffixes + $extra_suffixes)}')

    echo "$domains_json" | docker exec -i "$container_name" tee /tmp/claudebox-domains.json > /dev/null

    # Build provider JSON for install-language.sh
    local provider_json
    provider_json=$(jq -n \
        --argjson lang "$(cat "$lang_file")" \
        --argjson extra_commands "$(jq '.extra_commands // []' "$CB_MERGED_CONFIG")" \
        --argjson extra_apt "$(jq '.extra_apt_packages // []' "$CB_MERGED_CONFIG")" \
        '{
            name: $lang.name,
            apt_deps: ($lang.apt_deps + $extra_apt),
            install_commands: $lang.install_commands,
            env: $lang.env,
            extra_commands: $extra_commands
        }')

    echo "$provider_json" | docker exec -i "$container_name" tee /tmp/claudebox-provider.json > /dev/null

    # Run firewall init (as root)
    echo "Initializing firewall..."
    docker exec "$container_name" /usr/local/bin/init-firewall.sh

    # Run language installer (as root, it drops to node internally)
    echo "Installing language SDK..."
    docker exec "$container_name" /usr/local/bin/install-language.sh

    # Copy claude config subfolders into container
    cb_copy_claude_config "$container_name"

    # Attach shell as node user
    echo "Attaching to container..."
    docker exec -it --user node -w "/workspace/${cwd_leaf}" "$container_name" zsh
}

# --- Subcommand: resume (default) ---

cmd_resume() {
    local cwd
    cwd=$(pwd)
    local cwd_leaf
    cwd_leaf=$(basename "$cwd")
    local container_name
    container_name=$(find_container_by_hash "$cwd")
    if [[ -z "$container_name" ]]; then
        container_name=$(get_container_name "$cwd")
    fi

    local status
    status=$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)
    if [[ -z "$status" ]]; then
        echo "No container found for this directory. Run 'claudebox init' first." >&2
        exit 1
    fi

    if [[ "$status" == "exited" ]]; then
        docker start "$container_name" > /dev/null
    fi

    docker exec -it --user node -w "/workspace/${cwd_leaf}" "$container_name" zsh
}

# --- Subcommand: stop ---

cmd_stop() {
    local cwd
    cwd=$(pwd)
    local container_name
    container_name=$(find_container_by_hash "$cwd")
    if [[ -z "$container_name" ]]; then
        container_name=$(get_container_name "$cwd")
    fi
    docker stop "$container_name"
}

# --- Subcommand: destroy ---

cmd_destroy() {
    local cwd
    cwd=$(pwd)
    local container_name
    container_name=$(find_container_by_hash "$cwd")
    if [[ -z "$container_name" ]]; then
        container_name=$(get_container_name "$cwd")
    fi
    docker rm -f "$container_name"
}

# --- Subcommand: ref ---

cmd_ref() {
    local target="${1:-}"
    local project_hint="${2:-}"
    local refresh=false

    # Parse flags
    local -a positional=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --refresh) refresh=true; shift ;;
            --project) project_hint="$2"; shift 2 ;;
            *) positional+=("$1"); shift ;;
        esac
    done
    target="${positional[0]:-}"

    if [[ -z "$target" ]]; then
        echo "Usage: claudebox ref <directory> [--project <dir>] [--refresh]" >&2
        exit 1
    fi

    local cwd
    cwd=$(pwd)

    # Resolve target path
    if [[ ! "$target" = /* ]]; then
        local cwd_parent
        cwd_parent=$(dirname "$cwd")
        target=$(cd "$cwd_parent" && realpath "$target" 2>/dev/null || echo "${cwd_parent}/${target}")
    fi

    if [[ ! -d "$target" ]]; then
        echo "Error: Target directory not found: ${target}" >&2
        exit 1
    fi

    # Resolve container
    local lookup_dir="$cwd"
    if [[ -n "$project_hint" ]]; then
        if [[ "$project_hint" = /* ]]; then
            lookup_dir="$project_hint"
        else
            lookup_dir="$(dirname "$cwd")/${project_hint}"
        fi
    fi
    local container_name
    container_name=$(find_container_by_hash "$lookup_dir")
    if [[ -z "$container_name" ]]; then
        container_name=$(get_container_name "$lookup_dir")
    fi

    # Check container is running
    local status
    status=$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)
    if [[ "$status" != "running" ]]; then
        echo "Error: Container '${container_name}' is not running." >&2
        exit 1
    fi

    local ref_name
    ref_name=$(basename "$target")

    if ! $refresh; then
        if docker exec "$container_name" test -d "/workspace/refs/${ref_name}" 2>/dev/null; then
            echo "Reference '${ref_name}' already exists. Use --refresh to overwrite."
            exit 0
        fi
    fi

    echo "Copying '${target}' into container as reference '${ref_name}'..."
    docker exec "$container_name" mkdir -p "/workspace/refs/${ref_name}"
    docker cp "${target}/." "${container_name}:/workspace/refs/${ref_name}"
    docker exec "$container_name" chmod -R a-w "/workspace/refs/${ref_name}"
    echo "Reference '${ref_name}' is ready at /workspace/refs/${ref_name}."
}

# --- Subcommand: prune ---

cmd_prune() {
    local target="${1:-}"
    local all=false
    local project_hint=""

    local -a positional=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --all) all=true; shift ;;
            --project) project_hint="$2"; shift 2 ;;
            *) positional+=("$1"); shift ;;
        esac
    done
    target="${positional[0]:-}"

    local cwd
    cwd=$(pwd)
    local lookup_dir="$cwd"
    if [[ -n "$project_hint" ]]; then
        if [[ "$project_hint" = /* ]]; then
            lookup_dir="$project_hint"
        else
            lookup_dir="$(dirname "$cwd")/${project_hint}"
        fi
    fi
    local container_name
    container_name=$(find_container_by_hash "$lookup_dir")
    if [[ -z "$container_name" ]]; then
        container_name=$(get_container_name "$lookup_dir")
    fi

    if $all; then
        docker exec "$container_name" rm -rf /workspace/refs
        echo "All references removed."
    elif [[ -n "$target" ]]; then
        docker exec "$container_name" rm -rf "/workspace/refs/${target}"
        echo "Reference '${target}' removed."
    else
        local listing
        listing=$(docker exec "$container_name" sh -c 'ls /workspace/refs 2>/dev/null' || true)
        if [[ -z "$listing" ]]; then
            echo "No references to prune."
        else
            echo "References in /workspace/refs (use target name or --all to remove):"
            echo "$listing" | sed 's/^/  /'
        fi
    fi
}

# --- Subcommand: refresh ---

cmd_refresh() {
    local cwd
    cwd=$(pwd)
    local container_name
    container_name=$(find_container_by_hash "$cwd")
    if [[ -z "$container_name" ]]; then
        container_name=$(get_container_name "$cwd")
    fi

    local status
    status=$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)
    if [[ -z "$status" ]]; then
        echo "No container found for this directory. Run 'claudebox init' first." >&2
        exit 1
    fi
    if [[ "$status" != "running" ]]; then
        echo "Error: Container '${container_name}' is not running. Start it first." >&2
        exit 1
    fi

    cb_load_config "$cwd"
    if cb_copy_claude_config "$container_name"; then
        echo "Claude config refreshed in container '${container_name}'."
    else
        echo "Claude config refresh completed with errors (see warnings above)." >&2
        exit 1
    fi
}

# --- Subcommand: config ---

cmd_config() {
    if [[ -f "${CLAUDEBOX_HOME}/lib/wizard.sh" ]]; then
        source "${CLAUDEBOX_HOME}/lib/wizard.sh"
        cb_run_wizard
    else
        echo "Wizard not found at ${CLAUDEBOX_HOME}/lib/wizard.sh. Create ~/.claudebox/config.json manually." >&2
        exit 1
    fi
}

# --- Subcommand: help ---

cmd_help() {
    cat <<'HELP'
ClaudeBox - Run Claude Code in a sandboxed Docker container

USAGE:
    claudebox init [--rebuild]         Create a new container for the current directory
    claudebox                          Resume (reconnect to) an existing container
    claudebox stop                     Stop the container
    claudebox destroy                  Remove the container entirely
    claudebox ref <dir> [--project <dir>] [--refresh]
                                       Copy a host directory into the container as a reference
    claudebox prune [<name>] [--project <dir>] [--all]
                                       Remove one or all references from the container
    claudebox refresh                  Re-copy claude config subfolders into the running container
    claudebox config                   Run the configuration wizard
    claudebox help                     Show this help message

SUPPORTED LANGUAGES:
    dotnet, node, python, go, rust, java
    Auto-detected from project files, or set in config.

CONTAINER NAMING:
    Containers are named claudebox-{dirname}-{hash4} based on your
    working directory, so each project gets its own isolated container.

PREREQUISITES:
    * Docker running
    * jq installed on host
    * Claude Code login (~/.claude/.credentials.json)
HELP
}

# --- Main dispatch ---

check_docker

subcommand="${1:-}"
shift || true

case "$subcommand" in
    init)    cmd_init "$@" ;;
    stop)    cmd_stop ;;
    destroy) cmd_destroy ;;
    ref)     cmd_ref "$@" ;;
    prune)   cmd_prune "$@" ;;
    refresh) cmd_refresh ;;
    config)  cmd_config ;;
    help)    cmd_help ;;
    "")      cmd_resume ;;
    *)       echo "Unknown command: ${subcommand}. Run 'claudebox help' for usage." >&2; exit 1 ;;
esac
