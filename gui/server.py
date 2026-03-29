"""
HTTP request handler for the ClaudeBox GUI server.

Extends SimpleHTTPRequestHandler to serve the static SPA from gui/static/ and
route /api/* paths to the api module. SSE streaming uses chunked
Transfer-Encoding so output lines flow to the browser as the subprocess emits
them. (ref: DL-001, DL-003, DL-004)
"""
import json
import os
import shlex
import signal
import subprocess
import threading
import urllib.parse
from http.server import SimpleHTTPRequestHandler

from . import api

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


class ClaudeBoxHandler(SimpleHTTPRequestHandler):
    """
    Routes GET /api/* and POST /api/* to handler methods; all other GET
    requests are served as static files from _STATIC_DIR. Request logging is
    suppressed (log_message is a no-op) to avoid noise on stdout while the
    server runs in the foreground.
    """
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=_STATIC_DIR, **kwargs)

    def log_message(self, fmt, *args):
        pass

    # --- GET routing ---
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/":
            self.path = "/index.html"
            return super().do_GET()

        if path.startswith("/api/"):
            return self._handle_api_get(path, parsed.query)

        return super().do_GET()

    # --- POST routing ---
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""

        if path.startswith("/api/"):
            return self._handle_api_post(path, body)

        self._send_json({"error": "not found"}, status=404)

    # --- PATCH routing ---
    def do_PATCH(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""

        if path.startswith("/api/"):
            return self._handle_api_patch(path, body)

        self._send_json({"error": "not found"}, status=404)

    # --- DELETE routing ---
    # Mirrors do_POST: reads optional JSON body, delegates to _handle_api_delete.
    # Body is optional so callers can pass filter params in the JSON body instead
    # of query string, avoiding URL-encoding issues with names. (ref: plan:DL-006)
    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""

        if path.startswith("/api/"):
            return self._handle_api_delete(path, parsed.query, body)

        self._send_json({"error": "not found"}, status=404)

    def _handle_api_get(self, path, query):
        if path == "/api/containers":
            data = api.list_containers()
            return self._send_json(data)

        if path == "/api/config/merged":
            params = urllib.parse.parse_qs(query)
            project_dir = params.get("project_dir", [""])[0]
            if not project_dir:
                return self._send_json({"error": "project_dir required"}, status=400)
            result = api.get_merged_config(project_dir)
            if "error" in result:
                return self._send_json(result, status=500)
            return self._send_json(result)

        if path == "/api/config/global":
            return self._send_json(api.get_global_config())

        if path.startswith("/api/config/local"):
            params = urllib.parse.parse_qs(query)
            project_dir = params.get("project_dir", [""])[0]
            if not project_dir:
                return self._send_json({"error": "project_dir required"}, status=400)
            return self._send_json(api.get_local_config(project_dir))

        # Debug: returns raw docker inspect mounts for a container
        if path.startswith("/api/debug/inspect/"):
            name = path[len("/api/debug/inspect/"):]
            import subprocess as _sp
            r = _sp.run(["docker", "inspect", name, "--format", "{{json .Mounts}}"],
                        capture_output=True, text=True, timeout=10)
            return self._send_json({"stdout": r.stdout, "stderr": r.stderr, "rc": r.returncode})

        # GET /api/git-clone/stream?url=<url>&dest_dir=<dest_dir>[&username=<u>&token=<t>]
        if path == "/api/git-clone/stream":
            params = urllib.parse.parse_qs(query)
            url = params.get("url", [""])[0]
            dest_dir = params.get("dest_dir", [""])[0]
            username = params.get("username", [""])[0] or None
            token = params.get("token", [""])[0] or None
            if not url or not dest_dir:
                return self._send_json({"error": "url and dest_dir required"}, status=400)
            proc = api.start_git_clone_stream(url, dest_dir, username=username, token=token)
            if proc is None:
                return self._send_json({"error": "git not found on host"}, status=500)
            return self._stream_proc(proc)

        if path == "/api/command/stream":
            params = urllib.parse.parse_qs(query)
            args_raw = params.get("args", [""])[0]
            project_dir = params.get("project_dir", [""])[0]
            try:
                cmd_args = shlex.split(args_raw) if args_raw else []
            except ValueError:
                return self._send_json({"error": "invalid args"}, status=400)
            return self._handle_sse_stream(cmd_args, project_dir or None)

        # GET /api/modules?project_dir=<path>
        # Returns list from all three scopes; project_dir may be omitted to skip
        # the project scope. (ref: plan:DL-002)
        if path == "/api/modules":
            params = urllib.parse.parse_qs(query)
            project_dir = params.get("project_dir", [""])[0]
            result = api.list_modules(project_dir or None)
            return self._send_json(result)

        # GET /api/config/verify?project_dir=<path>
        # Calls verify_config(); 500 when the merge itself fails (e.g. bash not
        # found), 200 with issues list otherwise. (ref: plan:DL-004)
        if path == "/api/config/verify":
            params = urllib.parse.parse_qs(query)
            project_dir = params.get("project_dir", [""])[0]
            if not project_dir:
                return self._send_json({"error": "project_dir required"}, status=400)
            result = api.verify_config(project_dir)
            if "error" in result:
                return self._send_json(result, status=500)
            return self._send_json(result)

        # GET /api/containers/<name>/files?path=<path>
        # Returns directory listing from inside the container via docker exec ls.
        if path.startswith("/api/containers/") and "/files" in path:
            parts = path.split("/")
            if len(parts) >= 4 and parts[-1] == "files":
                container_name = parts[3]
                params = urllib.parse.parse_qs(query)
                file_path = params.get("path", [""])[0]
                result = api.browse_container_files(container_name, file_path or None)
                if "error" in result:
                    return self._send_json(result, status=500)
                return self._send_json(result)

        # GET /api/containers/<name>/files/content?path=<path>
        # Returns text content of a file inside the container.
        if path.startswith("/api/containers/") and "/files/content" in path:
            parts = path.split("/")
            if len(parts) >= 5:
                container_name = parts[3]
                params = urllib.parse.parse_qs(query)
                file_path = params.get("path", [""])[0]
                if not file_path:
                    return self._send_json({"error": "path required"}, status=400)
                result = api.get_file_content(container_name, file_path)
                if "error" in result:
                    return self._send_json(result, status=500)
                return self._send_json(result)

        # GET /api/terminal/options — available terminal emulators for the host platform
        if path == "/api/terminal/options":
            return self._send_json(api.get_terminal_options())

        # GET /api/containers/<name>/terminal/stream
        # Creates or reuses a PTY session and streams output via SSE.
        if path.startswith("/api/containers/") and path.endswith("/terminal/stream"):
            name = path[len("/api/containers/"):-len("/terminal/stream")]
            return self._handle_terminal_stream(name)

        # GET /api/local-terminal/stream — SSE output stream for the host shell
        if path == "/api/local-terminal/stream":
            return self._handle_local_terminal_stream()

        # GET /api/containers/<name>/inspect
        # Returns parsed docker inspect first element; 500 on docker errors.
        # (ref: plan:DL-003)
        if path.startswith("/api/containers/") and path.endswith("/inspect"):
            name = path[len("/api/containers/"):-len("/inspect")]
            result = api.inspect_container(name)
            if "error" in result:
                return self._send_json(result, status=500)
            return self._send_json(result)

        # GET /api/browse?path=<dir>
        # Returns subdirectories of the given path for the folder browser widget.
        # path defaults to home dir if omitted. Returns {current_path, parent_path, dirs}
        # or {error, current_path} on failure.
        if path == "/api/browse":
            params = urllib.parse.parse_qs(query)
            dir_path = params.get("path", [""])[0]
            result = api.browse_directory(dir_path or None)
            return self._send_json(result)

        self._send_json({"error": "not found"}, status=404)

    def _handle_api_post(self, path, body):
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            return self._send_json({"error": "invalid JSON"}, status=400)

        if path == "/api/config/global":
            result = api.save_global_config(data)
            status = 400 if "error" in result else 200
            return self._send_json(result, status=status)

        if path == "/api/config/local":
            project_dir = data.get("project_dir", "")
            config_data = data.get("config", {})
            if not project_dir:
                return self._send_json({"error": "project_dir required"}, status=400)
            result = api.save_local_config(project_dir, config_data)
            status = 400 if "error" in result else 200
            return self._send_json(result, status=status)

        if path == "/api/command":
            args = data.get("args", [])
            if not isinstance(args, list):
                return self._send_json({"error": "args must be a list"}, status=400)
            result = api.run_command(args)
            return self._send_json(result)

        # POST /api/containers/<name>/destroy -- docker rm -f without registry deregister
        if path.startswith("/api/containers/") and path.endswith("/destroy"):
            name = path[len("/api/containers/"):-len("/destroy")]
            result = api.destroy_container(name)
            status = 400 if "error" in result else 200
            return self._send_json(result, status=status)

        # POST /api/containers/<name>/start — start a stopped container via docker start
        if path.startswith("/api/containers/") and path.endswith("/start"):
            name = path[len("/api/containers/"):-len("/start")]
            result = api.start_container(name)
            status = 400 if "error" in result else 200
            return self._send_json(result, status=status)

        # POST /api/containers/<name>/terminal/resize -- resize PTY dimensions
        # Uses POST rather than a query param on the SSE connect URL so that
        # resize events can be sent independently at any time after connect. (ref: DL-001)
        if path.startswith("/api/containers/") and path.endswith("/terminal/resize"):
            name = path[len("/api/containers/"):-len("/terminal/resize")]
            cols = data.get("cols")
            rows = data.get("rows")
            if cols is None or rows is None:
                return self._send_json({"error": "cols and rows required"}, status=400)
            if not isinstance(cols, int) or not isinstance(rows, int):
                return self._send_json({"error": "cols and rows must be integers"}, status=400)
            if cols <= 0 or rows <= 0:
                return self._send_json({"error": "cols and rows must be positive"}, status=400)
            result = api.resize_terminal(name, cols, rows)
            if "error" in result:
                # "no session" is a race (tab closed before resize) -- 200 avoids spurious JS errors (ref: DL-003)
                status = 200 if result["error"] == "no session" else 500
                return self._send_json(result, status=status)
            return self._send_json(result, status=200)

        # POST /api/containers/<name>/terminal/input -- write keystroke data to PTY
        if path.startswith("/api/containers/") and path.endswith("/terminal/input"):
            name = path[len("/api/containers/"):-len("/terminal/input")]
            raw = data.get("data", "")
            if not isinstance(raw, str):
                return self._send_json({"error": "data must be a string"}, status=400)
            result = api.write_terminal(name, raw.encode("utf-8", errors="replace"))
            status = 400 if "error" in result else 200
            return self._send_json(result, status=status)

        # POST /api/local-terminal/resize -- resize PTY dimensions for local terminal
        # Mirrors /api/containers/<name>/terminal/resize for the singleton local session. (ref: DL-001)
        if path == "/api/local-terminal/resize":
            cols = data.get("cols")
            rows = data.get("rows")
            if cols is None or rows is None:
                return self._send_json({"error": "cols and rows required"}, status=400)
            if not isinstance(cols, int) or not isinstance(rows, int):
                return self._send_json({"error": "cols and rows must be integers"}, status=400)
            if cols <= 0 or rows <= 0:
                return self._send_json({"error": "cols and rows must be positive"}, status=400)
            result = api.resize_local_terminal(cols, rows)
            if "error" in result:
                # "no session" is a race (tab closed before resize) -- 200 avoids spurious JS errors (ref: DL-003)
                status = 200 if result["error"] == "no session" else 500
                return self._send_json(result, status=status)
            return self._send_json(result, status=200)

        # POST /api/local-terminal/input — write to local shell PTY
        if path == "/api/local-terminal/input":
            raw = data.get("data", "")
            if not isinstance(raw, str):
                return self._send_json({"error": "data must be a string"}, status=400)
            result = api.write_local_terminal(raw.encode("utf-8", errors="replace"))
            status = 400 if "error" in result else 200
            return self._send_json(result, status=status)

        # POST /api/containers/<name>/terminal — open host terminal with docker exec
        if path.startswith("/api/containers/") and path.endswith("/terminal"):
            name = path[len("/api/containers/"):-len("/terminal")]
            terminal_type = data.get("terminal", "auto")
            result = api.open_terminal(name, terminal_type)
            status = 400 if "error" in result else 200
            return self._send_json(result, status=status)

        # /api/containers/<name>/link  — manually set project_dir for a container
        if path.startswith("/api/containers/") and path.endswith("/link"):
            name = path[len("/api/containers/"):-len("/link")]
            project_dir = data.get("project_dir", "")
            result = api.link_container(name, project_dir)
            status = 400 if "error" in result else 200
            return self._send_json(result, status=status)

        # POST /api/containers/<name>/nickname — set display nickname
        if path.startswith("/api/containers/") and path.endswith("/nickname"):
            name = path[len("/api/containers/"):-len("/nickname")]
            nickname = data.get("nickname", "")
            result = api.set_container_nickname(name, nickname)
            status = 400 if "error" in result else 200
            return self._send_json(result, status=status)

        # POST /api/modules  — create or overwrite a module JSON file.
        # name and scope are required; project_dir required when scope="project".
        # data is the module JSON object; server does not validate its schema,
        # leaving that to api.save_module. (ref: plan:DL-002)
        if path == "/api/modules":
            name = data.get("name", "")
            scope = data.get("scope", "")
            project_dir = data.get("project_dir", "")
            module_data = data.get("data", {})
            if not name or not scope:
                return self._send_json({"error": "name and scope required"}, status=400)
            result = api.save_module(name, module_data, scope, project_dir or None)
            status = 400 if "error" in result else 200
            return self._send_json(result, status=status)

        # POST /api/mkdir  { "path": "..." }
        if path == "/api/mkdir":
            path_val = data.get("path", "")
            if not path_val:
                return self._send_json({"error": "path required"}, status=400)
            result = api.make_directory(path_val)
            return self._send_json(result, status=(400 if "error" in result else 200))

        self._send_json({"error": "not found"}, status=404)

    # Routes PATCH /api/containers/<name>/pin to api.patch_container_pin.
    def _handle_api_patch(self, path, body):
        try:
            data = json.loads(body) if body else {}
        except (json.JSONDecodeError, ValueError):
            return self._send_json({"error": "invalid JSON"}, status=400)

        # PATCH /api/containers/<name>/pin — set pinned field in registry
        if path.startswith("/api/containers/") and path.endswith("/pin"):
            name = path[len("/api/containers/"):-len("/pin")]
            if not name or "/" in name:
                return self._send_json({"error": "invalid container name"}, status=400)
            pinned = data.get("pinned")
            if pinned is None:
                return self._send_json({"error": "pinned field required"}, status=400)
            result = api.patch_container_pin(name, bool(pinned))
            status = 404 if result.get("error") == "not found" else (400 if "error" in result else 200)
            return self._send_json(result, status=status)

        self._send_json({"error": "not found"}, status=404)

    # Routes DELETE /api/modules to api.delete_module. Pattern matches _handle_api_post:
    # parse body JSON, dispatch by path, return 400 on validation errors. (ref: plan:DL-006)
    def _handle_api_delete(self, path, query, body):
        try:
            data = json.loads(body) if body else {}
        except (json.JSONDecodeError, ValueError):
            data = {}
        # Fall back to query string params when body is absent (JS DELETE sends params there)
        if not data:
            params = urllib.parse.parse_qs(query)
            data = {k: v[0] for k, v in params.items() if v}

        if path == "/api/modules":
            name = data.get("name", "")
            scope = data.get("scope", "")
            project_dir = data.get("project_dir", "")
            if not name or not scope:
                return self._send_json({"error": "name and scope required"}, status=400)
            result = api.delete_module(name, scope, project_dir or None)
            status = 400 if "error" in result else 200
            return self._send_json(result, status=status)

        # DELETE /api/containers/<name>/refs/<refname> — remove a ref directory
        if path.startswith("/api/containers/") and "/refs/" in path:
            parts = path.split("/")
            # Expect exactly: ['', 'api', 'containers', name, 'refs', refname]
            if len(parts) == 6 and parts[4] == "refs":
                result = api.remove_ref(parts[3], parts[5])
                status = 400 if "error" in result else 200
                return self._send_json(result, status=status)

        # DELETE /api/containers/<name>/terminal -- close the PTY session
        if path.startswith("/api/containers/") and path.endswith("/terminal"):
            name = path[len("/api/containers/"):-len("/terminal")]
            api.close_terminal(name)
            return self._send_json({"ok": True})

        # DELETE /api/local-terminal — close local shell session
        if path == "/api/local-terminal":
            api.close_local_terminal()
            return self._send_json({"ok": True})

        # DELETE /api/containers/<name> — remove from registry without docker rm
        # Restrict to bare container names only (no sub-paths) to prevent accidental
        # unregister when a new DELETE sub-path is added without placing it above this block.
        if path.startswith("/api/containers/"):
            tail = path[len("/api/containers/"):]
            name = tail if "/" not in tail else None
            if name:
                result = api.unregister_container(name)
                status = 400 if "error" in result else 200
                return self._send_json(result, status=status)

        self._send_json({"error": "not found"}, status=404)

    def _stream_proc(self, proc):
        """Send SSE headers and stream proc stdout lines, then send done event."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            for line in proc.stdout:
                msg = json.dumps({"line": line.rstrip("\n")})
                self.wfile.write(f"data: {msg}\n\n".encode())
                self.wfile.flush()
        except OSError:
            pass
        finally:
            proc.stdout.close()
            if os.name != "nt":
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except OSError:
                    pass
            else:
                proc.terminate()
            proc.wait()
        try:
            done_msg = json.dumps({"done": True, "rc": proc.returncode})
            self.wfile.write(f"data: {done_msg}\n\n".encode())
            self.wfile.flush()
        except OSError:
            pass

    def _handle_sse_stream(self, cmd_args, project_dir=None):
        proc = api.start_command_stream(cmd_args, project_dir=project_dir)
        if proc is None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            try:
                self.wfile.write(b'data: {"error": "claudebox not found"}\n\n')
                self.wfile.flush()
            except OSError:
                pass
            return
        return self._stream_proc(proc)

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_terminal_stream(self, container_name):
        """SSE stream for terminal output of a named container.

        Creates or reuses a PTY session via api.create_terminal_session().
        Registers a subscriber queue with api.subscribe_terminal() so this handler
        receives a copy of all PTY output from the shared broadcaster thread (DL-003).
        Streams output bytes base64-encoded as SSE events (format: {"data": "<b64>"}).
        Sends "heartbeat" SSE comments every 10 seconds when idle to keep the
        connection alive through proxies.
        Calls api.unsubscribe_terminal() in the finally block; does NOT call DELETE,
        preserving the PTY session for other active subscribers (DL-006).
        """
        import queue
        import base64

        result = api.create_terminal_session(container_name)
        if "error" in result:
            self._send_json(result, status=500)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        q = api.subscribe_terminal(container_name)

        try:
            while True:
                try:
                    chunk = q.get(timeout=10)
                except queue.Empty:
                    # Heartbeat to keep connection alive
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
                    continue
                if chunk is None:
                    break
                encoded = base64.b64encode(chunk).decode()
                msg = json.dumps({"data": encoded})
                self.wfile.write(f"data: {msg}\n\n".encode())
                self.wfile.flush()
        except OSError:
            pass
        finally:
            api.unsubscribe_terminal(container_name, q)

    def _handle_local_terminal_stream(self):
        """SSE stream for the local host shell terminal output."""
        import queue
        import base64

        result = api.create_local_terminal_session()
        if "error" in result:
            self._send_json(result, status=500)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        q = queue.Queue(maxsize=256)
        stop_evt = threading.Event()

        def _reader():
            while not stop_evt.is_set():
                chunk = api.read_local_terminal(timeout=0.05)
                if chunk is None:
                    q.put(None)
                    return
                if chunk:
                    try:
                        q.put_nowait(chunk)
                    except queue.Full:
                        pass

        t = threading.Thread(target=_reader, daemon=True)
        t.start()

        try:
            while True:
                try:
                    chunk = q.get(timeout=10)
                except queue.Empty:
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
                    continue
                if chunk is None:
                    break
                encoded = base64.b64encode(chunk).decode()
                msg = json.dumps({"data": encoded})
                self.wfile.write(f"data: {msg}\n\n".encode())
                self.wfile.flush()
        except OSError:
            pass
        finally:
            stop_evt.set()
            t.join(timeout=1)
