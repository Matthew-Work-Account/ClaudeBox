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

# --- Language-specific mount hooks ---
# Each cb_language_mounts_<lang> function receives (cwd, cwd_parent, cwd_leaf)
# and prints "host_path:container_path[:options]" lines — one per mount.
# cmd_init calls cb_language_mounts "$language" to collect them all.

cb_language_mounts_dotnet() {
    local cwd="$1" cwd_parent="$2" cwd_leaf="$3"
    declare -A _seen=()

    _resolve_sibling() {
        local ref_dir="$1" raw_path="$2"
        raw_path="${raw_path//\\//}"
        [[ "$raw_path" != ../* ]] && return
        local abs
        abs=$(cd "$ref_dir" && realpath -m "$raw_path" 2>/dev/null) || return
        local rel="${abs#${cwd_parent}/}"
        local name="${rel%%/*}"
        [[ -z "$name" || "$name" == "$cwd_leaf" ]] && return
        local host="${cwd_parent}/${name}"
        [[ ! -d "$host" ]] && return
        [[ -n "${_seen[$name]+_}" ]] && return
        _seen["$name"]=1
        # :rw required: dotnet restore writes obj/project.assets.json into sibling dirs (ref: DL-002)
        echo "${host}:/workspace/${name}:rw"
    }

    # .sln files: extract second quoted arg on Project(...) lines
    while IFS= read -r sln; do
        local sln_dir; sln_dir=$(dirname "$sln")
        while IFS= read -r p; do
            _resolve_sibling "$sln_dir" "$p"
        # awk -F'"' field 6 = third double-quoted value = project path in Project(...) = "Name", "path", "{GUID}" format (ref: DL-001)
        done < <(awk -F'"' '/^Project/{p=$6; if (p ~ /\.(cs|fs|vb)proj$/) print p}' "$sln" 2>/dev/null || true)
    done < <(find "$cwd" -maxdepth 4 -name "*.sln" 2>/dev/null)

    # .csproj/.fsproj/.vbproj files: extract <ProjectReference Include="..."/> paths (ref: DL-003)
    while IFS= read -r csproj; do
        local csproj_dir; csproj_dir=$(dirname "$csproj")
        while IFS= read -r p; do
            _resolve_sibling "$csproj_dir" "$p"
        done < <(grep -oP '(?<=<ProjectReference Include=")[^"]+\.(cs|fs|vb)proj' "$csproj" 2>/dev/null || true)
    done < <(find "$cwd" -maxdepth 4 \( -name "*.csproj" -o -name "*.fsproj" -o -name "*.vbproj" \) 2>/dev/null)

    unset -f _resolve_sibling
}

cb_language_mounts() {
    local language="$1" cwd="$2"
    local cwd_parent; cwd_parent=$(dirname "$cwd")
    local cwd_leaf; cwd_leaf=$(basename "$cwd")
    local fn="cb_language_mounts_${language}"
    if declare -f "$fn" > /dev/null 2>&1; then
        "$fn" "$cwd" "$cwd_parent" "$cwd_leaf"
    fi
}

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

    # Copy everything in claude_config_path into /home/node/.claude/
    # Overwrites conflicts but does not clear existing files.
    if docker exec "$container_name" mkdir -p "/home/node/.claude" 2>/dev/null \
        && docker cp "${claude_config_path}/." "${container_name}:/home/node/.claude/" 2>/dev/null \
        && docker exec "$container_name" chown -R node:node "/home/node/.claude" 2>/dev/null; then
        echo "Claude config copied from: ${claude_config_path}"
    else
        echo "Warning: Failed to copy claude config from '${claude_config_path}'" >&2
        return 1
    fi

    return 0
}

# --- Subcommand: init ---

cmd_init() {
    local rebuild=false
    local no_start=false
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --rebuild) rebuild=true; shift ;;
            --no-start) no_start=true; shift ;;
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
        if $rebuild; then
            echo "Removing existing container '${container_name}'..."
            docker rm -f "$container_name" > /dev/null
        else
            echo "Container '${container_name}' already exists. Use 'claudebox' (no args) to resume, or 'claudebox init --rebuild' to recreate."
            exit 0
        fi
    fi

    # --- Build docker run arguments ---
    local -a mount_args=()
    local -a env_args=()

    # Project directory (read-write)
    mount_args+=(-v "${cwd}:/workspace/${cwd_leaf}")

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

    # Bind-mount the host NuGet seed cache read-only when present (ref: DL-002, DL-005).
    # Read-only prevents container writes from corrupting the seeded cache.
    # Mount is skipped when the directory is absent; no mount args are added.
    if [[ "$language" == "dotnet" ]]; then
        local nuget_seed_dir="${HOME}/.claudebox/nuget-cache"
        if [[ -d "$nuget_seed_dir" ]]; then
            mount_args+=(-v "${nuget_seed_dir}:/home/node/.nuget-cache-seed:ro")
        fi
    fi


    # Language-specific auto-mounts (e.g. dotnet sibling repo detection)
    while IFS= read -r vol_entry; do
        [[ -z "$vol_entry" ]] && continue
        local host_part="${vol_entry%%:*}"
        local rest="${vol_entry#*:}"
        local container_part="${rest%%:*}"
        echo "Auto-mounting: ${host_part} -> ${container_part}"
        mount_args+=(-v "$vol_entry")
    done < <(cb_language_mounts "$language" "$cwd")
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
        --argjson extra_volumes "$(jq '.extra_volumes // {}' "$CB_MERGED_CONFIG")" \
        '{
            name: $lang.name,
            apt_deps: ($lang.apt_deps + $extra_apt),
            install_commands: $lang.install_commands,
            env: $lang.env,
            extra_commands: $extra_commands,
            volumes: (($lang.volumes // {}) + $extra_volumes)
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

    # Attach shell as node user (unless --no-start was passed)
    if $no_start; then
        echo "Container '${container_name}' is ready. Run 'claudebox' to attach."
    else
        echo "Attaching to container..."
        docker exec -it --user node -w "/workspace/${cwd_leaf}" "$container_name" zsh
    fi
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

# --- Subcommand: extract ---

cmd_extract() {
    local -a source_paths=()
    local output_dir="./extractions"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --file|--folder) source_paths+=("$2"); shift 2 ;;
            --output) output_dir="$2"; shift 2 ;;
            *) echo "Unknown option: $1" >&2; exit 1 ;;
        esac
    done

    if [[ ${#source_paths[@]} -eq 0 ]]; then
        echo "Usage: claudebox extract --file <path> [--output <dest>]" >&2
        echo "       claudebox extract --folder <path> [--output <dest>]" >&2
        exit 1
    fi

    local cwd
    cwd=$(pwd)
    local container_name
    container_name=$(find_container_by_hash "$cwd")
    if [[ -z "$container_name" ]]; then
        container_name=$(get_container_name "$cwd")
    fi

    local status
    status=$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)
    if [[ "$status" != "running" ]]; then
        echo "Error: Container '${container_name}' is not running." >&2
        exit 1
    fi

    mkdir -p "$output_dir"

    local path
    for path in "${source_paths[@]}"; do
        if ! docker exec "$container_name" test -e "$path" 2>/dev/null; then
            echo "Error: Path not found in container: ${path}" >&2
            exit 1
        fi
        echo "Extracting ${path} from container '${container_name}' to ${output_dir}..."
        if ! docker cp "${container_name}:${path}" "${output_dir}/"; then
            echo "Error: Failed to extract ${path}" >&2
            exit 1
        fi
    done
    echo "Done."
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

# --- Subcommand: upgrade ---

cmd_upgrade() {
    local repo_url=""
    local branch=""

    # Parse flags
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --repo|--repository)
                repo_url="${2:-}"
                shift 2
                ;;
            --branch)
                branch="${2:-}"
                shift 2
                ;;
            *)
                echo "Error: Unknown argument '$1'" >&2
                echo "  claudebox upgrade [--repo <url>] [--branch <branch>]" >&2
                exit 1
                ;;
        esac
    done

    # Try saved repo URL if none provided
    if [[ -z "$repo_url" && -f "${CLAUDEBOX_HOME}/.repo-url" ]]; then
        repo_url=$(cat "${CLAUDEBOX_HOME}/.repo-url")
    fi

    if [[ -z "$repo_url" ]]; then
        echo "Error: No repo URL found. Pass it explicitly:" >&2
        echo "  claudebox upgrade [--repo <url>] [--branch <branch>]" >&2
        echo "" >&2
        echo "The URL is saved automatically on future installs." >&2
        exit 1
    fi

    # Default branch to main if not specified
    local target_branch="${branch:-main}"

    echo "Upgrading ClaudeBox from ${repo_url} (branch: ${target_branch})..."

    local tmpdir
    tmpdir=$(mktemp -d)
    trap 'rm -rf "'"$tmpdir"'"' EXIT

    local base_url="${repo_url%.git}"
    local tarball_url="${base_url}/archive/refs/heads/${target_branch}.tar.gz"
    local tarball_file="${tmpdir}/claudebox.tar.gz"

    if ! curl -fsSL -o "$tarball_file" "$tarball_url"; then
        if [[ -n "$branch" ]]; then
            echo "" >&2
            echo "Branch '${branch}' was not found at ${tarball_url}" >&2
            echo "" >&2
            printf "Fall back to 'main'? [y/N] " >&2
            local answer
            read -r answer
            case "$answer" in
                [yY]|[yY][eE][sS])
                    tarball_url="${base_url}/archive/refs/heads/main.tar.gz"
                    echo "Falling back to 'main'..." >&2
                    if ! curl -fsSL -o "$tarball_file" "$tarball_url"; then
                        echo "Error: Failed to download tarball from ${tarball_url}" >&2
                        exit 1
                    fi
                    ;;
                *)
                    echo "Upgrade cancelled." >&2
                    exit 1
                    ;;
            esac
        else
            echo "Error: Failed to download tarball from ${tarball_url}" >&2
            echo "You can also pass a repo URL directly: claudebox upgrade <repo-url> [<branch>]" >&2
            exit 1
        fi
    fi

    if ! tar -xzf "$tarball_file" --strip-components=1 -C "$tmpdir"; then
        echo "Error: Failed to extract archive." >&2
        exit 1
    fi

    echo "Running installer..."
    bash "${tmpdir}/install.sh"

    echo ""
    echo "ClaudeBox upgraded successfully."
    echo "Restart your shell or run: source ~/.bashrc (or ~/.zshrc)"
}

# --- Subcommand: uninstall ---

cmd_uninstall() {
    local uninstall_script="${CLAUDEBOX_HOME}/uninstall.sh"
    if [[ ! -f "$uninstall_script" ]]; then
        echo "Error: uninstall.sh not found at $uninstall_script" >&2
        exit 1
    fi
    exec bash "$uninstall_script"
}

# --- Subcommand: dotnet ---

# Dispatch table for language-scoped dotnet subcommands (ref: DL-001).
# Keeps dotnet-specific operations out of the top-level namespace.
cmd_dotnet() {
    local subcmd="${1:-}"
    shift || true

    case "$subcmd" in
        seed-nuget-cache) cmd_dotnet_seed_nuget_cache "$@" ;;
        *)
            echo "Unknown dotnet subcommand: ${subcmd}" >&2
            echo "Usage: claudebox dotnet seed-nuget-cache [--source <path>]" >&2
            exit 1
            ;;
    esac
}

# Copies NuGet packages from a host directory to ~/.claudebox/nuget-cache/.
# That directory is bind-mounted read-only into dotnet containers at init time,
# enabling offline restore without contacting a private feed (ref: DL-004).
#
# Destination is cleared before copying so the cache exactly mirrors the source;
# stale packages from prior seeds do not accumulate (ref: DL-006).
#
# Args:
#   --source <path>  Host NuGet package directory (default: ~/.nuget/packages)
cmd_dotnet_seed_nuget_cache() {
    local source_path="${HOME}/.nuget/packages"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --source)
                if [[ $# -lt 2 || -z "${2:-}" ]]; then
                    echo "Error: --source requires a path argument" >&2
                    exit 1
                fi
                source_path="$2"
                shift 2
                ;;
            *) echo "Unknown option: $1" >&2; exit 1 ;;
        esac
    done

    if [[ ! -d "$source_path" ]]; then
        echo "Error: Source path does not exist: ${source_path}" >&2
        exit 1
    fi

    if ! find "$source_path" -name '*.nupkg' -print -quit 2>/dev/null | grep -q .; then
        echo "Error: No .nupkg files found in ${source_path}. Is this a NuGet packages cache?" >&2
        exit 1
    fi

    local cache_dir="${HOME}/.claudebox/nuget-cache"
    mkdir -p "$cache_dir"
    rm -rf "${cache_dir:?}/"*
    find "$source_path" -mindepth 1 -maxdepth 1 -exec cp -r {} "$cache_dir/" \;

    local pkg_count
    pkg_count=$(find "$cache_dir" -name '*.nupkg' | wc -l)
    echo "NuGet cache seeded: ${pkg_count} package(s) copied to ${cache_dir}"
}

# --- Subcommand: help ---

cmd_help() {
    cat <<'HELP'
ClaudeBox - Run Claude Code in a sandboxed Docker container

USAGE:
    claudebox init [--rebuild] [--no-start]
                                       Create a new container for the current directory
                                       --no-start: provision only, don't attach a shell
    claudebox                          Resume (reconnect to) an existing container
    claudebox stop                     Stop the container
    claudebox destroy                  Remove the container entirely
    claudebox ref <dir> [--project <dir>] [--refresh]
                                       Copy a host directory into the container as a reference
    claudebox prune [<name>] [--project <dir>] [--all]
                                       Remove one or all references from the container
    claudebox refresh                  Re-copy claude config subfolders into the running container
    claudebox extract --file <path> [--folder <path>] [--output <dest>]
                                       Copy files or folders from inside the container to the host
    claudebox config                   Run the configuration wizard
    claudebox upgrade [--repo <url>] [--branch <branch>]
                                       Upgrade ClaudeBox from git (default branch: main)
    claudebox uninstall                Uninstall ClaudeBox
    claudebox dotnet seed-nuget-cache [--source <path>]
                                       Copy NuGet packages from host into ~/.claudebox/nuget-cache/
                                       for offline use inside dotnet containers (default source: ~/.nuget/packages)
    claudebox help                     Show this help message

SUPPORTED LANGUAGES:
    dotnet, node, python, go, rust, java, none
    Auto-detected from project files, or set in config.
    Use "none" for projects that don't need language-specific setup.

CONTAINER NAMING:
    Containers are named claudebox-{dirname}-{hash4} based on your
    working directory, so each project gets its own isolated container.

PREREQUISITES:
    * Docker running
    * jq installed on host
    * claude_config_path set in config (optional, for Claude Code settings)
HELP
}

# --- Main dispatch ---

subcommand="${1:-}"
shift || true

case "$subcommand" in
    help)    cmd_help ;;
    config)  cmd_config ;;
    upgrade) cmd_upgrade "$@" ;;
    dotnet)  cmd_dotnet "$@" ;;
    uninstall) cmd_uninstall ;;
    *)
        check_docker
        case "$subcommand" in
            init)    cmd_init "$@" ;;
            stop)    cmd_stop ;;
            destroy) cmd_destroy ;;
            ref)     cmd_ref "$@" ;;
            prune)   cmd_prune "$@" ;;
            refresh) cmd_refresh ;;
            extract) cmd_extract "$@" ;;
            "")      cmd_resume ;;
            *)       echo "Unknown command: ${subcommand}. Run 'claudebox help' for usage." >&2; exit 1 ;;
        esac
        ;;
esac
