# Plan

## Overview

PTY backend spawns at OS default 24x80. No TIOCSWINSZ ioctl, no resize endpoint, no onResize handler. xterm.js fit() runs before layout settles. Sub-tab switches skip fit(). Shell programs always see 80-col terminal regardless of browser window size.

**Approach**: Add resize_terminal/resize_local_terminal functions using TIOCSWINSZ ioctl on master_fd. Add POST resize endpoints in server.py. Wire terminal.onResize in app.js to POST dimensions. Defer initial fit() via requestAnimationFrame. Call fit() on sub-tab reveal.

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | POST-based resize over query-param-on-SSE-connect | SSE connect starts before fit() runs, so initial dimensions unknown at connect time -> need POST anyway for initial + subsequent resizes -> single mechanism simpler than two |
| DL-002 | requestAnimationFrame for initial fit() deferral | open() attaches DOM but flex layout not settled -> immediate fit() measures stale dimensions -> rAF defers to next paint when layout is stable. Single rAF suffices (vs double-rAF) because open() is a synchronous DOM mutation that triggers layout in the same frame — rAF callback runs after that layout pass completes. Prior setTimeout(0) attempts (4 commits) failed because setTimeout can fire before the next layout pass; rAF is guaranteed to run after layout/style recalc. Double-rAF would add an unnecessary extra frame of delay (~16ms) with no benefit since the first rAF already sees settled dimensions. |
| DL-003 | No-op resize on pipe fallback path returns HTTP 200 with {ok: true} | TIOCSWINSZ requires PTY master_fd -> pipe path has master_fd=None -> attempting ioctl would crash -> guard with master_fd check -> return HTTP 200 with JSON body {"ok": true} (same as successful resize) so frontend treats it identically to a real resize success |
| DL-004 | terminal.onResize as single resize dispatch point | FitAddon.fit() triggers onResize when cols/rows change -> wiring POST to onResize covers initial fit, drag resize, and sub-tab reveal -> one handler covers all resize sources |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| setTimeout(0) deferral for fit() | Already tried in 4 prior commits (3999177, 85ba3ac, 0856764, 49fd8c3). Fragile under flex layout timing and backgrounded tabs. requestAnimationFrame aligns with browser paint cycle instead of arbitrary timer. (ref: DL-002) |
| Send size at PTY spawn time only | Does not handle subsequent resizes (window resize, drag, sub-tab switch). POST-based resize needed anyway, so spawn-time-only adds complexity without removing the POST path. (ref: DL-001) |

### Constraints

- MUST: No new npm/pip dependencies — gui uses vanilla JS with CDN-loaded xterm.js
- MUST: Both container terminal and local terminal must be fixed (they share the same pattern)
- MUST: Pipe fallback path (Windows, no pty module) must remain functional; TIOCSWINSZ only applies to PTY path
- SHOULD: Keep changes minimal — fix only what is broken, no refactoring
- SHOULD: Preserve existing ResizeObserver + FitAddon pattern; extend it rather than replace

### Known Risks

- **TIOCSWINSZ ioctl on dead/invalid PTY fd (EBADF, process exited)**: Wrap ioctl call in try/except OSError. On failure, log warning and return {error: str(e)}. Do not clean up master_fd here — session teardown owns fd lifecycle.
- **onResize fires before PTY session is connected (master_fd is None)**: Backend guard: if master_fd is None, return {ok: true} silently (no-op). Frontend: onResize handler checks that SSE stream has been established before POSTing; if not connected yet, skip. The next fit() after connect will fire onResize again with correct dimensions.
- **Pipe fallback path crashes on TIOCSWINSZ attempt**: Guard resize functions with master_fd is not None check before ioctl. Pipe sessions set master_fd=None, so guard catches them. Return {ok: true} to avoid frontend error handling for a non-error condition.

## Invisible Knowledge

### System

The GUI runs on the HOST machine (not inside the container). Python backend has direct access to PTY master_fd via fcntl/ioctl. Terminal connect is user-initiated (Connect button), not automatic on tab click — terminal pane IS visible when fit() first runs.

### Invariants

- Two separate terminal sessions: container terminal (per-container, dict-keyed by container name) and local terminal (singleton) — both need resize support with identical patterns
- Pipe fallback (no pty module) sets master_fd=None — resize calls must be no-ops on this path, never attempting ioctl

### Tradeoffs

- rAF deferral vs immediate fit(): rAF delays initial terminal render by one frame (~16ms) but guarantees layout is settled. Acceptable because terminal connect is user-initiated, not latency-sensitive.
- Silent no-op on pipe resize vs error response: silent success avoids frontend error toast for an expected non-error condition on Windows/pipe fallback

## Milestones

### Milestone 1: Backend resize API

**Files**: gui/api.py, gui/server.py

**Acceptance Criteria**:

- POST /api/containers/<name>/terminal/resize with {cols: 120, rows: 40} returns HTTP 200 {ok: true} when a PTY session exists for that container
- POST /api/local-terminal/resize with {cols: 120, rows: 40} returns HTTP 200 {ok: true} when local terminal PTY session exists
- POST resize with missing cols or rows returns HTTP 400 with error message
- POST resize with non-integer or non-positive values returns HTTP 400 with error message
- POST resize when no session exists returns HTTP 200 {error: 'no session'}
- POST resize on pipe-fallback session (master_fd=None) returns HTTP 200 {ok: true} without error

#### Code Intent

- **CI-M-001-001** `gui/api.py`: resize_terminal(container_name, cols, rows) function: acquires session from _terminal_sessions dict. If session not found, return {error: 'no session'}. Guards master_fd is not None — if None (pipe fallback), return {ok: True} immediately (no-op). Wraps fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0)) in try/except OSError to catch EBADF (closed fd), EPERM, and process-exited conditions. On OSError, return {error: str(e)} — do NOT close or clean up master_fd (session teardown owns fd lifecycle). Thread-safe via session lock. (refs: DL-001, DL-003)
- **CI-M-001-002** `gui/api.py`: resize_local_terminal(cols, rows) function: same TIOCSWINSZ ioctl pattern as resize_terminal but operates on _local_term_session singleton. Guards master_fd is not None. Thread-safe via _local_term_lock. (refs: DL-001, DL-003)
- **CI-M-001-003** `gui/server.py`: POST /api/containers/<name>/terminal/resize route in do_POST: parses JSON body for cols and rows. Validates: both fields present (else HTTP 400 {error: 'cols and rows required'}), both are integers (else HTTP 400 {error: 'cols and rows must be integers'}), both > 0 (else HTTP 400 {error: 'cols and rows must be positive'}). On valid input, calls api.resize_terminal(name, cols, rows), returns HTTP 200 with JSON result from api. Route placed adjacent to existing terminal/input route. (refs: DL-001)
- **CI-M-001-004** `gui/server.py`: POST /api/local-terminal/resize route in do_POST: parses JSON body for cols and rows, calls api.resize_local_terminal(cols, rows), returns JSON result. Route placed adjacent to existing local-terminal/input route. (refs: DL-001)

#### Code Changes

**CC-M-001-001** (gui/api.py) - implements CI-M-001-001

**Code:**

```diff
--- a/gui/api.py
+++ b/gui/api.py
@@ -1374,6 +1374,32 @@ def write_local_terminal(data):
         return {"error": str(exc)}
 
 
+def resize_terminal(container_name, cols, rows):
+    """Resize the PTY for a container terminal session via TIOCSWINSZ."""
+    with _terminal_sessions_lock:
+        session = _terminal_sessions.get(container_name)
+    if not session:
+        return {"error": "no session"}
+    master_fd = session["master_fd"]
+    if master_fd is None:
+        return {"ok": True}
+    try:
+        import fcntl
+        import termios
+        import struct
+        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
+        return {"ok": True}
+    except OSError as e:
+        return {"error": str(e)}
+
+
+def resize_local_terminal(cols, rows):
+    """Resize the PTY for the local terminal session via TIOCSWINSZ."""
+    with _local_term_lock:
+        session = _local_term_session.get("session")
+    if not session:
+        return {"error": "no session"}
+    master_fd = session["master_fd"]
+    if master_fd is None:
+        return {"ok": True}
+    try:
+        import fcntl
+        import termios
+        import struct
+        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
+        return {"ok": True}
+    except OSError as e:
+        return {"error": str(e)}
+
+
 def _cleanup_local_session():
```

**Documentation:**

```diff
--- a/gui/api.py
+++ b/gui/api.py
@@ -1374,6 +1374,32 @@ def write_local_terminal(data):
         return {"error": str(exc)}
 
 
+def resize_terminal(container_name, cols, rows):
+    """Resize the PTY for a container terminal session.
+
+    Sends TIOCSWINSZ to the PTY master fd so the kernel updates the terminal
+    window size visible to the shell and any running TUI program. Returns
+    {"ok": True} immediately when master_fd is None -- that indicates the pipe
+    fallback path (no pty module), which has no kernel window-size concept.
+    (ref: DL-003)
+    """
+    with _terminal_sessions_lock:
+        session = _terminal_sessions.get(container_name)
+    if not session:
+        return {"error": "no session"}
+    master_fd = session["master_fd"]
+    if master_fd is None:  # pipe fallback -- TIOCSWINSZ not applicable (ref: DL-003)
+        return {"ok": True}
+    try:
+        import fcntl
+        import termios
+        import struct
+        # TIOCSWINSZ expects (rows, cols, xpixels, ypixels) -- rows before cols per POSIX struct winsize
+        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
+        return {"ok": True}
+    except OSError as e:
+        return {"error": str(e)}
+
+
+def resize_local_terminal(cols, rows):
+    """Resize the PTY for the local terminal session.
+
+    Identical to resize_terminal but operates on the singleton local terminal
+    session rather than a per-container session. Returns {"ok": True} on the
+    pipe fallback path (master_fd is None) -- the pipe path has no kernel
+    window-size concept, so TIOCSWINSZ is not applicable. (ref: DL-003)
+    """
+    with _local_term_lock:
+        session = _local_term_session.get("session")
+    if not session:
+        return {"error": "no session"}
+    master_fd = session["master_fd"]
+    if master_fd is None:  # pipe fallback -- TIOCSWINSZ not applicable (ref: DL-003)
+        return {"ok": True}
+    try:
+        import fcntl
+        import termios
+        import struct
+        # TIOCSWINSZ expects (rows, cols, xpixels, ypixels) -- rows before cols per POSIX struct winsize
+        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
+        return {"ok": True}
+    except OSError as e:
+        return {"error": str(e)}
+
+
 def _cleanup_local_session():

```


**CC-M-001-002** (gui/server.py) - implements CI-M-001-003

**Code:**

```diff
--- a/gui/server.py
+++ b/gui/server.py
@@ -271,6 +271,25 @@ class _Handler(BaseHTTPRequestHandler):
             return self._send_json(result, status=status)
 
+        # POST /api/containers/<name>/terminal/resize -- resize PTY dimensions
+        if path.startswith("/api/containers/") and path.endswith("/terminal/resize"):
+            name = path[len("/api/containers/"):-len("/terminal/resize")]
+            cols = data.get("cols")
+            rows = data.get("rows")
+            if cols is None or rows is None:
+                return self._send_json({"error": "cols and rows required"}, status=400)
+            if not isinstance(cols, int) or not isinstance(rows, int):
+                return self._send_json({"error": "cols and rows must be integers"}, status=400)
+            if cols <= 0 or rows <= 0:
+                return self._send_json({"error": "cols and rows must be positive"}, status=400)
+            result = api.resize_terminal(name, cols, rows)
+            if "error" in result:
+                status = 200 if result["error"] == "no session" else 500
+                return self._send_json(result, status=status)
+            return self._send_json(result, status=200)
+
         # POST /api/containers/<name>/terminal/input -- write keystroke data to PTY
         if path.startswith("/api/containers/") and path.endswith("/terminal/input"):
```

**Documentation:**

```diff
--- a/gui/server.py
+++ b/gui/server.py
@@ -271,6 +271,25 @@ class _Handler(BaseHTTPRequestHandler):
             return self._send_json(result, status=status)
 
+        # POST /api/containers/<name>/terminal/resize -- resize PTY dimensions
+        # Uses POST rather than a query param on the SSE connect URL so that
+        # resize events can be sent independently at any time after connect. (ref: DL-001)
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
+                # "no session" is a race (tab closed before resize) -- 200 avoids spurious JS errors (ref: DL-003)
                 status = 200 if result["error"] == "no session" else 500
                 return self._send_json(result, status=status)
             return self._send_json(result, status=200)
 
         # POST /api/containers/<name>/terminal/input -- write keystroke data to PTY
         if path.startswith("/api/containers/") and path.endswith("/terminal/input"):

```


**CC-M-001-003** (gui/server.py) - implements CI-M-001-004

**Code:**

```diff
--- a/gui/server.py
+++ b/gui/server.py
@@ -280,6 +280,17 @@ class _Handler(BaseHTTPRequestHandler):
             return self._send_json(result, status=status)
 
+        # POST /api/local-terminal/resize -- resize PTY dimensions for local terminal
+        if path == "/api/local-terminal/resize":
+            cols = data.get("cols")
+            rows = data.get("rows")
+            if cols is None or rows is None:
+                return self._send_json({"error": "cols and rows required"}, status=400)
+            if not isinstance(cols, int) or not isinstance(rows, int):
+                return self._send_json({"error": "cols and rows must be integers"}, status=400)
+            if cols <= 0 or rows <= 0:
+                return self._send_json({"error": "cols and rows must be positive"}, status=400)
+            result = api.resize_local_terminal(cols, rows)
+            if "error" in result:
+                status = 200 if result["error"] == "no session" else 500
+                return self._send_json(result, status=status)
+            return self._send_json(result, status=200)
+
         # POST /api/local-terminal/input — write to local shell PTY
         if path == "/api/local-terminal/input":
```

**Documentation:**

```diff
--- a/gui/server.py
+++ b/gui/server.py
@@ -280,6 +280,17 @@ class _Handler(BaseHTTPRequestHandler):
             return self._send_json(result, status=status)
 
+        # POST /api/local-terminal/resize -- resize PTY dimensions for local terminal
+        # Mirrors /api/containers/<name>/terminal/resize for the singleton local session. (ref: DL-001)
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
+                # "no session" is a race (tab closed before resize) -- 200 avoids spurious JS errors (ref: DL-003)
                 status = 200 if result["error"] == "no session" else 500
                 return self._send_json(result, status=status)
             return self._send_json(result, status=200)
 
         # POST /api/local-terminal/input -- write to local shell PTY
         if path == "/api/local-terminal/input":

```


**CC-M-001-004** (gui/api.py) - implements CI-M-001-002

**Documentation:**

```diff
--- a/gui/api.py
+++ b/gui/api.py
@@ -1399,6 +1399,7 @@ def resize_local_terminal(cols, rows):
     master_fd = session["master_fd"]
     if master_fd is None:  # pipe fallback -- TIOCSWINSZ not applicable (ref: DL-003)
         return {"ok": True}
     try:
         import fcntl
         import termios
         import struct
+        # TIOCSWINSZ expects (rows, cols, xpixels, ypixels) -- rows before cols per POSIX struct winsize
         fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
         return {"ok": True}
```

> **Developer notes**: Removed: resize_local_terminal is already defined in CC-M-001-001 alongside resize_terminal. Applying both would produce a duplicate function definition.

**CC-M-001-005** (gui/README.md)

**Documentation:**

```diff
--- a/gui/README.md
+++ b/gui/README.md
@@ -131,6 +131,30 @@ xterm.js is loaded from CDN —
 no build step needed (DL-003). If the CDN is unreachable, `window._xtermJsFailed`
 is set and a fallback message is shown.
 
+**PTY resize (DL-001, DL-003, DL-004)**: Browser window resize fires
+`ResizeObserver` -> `FitAddon.fit()` -> `terminal.onResize(evt)` ->
+`POST /api/containers/<name>/terminal/resize` with `{cols, rows}` ->
+`fcntl.ioctl(master_fd, TIOCSWINSZ, ...)` on the PTY master fd. The
+`onResize` handler is gated by a `_termConnected` flag that is set only after
+`EventSource.onopen` fires, preventing resize posts before the session exists.
+`fit()` is called once more in `onopen` to push the correct initial dimensions
+to the PTY immediately after connect. On the pipe fallback path (`master_fd is
+None`), resize calls return `{"ok": True}` without issuing TIOCSWINSZ — the
+pipe path has no kernel window-size concept. (ref: DL-003)
+
+**fit() timing (DL-002)**: `FitAddon.fit()` is wrapped in `requestAnimationFrame`
+at `open()` time and after sub-tab visibility toggles. `requestAnimationFrame`
+defers until after the browser has completed flex layout, so FitAddon measures
+settled `offsetWidth`/`offsetHeight`. `setTimeout(0)` is fragile under flex layout and backgrounded tabs; `requestAnimationFrame` defers until after layout/style recalculation completes.
+
+**Sub-tab fit (DL-002)**: `ResizeObserver` does not fire when a pane transitions
+from `hidden` to visible. The sub-tab click handler calls `fit()` via
+`requestAnimationFrame` after the class toggle so the newly revealed terminal
+measures its actual dimensions.
+
 **SSE+POST vs WebSocket (DL-001)**: WebSocket requires a raw HTTP upgrade and
 frame parser that cannot be satisfied by Python stdlib alone. SSE+POST keeps the
 terminal within `http.server.ThreadingHTTPServer` at the cost of one HTTP
@@ -148,6 +172,8 @@ round-trip per keystroke — acceptable for interactive terminal use.
 
 **R-001 — PTY unavailable on Windows**: The `pty` module is Linux/Mac only. On
 Windows hosts the terminal backend falls back to subprocess pipes
-(`subprocess.Popen` with `stdin=PIPE`). The terminal still connects but lacks
-full PTY semantics (no resize, no raw mode). A warning label is shown in the UI.
+(`subprocess.Popen` with `stdin=PIPE`). The terminal still connects but lacks
+full PTY semantics (no resize support — `master_fd` is `None` and resize
+calls are no-ops, no raw mode). A warning label is shown in the UI.
 
 **R-004 — CDN unreachable**: xterm.js is loaded from `unpkg.com`. If the host
@@ -183,6 +209,8 @@ list with a `scope` field. Apply/remove writes to local config `modules` array
 | POST   | `/api/containers/<name>/destroy`  | docker rm -f, preserve registry entry |
 | GET    | `/api/containers/<name>/terminal/stream` | SSE stream of PTY output |
 | POST   | `/api/containers/<name>/terminal/input` | Write keystrokes to PTY |
+| POST   | `/api/containers/<name>/terminal/resize` | Update PTY window size via TIOCSWINSZ |
 | DELETE | `/api/containers/<name>/terminal` | Close PTY session |
+| POST   | `/api/local-terminal/resize` | Update local terminal PTY window size |
 
 ## Terminal Session Lifecycle
@@ -194,6 +222,7 @@ list with a `scope` field. Apply/remove writes to local config `modules` array
 4. Output bytes flow: PTY master fd -> SSE `data:` frames -> xterm.js `write()`.
 5. Input: `onData` callback -> `POST .../terminal/input` -> write to PTY master fd.
-6. Disconnect: `DELETE .../terminal` closes fd and kills the process group.
+6. Resize: `onResize` (gated by `_termConnected`) -> `POST .../terminal/resize` -> TIOCSWINSZ on master fd.
+7. Disconnect: `DELETE .../terminal` closes fd and kills the process group.
-7. On server shutdown, `signal.SIGTERM` and `atexit` handlers close all sessions (R-005).
+8. On server shutdown, `signal.SIGTERM` and `atexit` handlers close all sessions (R-005).

```


### Milestone 2: Frontend resize wiring and fit timing

**Files**: gui/static/app.js

**Acceptance Criteria**:

- Container terminal: after Connect, terminal.onResize fires and POSTs correct cols/rows to /api/containers/<name>/terminal/resize
- Local terminal: after Connect, terminal.onResize fires and POSTs correct cols/rows to /api/local-terminal/resize
- fit() is called inside requestAnimationFrame, not synchronously after open()
- Switching between container terminal and local terminal sub-tabs calls fit() on the revealed terminal
- onResize handler does NOT POST before SSE stream is connected (no 404/error from missing session)
- Browser window resize triggers onResize -> POST with updated dimensions

#### Code Intent

- **CI-M-002-001** `gui/static/app.js`: In onTerminalTabActivate(): replace immediate _termFitAddon.fit() call (line 3197) with requestAnimationFrame wrapper. Wire _termXterm.onResize callback that POSTs {cols, rows} to /api/containers/<name>/terminal/resize. The onResize handler must guard against firing before SSE connect: check that the terminal EventSource is open (readyState === EventSource.OPEN or a local connected flag) before POSTing; if not connected, skip the POST silently. When SSE connect succeeds (onopen), call fit() to trigger onResize with correct dimensions — this ensures the initial size is sent after the backend session exists, not before. (refs: DL-002, DL-004)
- **CI-M-002-002** `gui/static/app.js`: In _onLocalTermSubtabActivate(): same pattern — replace immediate fit() (line 3416) with requestAnimationFrame wrapper. Wire _localTermXterm.onResize callback that POSTs {cols, rows} to /api/local-terminal/resize. (refs: DL-002, DL-004)
- **CI-M-002-003** `gui/static/app.js`: In terminal sub-tab click handler (line 3472-3481): after toggling pane visibility, call fit() on the terminal in the newly revealed pane (container terminal or local terminal) so ResizeObserver-invisible visibility changes trigger a re-measure. (refs: DL-002)

#### Code Changes

**CC-M-002-001** (gui/static/app.js) - implements CI-M-002-001

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3192,7 +3192,22 @@ function onTerminalTabActivate() {
   if (window.FitAddon) {
     _termFitAddon = new window.FitAddon.FitAddon();
     _termXterm.loadAddon(_termFitAddon);
   }
   _termXterm.open(container);
-  if (_termFitAddon) _termFitAddon.fit();
+  if (_termFitAddon) requestAnimationFrame(function () { if (_termFitAddon) _termFitAddon.fit(); });
 
   // Re-fit when user drags the container to resize it
   if (typeof ResizeObserver !== "undefined" && _termFitAddon) {
@@ -3203,6 +3203,16 @@ function onTerminalTabActivate() {
     _termXterm._ro = ro;
   }
 
+  var _termConnected = false;
+  _termXterm._onResizeDisposable = _termXterm.onResize(function (evt) {
+    if (!_termConnected) return;
+    var name = _termContainer;
+    fetch("/api/containers/" + encodeURIComponent(name) + "/terminal/resize", {
+      method: "POST",
+      headers: { "Content-Type": "application/json" },
+      body: JSON.stringify({ cols: evt.cols, rows: evt.rows }),
+    }).catch(function () {});
+  });
+
   _termContainer = selectedContainer.name;
 
   // Send keystrokes to backend
@@ -3223,6 +3223,8 @@ function onTerminalTabActivate() {
 
   _termEventSource.onopen = function () {
     statusLabel.textContent = "Connected";
+    _termConnected = true;
+    if (_termFitAddon) _termFitAddon.fit();
   };
 
   _termEventSource.onmessage = function (evt) {
```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3192,7 +3192,22 @@ function onTerminalTabActivate() {
   _termXterm.open(container);
-  if (_termFitAddon) _termFitAddon.fit();
+  // requestAnimationFrame defers fit() until after the browser has completed
+  // flex layout so FitAddon measures settled dimensions. (ref: DL-002)
+  if (_termFitAddon) requestAnimationFrame(function () { if (_termFitAddon) _termFitAddon.fit(); });
 
   // Re-fit when user drags the container to resize it
   if (typeof ResizeObserver !== "undefined" && _termFitAddon) {
@@ -3203,6 +3203,16 @@ function onTerminalTabActivate() {
     _termXterm._ro = ro;
   }
 
+  // _termConnected gates resize dispatches -- onResize fires during open() before
+  // the SSE connection exists, which would POST to a session that is not yet
+  // started. Set to true only after EventSource.onopen fires. (ref: DL-004)
+  var _termConnected = false;
+  _termXterm._onResizeDisposable = _termXterm.onResize(function (evt) {
+    if (!_termConnected) return;
+    var name = _termContainer;
+    fetch("/api/containers/" + encodeURIComponent(name) + "/terminal/resize", {
+      method: "POST",
+      headers: { "Content-Type": "application/json" },
+      body: JSON.stringify({ cols: evt.cols, rows: evt.rows }),
+    }).catch(function () {});
+  });
+
   _termContainer = selectedContainer.name;
 
   // Send keystrokes to backend
@@ -3223,6 +3223,8 @@ function onTerminalTabActivate() {
 
   _termEventSource.onopen = function () {
     statusLabel.textContent = "Connected";
+    _termConnected = true;
+    // Fit after connect so the PTY receives the correct initial dimensions
+    // on the same tick that _termConnected is set, triggering the onResize handler. (ref: DL-004)
+    if (_termFitAddon) _termFitAddon.fit();
   };

```


**CC-M-002-002** (gui/static/app.js) - implements CI-M-002-002

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3411,7 +3411,22 @@ function _onLocalTermSubtabActivate() {
   if (window.FitAddon) {
     _localTermFitAddon = new window.FitAddon.FitAddon();
     _localTermXterm.loadAddon(_localTermFitAddon);
   }
   _localTermXterm.open(container);
-  if (_localTermFitAddon) _localTermFitAddon.fit();
+  if (_localTermFitAddon) requestAnimationFrame(function () { if (_localTermFitAddon) _localTermFitAddon.fit(); });
 
   if (typeof ResizeObserver !== "undefined" && _localTermFitAddon) {
     const ro = new ResizeObserver(function () { if (_localTermFitAddon) _localTermFitAddon.fit(); });
@@ -3421,6 +3421,15 @@ function _onLocalTermSubtabActivate() {
     _localTermXterm._ro = ro;
   }
 
+  var _localTermConnected = false;
+  _localTermXterm._onResizeDisposable = _localTermXterm.onResize(function (evt) {
+    if (!_localTermConnected) return;
+    fetch("/api/local-terminal/resize", {
+      method: "POST",
+      headers: { "Content-Type": "application/json" },
+      body: JSON.stringify({ cols: evt.cols, rows: evt.rows }),
+    }).catch(function () {});
+  });
+
   _localTermXterm.onData(function (data) {
     fetch("/api/local-terminal/input", {
@@ -3434,6 +3434,8 @@ function _onLocalTermSubtabActivate() {
 
   _localTermEventSource.onopen = function () {
     document.getElementById("local-term-status").textContent = "Connected";
+    _localTermConnected = true;
+    if (_localTermFitAddon) _localTermFitAddon.fit();
   };
 
   _localTermEventSource.onmessage = function (evt) {
```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3411,7 +3411,22 @@ function _onLocalTermSubtabActivate() {
   _localTermXterm.open(container);
-  if (_localTermFitAddon) _localTermFitAddon.fit();
+  // requestAnimationFrame defers fit() until after the browser has completed
+  // flex layout so FitAddon measures settled dimensions. (ref: DL-002)
+  if (_localTermFitAddon) requestAnimationFrame(function () { if (_localTermFitAddon) _localTermFitAddon.fit(); });
 
   if (typeof ResizeObserver !== "undefined" && _localTermFitAddon) {
     const ro = new ResizeObserver(function () { if (_localTermFitAddon) _localTermFitAddon.fit(); });
@@ -3421,6 +3421,15 @@ function _onLocalTermSubtabActivate() {
     _localTermXterm._ro = ro;
   }
 
+  // _localTermConnected gates resize dispatches -- onResize fires during open()
+  // before the SSE connection exists. Set to true only after EventSource.onopen. (ref: DL-004)
+  var _localTermConnected = false;
+  _localTermXterm._onResizeDisposable = _localTermXterm.onResize(function (evt) {
+    if (!_localTermConnected) return;
+    fetch("/api/local-terminal/resize", {
+      method: "POST",
+      headers: { "Content-Type": "application/json" },
+      body: JSON.stringify({ cols: evt.cols, rows: evt.rows }),
+    }).catch(function () {});
+  });
+
   _localTermXterm.onData(function (data) {
     fetch("/api/local-terminal/input", {
@@ -3434,6 +3434,8 @@ function _onLocalTermSubtabActivate() {
 
   _localTermEventSource.onopen = function () {
     document.getElementById("local-term-status").textContent = "Connected";
+    _localTermConnected = true;
+    // Fit after connect so the PTY receives the correct initial dimensions. (ref: DL-004)
+    if (_localTermFitAddon) _localTermFitAddon.fit();
   };

```


**CC-M-002-003** (gui/static/app.js) - implements CI-M-002-003

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3472,10 +3472,20 @@ document.querySelectorAll(".terminal-subtab-btn").forEach(function (btn) {
   btn.addEventListener("click", function () {
     document.querySelectorAll(".terminal-subtab-btn").forEach(function (b) {
       b.classList.toggle("active", b === btn);
     });
     document.querySelectorAll(".terminal-subtab-pane").forEach(function (pane) {
       pane.classList.toggle("hidden", pane.id !== "term-subtab-" + btn.dataset.subtab);
     });
+    if (btn.dataset.subtab === "container" && _termFitAddon) {
+      requestAnimationFrame(function () { if (_termFitAddon) _termFitAddon.fit(); });
+    }
+    if (btn.dataset.subtab === "local" && _localTermFitAddon) {
+      requestAnimationFrame(function () { if (_localTermFitAddon) _localTermFitAddon.fit(); });
+    }
   });
 });
```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3472,10 +3472,20 @@ document.querySelectorAll(".terminal-subtab-btn").forEach(function (btn) {
   btn.addEventListener("click", function () {
     document.querySelectorAll(".terminal-subtab-btn").forEach(function (b) {
       b.classList.toggle("active", b === btn);
     });
     document.querySelectorAll(".terminal-subtab-pane").forEach(function (pane) {
       pane.classList.toggle("hidden", pane.id !== "term-subtab-" + btn.dataset.subtab);
     });
+    // ResizeObserver does not fire when a pane transitions from hidden to visible.
+    // requestAnimationFrame defers fit() until after the class toggle has taken
+    // effect and the browser has laid out the now-visible pane. (ref: DL-002)
+    if (btn.dataset.subtab === "container" && _termFitAddon) {
+      requestAnimationFrame(function () { if (_termFitAddon) _termFitAddon.fit(); });
+    }
+    if (btn.dataset.subtab === "local" && _localTermFitAddon) {
+      requestAnimationFrame(function () { if (_localTermFitAddon) _localTermFitAddon.fit(); });
+    }
   });
 });

```

