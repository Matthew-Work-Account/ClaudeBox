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

## Terminal Session Lifecycle

1. Tab click -> `onTerminalTabActivate()` checks `window.Terminal` (CDN load guard).
2. Calls `GET /api/containers/<name>/terminal/stream` (SSE).
3. `create_terminal_session` in `api.py` spawns `docker exec -it zsh`; reuses if alive.
4. Output bytes flow: PTY master fd -> SSE `data:` frames -> xterm.js `write()`.
5. Input: `onData` callback -> `POST .../terminal/input` -> write to PTY master fd.
6. Disconnect: `DELETE .../terminal` closes fd and kills the process group.
7. On server shutdown, `signal.SIGTERM` and `atexit` handlers close all sessions (R-005).

## Running

```bash
# From the repo root (not inside a container):
cd ~/.local/share/claudebox
python3 -m gui
# or with a custom port:
python3 -m gui --port 8080
```

The normal entry point is `claudebox gui [--port <port>]`.
