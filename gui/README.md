# gui

Web dashboard for ClaudeBox. Runs as a local Python HTTP server on the host
machine (not inside a container). Opens in the user's default browser.

## Architecture

```
gui/
├── __init__.py      # Package marker
├── __main__.py      # Entry point: arg parsing, ThreadingHTTPServer lifecycle
├── server.py        # HTTP handler: static file serving + /api/* routing
├── api.py           # Business logic: registry, config, docker, subprocess
├── static/
│   ├── index.html   # Single-page app shell
│   ├── app.js       # SPA logic (vanilla JS, no framework, no build step)
│   └── style.css    # Dashboard styles
└── frontend/        # Svelte source for the SPA (compiled output -> static/)
```

## Key Decisions

**Python stdlib only (DL-001)**: `http.server.ThreadingHTTPServer` handles each
request in its own thread. No pip dependencies — zero install friction on the
host.

**Registry file (DL-002)**: `~/.claudebox/registry.json` is written by
`registry_add`/`registry_remove` helpers in `claudebox.sh` on init/destroy. The
GUI reads it for fast startup, then cross-checks `docker ps` to detect containers
removed via `docker rm` outside of ClaudeBox. Registry and Docker are the dual
source of truth; neither alone is sufficient.

**Vanilla JS SPA (DL-003)**: `gui/static/` ships as static HTML/CSS/JS served
directly by the Python handler. No build step required for the served files. The
`gui/frontend/` Svelte source is the development-time origin; its compiled output
lands in `gui/static/`. If feature count grows to require modularization, split
into per-area JS files rather than adopting a framework.

**SSE for streaming (DL-004)**: Command output streams via Server-Sent Events
(`EventSource` in the browser, chunked `text/event-stream` on the server).
Simpler than WebSocket for unidirectional server-to-client flow. On browser
disconnect, the server detects `OSError` on write and kills the subprocess
process group via `os.killpg`.

**Config merge via bash subprocess (DL-005)**: `get_merged_config` sources
`lib/config.sh` in a subprocess and reads the resulting `CB_MERGED_CONFIG`
file. This ensures the GUI always reflects the authoritative merge semantics
without reimplementing them in Python (which would risk drift).

**Port 19280, no auto-increment (DL-006)**: On `EADDRINUSE`, the server exits
with a message naming the port and suggesting `--port`. Auto-incrementing would
leave the user uncertain which port the GUI is on.

## Invariants

- Server binds to `127.0.0.1` only — no remote access
- Registry writes are atomic (tempfile + `os.replace`)
- Config saves create a `.bak` backup before overwrite
- `extra_commands` entries are flagged in the local config editor because they
  run as root during container initialization
- Builtin modules (in `$CLAUDEBOX_HOME/modules/`) are read-only via the GUI;
  delete and scope-change operations are blocked at the API layer

## Detail Panel Tab Architecture

The container detail panel has seven top-level tabs (Overview, Config, Modules,
Inspect, Files, Refs, Terminal) implemented with a scoped tab group pattern.
Each tab group is identified by a `data-tab-group` attribute on
both buttons and content panels, so `initTabGroup(groupName)` in `app.js`
scopes all DOM queries to that group. This prevents nested tab groups from
interfering: the Config tab contains its own inner Merged/Global/Local sub-tabs
using `data-tab-group="config"` while the outer detail tabs use
`data-tab-group="detail"`.

Tabs are organized into three visual clusters separated by CSS left-border
markers on `.tab-btn.tab-group-sep` elements:
- **[Overview Config Modules]** — container state and configuration
- **[Inspect Files]** — read-only introspection
- **[Refs Terminal]** — advanced/session tools

The separator is applied via CSS margin+border on `tab-group-sep` class
rather than HTML restructuring, to avoid touching the `initTabGroup` scoping
machinery (data-tab-group attributes). (PDL-001)

**Command panel (PDL-002)**: Overview tab command buttons are organized into
three intent groups divided by `.cmd-group-sep` vertical rule dividers:
- Session actions: Stop/Start, Terminal, Rebuild
- Config actions: Sync Config
- Destructive actions: Destroy, Unregister (behind `.cmd-overflow-menu` toggle)

Destructive actions are placed behind the overflow toggle to add friction
proportional to severity while keeping them accessible. The toggle closes on
any outside click or on selection. When a confirm bar is shown, the overflow
menu is hidden (it would otherwise float over the replaced DOM node).

**Terminal header (PDL-003)**: The terminal panel header retains only
session-control buttons (Connect, Disconnect, Stop/Start, Popout). Sync Config
and Destroy are not present in the terminal header; those actions live in
the Overview tab command panel. Stop/Start belongs here: it stops the
container process without navigating away from the terminal view.

**Config subtab style (PDL-004)**: Inner config subtabs (Merged/Global/Local)
use a pill/chip visual style (smaller font, border-radius, no bottom border)
to distinguish their nesting level from the outer detail tabs. Outer and inner
tabs share the `.tab-btn` base class; the inner tabs are further scoped under
`.config-tabs .tab-btn` so inner styles do not affect outer detail tabs.

**Spacing tokens (PDL-005)**: CSS custom properties `--space-xs` through
`--space-xl` are defined in `:root` alongside existing hardcoded `px` values.
Existing rules are migrated to tokens incrementally; hardcoded values in
unmigrated rules remain valid and coexist without conflict.

**File viewer (DL-005)**: The Files tab supports clicking non-directory entries
to open a read-only modal. Content is fetched via
`GET /api/containers/<name>/files/content?path=<path>`. Binary files (null byte
detected in first 512 B) and files over 1 MB are rejected with an error shown
inline. File writing is not supported.

**Destroy and Rebuild (DL-004, DL-008)**: `POST /api/containers/<name>/destroy`
calls `docker rm -f` directly and stamps a `destroyed_at` timestamp on the
registry entry without removing it. This keeps project metadata (language,
project_path) available so the UI can offer a one-click Rebuild. Rebuild runs
`claudebox init` in the same `project_path` via the existing SSE init flow.
`claudebox.sh cmd_destroy` handles the full CLI destroy (docker rm + registry deregister) for users not using the GUI.

**One session per container (DL-007)**: Terminal sessions are keyed by container
name. Opening a terminal for container A while container B has an active session
does not close container B's session; each container manages its PTY
independently.

**Web terminal (DL-001, DL-004, DL-007)**: The Terminal tab streams a PTY
session via SSE (`GET /api/containers/<name>/terminal/stream`) with input sent
via `POST /api/containers/<name>/terminal/input`. xterm.js is loaded from CDN —
no build step needed (DL-003). If the CDN is unreachable, `window._xtermJsFailed`
is set and a fallback message is shown.

The GUI always spawns plain `zsh` inside the container (ref: DL-001). No tmux
detection is performed. Users who want a multiplexer can set `startup_command`
in `.claudebox.json`:

```json
{ "startup_command": "tmux new-session -A -s main" }
```

`startup_command` is stored in the session dict at connect time. Changes take
effect on the next fresh connect (an existing live session is not interrupted).
Each dashboard tile has a ↱ button that opens the container in a native OS
terminal. When `startup_command` is set, both the in-browser xterm and the
native terminal attach to the same named multiplexer session.

**SSE+POST vs WebSocket (DL-001)**: WebSocket requires a raw HTTP upgrade and
frame parser that cannot be satisfied by Python stdlib alone. SSE+POST keeps the
terminal within `http.server.ThreadingHTTPServer` at the cost of one HTTP
round-trip per keystroke — acceptable for interactive terminal use.

**Light mode sidebar**: `--bg-sidebar` is dark-valued in both themes. Sidebar
elements are re-scoped with `[data-theme=light] .sidebar { ... }` overrides to
restore legible text colours against the dark sidebar background.

## Risks

**R-001 — PTY unavailable on Windows**: The `pty` module is Linux/Mac only. On
Windows hosts the terminal backend falls back to subprocess pipes
(`subprocess.Popen` with `stdin=PIPE`). The terminal still connects but lacks
full PTY semantics (no resize, no raw mode). A warning label is shown in the UI.

**R-004 — CDN unreachable**: xterm.js is loaded from `unpkg.com`. If the host
browser cannot reach the CDN, `window._xtermJsFailed` is set via the `onerror`
handler and the Terminal tab shows a fallback message instead of crashing.

**R-005 — Orphaned PTY processes**: If the GUI server exits without a clean
`DELETE /api/containers/<name>/terminal` call, PTY processes may remain attached
to the container. `signal.SIGTERM` and `atexit` handlers in `api.py` close all
active sessions on shutdown.

## Module Scopes

Modules are discovered from three directories in priority order:

| Scope   | Path                                  | Mutable via GUI |
| ------- | ------------------------------------- | --------------- |
| builtin | `$CLAUDEBOX_HOME/modules/`            | No (read-only)  |
| user    | `~/.claudebox/modules/`               | Yes             |
| project | `<project_dir>/.claudebox/modules/`   | Yes             |

`list_modules()` in `api.py` scans all three directories and returns a flat
list with a `scope` field. Apply/remove writes to local config `modules` array
via the existing `POST /api/config/local` endpoint.

## API Routes (Detail Panel)

| Method | Path                              | Purpose                            |
| ------ | --------------------------------- | ---------------------------------- |
| GET    | `/api/modules`                    | List modules from all scopes       |
| POST   | `/api/modules`                    | Create or overwrite a module file  |
| DELETE | `/api/modules`                    | Delete a user or project module    |
| GET    | `/api/config/verify`              | Validate merged config, return issues |
| GET    | `/api/containers/<name>/inspect`  | Return parsed docker inspect data  |
| GET    | `/api/containers/<name>/files/content` | Read file from container (1 MB cap, text only) |
| POST   | `/api/containers/<name>/destroy`  | docker rm -f, preserve registry entry |
| GET    | `/api/containers/<name>/terminal/stream` | SSE stream of PTY output |
| POST   | `/api/containers/<name>/terminal/input` | Write keystrokes to PTY |
| DELETE | `/api/containers/<name>/terminal` | Close PTY session |
| PATCH  | `/api/containers/<name>/pin`      | Set or clear the `pinned` field in registry |

## Running

```bash
# From the repo root (not inside a container):
cd ~/.local/share/claudebox
python3 -m gui
# or with a custom port:
python3 -m gui --port 8080
```

The normal entry point is `claudebox gui [--port <port>]`.

## Dashboard Panel (Pinned Container Terminals)

**Dashboard as top-level panel (DL-001)**: The dashboard is a sixth top-level panel
activated via `showPanel("dashboard")`, following the same show/hide pattern as the
detail, new-container, modules, settings, and welcome panels. No routing library is
required.

**Pin state in registry (DL-005)**: Pin state is stored as a `pinned` boolean field
per container entry in `~/.claudebox/registry.json`. The registry is the authoritative
per-container store; adding `pinned: true` is consistent with how all other container
state is managed. `PATCH /api/containers/<name>/pin` sets or clears the field atomically.
Automatic cleanup: when `claudebox destroy` removes a registry entry the pin is gone for
free. localStorage was rejected — it is browser-specific and not durable across data clears.

**CSS auto-fill grid (DL-008)**: `.dashboard-grid` uses
`grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`. The browser computes
column count from viewport width with no JS resize handlers. 320px minimum keeps
xterm.js output readable. `ceil(sqrt(n))` column math was rejected — it requires JS
recalculation on resize and pin changes.

**Read-only tiles, fullscreen for input (DL-004)**: Grid tiles are xterm.js instances
with `disableStdin: true`. Multiple tiles are visible simultaneously; enabling input
on all would create keystroke ambiguity. Clicking the fullscreen button opens a
`position:fixed` overlay (DL-013) with input re-enabled. ESC or the close button exits
fullscreen and restores the read-only tile EventSource.

**Server-side fan-out broadcaster (DL-003)**: `os.read()` on a PTY master fd is
consuming — bytes read by one thread are lost to others. When a dashboard tile and
the detail panel Terminal tab both have SSE streams open for the same container,
they would race on the fd and produce interleaved incomplete output.

`_start_broadcaster()` in `api.py` spawns one reader thread per PTY session. That
thread reads from master_fd and puts each chunk into every queue in
`session["subscribers"]`. Each SSE handler calls `subscribe_terminal()` to register
its queue and `unsubscribe_terminal()` on disconnect — no thread racing, identical
output to all readers. All reads go through the broadcaster via `subscribe_terminal()`/`unsubscribe_terminal()`; direct `os.read()` on the PTY fd is reserved to the single broadcaster thread.

**Activity detection (DL-002)**: Claude activity status is detected client-side.
`_startDashboardStatusInterval()` runs every 2 seconds and classifies each tile by
elapsed time since the last SSE `onmessage` event:

| Elapsed       | Status class     | Indicator            |
| ------------- | ---------------- | -------------------- |
| < 3 s         | `status-active`  | green pulse          |
| 3 s – 30 s    | `status-waiting` | yellow               |
| ≥ 30 s / none | `status-idle`    | grey                 |

The 30-second idle threshold (R-002) accounts for browser background-tab
throttling, which may buffer SSE delivery and delay `onmessage` timestamps, producing
false idle readings. A 5-second threshold triggers false-idle on every tab switch. A server-side status endpoint was rejected (RA-004) — it adds API surface
for a UI-only concern.

**Shared PTY sessions and cleanup (DL-006)**: Dashboard tiles share one PTY session
per container with the detail panel Terminal tab. Unpinning a tile or navigating away
from the dashboard closes the EventSource (unsubscribing from the broadcaster) but
does NOT call `DELETE /api/containers/<name>/terminal`. Calling DELETE would kill a
PTY session that the detail panel may still be using.

The idle reaper (`_idle_reaper()` in `api.py`) runs every 30 seconds and calls
`_cleanup_session()` on sessions whose subscriber list is empty and whose
`last_activity` timestamp is older than 60 seconds. The 60-second grace period
prevents premature cleanup when the last subscriber just disconnected but a reconnect
is imminent (e.g. page reload). The reaper thread starts on the first
`create_terminal_session()` call and exits when no sessions remain.

## Terminal Session Lifecycle

1. `create_terminal_session()` reuses an existing PTY session if one is alive for the
   container, or spawns a new `docker exec -it zsh` process (DL-007). It reads
   `startup_command` from `.claudebox.json` via the registry → `project_dir` →
   `get_local_config()` chain and stores it in the session dict. If set, the command
   is passed to `docker exec` in place of bare `zsh`. Changes to `startup_command`
   take effect on the next fresh connect; an active session is not restarted. One session per container.
2. `_start_broadcaster()` launches one reader thread for the session.
3. Each SSE handler (detail panel tab, dashboard tile) calls `subscribe_terminal()` and
   receives a dedicated `queue.Queue(maxsize=1024)`.
4. Broadcaster reads PTY master fd → puts chunks into all subscriber queues.
5. Each SSE handler dequeues chunks and streams base64-encoded `data:` events.
6. Input: `onData` → `POST .../terminal/input` → write to PTY master fd.
7. SSE disconnect: handler calls `unsubscribe_terminal()` in `finally`.
8. When subscriber count reaches zero and `last_activity` > 60 s ago, idle reaper calls
   `_cleanup_session()`, which sends None sentinel to any remaining queues and closes
   the PTY fd and process group.
9. On server shutdown, `signal.SIGTERM` and `atexit` handlers close all sessions.
