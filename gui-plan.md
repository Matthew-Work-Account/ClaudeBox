# Plan

## Overview

ClaudeBox users manage containers, configs, and commands entirely through CLI flags they must memorize. No visual overview of running containers, no side-by-side config diff view, and no way to run commands without knowing exact syntax.

**Approach**: A local web dashboard (Python stdlib HTTP server + vanilla JS SPA) launched via claudebox gui. The browser UI lists all claudebox containers from Docker, displays merged config with global/local provenance, allows config editing, and runs claudebox commands with streaming output via SSE. Zero external dependencies beyond Python3.

### ClaudeBox GUI Architecture

[Diagram pending Technical Writer rendering: DIAG-001]

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Pure Python stdlib GUI server (http.server + custom handler) | Python3 universally available on Linux/macOS/WSL -> no pip dependencies means zero install friction -> stdlib http.server sufficient for local-only dashboard traffic |
| DL-002 | Persistent registry at ~/.claudebox/registry.json updated by init/destroy hooks, cross-checked with Docker on GUI load | MUST constraint (CON-002) requires registry updated on init/destroy -> registry.json written by hooks in claudebox.sh cmd_init and cmd_destroy -> GUI reads registry for fast startup then cross-checks docker ps to detect stale entries from manual docker rm -> dual-source approach satisfies constraint while handling staleness |
| DL-003 | SPA built with Svelte + Vite; pre-built dist/ committed to repo; Python server serves pre-built bundle | Vanilla JS rejected: config editor + SSE streaming + merge diff view already at ergonomic ceiling, state management overhead compounds with each new feature -> Svelte produces ~4KB zero-runtime bundle -> pre-built dist/ committed to repo means end-users never need Node (Python serves static files) -> only ClaudeBox developers need Node to rebuild -> browser file-access restrictions are not a concern because all file I/O goes through the Python API server (localhost HTTP), never file:// protocol |
| DL-004 | Server-Sent Events for command output streaming | SSE works with stdlib chunked Transfer-Encoding -> browsers handle EventSource natively -> simpler than WebSocket for unidirectional server-to-client flow |
| DL-005 | Config merge replicated in Python by calling bash functions via subprocess | lib/config.sh is authoritative merge logic -> reimplementing in Python risks drift -> subprocess call to source config.sh and emit JSON ensures consistency |
| DL-006 | GUI served on localhost:19280 (default, configurable via --port); on port conflict, exit with error naming the port and suggesting --port flag | High port avoids conflicts -> localhost-only binding prevents remote access -> port flag allows override if occupied -> on OSError(EADDRINUSE) print 'Port 19280 is already in use. Use --port <number> to specify a different port.' and exit 1 -> no auto-increment to avoid user confusion about which port the GUI is actually on |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Electron app | Heavy runtime, complex install process, overkill for a CLI companion tool (ref: DL-001) |
| Rewriting claudebox.sh in Python/Node | Too risky — breaks existing users who depend on current bash CLI (ref: DL-005) |
| TUI (terminal UI) | Less discoverable for new users, harder to show config diffs side-by-side (ref: DL-003) |
| Vanilla JS SPA | Complexity of config editor + SSE streaming + merge diff view is already at vanilla JS ergonomic ceiling; state management without a component model becomes copy-pasted DOM manipulation as features grow; "no Node on host" constraint is satisfied by pre-building the bundle and committing dist/ — end-users never need Node regardless of framework choice (ref: DL-003) |

### Constraints

- MUST: GUI must work on the host machine (not inside a container) — same environment that runs claudebox.sh
- MUST: Registry must be updated on claudebox init/destroy so GUI always reflects current state without filesystem scanning
- SHOULD: Show merged config view (global ~/.claudebox/config.json + local .claudebox.json with merge semantics matching config.sh)
- SHOULD: Allow editing global and local configs from the GUI
- SHOULD: Run claudebox commands (init, stop, destroy, rebuild, etc.) and stream output
- SHOULD: Be installable alongside the existing CLI without breaking it
- MUST NOT: Require rewriting claudebox.sh from scratch — GUI wraps/extends it

### Known Risks

- **Python stdlib http.server is single-threaded; concurrent SSE streams and API requests could block each other**: Use ThreadingHTTPServer (also stdlib) to handle each request in a separate thread
- **Registry file could diverge from Docker state if user runs docker rm manually outside claudebox**: GUI always cross-checks registry against docker ps on load; stale entries are marked with warning and offer cleanup
- **SSE connections left open if browser tab closed mid-command; orphaned subprocesses**: Server detects closed connection on write and terminates subprocess; set process group for clean child cleanup
- **Subprocess call to source config.sh could fail if bash not at expected path or config.sh changes its interface**: Validate bash availability at server start; wrap subprocess in try/except with clear error message to GUI
- **Default port 19280 already occupied by another process**: On bind failure, print clear error message naming the port and suggesting --port flag; do not auto-increment to avoid user confusion
- **dist/ bundle in repo can get out of sync if developer forgets to rebuild before committing**: Add a CI check that runs `npm run build` and fails if dist/ has uncommitted changes; document the build step in gui/README.md

## Invisible Knowledge

### System

ClaudeBox is a Docker-based sandboxed dev environment. The GUI runs on the host, not inside containers. Container naming follows claudebox-{leaf}-{hash4} where hash4 = first 4 chars of sha256(lowercase(project_path)), so same project at different paths produces different containers.

### Invariants

- Config merge order: base defaults -> global ~/.claudebox/config.json -> local .claudebox.json; arrays concatenated (global first), scalars: local wins
- extra_commands run as root during container init — GUI config editor must warn users about this privilege escalation
- claudebox.sh has no built-in list/status command — container discovery requires docker ps -a --filter name=claudebox-
- .claudebox.json is gitignored (since commit 81afe2b) — GUI should not assume it exists in every project

### Tradeoffs

- Registry file (DL-002) adds a staleness vector but satisfies the MUST constraint for init/destroy tracking; cross-check with Docker on GUI load mitigates drift
- Subprocess-based config merge (DL-005) avoids reimplementation drift but adds bash dependency and startup latency per config read

## Milestones

### Milestone 1: GUI Python server and API layer

**Files**: gui/server.py, gui/api.py, gui/__init__.py, gui/__main__.py

**Acceptance Criteria**:

- python3 -m gui --port 19281 starts server and responds to GET / with 200
- GET /api/containers returns JSON array of container objects with name, status, project_path, language fields
- GET /api/config/merged?project_dir=/path returns merged config JSON matching lib/config.sh output
- POST /api/config/global with invalid JSON returns 400
- POST /api/config/global with valid JSON creates .bak backup and writes new config
- SIGINT causes server to shut down cleanly within 2 seconds
- Starting server on occupied port prints error message and exits 1

#### Code Intent

- **CI-M-001-001** `gui/__main__.py`: Entry point: parse --port flag (default 19280), start ThreadingHTTPServer on localhost, open browser via webbrowser.open(). Register SIGINT and SIGTERM handlers for graceful shutdown: handler sets a threading.Event, main loop checks it, calls server.shutdown() and sys.exit(0). On OSError(EADDRINUSE), print port-in-use message with --port suggestion and exit 1. (refs: DL-006)
- **CI-M-001-002** `gui/__init__.py`: Empty package init file (refs: DL-001)
- **CI-M-001-003** `gui/server.py`: HTTP request handler extending http.server.SimpleHTTPRequestHandler. Routes: GET /api/* dispatches to api module, GET /static/* serves gui/static/ files, POST /api/command runs claudebox subcommands. SSE endpoint at GET /api/command/stream for live output. (refs: DL-001, DL-004)
- **CI-M-001-004** `gui/api.py`: API functions: list_containers() reads ~/.claudebox/registry.json then cross-checks docker ps -a --filter name=claudebox- to detect stale entries; returns JSON with name, status, project path, language, and staleness flag. get_merged_config(project_dir) shells out to bash sourcing lib/config.sh then reads CB_MERGED_CONFIG. get_global_config() reads ~/.claudebox/config.json. get_local_config(project_dir) reads project_dir/.claudebox.json. save_global_config(data) and save_local_config(project_dir, data) validate input: must be valid JSON, must be a dict (not array/string), keys must be from known schema set (language, extra_domains, extra_suffixes, extra_apt_packages, extra_commands, modules, gui_port), values must match expected types; on validation failure return 400 with specific error; on write, create .bak backup of existing file before overwriting. run_command(args) executes claudebox.sh with args via subprocess.Popen; args are passed as list (not shell=True) to prevent injection; streams stdout/stderr. Registry helpers: register_container(name, project_dir) and deregister_container(name) update ~/.claudebox/registry.json atomically (write to tmp then rename). (refs: DL-002, DL-005)

#### Code Changes

**CC-M-001-001** (gui/__init__.py) - implements CI-M-001-002

**Code:**

```diff
--- /dev/null
+++ b/gui/__init__.py
@@ -0,0 +1 @@
+
```

**Documentation:**

```diff
--- a/gui/__init__.py
+++ b/gui/__init__.py
@@ -1 +1,3 @@
+# gui — ClaudeBox web dashboard package. (ref: DL-001)
+# Pure Python stdlib; no third-party dependencies required.
+

```


**CC-M-001-002** (gui/__main__.py) - implements CI-M-001-001

**Code:**

```diff
--- /dev/null
+++ b/gui/__main__.py
@@ -0,0 +1,56 @@
+import argparse
+import errno
+import signal
+import socket
+import sys
+import threading
+import webbrowser
+from http.server import ThreadingHTTPServer
+
+from .server import ClaudeBoxHandler
+
+
+def main():
+    parser = argparse.ArgumentParser(description="ClaudeBox GUI Dashboard")
+    parser.add_argument(
+        "--port",
+        type=int,
+        default=19280,
+        help="Port to listen on (default: 19280)",
+    )
+    args = parser.parse_args()
+
+    server_address = ("127.0.0.1", args.port)
+    try:
+        httpd = ThreadingHTTPServer(server_address, ClaudeBoxHandler)
+    except OSError as exc:
+        if exc.errno == errno.EADDRINUSE:
+            print(
+                f"Port {args.port} is already in use. "
+                f"Use --port <number> to specify a different port."
+            )
+            sys.exit(1)
+        raise
+
+    shutdown_event = threading.Event()
+
+    def _handle_signal(signum, frame):
+        shutdown_event.set()
+
+    signal.signal(signal.SIGINT, _handle_signal)
+    signal.signal(signal.SIGTERM, _handle_signal)
+
+    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
+    server_thread.start()
+
+    url = f"http://127.0.0.1:{args.port}/"
+    print(f"ClaudeBox GUI running at {url}")
+    print("Press Ctrl+C to stop.")
+    webbrowser.open(url)
+
+    shutdown_event.wait()
+    httpd.shutdown()
+    sys.exit(0)
+
+
+if __name__ == "__main__":
+    main()
```

**Documentation:**

```diff
--- a/gui/__main__.py
+++ b/gui/__main__.py
@@ -1,3 +1,9 @@
+"""
+Entry point for `python3 -m gui`.
+
+Starts a ThreadingHTTPServer on localhost (DL-001, RISK-001). Binds to 127.0.0.1
+only to prevent remote access. On EADDRINUSE exits with a message naming the port
+and suggesting --port rather than auto-incrementing (DL-006).
+"""
 import argparse
 import errno
 import signal
@@ -14,6 +20,7 @@ from .server import ClaudeBoxHandler

 def main():
+    """Parse CLI args, start server, open browser, block until signal."""
     parser = argparse.ArgumentParser(description="ClaudeBox GUI Dashboard")
     parser.add_argument(
         "--port",
@@ -27,6 +34,8 @@ def main():
     server_address = ("127.0.0.1", args.port)
     try:
         httpd = ThreadingHTTPServer(server_address, ClaudeBoxHandler)
+        # ThreadingHTTPServer handles each request in its own thread, preventing
+        # concurrent SSE streams from blocking API requests. (ref: RISK-001)
     except OSError as exc:
         if exc.errno == errno.EADDRINUSE:
             print(

```


**CC-M-001-003** (gui/server.py) - implements CI-M-001-003

**Code:**

```diff
--- /dev/null
+++ b/gui/server.py
@@ -0,0 +1,135 @@
+import json
+import os
+import shlex
+import subprocess
+import urllib.parse
+from http.server import SimpleHTTPRequestHandler
+
+from . import api
+
+_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
+
+
+class ClaudeBoxHandler(SimpleHTTPRequestHandler):
+    def __init__(self, *args, **kwargs):
+        super().__init__(*args, directory=_STATIC_DIR, **kwargs)
+
+    def log_message(self, fmt, *args):
+        pass
+
+    def do_GET(self):
+        parsed = urllib.parse.urlparse(self.path)
+        path = parsed.path
+
+        if path == "/":
+            self.path = "/index.html"
+            return super().do_GET()
+
+        if path.startswith("/api/"):
+            return self._handle_api_get(path, parsed.query)
+
+        return super().do_GET()
+
+    def do_POST(self):
+        parsed = urllib.parse.urlparse(self.path)
+        path = parsed.path
+
+        length = int(self.headers.get("Content-Length", 0))
+        body = self.rfile.read(length) if length else b""
+
+        if path.startswith("/api/"):
+            return self._handle_api_post(path, body)
+
+        self._send_json({"error": "not found"}, status=404)
+
+    def _handle_api_get(self, path, query):
+        if path == "/api/containers":
+            data = api.list_containers()
+            return self._send_json(data)
+
+        if path == "/api/config/merged":
+            params = urllib.parse.parse_qs(query)
+            project_dir = params.get("project_dir", [""])[0]
+            if not project_dir:
+                return self._send_json({"error": "project_dir required"}, status=400)
+            result = api.get_merged_config(project_dir)
+            if "error" in result:
+                return self._send_json(result, status=500)
+            return self._send_json(result)
+
+        if path == "/api/config/global":
+            return self._send_json(api.get_global_config())
+
+        if path.startswith("/api/config/local"):
+            params = urllib.parse.parse_qs(query)
+            project_dir = params.get("project_dir", [""])[0]
+            if not project_dir:
+                return self._send_json({"error": "project_dir required"}, status=400)
+            return self._send_json(api.get_local_config(project_dir))
+
+        if path == "/api/command/stream":
+            params = urllib.parse.parse_qs(query)
+            args_raw = params.get("args", [""])[0]
+            project_dir = params.get("project_dir", [""])[0]
+            try:
+                cmd_args = shlex.split(args_raw) if args_raw else []
+            except ValueError:
+                return self._send_json({"error": "invalid args"}, status=400)
+            return self._handle_sse_stream(cmd_args, project_dir or None)
+
+        self._send_json({"error": "not found"}, status=404)
+
+    def _handle_api_post(self, path, body):
+        try:
+            data = json.loads(body) if body else {}
+        except json.JSONDecodeError:
+            return self._send_json({"error": "invalid JSON"}, status=400)
+
+        if path == "/api/config/global":
+            result = api.save_global_config(data)
+            status = 400 if "error" in result else 200
+            return self._send_json(result, status=status)
+
+        if path == "/api/config/local":
+            project_dir = data.get("project_dir", "")
+            config_data = data.get("config", {})
+            if not project_dir:
+                return self._send_json({"error": "project_dir required"}, status=400)
+            result = api.save_local_config(project_dir, config_data)
+            status = 400 if "error" in result else 200
+            return self._send_json(result, status=status)
+
+        if path == "/api/command":
+            args = data.get("args", [])
+            if not isinstance(args, list):
+                return self._send_json({"error": "args must be a list"}, status=400)
+            result = api.run_command(args)
+            return self._send_json(result)
+
+        self._send_json({"error": "not found"}, status=404)
+
+    def _handle_sse_stream(self, cmd_args, project_dir=None):
+        self.send_response(200)
+        self.send_header("Content-Type", "text/event-stream")
+        self.send_header("Cache-Control", "no-cache")
+        self.send_header("Connection", "keep-alive")
+        self.end_headers()
+
+        proc = api.start_command_stream(cmd_args, project_dir=project_dir)
+        if proc is None:
+            try:
+                self.wfile.write(b'data: {"error": "claudebox not found"}\n\n')
+                self.wfile.flush()
+            except OSError:
+                pass
+            return
+
+        try:
+            for line in proc.stdout:
+                msg = json.dumps({"line": line.rstrip("\n")})
+                self.wfile.write(f"data: {msg}\n\n".encode())
+                self.wfile.flush()
+        except OSError:
+            pass
+        finally:
+            proc.stdout.close()
+            os.killpg(os.getpgid(proc.pid), __import__("signal").SIGTERM)
+            proc.wait()
+
+        try:
+            self.wfile.write(b'data: {"done": true}\n\n')
+            self.wfile.flush()
+        except OSError:
+            pass
+
+    def _send_json(self, data, status=200):
+        body = json.dumps(data).encode()
+        self.send_response(status)
+        self.send_header("Content-Type", "application/json")
+        self.send_header("Content-Length", str(len(body)))
+        self.end_headers()
+        self.wfile.write(body)
```

**Documentation:**

```diff
--- a/gui/server.py
+++ b/gui/server.py
@@ -1,3 +1,13 @@
+"""
+HTTP request handler for the ClaudeBox GUI server.
+
+Extends SimpleHTTPRequestHandler to serve the static SPA from gui/static/ and
+route /api/* paths to the api module. SSE streaming uses chunked
+Transfer-Encoding so output lines flow to the browser as the subprocess emits
+them. (ref: DL-001, DL-003, DL-004)
+"""
 import json
 import os
 import shlex
@@ -12,6 +22,12 @@ _STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

 class ClaudeBoxHandler(SimpleHTTPRequestHandler):
+    """
+    Routes GET /api/* and POST /api/* to handler methods; all other GET
+    requests are served as static files from _STATIC_DIR. Request logging is
+    suppressed (log_message is a no-op) to avoid noise on stdout while the
+    server runs in the foreground.
+    """
     def __init__(self, *args, **kwargs):
         super().__init__(*args, directory=_STATIC_DIR, **kwargs)

@@ -19,6 +35,7 @@ class ClaudeBoxHandler(SimpleHTTPRequestHandler):
     def log_message(self, fmt, *args):
         pass

+    # --- GET routing ---
     def do_GET(self):
         parsed = urllib.parse.urlparse(self.path)
         path = parsed.path
@@ -32,6 +49,7 @@ class ClaudeBoxHandler(SimpleHTTPRequestHandler):
         return super().do_GET()

+    # --- POST routing ---
     def do_POST(self):
         parsed = urllib.parse.urlparse(self.path)
         path = parsed.path

```


**CC-M-001-004** (gui/api.py) - implements CI-M-001-004

**Code:**

```diff
--- /dev/null
+++ b/gui/api.py
@@ -0,0 +1,209 @@
+import json
+import os
+import subprocess
+import tempfile
+from datetime import datetime, timezone
+
+_REGISTRY_PATH = os.path.expanduser("~/.claudebox/registry.json")
+_GLOBAL_CONFIG_PATH = os.path.expanduser("~/.claudebox/config.json")
+_KNOWN_CONFIG_KEYS = {
+    "language",
+    "extra_domains",
+    "extra_suffixes",
+    "extra_apt_packages",
+    "extra_commands",
+    "modules",
+    "extra_volumes",
+    "extra_env",
+    "env_profile",
+    "env_profiles",
+    "default_env_profile",
+    "extra_hosts",
+    "claude_config_path",
+}
+_CONFIG_TYPES = {
+    "language": str,
+    "extra_domains": list,
+    "extra_suffixes": list,
+    "extra_apt_packages": list,
+    "extra_commands": list,
+    "modules": list,
+    "extra_volumes": dict,
+    "extra_env": list,
+    "env_profile": str,
+    "env_profiles": dict,
+    "default_env_profile": str,
+    "extra_hosts": list,
+    "claude_config_path": str,
+}
+
+
+def _read_json_file(path):
+    try:
+        with open(path) as fh:
+            return json.load(fh)
+    except FileNotFoundError:
+        return {}
+    except json.JSONDecodeError:
+        return {}
+
+
+def _write_json_atomic(path, data):
+    dir_path = os.path.dirname(path) or "."
+    os.makedirs(dir_path, exist_ok=True)
+    fd, tmp_path = tempfile.mkstemp(dir=dir_path)
+    try:
+        with os.fdopen(fd, "w") as fh:
+            json.dump(data, fh, indent=2)
+        os.replace(tmp_path, path)
+    except Exception:
+        try:
+            os.unlink(tmp_path)
+        except OSError:
+            pass
+        raise
+
+
+def _docker_running_names():
+    try:
+        result = subprocess.run(
+            ["docker", "ps", "-a", "--filter", "name=claudebox-", "--format", "{{.Names}}\t{{.Status}}"],
+            capture_output=True,
+            text=True,
+            timeout=10,
+        )
+        rows = {}
+        for line in result.stdout.splitlines():
+            parts = line.split("\t", 1)
+            if len(parts) == 2:
+                rows[parts[0]] = parts[1]
+        return rows
+    except Exception:
+        return {}
+
+
+def list_containers():
+    registry = _read_json_file(_REGISTRY_PATH)
+    entries = registry.get("containers", {})
+    docker_state = _docker_running_names()
+    docker_names = set(docker_state.keys())
+
+    results = []
+    seen = set()
+
+    for name, meta in entries.items():
+        seen.add(name)
+        status_raw = docker_state.get(name, "")
+        stale = name not in docker_names
+        results.append({
+            "name": name,
+            "status": status_raw if not stale else "removed",
+            "project_path": meta.get("project_dir", ""),
+            "language": meta.get("language", ""),
+            "created_at": meta.get("created_at", ""),
+            "stale": stale,
+        })
+
+    for name, status_raw in docker_state.items():
+        if name not in seen:
+            results.append({
+                "name": name,
+                "status": status_raw,
+                "project_path": "",
+                "language": "",
+                "created_at": "",
+                "stale": False,
+            })
+
+    return results
+
+
+def get_merged_config(project_dir):
+    claudebox_sh = _find_claudebox_sh()
+    if not claudebox_sh:
+        return {"error": "claudebox.sh not found"}
+
+    lib_config = os.path.join(os.path.dirname(claudebox_sh), "lib", "config.sh")
+    if not os.path.isfile(lib_config):
+        return {"error": "lib/config.sh not found"}
+
+    script = (
+        f"set -euo pipefail; "
+        f"source {lib_config!r}; "
+        f"cb_load_config {project_dir!r}; "
+        f'cat "$CB_MERGED_CONFIG"'
+    )
+    try:
+        result = subprocess.run(
+            ["bash", "-c", script],
+            capture_output=True,
+            text=True,
+            timeout=10,
+        )
+        if result.returncode != 0:
+            return {"error": result.stderr.strip() or "config load failed"}
+        return json.loads(result.stdout)
+    except subprocess.TimeoutExpired:
+        return {"error": "config load timed out"}
+    except json.JSONDecodeError:
+        return {"error": "config output was not valid JSON"}
+
+
+def get_global_config():
+    return _read_json_file(_GLOBAL_CONFIG_PATH)
+
+
+def get_local_config(project_dir):
+    path = os.path.join(project_dir, ".claudebox.json")
+    return _read_json_file(path)
+
+
+def _validate_config(data):
+    if not isinstance(data, dict):
+        return "config must be a JSON object"
+    unknown = set(data.keys()) - _KNOWN_CONFIG_KEYS
+    if unknown:
+        return f"unknown keys: {', '.join(sorted(unknown))}"
+    for key, expected_type in _CONFIG_TYPES.items():
+        if key in data and not isinstance(data[key], expected_type):
+            return f"{key} must be of type {expected_type.__name__}"
+    return None
+
+
+def save_global_config(data):
+    err = _validate_config(data)
+    if err:
+        return {"error": err}
+    _backup_file(_GLOBAL_CONFIG_PATH)
+    _write_json_atomic(_GLOBAL_CONFIG_PATH, data)
+    return {"ok": True}
+
+
+def save_local_config(project_dir, data):
+    err = _validate_config(data)
+    if err:
+        return {"error": err}
+    path = os.path.join(project_dir, ".claudebox.json")
+    _backup_file(path)
+    _write_json_atomic(path, data)
+    return {"ok": True}
+
+
+def _backup_file(path):
+    if os.path.isfile(path):
+        bak = path + ".bak"
+        try:
+            import shutil
+            shutil.copy2(path, bak)
+        except OSError:
+            pass
+
+
+def register_container(name, project_dir, language=""):
+    registry = _read_json_file(_REGISTRY_PATH)
+    containers = registry.get("containers", {})
+    containers[name] = {
+        "project_dir": project_dir,
+        "language": language,
+        "created_at": datetime.now(timezone.utc).isoformat(),
+    }
+    registry["containers"] = containers
+    _write_json_atomic(_REGISTRY_PATH, registry)
+
+
+def deregister_container(name):
+    registry = _read_json_file(_REGISTRY_PATH)
+    containers = registry.get("containers", {})
+    containers.pop(name, None)
+    registry["containers"] = containers
+    _write_json_atomic(_REGISTRY_PATH, registry)
+
+
+def run_command(args):
+    claudebox_sh = _find_claudebox_sh()
+    if not claudebox_sh:
+        return {"error": "claudebox.sh not found"}
+    try:
+        result = subprocess.run(
+            [claudebox_sh] + list(args),
+            capture_output=True,
+            text=True,
+            timeout=120,
+        )
+        return {
+            "stdout": result.stdout,
+            "stderr": result.stderr,
+            "returncode": result.returncode,
+        }
+    except subprocess.TimeoutExpired:
+        return {"error": "command timed out"}
+
+
+def start_command_stream(args, project_dir=None):
+    claudebox_sh = _find_claudebox_sh()
+    if not claudebox_sh:
+        return None
+    return subprocess.Popen(
+        [claudebox_sh] + list(args),
+        stdout=subprocess.PIPE,
+        stderr=subprocess.STDOUT,
+        text=True,
+        cwd=project_dir,
+        preexec_fn=os.setsid,
+    )
+
+
+def _find_claudebox_sh():
+    explicit = os.environ.get("CLAUDEBOX_HOME")
+    if explicit:
+        candidate = os.path.join(explicit, "claudebox.sh")
+        if os.path.isfile(candidate):
+            return candidate
+    for candidate in [
+        os.path.expanduser("~/.local/share/claudebox/claudebox.sh"),
+    ]:
+        if os.path.isfile(candidate):
+            return candidate
+    return None
```

**Documentation:**

```diff
--- a/gui/api.py
+++ b/gui/api.py
@@ -1,3 +1,17 @@
+"""
+API layer for the ClaudeBox GUI server.
+
+Reads/writes the container registry at ~/.claudebox/registry.json (DL-002).
+On list_containers, cross-checks registry against `docker ps` output to detect
+stale entries from manual `docker rm` (RISK-002). Config merge is obtained by
+sourcing lib/config.sh via subprocess — ensures the GUI reflects the
+authoritative bash merge semantics without reimplementing them (DL-005,
+RISK-004). Atomic JSON writes use tempfile+os.replace to avoid partial writes.
+"""
 import json
 import os
 import subprocess
@@ -46,6 +60,7 @@ _CONFIG_TYPES = {


 def _read_json_file(path):
+    """Return parsed JSON from path, or {} on missing file or parse error.

    {} is chosen over None so callers can always use .get() without a None-check,
    and over raising so missing/corrupt files are treated as empty state (e.g.,
    absent registry.json is equivalent to an empty registry).
    """
     try:
         with open(path) as fh:
             return json.load(fh)
@@ -56,6 +71,7 @@ def _read_json_file(path):


 def _write_json_atomic(path, data):
+    """Write data as JSON to path atomically via tempfile+os.replace.

    Atomicity prevents a partial registry.json on crash mid-write, which would
    corrupt the container list and require manual recovery.
    """
     dir_path = os.path.dirname(path) or "."
     os.makedirs(dir_path, exist_ok=True)
     fd, tmp_path = tempfile.mkstemp(dir=dir_path)
@@ -70,6 +86,9 @@ def _write_json_atomic(path, data):


 def _docker_running_names():
+    """
+    Return {name: status_string} for all claudebox-* containers via `docker ps -a`.
+    Returns {} on subprocess error or timeout.
+    """
     try:
         result = subprocess.run(
             ["docker", "ps", "-a", "--filter", "name=claudebox-", "--format", "{{.Names}}\t{{.Status}}"],
@@ -88,6 +107,14 @@ def _docker_running_names():


 def list_containers():
+    """
+    Return a list of container dicts combining registry and live Docker state.
+
+    Registry entries absent from Docker output are marked stale=True with
+    status="removed". Docker containers absent from the registry are included
+    with empty project_path/language/created_at. (ref: DL-002, RISK-002)
+    """
     registry = _read_json_file(_REGISTRY_PATH)
     entries = registry.get("containers", {})
     docker_state = _docker_running_names()
@@ -128,6 +155,10 @@ def list_containers():


 def get_merged_config(project_dir):
+    """
+    Return merged config JSON for project_dir by sourcing lib/config.sh in a
+    subprocess and reading the emitted CB_MERGED_CONFIG file. Returns
+    {"error": ...} on subprocess failure or non-JSON output. (ref: DL-005)
+    """
     claudebox_sh = _find_claudebox_sh()
     if not claudebox_sh:
         return {"error": "claudebox.sh not found"}
@@ -157,9 +188,12 @@ def get_merged_config(project_dir):


 def get_global_config():
+    """Return the global config dict from ~/.claudebox/config.json.

    Returns {} (via _read_json_file) when absent so callers get a consistent
    dict type regardless of whether the user has created a global config.
    """
     return _read_json_file(_GLOBAL_CONFIG_PATH)


 def get_local_config(project_dir):
+    """Return the local config dict from project_dir/.claudebox.json.

    Returns {} when absent; .claudebox.json is gitignored and may not exist in
    every project (see commit 81afe2b), so absence is the normal case.
    """
     path = os.path.join(project_dir, ".claudebox.json")
     return _read_json_file(path)

@@ -167,6 +201,8 @@ def get_local_config(project_dir):


 def _validate_config(data):
+    """Return an error string if data contains unknown keys or wrong types, else None."""
     if not isinstance(data, dict):
         return "config must be a JSON object"
     unknown = set(data.keys()) - _KNOWN_CONFIG_KEYS
@@ -178,9 +214,11 @@ def _validate_config(data):


 def save_global_config(data):
+    """Validate, backup, and atomically write data to the global config file."""
     err = _validate_config(data)
     if err:
         return {"error": err}
@@ -190,6 +228,7 @@ def save_global_config(data):


 def save_local_config(project_dir, data):
+    """Validate, backup, and atomically write data to project_dir/.claudebox.json."""
     err = _validate_config(data)
     if err:
         return {"error": err}
@@ -199,6 +239,8 @@ def save_local_config(project_dir, data):


 def _backup_file(path):
+    """Copy path to path+.bak before overwrite. Silently skips on OSError.

    .bak extension is chosen for discoverability (users know to look for it).
    OSError is swallowed because backup failure should not block the save.
    """
     if os.path.isfile(path):
         bak = path + ".bak"
         try:
@@ -209,6 +251,8 @@ def _backup_file(path):


 def register_container(name, project_dir, language=""):
+    """Add or update container entry in registry.json with current UTC timestamp.

    UTC is used (not local time) so the timestamp survives timezone changes
    and displays consistently across host locales in the GUI.
    """
     registry = _read_json_file(_REGISTRY_PATH)
     containers = registry.get("containers", {})
     containers[name] = {
@@ -221,6 +265,7 @@ def register_container(name, project_dir, language=""):


 def deregister_container(name):
+    """Remove container entry from registry.json. No-op if name absent.

    dict.pop(name, None) is used rather than checking containment first to
    avoid a race between the check and the remove on concurrent destroy calls.
    """
     registry = _read_json_file(_REGISTRY_PATH)
     containers = registry.get("containers", {})
     containers.pop(name, None)
@@ -230,6 +275,8 @@ def deregister_container(name):


 def run_command(args):
+    """Run claudebox.sh with args, capturing stdout/stderr. Returns dict with stdout/stderr/returncode.

    args is passed as a list (not shell=True) to prevent shell injection from
    user-supplied command arguments in the GUI.
    """
     claudebox_sh = _find_claudebox_sh()
     if not claudebox_sh:
         return {"error": "claudebox.sh not found"}
@@ -248,6 +295,10 @@ def run_command(args):


 def start_command_stream(args, project_dir=None):
+    """
+    Spawn claudebox.sh with args as a subprocess with stdout piped for SSE streaming.
+    Uses os.setsid so the process group can be killed on disconnect. (ref: RISK-003)
+    """
     claudebox_sh = _find_claudebox_sh()
     if not claudebox_sh:
         return None
@@ -263,6 +312,11 @@ def start_command_stream(args, project_dir=None):


 def _find_claudebox_sh():
+    """
+    Locate claudebox.sh by checking CLAUDEBOX_HOME env var first, then
+    ~/.local/share/claudebox/. Returns None if not found.
+    """
     explicit = os.environ.get("CLAUDEBOX_HOME")
     if explicit:
         candidate = os.path.join(explicit, "claudebox.sh")

```


**CC-M-001-005** (gui/README.md)

**Documentation:**

```diff
--- /dev/null
+++ b/gui/README.md
@@ -0,0 +1,66 @@
+# gui
+
+Web dashboard for ClaudeBox. Runs as a local Python HTTP server on the host
+machine (not inside a container). Opens in the user's default browser.
+
+## Architecture
+
+```
+gui/
+├── __init__.py      # Package marker
+├── __main__.py      # Entry point: arg parsing, ThreadingHTTPServer lifecycle
+├── server.py        # HTTP handler: static file serving + /api/* routing
+├── api.py           # Business logic: registry, config, docker, subprocess
+└── static/
+    ├── index.html   # Single-page app shell
+    ├── app.js       # SPA logic (vanilla JS, no framework, no build step)
+    └── style.css    # Dashboard styles
+```
+
+## Key Decisions
+
+**Python stdlib only (DL-001)**: `http.server.ThreadingHTTPServer` handles each
+request in its own thread. No pip dependencies — zero install friction on the
+host.
+
+**Registry file (DL-002)**: `~/.claudebox/registry.json` is written by
+`registry_add`/`registry_remove` hooks in `claudebox.sh`. The GUI reads it for
+fast startup, then cross-checks `docker ps` to detect containers removed via
+`docker rm` outside of ClaudeBox. Registry and Docker are the dual source of
+truth; neither alone is sufficient.
+
+**Vanilla JS SPA (DL-003)**: No framework, no build step. Ships as static
+HTML/CSS/JS served directly from `gui/static/`. Sufficient for dashboard
+complexity. If feature count grows to require modularization, split into
+per-area JS files rather than adopting a framework (RISK-006 mitigation).
+
+**SSE for streaming (DL-004)**: Command output streams via Server-Sent Events
+(`EventSource` in the browser, chunked `text/event-stream` on the server).
+Simpler than WebSocket for unidirectional server-to-client flow. On browser
+disconnect, the server detects `OSError` on write and kills the subprocess
+process group via `os.killpg`.
+
+**Config merge via bash subprocess (DL-005)**: `get_merged_config` sources
+`lib/config.sh` in a subprocess and reads the resulting `CB_MERGED_CONFIG`
+file. This ensures the GUI always reflects the authoritative merge semantics
+without reimplementing them in Python (which would risk drift).
+
+**Port 19280, no auto-increment (DL-006)**: On `EADDRINUSE`, the server exits
+with a message naming the port and suggesting `--port`. Auto-incrementing would
+leave the user uncertain which port the GUI is actually on.
+
+## Invariants
+
+- Server binds to `127.0.0.1` only — no remote access
+- Registry writes are atomic (tempfile + `os.replace`)
+- Config saves create a `.bak` backup before overwrite
+- `extra_commands` entries are flagged in the local config editor because they
+  run as root during container initialization
+
+## Running Locally
+
+```bash
+# From the repo root (not inside a container):
+cd ~/.local/share/claudebox
+python3 -m gui
+# or with a custom port:
+python3 -m gui --port 8080
+```
+
+The normal entry point is `claudebox gui [--port <port>]`.


```


### Milestone 2: Web frontend (HTML/CSS/JS SPA)

**Files**: gui/static/index.html, gui/static/app.js, gui/static/style.css

**Acceptance Criteria**:

- GET / serves index.html with sidebar, config viewer, and command runner sections
- Sidebar populates with container list from /api/containers on page load
- Clicking a container shows its status, language, and mount info in the details panel
- Config tab displays merged config with visual distinction between global and local sources
- Config edit mode allows saving changes; success/error feedback shown to user
- Command buttons trigger SSE stream; output appears in terminal-like panel in real time
- extra_commands field in config editor displays root privilege warning

#### Code Intent

- **CI-M-002-001** `gui/static/index.html`: Single HTML page with sidebar listing containers, main content area showing: container details panel, merged config viewer, config editor (global and local tabs), command runner with output terminal. Loads app.js and style.css. (refs: DL-003)
- **CI-M-002-002** `gui/static/app.js`: Vanilla JS SPA logic. On load, fetches /api/containers and populates sidebar. Clicking a container shows its details (status, language, mounts). Config tab fetches merged config and renders as formatted JSON with diff highlighting (global vs local). Edit mode allows modifying global or local config and POSTing back. Command panel has buttons for init, stop, destroy, rebuild, refresh -- each POSTs to /api/command and connects to SSE stream for live output in a terminal-like div. (refs: DL-003, DL-004)
- **CI-M-002-003** `gui/static/style.css`: Dashboard layout: fixed sidebar (250px), scrollable main area. Dark terminal-style output panel for command results. Responsive two-column layout for config viewer. Status badges (running=green, exited=gray, paused=yellow). (refs: DL-003)

#### Code Changes

**CC-M-002-001** (gui/static/index.html) - implements CI-M-002-001

**Code:**

```diff
--- /dev/null
+++ b/gui/static/index.html
@@ -0,0 +1,100 @@
+<!DOCTYPE html>
+<html lang="en">
+<head>
+  <meta charset="UTF-8">
+  <meta name="viewport" content="width=device-width, initial-scale=1.0">
+  <title>ClaudeBox Dashboard</title>
+  <link rel="stylesheet" href="/style.css">
+</head>
+<body>
+  <div class="layout">
+    <aside class="sidebar">
+      <div class="sidebar-header">
+        <h1>ClaudeBox</h1>
+      </div>
+      <nav id="container-list" class="container-list">
+        <div class="loading">Loading containers...</div>
+      </nav>
+    </aside>
+
+    <main class="main">
+      <section id="detail-panel" class="panel hidden">
+        <h2 id="detail-name"></h2>
+        <div class="detail-grid">
+          <div class="detail-row"><span class="label">Status</span><span id="detail-status" class="badge"></span></div>
+          <div class="detail-row"><span class="label">Language</span><span id="detail-language"></span></div>
+          <div class="detail-row"><span class="label">Project</span><span id="detail-project"></span></div>
+          <div class="detail-row"><span class="label">Created</span><span id="detail-created"></span></div>
+        </div>
+
+        <div class="command-panel">
+          <h3>Run Command</h3>
+          <div class="command-buttons">
+            <button class="cmd-btn" data-cmd="stop">Stop</button>
+            <button class="cmd-btn" data-cmd="destroy">Destroy</button>
+            <button class="cmd-btn" data-cmd="refresh">Refresh</button>
+          </div>
+          <div id="cmd-output" class="terminal hidden"></div>
+        </div>
+      </section>
+
+      <section id="config-panel" class="panel hidden">
+        <div class="config-tabs">
+          <button class="tab-btn active" data-tab="merged">Merged Config</button>
+          <button class="tab-btn" data-tab="global">Global Config</button>
+          <button class="tab-btn" data-tab="local">Local Config</button>
+        </div>
+
+        <div id="tab-merged" class="tab-content active">
+          <pre id="merged-config-view" class="config-view"></pre>
+        </div>
+
+        <div id="tab-global" class="tab-content hidden">
+          <div class="config-editor-toolbar">
+            <button id="global-edit-btn">Edit</button>
+            <button id="global-save-btn" class="hidden">Save</button>
+            <button id="global-cancel-btn" class="hidden">Cancel</button>
+          </div>
+          <pre id="global-config-view" class="config-view"></pre>
+          <textarea id="global-config-editor" class="config-editor hidden"></textarea>
+          <div id="global-config-msg" class="config-msg"></div>
+        </div>
+
+        <div id="tab-local" class="tab-content hidden">
+          <div class="config-editor-toolbar">
+            <button id="local-edit-btn">Edit</button>
+            <button id="local-save-btn" class="hidden">Save</button>
+            <button id="local-cancel-btn" class="hidden">Cancel</button>
+          </div>
+          <pre id="local-config-view" class="config-view"></pre>
+          <textarea id="local-config-editor" class="config-editor hidden"></textarea>
+          <div class="extra-commands-warning hidden" id="extra-commands-warning">
+            Warning: extra_commands run as root during container initialization.
+          </div>
+          <div id="local-config-msg" class="config-msg"></div>
+        </div>
+      </section>
+
+      <section id="welcome-panel" class="panel">
+        <div class="welcome">
+          <h2>ClaudeBox Dashboard</h2>
+          <p>Select a container from the sidebar to view its details and configuration.</p>
+        </div>
+      </section>
+    </main>
+  </div>
+
+  <script src="/app.js"></script>
+</body>
+</html>

```

**Documentation:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -1,3 +1,4 @@
+<!-- ClaudeBox Dashboard SPA — single HTML file, no build step required. (ref: DL-003) -->
 <!DOCTYPE html>
 <html lang="en">
 <head>
@@ -13,6 +14,7 @@
   <div class="layout">
     <aside class="sidebar">
       <div class="sidebar-header">
+        <!-- Sidebar populated by JS (not server-side) so the static HTML
             can be served without template rendering; list refreshes on page load. -->
         <h1>ClaudeBox</h1>
       </div>
       <nav id="container-list" class="container-list">
@@ -21,6 +23,7 @@
     </aside>

     <main class="main">
+      <!-- Detail, config, and welcome panels are mutually exclusive; shown via JS class toggling -->
       <section id="detail-panel" class="panel hidden">
         <h2 id="detail-name"></h2>
         <div class="detail-grid">
@@ -38,6 +41,7 @@
       </section>

       <section id="config-panel" class="panel hidden">
+        <!-- Config panel: merged (read-only), global (editable), local (editable) tabs -->
         <div class="config-tabs">
           <button class="tab-btn active" data-tab="merged">Merged Config</button>
           <button class="tab-btn" data-tab="global">Global Config</button>
@@ -65,6 +69,7 @@
           <div id="tab-local" class="tab-content hidden">
             <div class="config-editor-toolbar">
               <button id="local-edit-btn">Edit</button>
+              <!-- Warning shown when edited local config contains extra_commands (run as root) -->
               <button id="local-save-btn" class="hidden">Save</button>
               <button id="local-cancel-btn" class="hidden">Cancel</button>
             </div>

```


**CC-M-002-002** (gui/static/app.js) - implements CI-M-002-002

**Code:**

```diff
--- /dev/null
+++ b/gui/static/app.js
@@ -0,0 +1,262 @@
+(function () {
+  "use strict";
+
+  let selectedContainer = null;
+
+  // --- DOM refs ---
+  const containerList = document.getElementById("container-list");
+  const detailPanel   = document.getElementById("detail-panel");
+  const configPanel   = document.getElementById("config-panel");
+  const welcomePanel  = document.getElementById("welcome-panel");
+  const detailName    = document.getElementById("detail-name");
+  const detailStatus  = document.getElementById("detail-status");
+  const detailLanguage = document.getElementById("detail-language");
+  const detailProject = document.getElementById("detail-project");
+  const detailCreated = document.getElementById("detail-created");
+  const cmdOutput     = document.getElementById("cmd-output");
+
+  // Config panel refs
+  const mergedView       = document.getElementById("merged-config-view");
+  const globalView       = document.getElementById("global-config-view");
+  const globalEditor     = document.getElementById("global-config-editor");
+  const globalMsg        = document.getElementById("global-config-msg");
+  const localView        = document.getElementById("local-config-view");
+  const localEditor      = document.getElementById("local-config-editor");
+  const localMsg         = document.getElementById("local-config-msg");
+  const extraCmdWarning  = document.getElementById("extra-commands-warning");
+
+  // --- Utilities ---
+  function statusClass(raw) {
+    if (!raw) return "unknown";
+    const r = raw.toLowerCase();
+    if (r.startsWith("up")) return "running";
+    if (r.startsWith("exited")) return "exited";
+    if (r.startsWith("paused")) return "paused";
+    if (r === "removed") return "removed";
+    return "unknown";
+  }
+
+  function showPanel(name) {
+    detailPanel.classList.add("hidden");
+    configPanel.classList.add("hidden");
+    welcomePanel.classList.add("hidden");
+    if (name === "detail") detailPanel.classList.remove("hidden");
+    else if (name === "config") configPanel.classList.remove("hidden");
+    else welcomePanel.classList.remove("hidden");
+  }
+
+  function setMsg(el, text, isError) {
+    el.textContent = text;
+    el.className = "config-msg " + (isError ? "error" : "success");
+  }
+
+  // --- Container list ---
+  async function loadContainers() {
+    try {
+      const resp = await fetch("/api/containers");
+      const containers = await resp.json();
+      renderContainerList(containers);
+    } catch (e) {
+      containerList.innerHTML = '<div class="loading">Failed to load containers.</div>';
+    }
+  }
+
+  function renderContainerList(containers) {
+    if (!containers.length) {
+      containerList.innerHTML = '<div class="loading">No containers found.</div>';
+      return;
+    }
+    containerList.innerHTML = "";
+    containers.forEach(function (c) {
+      const cls = statusClass(c.status);
+      const item = document.createElement("div");
+      item.className = "container-item";
+      item.dataset.name = c.name;
+      item.innerHTML =
+        '<span class="name">' + escHtml(c.name) + "</span>" +
+        '<span class="badge ' + cls + '">' + escHtml(cls) + "</span>";
+      item.addEventListener("click", function () { selectContainer(c); });
+      containerList.appendChild(item);
+    });
+  }
+
+  function escHtml(str) {
+    return String(str)
+      .replace(/&/g, "&amp;")
+      .replace(/</g, "&lt;")
+      .replace(/>/g, "&gt;")
+      .replace(/"/g, "&quot;");
+  }
+
+  // --- Container selection ---
+  function selectContainer(c) {
+    selectedContainer = c;
+
+    document.querySelectorAll(".container-item").forEach(function (el) {
+      el.classList.toggle("active", el.dataset.name === c.name);
+    });
+
+    detailName.textContent = c.name;
+    const cls = statusClass(c.status);
+    detailStatus.textContent = cls;
+    detailStatus.className = "badge " + cls;
+    detailLanguage.textContent = c.language || "—";
+    detailProject.textContent = c.project_path || "—";
+    detailCreated.textContent = c.created_at ? new Date(c.created_at).toLocaleString() : "—";
+
+    cmdOutput.textContent = "";
+    cmdOutput.classList.add("hidden");
+
+    showPanel("detail");
+    loadConfigForContainer(c);
+  }
+
+  // --- Config loading ---
+  async function loadConfigForContainer(c) {
+    if (!c.project_path) {
+      mergedView.textContent = "(no project path — config unavailable)";
+      globalView.textContent = "";
+      localView.textContent = "";
+      return;
+    }
+
+    const qs = "?project_dir=" + encodeURIComponent(c.project_path);
+
+    const [mergedResp, globalResp, localResp] = await Promise.all([
+      fetch("/api/config/merged" + qs).then(function (r) { return r.json(); }),
+      fetch("/api/config/global").then(function (r) { return r.json(); }),
+      fetch("/api/config/local" + qs).then(function (r) { return r.json(); }),
+    ]);
+
+    mergedView.textContent = JSON.stringify(mergedResp, null, 2);
+    globalView.textContent = JSON.stringify(globalResp, null, 2);
+    localView.textContent  = JSON.stringify(localResp, null, 2);

+    globalEditor.value = JSON.stringify(globalResp, null, 2);
+    localEditor.value  = JSON.stringify(localResp, null, 2);
+  }
+
+  // --- Tab switching ---
+  document.querySelectorAll(".tab-btn").forEach(function (btn) {
+    btn.addEventListener("click", function () {
+      const tab = btn.dataset.tab;
+      document.querySelectorAll(".tab-btn").forEach(function (b) {
+        b.classList.toggle("active", b.dataset.tab === tab);
+      });
+      document.querySelectorAll(".tab-content").forEach(function (el) {
+        el.classList.toggle("active", el.id === "tab-" + tab);
+        el.classList.toggle("hidden", el.id !== "tab-" + tab);
+      });
+    });
+  });
+
+  // --- Config editing: global ---
+  document.getElementById("global-edit-btn").addEventListener("click", function () {
+    globalView.classList.add("hidden");
+    globalEditor.classList.remove("hidden");
+    document.getElementById("global-edit-btn").classList.add("hidden");
+    document.getElementById("global-save-btn").classList.remove("hidden");
+    document.getElementById("global-cancel-btn").classList.remove("hidden");
+  });
+
+  document.getElementById("global-cancel-btn").addEventListener("click", function () {
+    globalEditor.classList.add("hidden");
+    globalView.classList.remove("hidden");
+    document.getElementById("global-edit-btn").classList.remove("hidden");
+    document.getElementById("global-save-btn").classList.add("hidden");
+    document.getElementById("global-cancel-btn").classList.add("hidden");
+    setMsg(globalMsg, "", false);
+  });
+
+  document.getElementById("global-save-btn").addEventListener("click", async function () {
+    let data;
+    try { data = JSON.parse(globalEditor.value); } catch (e) {
+      setMsg(globalMsg, "Invalid JSON: " + e.message, true); return;
+    }
+    const resp = await fetch("/api/config/global", {
+      method: "POST",
+      headers: { "Content-Type": "application/json" },
+      body: JSON.stringify(data),
+    });
+    const result = await resp.json();
+    if (result.error) { setMsg(globalMsg, result.error, true); return; }
+    setMsg(globalMsg, "Saved.", false);
+    globalView.textContent = globalEditor.value;
+    document.getElementById("global-cancel-btn").click();
+  });
+
+  // --- Config editing: local ---
+  document.getElementById("local-edit-btn").addEventListener("click", function () {
+    localView.classList.add("hidden");
+    localEditor.classList.remove("hidden");
+    document.getElementById("local-edit-btn").classList.add("hidden");
+    document.getElementById("local-save-btn").classList.remove("hidden");
+    document.getElementById("local-cancel-btn").classList.remove("hidden");
+    checkExtraCommandsWarning();
+  });
+
+  document.getElementById("local-cancel-btn").addEventListener("click", function () {
+    localEditor.classList.add("hidden");
+    localView.classList.remove("hidden");
+    document.getElementById("local-edit-btn").classList.remove("hidden");
+    document.getElementById("local-save-btn").classList.add("hidden");
+    document.getElementById("local-cancel-btn").classList.add("hidden");
+    extraCmdWarning.classList.add("hidden");
+    setMsg(localMsg, "", false);
+  });
+
+  function checkExtraCommandsWarning() {
+    try {
+      const parsed = JSON.parse(localEditor.value);
+      const hasExtra = Array.isArray(parsed.extra_commands) && parsed.extra_commands.length > 0;
+      extraCmdWarning.classList.toggle("hidden", !hasExtra);
+    } catch (e) {
+      extraCmdWarning.classList.add("hidden");
+    }
+  }
+  localEditor.addEventListener("input", checkExtraCommandsWarning);
+
+  document.getElementById("local-save-btn").addEventListener("click", async function () {
+    if (!selectedContainer || !selectedContainer.project_path) {
+      setMsg(localMsg, "No project path for this container.", true); return;
+    }
+    let data;
+    try { data = JSON.parse(localEditor.value); } catch (e) {
+      setMsg(localMsg, "Invalid JSON: " + e.message, true); return;
+    }
+    const resp = await fetch("/api/config/local", {
+      method: "POST",
+      headers: { "Content-Type": "application/json" },
+      body: JSON.stringify({ project_dir: selectedContainer.project_path, config: data }),
+    });
+    const result = await resp.json();
+    if (result.error) { setMsg(localMsg, result.error, true); return; }
+    setMsg(localMsg, "Saved.", false);
+    localView.textContent = localEditor.value;
+    document.getElementById("local-cancel-btn").click();
+  });
+
+  // --- Command buttons ---
+  document.querySelectorAll(".cmd-btn").forEach(function (btn) {
+    btn.addEventListener("click", function () {
+      if (!selectedContainer) return;
+      const cmd = btn.dataset.cmd;
+      runCommand(cmd);
+    });
+  });
+
+  function runCommand(cmd) {
+    cmdOutput.textContent = "";
+    cmdOutput.classList.remove("hidden");
+
+    const args = encodeURIComponent(cmd);
+    const es = new EventSource("/api/command/stream?args=" + args);
+
+    es.onmessage = function (evt) {
+      const msg = JSON.parse(evt.data);
+      if (msg.done) { es.close(); return; }
+      if (msg.error) { cmdOutput.textContent += "[error] " + msg.error + "\n"; es.close(); return; }
+      if (msg.line !== undefined) { cmdOutput.textContent += msg.line + "\n"; }
+      cmdOutput.scrollTop = cmdOutput.scrollHeight;
+    };
+
+    es.onerror = function () {
+      cmdOutput.textContent += "[connection closed]\n";
+      es.close();
+    };
+  }
+
+  // --- Init ---
+  loadContainers();
+
+}());

```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -1,3 +1,9 @@
+/**
+ * ClaudeBox Dashboard — single-page application. (ref: DL-003)
+ * No framework; plain ES5-compatible JS so no transpile or build step is needed.
+ * Communicates with the Python server via fetch (REST) and EventSource (SSE for
+ * command streaming). (ref: DL-004)
+ */
 (function () {
   "use strict";

@@ -33,6 +39,7 @@
   // --- Utilities ---
+  /** Map raw Docker status string to CSS class name.
   * Abstracted so badge styles and status string parsing are co-located;
   * Docker status strings vary (e.g. "Up 2 hours") and prefix matching keeps
   * this mapping stable across Docker versions. */
   function statusClass(raw) {
     if (!raw) return "unknown";
     const r = raw.toLowerCase();
@@ -43,12 +50,14 @@
     return "unknown";
   }

+  /** Show one of "detail", "config", or "welcome" panels; hide the other two.
   * Mutual exclusion is enforced here (not in callers) so adding a new panel
   * only requires updating this function rather than every call site. */
   function showPanel(name) {
     detailPanel.classList.add("hidden");
     configPanel.classList.add("hidden");
     welcomePanel.classList.add("hidden");
     if (name === "detail") detailPanel.classList.remove("hidden");
     else if (name === "config") configPanel.classList.remove("hidden");
     else welcomePanel.classList.remove("hidden");
   }

+  /** Set text and error/success class on a status message element. */
   function setMsg(el, text, isError) {
     el.textContent = text;
     el.className = "config-msg " + (isError ? "error" : "success");
@@ -56,12 +65,14 @@

   // --- Container list ---
+  /** Fetch /api/containers and re-render the sidebar list. */
   async function loadContainers() {
     try {
       const resp = await fetch("/api/containers");
       const containers = await resp.json();
       renderContainerList(containers);
     } catch (e) {
       containerList.innerHTML = '<div class="loading">Failed to load containers.</div>';
     }
   }

+  /** Build sidebar items from containers array; attach click handler per item. */
   function renderContainerList(containers) {
     if (!containers.length) {
       containerList.innerHTML = '<div class="loading">No containers found.</div>';
@@ -79,6 +90,7 @@
     });
   }

+  /** Escape HTML special characters for safe innerHTML insertion. */
   function escHtml(str) {
     return String(str)
       .replace(/&/g, "&amp;")

```


**CC-M-002-003** (gui/static/style.css) - implements CI-M-002-003

**Code:**

```diff
--- /dev/null
+++ b/gui/static/style.css
@@ -0,0 +1,185 @@
+*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
+
+body {
+  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
+  font-size: 14px;
+  color: #e0e0e0;
+  background: #1a1a1a;
+  height: 100vh;
+  overflow: hidden;
+}
+
+.layout {
+  display: flex;
+  height: 100vh;
+}
+
+.sidebar {
+  width: 250px;
+  flex-shrink: 0;
+  background: #111;
+  border-right: 1px solid #333;
+  display: flex;
+  flex-direction: column;
+  overflow: hidden;
+}
+
+.sidebar-header {
+  padding: 16px;
+  border-bottom: 1px solid #333;
+}
+
+.sidebar-header h1 {
+  font-size: 16px;
+  font-weight: 600;
+  color: #fff;
+}
+
+.container-list {
+  flex: 1;
+  overflow-y: auto;
+  padding: 8px 0;
+}
+
+.container-item {
+  padding: 10px 16px;
+  cursor: pointer;
+  display: flex;
+  align-items: center;
+  gap: 8px;
+  border-left: 3px solid transparent;
+  transition: background 0.15s;
+}
+
+.container-item:hover { background: #1e1e1e; }
+.container-item.active { background: #1e1e1e; border-left-color: #4a9eff; }
+
+.container-item .name {
+  font-size: 13px;
+  white-space: nowrap;
+  overflow: hidden;
+  text-overflow: ellipsis;
+  flex: 1;
+}
+
+.badge {
+  font-size: 11px;
+  padding: 2px 6px;
+  border-radius: 3px;
+  font-weight: 500;
+  white-space: nowrap;
+}
+
+.badge.running { background: #1a4a1a; color: #4caf50; }
+.badge.exited  { background: #2a2a2a; color: #888; }
+.badge.paused  { background: #3a3000; color: #ffc107; }
+.badge.removed { background: #3a1010; color: #f44336; }
+.badge.unknown { background: #2a2a2a; color: #888; }
+
+.main {
+  flex: 1;
+  overflow-y: auto;
+  padding: 24px;
+  background: #1a1a1a;
+}
+
+.panel { display: block; }
+.panel.hidden { display: none; }
+
+.detail-grid { margin: 16px 0; }
+.detail-row {
+  display: flex;
+  gap: 16px;
+  padding: 6px 0;
+  border-bottom: 1px solid #2a2a2a;
+  align-items: center;
+}
+.detail-row .label { color: #888; width: 80px; flex-shrink: 0; }
+
+.command-panel { margin-top: 24px; }
+.command-panel h3 { margin-bottom: 12px; font-size: 14px; color: #aaa; }
+
+.command-buttons {
+  display: flex;
+  gap: 8px;
+  flex-wrap: wrap;
+  margin-bottom: 12px;
+}
+
+button {
+  padding: 6px 14px;
+  border: 1px solid #444;
+  background: #2a2a2a;
+  color: #e0e0e0;
+  border-radius: 4px;
+  cursor: pointer;
+  font-size: 13px;
+  transition: background 0.15s;
+}
+button:hover { background: #333; }
+button:disabled { opacity: 0.5; cursor: not-allowed; }
+
+.terminal {
+  background: #0d0d0d;
+  border: 1px solid #333;
+  border-radius: 4px;
+  padding: 12px;
+  font-family: "Fira Code", "Cascadia Code", monospace;
+  font-size: 12px;
+  color: #c8e6c9;
+  max-height: 320px;
+  overflow-y: auto;
+  white-space: pre-wrap;
+  word-break: break-all;
+}
+
+.config-tabs {
+  display: flex;
+  gap: 4px;
+  border-bottom: 1px solid #333;
+  margin-bottom: 16px;
+}
+
+.tab-btn {
+  background: none;
+  border: none;
+  border-bottom: 2px solid transparent;
+  padding: 8px 14px;
+  color: #888;
+  cursor: pointer;
+  font-size: 13px;
+  border-radius: 0;
+}
+.tab-btn.active { color: #4a9eff; border-bottom-color: #4a9eff; }
+
+.tab-content { display: none; }
+.tab-content.active { display: block; }
+
+.config-view {
+  background: #111;
+  border: 1px solid #2a2a2a;
+  border-radius: 4px;
+  padding: 12px;
+  font-family: monospace;
+  font-size: 12px;
+  overflow: auto;
+  max-height: 420px;
+  white-space: pre;
+  color: #c8e6c9;
+}
+
+.config-editor-toolbar { display: flex; gap: 8px; margin-bottom: 8px; }
+
+.config-editor {
+  width: 100%;
+  min-height: 200px;
+  background: #111;
+  border: 1px solid #444;
+  border-radius: 4px;
+  padding: 12px;
+  font-family: monospace;
+  font-size: 12px;
+  color: #e0e0e0;
+  resize: vertical;
+}
+
+.config-msg { margin-top: 8px; font-size: 12px; min-height: 18px; }
+.config-msg.error { color: #f44336; }
+.config-msg.success { color: #4caf50; }
+
+.extra-commands-warning {
+  background: #3a2000;
+  border: 1px solid #664400;
+  border-radius: 4px;
+  padding: 8px 12px;
+  color: #ffc107;
+  font-size: 12px;
+  margin: 8px 0;
+}
+
+.loading { padding: 16px; color: #666; font-size: 13px; }
+
+.welcome { padding: 40px 0; }
+.welcome h2 { font-size: 22px; margin-bottom: 12px; color: #fff; }
+.welcome p { color: #888; line-height: 1.6; }
+
+h2 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
+
+.hidden { display: none !important; }

```

**Documentation:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -1,3 +1,4 @@
+/* ClaudeBox Dashboard styles — no preprocessor, plain CSS. (ref: DL-003) */
 /* --- Reset & base --- */

```


### Milestone 3: CLI integration and installer update

**Files**: claudebox.sh, install.sh

**Acceptance Criteria**:

- claudebox gui launches the Python server and opens browser
- claudebox gui --port 9999 passes port to server
- claudebox help lists gui subcommand with description
- claudebox init writes entry to ~/.claudebox/registry.json with container name and project path
- claudebox destroy removes entry from ~/.claudebox/registry.json
- install.sh copies gui/ directory to CLAUDEBOX_HOME
- Existing CLI commands still work unchanged after install

#### Code Intent

- **CI-M-003-001** `claudebox.sh`: Add gui subcommand to dispatch table at bottom. cmd_gui() function validates python3 is available, locates gui/ directory relative to CLAUDEBOX_HOME, and execs python3 -m gui with forwarded args (--port). Add gui entry to cmd_help(). In cmd_init(), after successful container creation, call a registry_add helper that appends {name, project_dir, created_at} to ~/.claudebox/registry.json. In cmd_destroy(), after successful container removal, call a registry_remove helper that deletes the entry by container name. Registry helpers use python3 one-liners for atomic JSON read-modify-write (avoiding fragile jq piping). (refs: DL-001, DL-006)
- **CI-M-003-002** `install.sh`: Add cp -r of gui/ directory into CLAUDEBOX_HOME alongside existing lib/, languages/, .devcontainer/ copies. (refs: DL-001)

#### Code Changes

**CC-M-003-001** (claudebox.sh) - implements CI-M-003-001

**Code:**

```diff
--- a/claudebox.sh
+++ b/claudebox.sh
@@ -70,6 +70,43 @@ cb_language_mounts() {
 
 # --- Utility functions ---
 
+# --- Registry helpers ---
+
+registry_add() {
+    local name="$1"
+    local project_dir="$2"
+    local language="${3:-}"
+    local registry_file="${HOME}/.claudebox/registry.json"
+    python3 - "$name" "$project_dir" "$language" "$registry_file" << 'PYEOF'
+import json, os, sys, tempfile
+from datetime import datetime, timezone
+name, project_dir, language, path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
+os.makedirs(os.path.dirname(path), exist_ok=True)
+try:
+    with open(path) as fh:
+        reg = json.load(fh)
+except (FileNotFoundError, json.JSONDecodeError):
+    reg = {}
+containers = reg.get("containers", {})
+containers[name] = {"project_dir": project_dir, "language": language, "created_at": datetime.now(timezone.utc).isoformat()}
+reg["containers"] = containers
+fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
+with os.fdopen(fd, "w") as fh:
+    json.dump(reg, fh, indent=2)
+os.replace(tmp, path)
+PYEOF
+}
+
+registry_remove() {
+    local name="$1"
+    local registry_file="${HOME}/.claudebox/registry.json"
+    [[ ! -f "$registry_file" ]] && return 0
+    python3 - "$name" "$registry_file" << 'PYEOF'
+import json, os, sys, tempfile
+name, path = sys.argv[1], sys.argv[2]
+try:
+    with open(path) as fh:
+        reg = json.load(fh)
+except (FileNotFoundError, json.JSONDecodeError):
+    sys.exit(0)
+containers = reg.get("containers", {})
+containers.pop(name, None)
+reg["containers"] = containers
+fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
+with os.fdopen(fd, "w") as fh:
+    json.dump(reg, fh, indent=2)
+os.replace(tmp, path)
+PYEOF
+}
+
 get_container_hash() {
@@ -314,6 +351,8 @@ cmd_init() {
     # Copy claude config subfolders into container
     cb_copy_claude_config "$container_name"
 
+    registry_add "$container_name" "$cwd" "$language"
+
     # Attach shell as node user (unless --no-start was passed)
     if $no_start; then
         echo "Container '${container_name}' is ready. Run 'claudebox' to attach."
@@ -374,7 +413,7 @@ cmd_destroy() {
     if [[ -z "$container_name" ]]; then
         container_name=$(get_container_name "$cwd")
     fi
-    docker rm -f "$container_name"
+    docker rm -f "$container_name" && registry_remove "$container_name"
 }
 
@@ -1048,6 +1087,20 @@ cmd_use_profile() {
 
 # --- Subcommand: help ---
 
+# --- Subcommand: gui ---
+
+cmd_gui() {
+    if ! command -v python3 > /dev/null 2>&1; then
+        echo "Error: python3 is required to run the ClaudeBox GUI." >&2
+        exit 1
+    fi
+    local gui_dir="${CLAUDEBOX_HOME}/gui"
+    if [[ ! -d "$gui_dir" ]]; then
+        echo "Error: GUI directory not found at ${gui_dir}" >&2
+        exit 1
+    fi
+    cd "${CLAUDEBOX_HOME}"
+    exec python3 -m gui "$@"
+}
+
 cmd_help() {
@@ -1055,6 +1098,7 @@ cmd_help() {
     cat <<'HELP'
 ClaudeBox - Run Claude Code in a sandboxed Docker container
 
 USAGE:
     claudebox init [--rebuild] [--no-start]
@@ -1082,6 +1126,7 @@ USAGE:
     claudebox module export <name>     Print a module's JSON to stdout
     claudebox module import [file]     Import a module JSON (stdin if no file given)
     claudebox use-profile <name>       Switch active env profile in the running container
+    claudebox gui [--port <port>]      Launch the web dashboard (default port: 19280)
     claudebox help                     Show this help message
 
 SUPPORTED LANGUAGES:
@@ -1108,6 +1153,7 @@ case "$subcommand" in
     help)    cmd_help ;;
     config)  cmd_config ;;
     upgrade) cmd_upgrade "$@" ;;
+    gui)     cmd_gui "$@" ;;
     dotnet)  cmd_dotnet "$@" ;;
     uninstall) cmd_uninstall ;;
     module)  cmd_module "$@" ;;
```

**Documentation:**

```diff
--- a/claudebox.sh
+++ b/claudebox.sh
@@ -70,6 +70,12 @@ cb_language_mounts() {

 # --- Utility functions ---

+# --- Registry helpers ---
+# registry_add and registry_remove maintain ~/.claudebox/registry.json so the
+# GUI dashboard can list containers without a full docker ps scan on every page
+# load. The file is written atomically via Python's tempfile+os.replace to
+# avoid partial writes. (ref: DL-002)
+
 registry_add() {
+    # Write or update a container entry in registry.json with project path,
+    # language, and UTC creation timestamp.
     local name="$1"
     local project_dir="$2"
     local language="${3:-}"
@@ -108,6 +114,8 @@ registry_add() {

 registry_remove() {
+    # Remove container entry from registry.json. Exits cleanly if file absent
+    # or entry not found.
     local name="$1"
     local registry_file="${HOME}/.claudebox/registry.json"
     [[ ! -f "$registry_file" ]] && return 0
@@ -1090,6 +1096,12 @@ cmd_use_profile() {
 # --- Subcommand: gui ---

 cmd_gui() {
+    # Start the GUI dashboard web server using the bundled Python package at
+    # $CLAUDEBOX_HOME/gui. Requires python3 (always available on supported
+    # hosts). Delegates all arguments to __main__.py, which accepts --port.
+    # Serves on localhost:19280 by default; exits with error if port is in use
+    # rather than auto-incrementing. (ref: DL-001, DL-006)
     if ! command -v python3 > /dev/null 2>&1; then
         echo "Error: python3 is required to run the ClaudeBox GUI." >&2
         exit 1

```


**CC-M-003-002** (install.sh) - implements CI-M-003-002

**Code:**

```diff
--- a/install.sh
+++ b/install.sh
@@ -91,6 +91,7 @@ cp -r "${SCRIPT_DIR}/lib" "${CLAUDEBOX_HOME}/"
 cp -r "${SCRIPT_DIR}/languages" "${CLAUDEBOX_HOME}/"
 cp -r "${SCRIPT_DIR}/.devcontainer" "${CLAUDEBOX_HOME}/"
 [[ -d "${SCRIPT_DIR}/modules" ]] && cp -r "${SCRIPT_DIR}/modules" "${CLAUDEBOX_HOME}/"
+[[ -d "${SCRIPT_DIR}/gui" ]] && cp -r "${SCRIPT_DIR}/gui" "${CLAUDEBOX_HOME}/"

```

**Documentation:**

```diff
--- a/install.sh
+++ b/install.sh
@@ -91,6 +91,7 @@ cp -r "${SCRIPT_DIR}/lib" "${CLAUDEBOX_HOME}/"
 cp -r "${SCRIPT_DIR}/languages" "${CLAUDEBOX_HOME}/"
 cp -r "${SCRIPT_DIR}/.devcontainer" "${CLAUDEBOX_HOME}/"
 [[ -d "${SCRIPT_DIR}/modules" ]] && cp -r "${SCRIPT_DIR}/modules" "${CLAUDEBOX_HOME}/"
+# Copy GUI package if present; absent on minimal installs without the gui/ directory.
 [[ -d "${SCRIPT_DIR}/gui" ]] && cp -r "${SCRIPT_DIR}/gui" "${CLAUDEBOX_HOME}/"

```


**CC-M-003-003** (README.md)

**Documentation:**

```diff
--- a/README.md
+++ b/README.md
@@ -62,6 +62,7 @@ claudebox dotnet seed-nuget-cache [--source <path>]  # Seed offline NuGet cache
 claudebox upgrade                      # Upgrade ClaudeBox to latest from git
 claudebox dotnet seed-nuget-cache [--source <path>]  # Seed offline NuGet cache from host
+claudebox gui [--port <port>]          # Launch web dashboard (default port: 19280)
 ```

@@ -167,6 +168,36 @@ claudebox/
 ├── .devcontainer/          # Dockerfile, firewall init, language installer
 └── scc/                    # Claude Code config (copied into containers)
 ```
+
+---
+
+## GUI Dashboard
+
+`claudebox gui` starts a local web server and opens the dashboard in your browser.
+The server runs on `localhost:19280` by default. Use `--port` to override.
+
+```bash
+claudebox gui              # Start dashboard on localhost:19280
+claudebox gui --port 8080  # Start on a different port
+```
+
+The dashboard provides:
+
+- **Container list** — all ClaudeBox containers with live Docker status
+- **Merged config view** — global and local configs merged per the same rules as `claudebox init`
+- **Config editor** — edit global (`~/.claudebox/config.json`) or local (`.claudebox.json`) configs with validation
+- **Command runner** — run `stop`, `destroy`, `refresh`, and other commands with live output streaming
+
+### Registry
+
+`claudebox init` and `claudebox destroy` maintain `~/.claudebox/registry.json`.
+The GUI reads this file for fast startup, then cross-checks against `docker ps`
+to detect containers removed with `docker rm` outside of ClaudeBox. Stale
+entries are flagged in the sidebar and offer a cleanup action.
+
+### Requirements
+
+- `python3` on the host (available on all supported platforms)
+- No additional pip packages — uses Python stdlib only
+
+Press `Ctrl+C` in the terminal where `claudebox gui` is running to stop the server.

```

