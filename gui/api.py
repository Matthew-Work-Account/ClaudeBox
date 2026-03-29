"""
API layer for the ClaudeBox GUI server.

Reads/writes the container registry at ~/.claudebox/registry.json (DL-002).
On list_containers, cross-checks registry against `docker ps` output to detect
stale entries from manual `docker rm` (RISK-002). Config merge is obtained by
sourcing lib/config.sh via subprocess — ensures the GUI reflects the
authoritative bash merge semantics without reimplementing them (DL-005,
RISK-004). Atomic JSON writes use tempfile+os.replace to avoid partial writes.
"""
import json
import os
import queue
import re
import shlex
import subprocess
import tempfile
import threading
from datetime import datetime, timezone

_MODULE_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

try:
    import pty as _pty_mod
    HAS_PTY = True
except ImportError:
    _pty_mod = None
    HAS_PTY = False

_REGISTRY_PATH = os.path.expanduser("~/.claudebox/registry.json")
_GLOBAL_CONFIG_PATH = os.path.expanduser("~/.claudebox/config.json")
_KNOWN_CONFIG_KEYS = {
    "language",
    "extra_domains",
    "extra_suffixes",
    "extra_apt_packages",
    "extra_commands",
    "modules",
    "extra_volumes",
    "extra_env",
    "env_profile",
    "env_profiles",
    "default_env_profile",
    "extra_hosts",
    "claude_config_path",
    "default_clone_dir",
}
_VALID_LANGUAGES = {"node", "python", "dotnet", "go", "rust", "java", "none", "auto"}
_CONFIG_TYPES = {
    "language": (str, list),  # str for single, list for multi-language
    "extra_domains": list,
    "extra_suffixes": list,
    "extra_apt_packages": list,
    "extra_commands": list,
    "modules": list,
    "extra_volumes": dict,
    "extra_env": list,
    "env_profile": str,
    "env_profiles": dict,
    "default_env_profile": str,
    "extra_hosts": list,
    "claude_config_path": str,
    "default_clone_dir": str,
}


def _read_json_file(path):
    """Return parsed JSON from path, or {} on missing file or parse error.

    {} is chosen over None so callers can always use .get() without a None-check,
    and over raising so missing/corrupt files are treated as empty state (e.g.,
    absent registry.json is equivalent to an empty registry).
    """
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        return {}


def _write_json_atomic(path, data):
    """Write data as JSON to path atomically via tempfile+os.replace.

    Atomicity prevents a partial registry.json on crash mid-write, which would
    corrupt the container list and require manual recovery.
    """
    dir_path = os.path.dirname(path) or "."
    os.makedirs(dir_path, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=dir_path)
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _docker_running_names():
    """
    Return {name: status_string} for all claudebox-* containers via `docker ps -a`.
    Returns {} on subprocess error or timeout.
    """
    try:
        result = subprocess.run(
            ["docker", "ps", "-a", "--filter", "name=claudebox-", "--format", "{{.Names}}\t{{.Status}}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        rows = {}
        for line in result.stdout.splitlines():
            parts = line.split("\t", 1)
            if len(parts) == 2:
                rows[parts[0]] = parts[1]
        return rows
    except Exception:
        return {}


def _find_project_dir_from_docker(container_name):
    """Inspect container mounts to find the host-side project directory.

    ClaudeBox always bind-mounts the project at /workspace/<name> inside the
    container, so the Source of that mount is the host project path. Returns
    empty string if the container is not found or has no /workspace/ mount.

    Uses {{json .Mounts}} output rather than a text format string because
    Docker's Go template engine treats \\n as a literal two-character sequence,
    not a newline, making line-oriented parsing unreliable.
    """
    try:
        result = subprocess.run(
            ["docker", "inspect", container_name, "--format", "{{json .Mounts}}"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return ""
        mounts = json.loads(result.stdout.strip())
        for m in mounts:
            if m.get("Type") == "bind" and m.get("Destination", "").startswith("/workspace/"):
                return m.get("Source", "")
    except Exception:
        pass
    return ""


def list_containers():
    """
    Return a list of container dicts combining registry and live Docker state.

    Registry entries absent from Docker output are marked stale=True with
    status="removed". Docker containers absent from the registry are included
    with empty project_path/language/created_at. (ref: DL-002, RISK-002)

    For any container with no project_path in the registry, we attempt to
    auto-detect it from Docker inspect bind mounts. If found, the registry is
    updated so the path persists on future loads.
    """
    registry = _read_json_file(_REGISTRY_PATH)
    entries = registry.get("containers", {})
    docker_state = _docker_running_names()
    docker_names = set(docker_state.keys())

    results = []
    seen = set()
    registry_updated = False

    for name, meta in entries.items():
        seen.add(name)
        status_raw = docker_state.get(name, "")
        stale = name not in docker_names
        project_path = meta.get("project_dir", "")

        if not project_path and not stale:
            detected = _find_project_dir_from_docker(name)
            if detected:
                project_path = detected
                entries[name] = dict(meta, project_dir=detected)
                registry_updated = True

        results.append({
            "name": name,
            "nickname": meta.get("nickname", ""),
            "status": status_raw if not stale else "removed",
            "project_path": project_path,
            "language": meta.get("language", ""),
            "created_at": meta.get("created_at", ""),
            "stale": stale,
            "pinned": bool(meta.get("pinned", False)),
        })

    for name, status_raw in docker_state.items():
        if name not in seen:
            project_path = _find_project_dir_from_docker(name)
            if project_path:
                entries[name] = {"project_dir": project_path, "language": "", "created_at": ""}
                registry_updated = True
            results.append({
                "name": name,
                "nickname": "",
                "status": status_raw,
                "project_path": project_path,
                "language": "",
                "created_at": "",
                "stale": False,
                "pinned": False,
            })

    if registry_updated:
        registry["containers"] = entries
        try:
            _write_json_atomic(_REGISTRY_PATH, registry)
        except OSError:
            pass  # non-fatal: path will be re-detected on next load

    return results


def patch_container_pin(container_name, pinned):
    """Set the pinned field for a registry entry to pinned (bool).

    Reads the registry, updates only the pinned field for the named container,
    and writes back atomically using _write_json_atomic. Returns {"ok": True,
    "pinned": pinned} on success or {"error": ...} if the entry is not found.
    (refs: DL-005)
    """
    registry = _read_json_file(_REGISTRY_PATH)
    entries = registry.get("containers", {})
    if container_name not in entries:
        return {"error": "not found"}
    entries[container_name] = dict(entries[container_name], pinned=bool(pinned))
    registry["containers"] = entries
    try:
        _write_json_atomic(_REGISTRY_PATH, registry)
    except OSError as exc:
        return {"error": str(exc)}
    return {"ok": True, "pinned": bool(pinned)}


def get_merged_config(project_dir):
    """
    Return merged config JSON for project_dir by sourcing lib/config.sh in a
    subprocess and reading the emitted CB_MERGED_CONFIG file. Returns
    {"error": ...} on subprocess failure or non-JSON output. (ref: DL-005)
    """
    claudebox_sh = _find_claudebox_sh()
    if not claudebox_sh:
        return {"error": "claudebox.sh not found"}

    lib_config = os.path.join(os.path.dirname(claudebox_sh), "lib", "config.sh")
    if not os.path.isfile(lib_config):
        return {"error": "lib/config.sh not found"}

    script = (
        f"set -euo pipefail; "
        f"source {shlex.quote(lib_config)}; "
        f"cb_load_config {shlex.quote(project_dir)}; "
        f'cat "$CB_MERGED_CONFIG"'
    )
    try:
        result = subprocess.run(
            ["bash", "-c", script],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return {"error": result.stderr.strip() or "config load failed"}
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        return {"error": "config load timed out"}
    except json.JSONDecodeError:
        return {"error": "config output was not valid JSON"}


def get_global_config():
    """Return the global config dict from ~/.claudebox/config.json.

    Returns {} (via _read_json_file) when absent so callers get a consistent
    dict type regardless of whether the user has created a global config.
    """
    return _read_json_file(_GLOBAL_CONFIG_PATH)


def get_local_config(project_dir):
    """Return the local config dict from project_dir/.claudebox.json.

    Returns {} when absent; .claudebox.json is gitignored and may not exist in
    every project (see commit 81afe2b), so absence is the normal case.
    """
    path = os.path.join(project_dir, ".claudebox.json")
    return _read_json_file(path)


def _validate_config(data):
    """Return an error string if data contains unknown keys or wrong types, else None."""
    if not isinstance(data, dict):
        return "config must be a JSON object"
    unknown = set(data.keys()) - _KNOWN_CONFIG_KEYS
    if unknown:
        return f"unknown keys: {', '.join(sorted(unknown))}"
    for key, expected_type in _CONFIG_TYPES.items():
        if key not in data:
            continue
        val = data[key]
        if not isinstance(val, expected_type):
            type_name = " or ".join(t.__name__ for t in expected_type) if isinstance(expected_type, tuple) else expected_type.__name__
            return f"{key} must be of type {type_name}"
    # Validate language values
    if "language" in data:
        langs = data["language"] if isinstance(data["language"], list) else [data["language"]]
        for lang in langs:
            if not isinstance(lang, str):
                return "language entries must be strings"
            if lang and lang not in _VALID_LANGUAGES:
                return f"unknown language: {lang!r} (valid: {', '.join(sorted(_VALID_LANGUAGES))})"
    return None


def save_global_config(data):
    """Validate, backup, and atomically write data to the global config file."""
    err = _validate_config(data)
    if err:
        return {"error": err}
    _backup_file(_GLOBAL_CONFIG_PATH)
    _write_json_atomic(_GLOBAL_CONFIG_PATH, data)
    return {"ok": True}


def save_local_config(project_dir, data):
    """Validate, backup, and atomically write data to project_dir/.claudebox.json."""
    err = _validate_config(data)
    if err:
        return {"error": err}
    path = os.path.join(project_dir, ".claudebox.json")
    _backup_file(path)
    _write_json_atomic(path, data)
    return {"ok": True}


def _backup_file(path):
    """Copy path to path+.bak before overwrite. Silently skips on OSError.

    .bak extension is chosen for discoverability (users know to look for it).
    OSError is swallowed because backup failure should not block the save.
    """
    if os.path.isfile(path):
        bak = path + ".bak"
        try:
            import shutil
            shutil.copy2(path, bak)
        except OSError:
            pass


def link_container(name, project_dir):
    """Save project_dir for an existing container entry in the registry.

    Used when auto-detection fails and the user manually enters the path.
    Creates a minimal registry entry if none exists for this container.
    """
    if not project_dir:
        return {"error": "project_dir required"}
    registry = _read_json_file(_REGISTRY_PATH)
    containers = registry.get("containers", {})
    existing = containers.get(name, {})
    containers[name] = dict(existing, project_dir=project_dir)
    registry["containers"] = containers
    _write_json_atomic(_REGISTRY_PATH, registry)
    return {"ok": True}


def register_container(name, project_dir, language=""):
    """Add or update container entry in registry.json with current UTC timestamp.

    UTC is used (not local time) so the timestamp survives timezone changes
    and displays consistently across host locales in the GUI.
    """
    registry = _read_json_file(_REGISTRY_PATH)
    containers = registry.get("containers", {})
    containers[name] = {
        "project_dir": project_dir,
        "language": language,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    registry["containers"] = containers
    _write_json_atomic(_REGISTRY_PATH, registry)


def deregister_container(name):
    """Remove container entry from registry.json. No-op if name absent.

    dict.pop(name, None) is used rather than checking containment first to
    avoid a race between the check and the remove on concurrent destroy calls.
    """
    registry = _read_json_file(_REGISTRY_PATH)
    containers = registry.get("containers", {})
    containers.pop(name, None)
    registry["containers"] = containers
    _write_json_atomic(_REGISTRY_PATH, registry)


def run_command(args):
    """Run claudebox.sh with args, capturing stdout/stderr. Returns dict with stdout/stderr/returncode.

    args is passed as a list (not shell=True) to prevent shell injection from
    user-supplied command arguments in the GUI.
    """
    claudebox_sh = _find_claudebox_sh()
    if not claudebox_sh:
        return {"error": "claudebox.sh not found"}
    try:
        result = subprocess.run(
            [claudebox_sh] + list(args),
            capture_output=True,
            text=True,
            timeout=120,
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"error": "command timed out"}


def start_command_stream(args, project_dir=None):
    """
    Spawn claudebox.sh with args as a subprocess with stdout piped for SSE streaming.
    Uses os.setsid so the process group can be killed on disconnect. (ref: RISK-003)

    project_dir is used as cwd only when it actually exists on the host filesystem.
    Docker Desktop on WSL stores bind-mount paths under /run/desktop/mnt/host/wsl/...
    which are not accessible from the host Python process; falling back to None avoids
    a FileNotFoundError crash in that case. Commands like destroy now accept the
    container name directly so they do not need a cwd.
    """
    claudebox_sh = _find_claudebox_sh()
    if not claudebox_sh:
        return None
    if project_dir and not os.path.isdir(project_dir):
        project_dir = None
    return subprocess.Popen(
        [claudebox_sh] + list(args),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=project_dir,
        preexec_fn=os.setsid if os.name != "nt" else None,
    )


def make_directory(path):
    """Create a directory (and parents) at path on the host filesystem."""
    try:
        os.makedirs(path, exist_ok=True)
        return {}
    except Exception as exc:
        return {"error": str(exc)}


def start_git_clone_stream(url, dest_dir, username=None, token=None):
    """Run git clone <url> <dest_dir> as a streaming subprocess.

    If username/token are provided they are injected into the URL so git
    does not need an interactive prompt (works for HTTPS repos including
    Azure DevOps PATs and GitHub tokens).
    """
    import shutil as _shutil_git
    from urllib.parse import urlparse, urlunparse, quote as _urlquote
    git = _shutil_git.which("git")
    if not git:
        return None
    if username or token:
        parsed = urlparse(url)
        # Strip any pre-existing userinfo to avoid doubling
        host = parsed.netloc.split("@", 1)[-1]
        user_part = _urlquote(username or "", safe="")
        pass_part = _urlquote(token or "", safe="")
        userinfo = (user_part + ":" + pass_part) if (user_part and pass_part) else (user_part or pass_part)
        url = urlunparse(parsed._replace(netloc=userinfo + "@" + host))
    parent = os.path.dirname(os.path.abspath(dest_dir))
    cwd = parent if os.path.isdir(parent) else None
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    return subprocess.Popen(
        [git, "clone", "--progress", url, dest_dir],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=cwd,
        env=env,
        preexec_fn=os.setsid if os.name != "nt" else None,
    )


def _find_claudebox_sh():
    """
    Locate claudebox.sh by checking CLAUDEBOX_HOME env var first, then
    ~/.local/share/claudebox/. Returns None if not found.
    """
    explicit = os.environ.get("CLAUDEBOX_HOME")
    if explicit:
        candidate = os.path.join(explicit, "claudebox.sh")
        if os.path.isfile(candidate):
            return candidate
    for candidate in [
        os.path.expanduser("~/.local/share/claudebox/claudebox.sh"),
    ]:
        if os.path.isfile(candidate):
            return candidate
    return None


# Resolves CLAUDEBOX_HOME by env var first, then the conventional install path.
# Separate from _find_claudebox_sh() because modules/ lives under the home
# directory while claudebox.sh lives at its root. (ref: plan:DL-002)
def _find_claudebox_home():
    """Return the CLAUDEBOX_HOME directory path, or None if not found."""
    explicit = os.environ.get("CLAUDEBOX_HOME")
    if explicit and os.path.isdir(explicit):
        return explicit
    candidate = os.path.expanduser("~/.local/share/claudebox")
    if os.path.isdir(candidate):
        return candidate
    return None


def _is_wsl():
    import platform
    try:
        return "microsoft" in platform.uname().release.lower()
    except Exception:
        return False


def _wsl_windows_drives():
    drives = []
    mnt = "/mnt"
    if os.path.isdir(mnt):
        for entry in sorted(os.listdir(mnt)):
            if len(entry) == 1 and entry.isalpha():
                full = os.path.join(mnt, entry)
                if os.path.isdir(full):
                    drives.append({
                        "name": entry.upper() + ":\\",
                        "path": full,
                        "display": entry.upper() + ":\\",
                    })
    return drives


def _make_display_path(path):
    """Convert /mnt/c/Users/foo to C:\\Users\\foo for WSL paths."""
    import re
    m = re.match(r'^/mnt/([a-z])(/.*)$', path)
    if m:
        drive = m.group(1).upper()
        rest = m.group(2).replace('/', '\\')
        return drive + ':' + rest
    m2 = re.match(r'^/mnt/([a-z])$', path)
    if m2:
        return m2.group(1).upper() + ':\\'
    return path


def browse_directory(path=None):
    """Return subdirectories of path for the folder browser widget.

    path defaults to the user's home directory if omitted or empty.
    Returns dict with current_path, parent_path, dirs list, or error key.
    Only directories are returned (files are excluded — this is a dir picker).
    Sorted alphabetically. Hidden dirs (starting with .) excluded unless path
    itself is hidden.
    """
    if not path:
        home = os.path.expanduser("~")
        if _is_wsl():
            drives = _wsl_windows_drives()
            return {
                "current_path": home,
                "display_path": home,
                "parent_path": home,
                "dirs": [{"name": "~ Home (WSL)", "path": home, "display": "~ Home (WSL)"}] + drives,
                "is_wsl_root": True,
            }
        path = home
    path = os.path.expanduser(path)
    try:
        path = os.path.realpath(path)
    except Exception:
        return {"error": "invalid path", "current_path": path}

    if not os.path.exists(path):
        return {"error": "path does not exist", "current_path": path}
    if not os.path.isdir(path):
        return {"error": "not a directory", "current_path": path}

    parent = os.path.dirname(path) if path != "/" else "/"

    on_wsl = _is_wsl()
    try:
        entries = []
        for name in sorted(os.listdir(path)):
            if name.startswith("."):
                continue
            full = os.path.join(path, name)
            try:
                if os.path.isdir(full):
                    entry = {"name": name, "path": full}
                    if on_wsl:
                        entry["display"] = _make_display_path(full)
                    else:
                        entry["display"] = name
                    entries.append(entry)
            except OSError:
                pass
        return {
            "current_path": path,
            "display_path": _make_display_path(path) if on_wsl else path,
            "parent_path": parent,
            "dirs": entries,
        }
    except PermissionError:
        return {"error": "permission denied", "current_path": path}
    except OSError as exc:
        return {"error": str(exc), "current_path": path}


def browse_container_files(name, path=None):
    """List files/directories inside a container at the given path.

    Uses docker exec + ls to get directory listing. Default path is /workspace.
    Returns {current_path, parent_path, entries: [{name, path, is_dir}]} or {error}.
    """
    if not path:
        path = "/workspace"
    try:
        r = subprocess.run(
            ["docker", "exec", name, "ls", "-1Ap", path],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            if path == "/workspace":
                r2 = subprocess.run(
                    ["docker", "exec", name, "ls", "-1Ap", "/"],
                    capture_output=True, text=True, timeout=10,
                )
                if r2.returncode == 0:
                    path = "/"
                    r = r2
                else:
                    return {"error": r.stderr.strip() or "ls failed"}
            else:
                return {"error": r.stderr.strip() or "ls failed"}

        entries = []
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line or line in ("./", "../"):
                continue
            is_dir = line.endswith("/")
            name_clean = line.rstrip("/")
            entry_path = path.rstrip("/") + "/" + name_clean
            entries.append({
                "name": name_clean,
                "path": entry_path,
                "is_dir": is_dir,
            })

        parent = path.rstrip("/").rsplit("/", 1)[0] or "/"
        if path == "/":
            parent = "/"

        return {
            "current_path": path,
            "parent_path": parent,
            "entries": entries,
        }
    except subprocess.TimeoutExpired:
        return {"error": "docker exec timed out"}
    except Exception as e:
        return {"error": str(e)}


def unregister_container(name):
    """Remove a container entry from the registry without touching Docker.

    Used by the GUI to clean up stale or manually-removed containers.
    Idempotent: returns {"ok": true} even if the entry was not present.
    """
    registry = _read_json_file(_REGISTRY_PATH)
    entries = registry.get("containers", {})
    if name in entries:
        del entries[name]
        registry["containers"] = entries
        try:
            _write_json_atomic(_REGISTRY_PATH, registry)
        except OSError as exc:
            return {"error": str(exc)}
    return {"ok": True}


def set_container_nickname(name, nickname):
    """Store a display nickname for a container in the registry.
    Nickname is purely cosmetic — the container name is unchanged.
    Returns {"ok": True} or {"error": ...}.
    """
    registry = _read_json_file(_REGISTRY_PATH)
    entries = registry.get("containers", {})
    if name not in entries:
        return {"error": "container not found in registry"}
    entries[name]["nickname"] = nickname.strip()
    registry["containers"] = entries
    try:
        _write_json_atomic(_REGISTRY_PATH, registry)
    except OSError as exc:
        return {"error": str(exc)}
    return {"ok": True}


def list_modules(project_dir=None):
    """Scan builtin, user, and project scopes for module JSON files.  (ref: plan:DL-002)

    Returns a list of dicts with keys: name, description, scope, path.
    Scope values: "builtin", "user", "project".

    Scope resolution order: builtin ($CLAUDEBOX_HOME/modules/) ->
    user (~/.claudebox/modules/) -> project (<project_dir>/.claudebox/modules/).
    Missing scope directories are silently skipped.
    """
    scopes = []
    home = _find_claudebox_home()
    if home:
        scopes.append(("builtin", os.path.join(home, "modules")))
    scopes.append(("user", os.path.expanduser("~/.claudebox/modules")))
    if project_dir:
        scopes.append(("project", os.path.join(project_dir, ".claudebox", "modules")))

    applied_names = set()
    if project_dir:
        local = get_local_config(project_dir)
        applied_names = set(local.get("modules", []))

    results = []
    for scope, directory in scopes:
        if not os.path.isdir(directory):
            continue
        for filename in sorted(os.listdir(directory)):
            if not filename.endswith(".json"):
                continue
            full_path = os.path.join(directory, filename)
            data = _read_json_file(full_path)
            name = filename[:-5]
            results.append({
                "name": name,
                "description": data.get("description", ""),
                "scope": scope,
                "path": full_path,
                "applied": name in applied_names,
                "data": data,
            })
    return results


def save_module(name, data, scope, project_dir=None):
    """Write module JSON to the appropriate scope directory.  (ref: plan:DL-002)

    scope must be one of: "builtin", "user", "project".
    project_dir is required when scope is "project".
    Creates the target directory if absent. Backs up an existing file before
    overwriting via _backup_file + _write_json_atomic to prevent partial writes.
    Returns {"ok": True} or {"error": ...}.
    """
    if not _MODULE_NAME_RE.match(name):
        return {"error": "invalid module name; only letters, digits, _ and - are allowed"}
    if scope == "builtin":
        home = _find_claudebox_home()
        if not home:
            return {"error": "CLAUDEBOX_HOME not found"}
        directory = os.path.join(home, "modules")
    elif scope == "user":
        directory = os.path.expanduser("~/.claudebox/modules")
    elif scope == "project":
        if not project_dir:
            return {"error": "project_dir required for project scope"}
        directory = os.path.join(project_dir, ".claudebox", "modules")
    else:
        return {"error": f"unknown scope: {scope}"}

    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, name + ".json")
    _backup_file(path)
    _write_json_atomic(path, data)
    return {"ok": True}


def delete_module(name, scope, project_dir=None):
    """Delete a non-builtin module JSON file.  (ref: plan:DL-002, plan:DL-006)

    Builtin modules cannot be deleted. Returns {"ok": True} or {"error": ...}.
    Validates name against the same pattern as save_module to prevent path
    traversal. Returns {"error": "builtin modules cannot be deleted"} without
    touching the filesystem when scope is "builtin".
    """
    if not _MODULE_NAME_RE.match(name):
        return {"error": "invalid module name; only letters, digits, _ and - are allowed"}
    if scope == "builtin":
        return {"error": "builtin modules cannot be deleted"}
    elif scope == "user":
        directory = os.path.expanduser("~/.claudebox/modules")
    elif scope == "project":
        if not project_dir:
            return {"error": "project_dir required for project scope"}
        directory = os.path.join(project_dir, ".claudebox", "modules")
    else:
        return {"error": f"unknown scope: {scope}"}

    path = os.path.join(directory, name + ".json")
    if not os.path.isfile(path):
        return {"error": f"module not found: {name}"}
    try:
        os.remove(path)
    except OSError as exc:
        return {"error": str(exc)}
    return {"ok": True}


def verify_config(project_dir):
    """Validate merged config for project_dir and return a list of issues.  (ref: plan:DL-004)

    Calls get_merged_config() for the authoritative merge, then applies
    validation checks: language value, module names, domain format.

    Language validation reads available names from the languages/ directory
    on disk so new languages are recognized without code changes.
    Module validation calls list_modules(project_dir) so all three scopes are
    checked. Domain pattern allows leading wildcard (*).
    Returns {"issues": [...], "config": {...}} or {"error": ...}.
    """
    merged = get_merged_config(project_dir)
    if "error" in merged:
        return merged

    issues = []

    language = merged.get("language", "")
    languages_dir = os.path.join(os.path.dirname(__file__), "..", "languages")
    try:
        valid_languages = {
            os.path.splitext(f)[0]
            for f in os.listdir(languages_dir)
            if f.endswith(".json")
        } | {""}
    except OSError:
        valid_languages = {"node", "python", "dotnet", "go", "rust", "java", "none", ""}
    if language and language not in valid_languages:
        issues.append(f"language \u2018{language}\u2019 is not a recognized value")

    module_names = merged.get("modules", [])
    if isinstance(module_names, list):
        available = {m["name"] for m in list_modules(project_dir)}
        for mod in module_names:
            if isinstance(mod, str) and mod not in available:
                issues.append(f"module \u2018{mod}\u2019 not found in any scope")

    domain_pattern = re.compile(r"^[a-zA-Z0-9*][a-zA-Z0-9.*-]*$")
    for key in ("extra_domains", "extra_suffixes"):
        for domain in merged.get(key, []):
            if isinstance(domain, str) and not domain_pattern.match(domain):
                issues.append(f"{key} entry \u2018{domain}\u2019 has invalid format")

    return {"issues": issues, "config": merged}


def start_container(name):
    """Start a stopped container via docker start.

    Returns {"ok": True} or {"error": ...}.
    """
    try:
        r = subprocess.run(
            ["docker", "start", name],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            return {"error": r.stderr.strip() or "docker start failed"}
        return {"ok": True}
    except subprocess.TimeoutExpired:
        return {"error": "docker start timed out"}
    except Exception as e:
        return {"error": str(e)}


def get_terminal_options():
    """Return available terminal emulator options for the current platform.

    Returns {"options": [{"id": ..., "label": ...}, ...]} where "auto" is always
    first. Only terminals whose executables are found on PATH are included
    (except Windows built-ins which are always present).
    """
    import platform
    import shutil as _shutil
    import os as _os

    system = platform.system().lower()
    release = platform.uname().release.lower()
    is_wsl = system == "linux" and "microsoft" in release

    options = [{"id": "auto", "label": "Auto-detect"}]

    if system == "windows" or is_wsl:
        if _shutil.which("wt.exe") or _shutil.which("wt"):
            options.append({"id": "windows-terminal", "label": "Windows Terminal"})
        if _shutil.which("pwsh.exe") or _shutil.which("pwsh"):
            options.append({"id": "pwsh", "label": "PowerShell 7+"})
        options.append({"id": "powershell", "label": "PowerShell 5"})
        options.append({"id": "cmd", "label": "Command Prompt"})
    elif system == "darwin":
        options.append({"id": "macos-terminal", "label": "Terminal.app"})
        if _os.path.exists("/Applications/iTerm.app"):
            options.append({"id": "iterm", "label": "iTerm2"})
    else:
        for exe, label in [
            ("gnome-terminal", "GNOME Terminal"),
            ("konsole", "Konsole"),
            ("xfce4-terminal", "XFCE Terminal"),
            ("x-terminal-emulator", "System Default"),
            ("xterm", "xterm"),
        ]:
            if _shutil.which(exe):
                options.append({"id": exe, "label": label})

    return {"options": options}


def open_terminal(name, terminal_type="auto"):
    """Open a host terminal window running docker exec -it <name> zsh.

    Detects the platform to choose the right terminal executable. On WSL/Windows
    defaults to PowerShell; on macOS uses open -a Terminal; on Linux uses xterm.
    terminal_type may be: auto, pwsh, powershell, windows-terminal, cmd,
    macos-terminal, iterm, gnome-terminal, konsole, xfce4-terminal,
    x-terminal-emulator, xterm.
    Returns {"ok": True} or {"error": ...}.
    """
    import platform
    import shutil as _shutil

    docker_cmd = "docker exec -it -u node -e TERM=xterm-256color " + shlex.quote(name) + " tmux new-session -A -s claudebox"
    system = platform.system().lower()
    release = platform.uname().release.lower()
    is_wsl = system == "linux" and "microsoft" in release

    if terminal_type == "auto":
        if system == "windows" or is_wsl:
            if _shutil.which("pwsh.exe") or _shutil.which("pwsh"):
                terminal_type = "pwsh"
            elif _shutil.which("wt.exe") or _shutil.which("wt"):
                terminal_type = "windows-terminal"
            else:
                terminal_type = "powershell"
        elif system == "darwin":
            terminal_type = "macos-terminal"
        else:
            for exe in ("gnome-terminal", "konsole", "xfce4-terminal",
                        "x-terminal-emulator", "xterm"):
                if _shutil.which(exe):
                    terminal_type = exe
                    break
            else:
                terminal_type = "xterm"

    try:
        if is_wsl or system == "windows":
            # WSL → Windows terminal spawning via cmd.exe /c start
            if terminal_type == "pwsh":
                inner = ["pwsh.exe", "-NoExit", "-Command", docker_cmd]
            elif terminal_type == "powershell":
                inner = ["powershell.exe", "-NoExit", "-Command", docker_cmd]
            elif terminal_type == "windows-terminal":
                shell = "pwsh.exe" if (_shutil.which("pwsh.exe") or _shutil.which("pwsh")) else "powershell.exe"
                inner = ["wt.exe", "new-tab", "--", shell, "-NoExit", "-Command", docker_cmd]
            elif terminal_type == "cmd":
                inner = ["cmd.exe", "/k", docker_cmd]
            else:
                inner = ["pwsh.exe", "-NoExit", "-Command", docker_cmd]
            subprocess.Popen(
                ["cmd.exe", "/c", "start"] + inner,
                start_new_session=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return {"ok": True}
        elif terminal_type == "macos-terminal":
            subprocess.Popen(
                ["osascript", "-e",
                 f'tell application "Terminal" to do script "{docker_cmd}"'],
                start_new_session=True,
            )
        elif terminal_type == "iterm":
            subprocess.Popen(
                ["osascript", "-e",
                 f'tell application "iTerm" to create window with default profile'
                 f' command "{docker_cmd}"'],
                start_new_session=True,
            )
        elif terminal_type == "gnome-terminal":
            subprocess.Popen(
                ["gnome-terminal", "--", "bash", "-c", docker_cmd + "; exec bash"],
                start_new_session=True,
            )
        elif terminal_type in ("konsole", "xfce4-terminal", "x-terminal-emulator"):
            subprocess.Popen([terminal_type, "-e", docker_cmd], start_new_session=True)
        else:  # xterm fallback
            subprocess.Popen(["xterm", "-e", docker_cmd], start_new_session=True)
        return {"ok": True}

    except FileNotFoundError as e:
        return {"error": f"Terminal executable not found: {e.filename}"}
    except Exception as e:
        return {"error": str(e)}


def inspect_container(name):
    """Run docker inspect <name> and return the parsed first element.  (ref: plan:DL-003)

    Runs without --format so the full JSON array is returned; only the first
    element is extracted because docker inspect always wraps results in an array.
    Timeout is 10 seconds matching other docker subprocess calls in this module.
    Returns {"inspect": {...}} or {"error": ...}.
    """
    try:
        result = subprocess.run(
            ["docker", "inspect", name],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return {"error": result.stderr.strip() or "docker inspect failed"}
        parsed = json.loads(result.stdout)
        if not parsed:
            return {"error": "no inspect data returned"}
        return {"inspect": parsed[0]}
    except subprocess.TimeoutExpired:
        return {"error": "docker inspect timed out"}
    except json.JSONDecodeError:
        return {"error": "docker inspect output was not valid JSON"}


def get_file_content(container_name, file_path):
    """Read a file inside a container via docker exec cat.

    Returns ``{content, path, size}`` on success or ``{error}`` on failure.
    Binary files (null byte in first 512 B) and files over 1 MB are rejected
    to prevent browser memory exhaustion. File writing is not supported;
    the viewer is read-only (ref: DL-005).
    """
    if not file_path or not file_path.startswith("/"):
        return {"error": "absolute file path required"}
    MAX_BYTES = 1024 * 1024  # 1MB
    try:
        # First get file size via stat
        stat_r = subprocess.run(
            ["docker", "exec", container_name, "stat", "-c", "%s", file_path],
            capture_output=True, text=True, timeout=10,
        )
        if stat_r.returncode != 0:
            return {"error": stat_r.stderr.strip() or "file not found"}
        try:
            size = int(stat_r.stdout.strip())
        except ValueError:
            size = 0
        if size > MAX_BYTES:
            return {"error": f"file too large ({size} bytes); maximum is {MAX_BYTES // 1024}KB"}

        # Check for binary content using first 512 bytes
        head_r = subprocess.run(
            ["docker", "exec", container_name, "head", "-c", "512", file_path],
            capture_output=True, timeout=10,
        )
        if b"\x00" in head_r.stdout:
            return {"error": "binary file — cannot display"}

        # Read full content as text
        cat_r = subprocess.run(
            ["docker", "exec", container_name, "cat", file_path],
            capture_output=True, text=True, timeout=15,
        )
        if cat_r.returncode != 0:
            return {"error": cat_r.stderr.strip() or "cat failed"}
        return {"content": cat_r.stdout, "path": file_path, "size": size}
    except subprocess.TimeoutExpired:
        return {"error": "docker exec timed out"}
    except Exception as e:
        return {"error": str(e)}


def destroy_container(name):
    """Remove a Docker container by force without deregistering from the registry.

    Calls docker rm -f directly so the GUI can offer a Rebuild action afterward.
    Updates the registry entry with a destroyed_at timestamp to distinguish
    intentional destroy from external removal. Uses atomic JSON write.
    Returns {ok: True} or {error: ...}.
    """
    try:
        result = subprocess.run(
            ["docker", "rm", "-f", name],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return {"error": result.stderr.strip() or "docker rm failed"}
    except subprocess.TimeoutExpired:
        return {"error": "docker rm timed out"}
    except Exception as e:
        return {"error": str(e)}

    # Update registry entry with destroyed_at timestamp (do not remove)
    registry = _read_json_file(_REGISTRY_PATH)
    entries = registry.get("containers", {})
    if name in entries:
        entries[name] = dict(entries[name], destroyed_at=datetime.now(timezone.utc).isoformat())
        registry["containers"] = entries
        try:
            _write_json_atomic(_REGISTRY_PATH, registry)
        except OSError:
            pass  # non-fatal: timestamp update is best-effort
    return {"ok": True}


# Terminal session management
# Keyed by container_name. Each session dict:
#   proc          - subprocess.Popen for the docker exec process
#   master_fd     - PTY master file descriptor, or None when using pipe fallback
#   lock          - threading.Lock for fd write access
#   subscribers   - list of queue.Queue instances registered by active SSE handlers (DL-003)
#   last_activity - float timestamp (time.time()) of last PTY byte read; 0 if none (DL-006)
_terminal_sessions = {}
_terminal_sessions_lock = threading.Lock()
_reaper_started = False  # True while _idle_reaper daemon thread is running (DL-006)


def create_terminal_session(container_name):
    """Spawn docker exec -it <name> zsh with PTY allocation.

    Uses pty.openpty() when available (Linux/macOS); falls back to
    subprocess.Popen with pipes when pty module is absent (Windows).
    Returns {ok: True} or {error: ...}.
    """
    import time as _time
    global _reaper_started
    with _terminal_sessions_lock:
        existing = _terminal_sessions.get(container_name)
        if existing:
            # Check if still alive
            proc = existing["proc"]
            if proc.poll() is None:
                return {"ok": True, "reused": True}
            # Stale session — clean up
            _cleanup_session(container_name)

        _reg = _read_json_file(_REGISTRY_PATH).get("containers", {})
        _proj = _reg.get(container_name, {}).get("project_dir", "/workspace")
        cmd = ["docker", "exec", "-it", "-u", "node", "-e", "TERM=xterm-256color", container_name,
               "tmux", "new-session", "-A", "-s", "claudebox", "-c", _proj]
        try:
            if HAS_PTY:
                master_fd, slave_fd = _pty_mod.openpty()
                proc = subprocess.Popen(
                    cmd,
                    stdin=slave_fd,
                    stdout=slave_fd,
                    stderr=slave_fd,
                    close_fds=True,
                    preexec_fn=os.setsid,
                )
                os.close(slave_fd)
                _terminal_sessions[container_name] = {
                    "proc": proc,
                    "master_fd": master_fd,
                    "lock": threading.Lock(),
                    "subscribers": [],
                    "last_activity": 0,
                }
            else:
                # Pipe fallback for Windows where pty is unavailable.
                # os.setsid is POSIX-only — use it only when available (not on Windows/nt).
                _preexec = os.setsid if hasattr(os, "setsid") else None
                proc = subprocess.Popen(
                    ["docker", "exec", "-i", "-u", "node", container_name, "zsh"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    preexec_fn=_preexec,
                )
                _terminal_sessions[container_name] = {
                    "proc": proc,
                    "master_fd": None,
                    "lock": threading.Lock(),
                    "subscribers": [],
                    "last_activity": 0,
                }
        except Exception as e:
            return {"error": str(e)}
        _start_broadcaster(container_name, _terminal_sessions[container_name])
        if not _reaper_started:
            _reaper_started = True
            t = threading.Thread(target=_idle_reaper, daemon=True)
            t.start()
        return {"ok": True}


def _start_broadcaster(container_name, session):
    """Start the single reader thread that fans out PTY output to subscriber queues.

    One broadcaster thread per PTY session reads from master_fd (or stdout pipe on
    Windows) and puts each chunk into every queue in session["subscribers"].
    Multiple concurrent SSE handlers (e.g. dashboard tile + detail panel) each register
    a queue via subscribe_terminal() and receive identical output without racing on the
    fd (DL-003).

    Sends None sentinel to all subscribers when the PTY EOF or process exit is detected,
    signalling SSE handlers to close their streams.
    Updates session["last_activity"] on each non-empty read for the idle reaper (DL-006).
    """
    import time as _time

    def _broadcaster():
        import select as _select
        master_fd = session.get("master_fd")
        if master_fd is None:
            pipe_q = queue.Queue()

            def _pipe_reader():
                try:
                    while True:
                        chunk = session["proc"].stdout.read(4096)
                        if chunk:
                            pipe_q.put(chunk)
                        else:
                            pipe_q.put(None)
                            return
                except (OSError, AttributeError):
                    pipe_q.put(None)

            _pt = threading.Thread(target=_pipe_reader, daemon=True)
            _pt.start()

        while True:
            master_fd = session.get("master_fd")
            if master_fd is not None:
                try:
                    r, _, _ = _select.select([master_fd], [], [], 0.05)
                    if r:
                        chunk = os.read(master_fd, 4096)
                    else:
                        chunk = b""
                except OSError:
                    chunk = None
            else:
                try:
                    chunk = pipe_q.get(timeout=0.05)
                except queue.Empty:
                    chunk = b""

            if chunk is None:
                with _terminal_sessions_lock:
                    subs = list(session.get("subscribers", []))
                for q in subs:
                    try:
                        q.put_nowait(None)
                    except Exception:
                        pass
                return

            if chunk:
                session["last_activity"] = _time.time()
                with _terminal_sessions_lock:
                    subs = list(session.get("subscribers", []))
                for q in subs:
                    try:
                        q.put_nowait(chunk)
                    except queue.Full:
                        pass

            if not chunk:
                if session["proc"].poll() is not None:
                    with _terminal_sessions_lock:
                        subs = list(session.get("subscribers", []))
                    for q in subs:
                        try:
                            q.put_nowait(None)
                        except Exception:
                            pass
                    return

    t = threading.Thread(target=_broadcaster, daemon=True)
    t.start()


def subscribe_terminal(container_name):
    """Register a new subscriber queue for the named container's PTY broadcaster.

    Returns a queue.Queue(maxsize=1024). The caller (SSE handler) dequeues chunks
    and writes them to the HTTP response. Call unsubscribe_terminal() in a finally
    block to avoid stale queue references in session["subscribers"] (DL-006).
    Returns an empty queue if no session exists for container_name.
    """
    q = queue.Queue(maxsize=1024)
    with _terminal_sessions_lock:
        session = _terminal_sessions.get(container_name)
        if session is not None:
            session["subscribers"].append(q)
    return q


def unsubscribe_terminal(container_name, q):
    """Remove subscriber queue q from the named container's PTY session.

    Safe to call if the session has already been cleaned up (no-op in that case).
    Does NOT delete the PTY session; the idle reaper (DL-006) handles cleanup
    when zero subscribers remain and last_activity is stale.
    """
    with _terminal_sessions_lock:
        session = _terminal_sessions.get(container_name)
        if session is not None:
            try:
                session["subscribers"].remove(q)
            except ValueError:
                pass


def _idle_reaper():
    """Background daemon: close PTY sessions orphaned by all consumers disconnecting.

    Wakes every 30 seconds and scans _terminal_sessions. Calls _cleanup_session() on
    any session that has zero subscribers AND whose last_activity timestamp is either
    zero or older than 60 seconds (DL-006).

    The 60-second grace period prevents premature cleanup of sessions whose last
    subscriber just disconnected but a new one is about to connect (e.g. page reload).
    Exits and resets _reaper_started when no sessions remain, so a new reaper thread
    is started on the next create_terminal_session() call.
    """
    import time as _time
    while True:
        _time.sleep(30)
        with _terminal_sessions_lock:
            names = list(_terminal_sessions.keys())
        for name in names:
            with _terminal_sessions_lock:
                session = _terminal_sessions.get(name)
                if session is None:
                    continue
                subs = session.get("subscribers", [])
                last = session.get("last_activity", 0)
                if len(subs) == 0 and (last == 0 or (_time.time() - last) > 60):
                    _cleanup_session(name)
        with _terminal_sessions_lock:
            if not _terminal_sessions:
                global _reaper_started
                _reaper_started = False
                return


# read_terminal() removed — broadcaster fan-out replaced per-connection reads


def write_terminal(container_name, data):
    """Write bytes to the terminal session. Returns {ok: True} or {error: ...}."""
    session = _terminal_sessions.get(container_name)
    if not session:
        return {"error": "no active session"}
    try:
        if session["master_fd"] is not None:
            os.write(session["master_fd"], data)
        else:
            session["proc"].stdin.write(data)
            session["proc"].stdin.flush()
        return {"ok": True}
    except OSError as e:
        return {"error": str(e)}


def _cleanup_session(container_name):
    """Internal: close session resources. Caller must hold _terminal_sessions_lock."""
    session = _terminal_sessions.pop(container_name, None)
    if not session:
        return
    # Signal all subscriber queues with None sentinel so SSE handlers exit their
    # dequeue loops instead of blocking indefinitely after the session is removed (DL-006).
    for q in session.get("subscribers", []):
        try:
            q.put_nowait(None)
        except Exception:
            pass
    proc = session["proc"]
    master_fd = session["master_fd"]
    try:
        proc.terminate()
        proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    if master_fd is not None:
        try:
            os.close(master_fd)
        except OSError:
            pass


def close_terminal(container_name):
    """Close and remove a terminal session. Idempotent."""
    with _terminal_sessions_lock:
        _cleanup_session(container_name)


def close_all_terminals():
    """Close all active terminal sessions (atexit / SIGTERM handler)."""
    with _terminal_sessions_lock:
        for name in list(_terminal_sessions.keys()):
            _cleanup_session(name)
    with _local_term_lock:
        _cleanup_local_session()


def remove_ref(container_name, ref_name):
    """Delete a ref directory from inside the container.

    Sanitizes ref_name to prevent path traversal. Returns {"ok": True} or {"error": ...}.
    """
    if not ref_name or "/" in ref_name or ref_name in (".", ".."):
        return {"error": "invalid ref name"}
    try:
        r = subprocess.run(
            ["docker", "exec", "-u", "root", container_name,
             "rm", "-rf", f"/workspace/refs/{ref_name}"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            return {"error": r.stderr.strip() or "rm failed"}
        return {"ok": True}
    except subprocess.TimeoutExpired:
        return {"error": "timed out"}
    except Exception as exc:
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Local terminal (host shell PTY) — single shared session, not per-container
# ---------------------------------------------------------------------------

_local_term_session = {}
_local_term_lock = threading.Lock()


def create_local_terminal_session():
    """Start a local shell with PTY allocation on the host.

    Reuses the existing session if the process is still alive.
    Returns {"ok": True} or {"error": ...}.
    """
    with _local_term_lock:
        existing = _local_term_session.get("session")
        if existing and existing["proc"].poll() is None:
            return {"ok": True, "reused": True}
        if existing:
            _cleanup_local_session()

        shell = os.environ.get("SHELL", "/bin/bash")
        home_dir = os.path.expanduser("~")
        try:
            if HAS_PTY:
                master_fd, slave_fd = _pty_mod.openpty()
                proc = subprocess.Popen(
                    [shell],
                    cwd=home_dir,
                    stdin=slave_fd,
                    stdout=slave_fd,
                    stderr=slave_fd,
                    close_fds=True,
                    preexec_fn=os.setsid if os.name != "nt" else None,
                    env=os.environ.copy(),
                )
                os.close(slave_fd)
                _local_term_session["session"] = {
                    "proc": proc,
                    "master_fd": master_fd,
                    "lock": threading.Lock(),
                }
            else:
                _preexec = os.setsid if hasattr(os, "setsid") else None
                proc = subprocess.Popen(
                    [shell],
                    cwd=home_dir,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    preexec_fn=_preexec,
                    env=os.environ.copy(),
                )
                _local_term_session["session"] = {
                    "proc": proc,
                    "master_fd": None,
                    "lock": threading.Lock(),
                }
        except Exception as exc:
            return {"error": str(exc)}
        return {"ok": True}


def read_local_terminal(timeout=0.05):
    """Read available bytes from the local terminal session.

    Returns bytes, b'' when nothing available, or None if session absent.
    """
    session = _local_term_session.get("session")
    if not session:
        return None
    if session["master_fd"] is not None:
        import select
        try:
            r, _, _ = select.select([session["master_fd"]], [], [], timeout)
            if r:
                return os.read(session["master_fd"], 4096)
            return b""
        except OSError:
            return None
    else:
        try:
            import fcntl
            fd = session["proc"].stdout.fileno()
            fl = fcntl.fcntl(fd, fcntl.F_GETFL)
            fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
            return session["proc"].stdout.read(4096) or b""
        except (OSError, AttributeError):
            return b""


def write_local_terminal(data):
    """Write bytes to the local terminal session. Returns {"ok": True} or {"error": ...}."""
    session = _local_term_session.get("session")
    if not session:
        return {"error": "no active local session"}
    try:
        if session["master_fd"] is not None:
            os.write(session["master_fd"], data)
        else:
            session["proc"].stdin.write(data)
            session["proc"].stdin.flush()
        return {"ok": True}
    except OSError as exc:
        return {"error": str(exc)}


def resize_terminal(container_name, cols, rows):
    """Resize the PTY for a container terminal session.

    Sends TIOCSWINSZ to the PTY master fd so the kernel updates the terminal
    window size visible to the shell and any running TUI program. Returns
    {"ok": True} immediately when master_fd is None -- that indicates the pipe
    fallback path (no pty module), which has no kernel window-size concept.
    (ref: DL-003)
    """
    with _terminal_sessions_lock:
        session = _terminal_sessions.get(container_name)
    if not session:
        return {"error": "no session"}
    master_fd = session["master_fd"]
    if master_fd is None:  # pipe fallback -- TIOCSWINSZ not applicable (ref: DL-003)
        return {"ok": True}
    try:
        import fcntl
        import termios
        import struct
        # TIOCSWINSZ expects (rows, cols, xpixels, ypixels) -- rows before cols per POSIX struct winsize
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        return {"ok": True}
    except OSError as e:
        return {"error": str(e)}


def resize_local_terminal(cols, rows):
    """Resize the PTY for the local terminal session.

    Identical to resize_terminal but operates on the singleton local terminal
    session rather than a per-container session. Returns {"ok": True} on the
    pipe fallback path (master_fd is None) -- the pipe path has no kernel
    window-size concept, so TIOCSWINSZ is not applicable. (ref: DL-003)
    """
    with _local_term_lock:
        session = _local_term_session.get("session")
    if not session:
        return {"error": "no session"}
    master_fd = session["master_fd"]
    if master_fd is None:  # pipe fallback -- TIOCSWINSZ not applicable (ref: DL-003)
        return {"ok": True}
    try:
        import fcntl
        import termios
        import struct
        # TIOCSWINSZ expects (rows, cols, xpixels, ypixels) -- rows before cols per POSIX struct winsize
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        return {"ok": True}
    except OSError as e:
        return {"error": str(e)}


def _cleanup_local_session():
    """Internal: close local session resources. Caller must hold _local_term_lock."""
    session = _local_term_session.pop("session", None)
    if not session:
        return
    proc = session["proc"]
    master_fd = session["master_fd"]
    try:
        proc.terminate()
        proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    if master_fd is not None:
        try:
            os.close(master_fd)
        except OSError:
            pass


def close_local_terminal():
    """Close and remove the local terminal session. Idempotent."""
    with _local_term_lock:
        _cleanup_local_session()


import atexit as _atexit
import signal as _signal
_atexit.register(close_all_terminals)
try:
    _signal.signal(_signal.SIGTERM, lambda *_: close_all_terminals())
except (OSError, ValueError):
    pass  # signal registration may fail in non-main threads
