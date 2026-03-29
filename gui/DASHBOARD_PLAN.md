# Plan

## Overview

The ClaudeBox GUI lacks a consolidated view for monitoring multiple container terminals simultaneously. Users must click into each container detail panel individually to see terminal output, with no way to watch several containers at once or quickly identify which containers have active Claude sessions.

**Approach**: Add a Terminal Dashboard as a new top-level SPA panel (alongside detail, modules, settings). Users pin containers from the detail header; pinned containers appear as auto-arranged CSS Grid tiles, each with a read-only xterm.js preview streaming via SSE. Clicking a tile opens a fullscreen overlay with input enabled. Activity status dots (active/waiting/idle) use client-side timestamp tracking on SSE messages. Pin state stored per-container in the registry (~/.claudebox/registry.json) as a `pinned` boolean field. Server-side PTY output is fan-out broadcast via a per-session subscriber list so multiple SSE readers (dashboard tile + detail panel) receive identical output without os.read() race conditions.

### Terminal Dashboard Data Flow

[Diagram pending Technical Writer rendering: DIAG-001]

### Terminal Dashboard Data Flow

[Diagram pending Technical Writer rendering: DIAG-002]

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Dashboard is a top-level panel via showPanel pattern | Existing SPA uses showPanel() to switch between detail/modules/settings/welcome panels -> adding dashboard-panel follows the same pattern -> no routing library needed, consistent with vanilla JS constraint |
| DL-002 | Client-side activity detection via SSE message timestamps with accepted browser-throttle limitation | Server PTY sessions lack output-timestamp tracking -> adding a server endpoint increases API surface for a UI-only concern -> client Date.now() on each SSE onmessage provides idle/active with zero server changes. Accepted limitation: browser background-tab throttling reduces the frequency of setInterval callbacks that update status dots, which may delay status-dot transitions in background tabs. SSE message delivery itself is not throttled. Mitigation: use a generous idle threshold (30s) so brief throttle pauses don't trigger false status changes. |
| DL-003 | Server-side fan-out broadcaster for PTY output to support multiple concurrent SSE readers | os.read() on PTY master fd is consuming — bytes read by one thread are lost to others. The existing architecture spawns a per-SSE-connection _reader thread that calls os.read(master_fd, 4096) directly; two concurrent SSE streams (dashboard tile + detail panel) for the same container would race on the fd, producing interleaved incomplete output. Fix: add a single reader thread per PTY session that reads from master_fd and broadcasts to a list of subscriber queues. Each SSE handler registers/unregisters its queue. This keeps the one-session-per-container invariant while supporting multiple viewers. Queue size: 1024 per subscriber (not 256) — dashboard tiles may drain slower than focused terminal tabs; a larger queue avoids silent drops during bursts. Silent drop behavior: `queue.put_nowait()` silently discards frames when the queue is full; this is documented and accepted for preview tiles. Broadcaster restart guard: if the broadcaster thread dies (e.g., PTY closed unexpectedly), `_start_broadcaster()` checks `thread.is_alive()` before spawning a new one. |
| DL-004 | Tiles are read-only previews; fullscreen overlay enables input | Grid tiles are small and multiple are visible simultaneously -> enabling input on all would cause keystroke ambiguity -> read-only preview with click-to-fullscreen gives clear input focus |
| DL-005 | Pin state stored in the container registry as a `pinned` field per entry | ClaudeBox is a single-machine local tool — localStorage is browser-specific and lost on browser data clear. The registry is the authoritative per-container store; adding `pinned: true` to a container entry is consistent with how all other container state is managed. Automatic cleanup: when `claudebox destroy` removes a registry entry the pin is gone for free. CLI coupling: `registry_add`/`registry_remove` in claudebox.sh rewrite entries atomically; the `pinned` field must be preserved on partial updates — use `_write_json_atomic` merge pattern in api.py. |
| DL-006 | Dashboard SSE disconnects unsubscribe from broadcaster; DELETE only when ALL subscribers gone and idle timeout expires | The detail-panel Terminal tab may have an active session for the same container -> calling DELETE immediately on unpin would kill the shared PTY. Dashboard tiles only unsubscribe their queue from the broadcaster. A server-side idle reaper closes PTY sessions that have zero subscribers and no activity for 60 seconds, preventing orphan accumulation while protecting active consumers. |
| DL-007 | Reuse existing SSE+POST terminal infrastructure for dashboard connections | SSE stream endpoint (GET /terminal/stream) and input endpoint (POST /terminal/input) already handle PTY lifecycle -> dashboard tiles use the same endpoints with the fan-out broadcaster (DL-003) -> no new transport protocol needed, WebSocket prohibited by stdlib constraint |
| DL-008 | CSS Grid auto-fill with minmax(320px, 1fr) instead of ceil(sqrt(n)) JS-computed columns | CSS auto-fill minmax is purely declarative and responsive — the browser handles column count based on viewport width with no JS layout computation needed. ceil(sqrt(n)) requires JS recalculation on resize and pin changes. Auto-fill handles edge cases naturally: 0 pinned containers shows empty-state div (AC in M-001), 1 pinned container fills available width, many containers wrap to multiple rows automatically. 320px minimum ensures terminals remain readable. |
| DL-009 | Superseded by DL-002 — stale duplicate removed | DL-009 and DL-002 both described client-side activity detection via SSE timestamps. DL-002 v2 is the authoritative entry with accepted-limitation language. DL-009 is retired. |
| DL-010 | Shared PTY session with reference-counted EventSource manager | One PTY per container (DL-007) means dashboard tile and detail panel share the same session -> multiple xterm.js instances can write() from same SSE stream -> ref-counted manager ensures EventSource stays open while any consumer exists and closes on last detach |
| DL-011 | Superseded by DL-001 — stale duplicate removed | DL-011 (dashboard as sixth top-level panel) restates DL-001 (dashboard top-level via showPanel). DL-001 is authoritative. DL-011 retired. |
| DL-012 | Superseded by DL-008 — grid layout uses CSS auto-fill minmax | DL-012 prescribed ceil(sqrt(n)) columns but DL-008 explicitly rejected that approach in favor of CSS auto-fill minmax(320px,1fr). The implemented CSS in M-001 follows DL-008. DL-012 is retired. |
| DL-013 | Fullscreen overlay with position:fixed, re-enable input on enter | Dashboard tiles are read-only previews to avoid accidental input -> fullscreen needs keyboard focus -> position:fixed overlay isolates the terminal and re-enables onData handler -> ESC or close button exits fullscreen and disables input again. z-index: 1001 required — existing file-viewer modal uses z-index: 1000; fullscreen overlay must be set to z-index: 1001 to stack above it. ESC handler must check `document.querySelector('.file-viewer-modal:not(.hidden)')` and skip if file-viewer modal is open, to avoid closing the wrong overlay. |
| DL-014 | Superseded by DL-003 — server-side fan-out broadcaster required | DL-014 (zero server-side changes) was an early assumption that held when only one SSE reader was expected per container. DL-003 correctly identified that concurrent dashboard tile + detail panel SSE streams race on the PTY fd. M-002 implements the broadcaster in api.py and updates server.py. DL-014 is retired; DL-003 is authoritative. |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| WebSocket transport | Python stdlib http.server cannot handle HTTP upgrade; would require a pip dependency, violating the stdlib-only constraint (ref: DL-007) |
| localStorage for pin state | ClaudeBox runs on a single machine; localStorage is browser-specific and not durable across browser data clears. The registry already stores all container state and is the natural fit. |
| iframe per terminal tile | SSE sessions already work per-container; iframes add weight and cross-origin complexity for no benefit (ref: DL-003) |
| Server-side status endpoint for activity detection | Adds API surface for a UI-only concern; client-side timestamp tracking achieves the same result with zero server changes (ref: DL-002) |

### Constraints

- MUST: No external JS framework — vanilla JS only, no build step
- MUST: No pip dependencies — Python stdlib only on the server
- MUST: Use existing SSE+POST terminal infrastructure (DL-001, DL-004, DL-007)
- MUST: xterm.js loaded from vendored static/vendor/ (not CDN for dashboard use)
- MUST NOT: WebSocket — stdlib HTTP server cannot handle upgrade
- MUST NOT: Break existing Terminal tab in container detail panel
- SHOULD: One PTY session per container — reuse existing session if alive (DL-007)
- SHOULD: Dashboard is a new top-level view (separate from the detail panel)
- SHOULD: Pin state stored in registry via PATCH /api/containers/<name>/pin endpoint

### Known Risks

- **PTY orphan accumulation: if all consumers disconnect (no detail panel, no dashboard tiles) the PTY process persists indefinitely**: Server-side idle reaper (DL-006): a background thread checks sessions with zero broadcaster subscribers every 30s; sessions idle for 60s with zero subscribers are closed via _cleanup_session(). Reaper thread starts on first terminal session creation and stops when no sessions remain.
- **Browser background-tab throttling reduces setInterval frequency, delaying status-dot updates when the dashboard is in a background tab.**: Use 30s idle threshold (DL-002) so brief throttle pauses don't trigger false status. Document as accepted limitation.
- **PTY orphan risk: dashboard tiles sharing a PTY session with the detail panel could leave orphaned PTY processes if all consumers disconnect without cleanup**: Dashboard unpin/close calls unsubscribe (not DELETE) to avoid killing shared PTY. Server-side idle reaper (DL-006) monitors subscriber count and last_activity timestamp; sessions with zero subscribers and >60s inactivity are automatically cleaned up via _cleanup_session(). This prevents orphan accumulation without risking premature termination of sessions still in use by the detail panel.

## Invisible Knowledge

### System

GUI runs on the host (not inside a container). Python stdlib only, no pip dependencies. Vanilla JS SPA with no build step. xterm.js 5.5.0 vendored in static/vendor/.

### Invariants

- xterm.js FitAddon must be called after element is visible and sized — critical for dashboard tiles that may be hidden or zero-sized at creation time; use ResizeObserver to trigger fit() when tile becomes visible
- One PTY session per container — dashboard tiles and detail panel Terminal tab share the same server-side PTY session; multiple viewers are supported via the fan-out broadcaster (DL-003), not multiple PTY processes

### Tradeoffs

- SSE+POST per-keystroke latency is acceptable for interactive terminal use, but polling for status must be infrequent — activity detection uses client-side timestamps on SSE data events rather than polling a server endpoint
- PTY cleanup: dashboard does NOT call DELETE on unpin (would kill shared PTY); instead relies on subscriber-count-based idle reaper (DL-006) to eventually clean up sessions with no consumers

## Milestones

### Milestone 1: Dashboard panel shell and pin management

**Files**: gui/static/index.html, gui/static/app.js, gui/static/style.css

**Acceptance Criteria**:

- Terminals sidebar button appears between Module Library and Settings
- Clicking Terminals button shows #dashboard-panel and hides other panels
- Pin button visible on container detail header; toggles container in/out of pinned list
- Pinned containers stored as `pinned: true` in registry entries via PATCH /api/containers/<name>/pin
- Dashboard grid renders a tile per pinned container with name, status badge, unpin button
- Unpinning removes tile and sends PATCH /api/containers/<name>/pin with pinned=false
- Empty dashboard (0 pinned) shows placeholder message

#### Code Intent

- **CI-M-001-001** `gui/static/index.html`: Add a #dashboard-panel section in <main> alongside existing panels (detail-panel, new-panel, welcome-panel, modules-panel, settings-panel). Contains a header with title Terminals and an empty #dashboard-grid container div. Add an empty-state div inside #dashboard-panel shown when no containers are pinned. Add a Terminals sidebar button in .sidebar-tools (between Module Library and Settings) with a grid icon SVG. (refs: DL-001)
- **CI-M-001-002** `gui/static/app.js`: Add dashboardPanel DOM ref. Extend showPanel() to handle name=dashboard (hide all others, show dashboard-panel, toggle active class on dashboard-nav-btn). Add click handler on dashboard-nav-btn that calls showPanel(dashboard) and renderDashboardGrid(). Replace `getPinnedContainers()/setPinnedContainers()` localStorage helpers with `fetchPinnedContainers()` that calls GET /api/containers and filters `c.pinned === true`, and `setPinned(name, pinned)` that calls `PATCH /api/containers/<name>/pin`. Add a pin/unpin toggle button to the container detail header (near the nickname area) that adds/removes the selected container from the pinned list. Add renderDashboardGrid() that calls fetchPinnedContainers(), and renders placeholder tiles (container name + status badge + unpin button) into #dashboard-grid. Show empty-state div when pinned list is empty. Unpin button calls setPinned(name, false) and re-renders grid. (refs: DL-001, DL-005)
- **CI-M-001-003** `gui/static/style.css`: Add #dashboard-panel styles matching existing panel patterns. Add .dashboard-grid as a CSS Grid with auto-fill columns (minmax(320px, 1fr)), gap of var(--space-md, 16px). Add .dashboard-tile with border, border-radius, background var(--bg-card), overflow hidden, display flex flex-direction column. Add .dashboard-tile-header with container name, status dot, and unpin button laid out as flex row. Add .dashboard-empty-state centered text styling. Style the sidebar Terminals button consistent with existing .sidebar-tool-item pattern. Add z-index: 1001 to .dashboard-fullscreen-overlay to stack above file-viewer modal (z-index: 1000). (refs: DL-001, DL-008, DL-013)
- **CI-M-001-004** `gui/api.py`: Add `PATCH /api/containers/<name>/pin` endpoint that reads the registry entry for the container, sets `pinned: true/false` based on request body `{"pinned": true/false}`, and writes back atomically using the `_write_json_atomic` merge pattern. Return 200 with updated entry or 404 if not found. Also update `list_containers()` to include `pinned` field (defaulting to False) in the returned container dicts. (refs: DL-005)

#### Code Changes

**CC-M-001-001** (gui/static/index.html) - implements CI-M-001-001

**Code:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -51,6 +51,16 @@
           <span>Module Library</span>
         </button>
+        <button id="dashboard-nav-btn" class="sidebar-tool-item">
+          <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
+            <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor"/>
+            <rect x="8" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.5"/>
+            <rect x="1" y="8" width="6" height="6" rx="1" fill="currentColor" opacity="0.5"/>
+            <rect x="8" y="8" width="6" height="6" rx="1" fill="currentColor"/>
+          </svg>
+          <span>Terminals</span>
+        </button>
         <button id="settings-nav-btn" class="sidebar-tool-item">
```

**Documentation:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -51,6 +51,16 @@
           <span>Module Library</span>
         </button>
+        <!-- Dashboard nav: navigates to #dashboard-panel (DL-001) -->
         <button id="dashboard-nav-btn" class="sidebar-tool-item">

```


**CC-M-001-002** (gui/static/index.html) - implements CI-M-001-001

**Code:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -613,6 +613,27 @@
       </section>
 
       <section id="welcome-panel" class="panel">
+      <section id="dashboard-panel" class="panel hidden">
+        <div class="dashboard-header">
+          <h2>Terminals</h2>
+        </div>
+        <div id="dashboard-grid" class="dashboard-grid"></div>
+        <div id="dashboard-empty-state" class="dashboard-empty-state">
+          No terminals pinned. Open a container and click <strong>Pin</strong> to add it here.
+        </div>
+      </section>
+
+      <!-- Fullscreen overlay for dashboard terminal interaction -->
+      <div id="dashboard-fullscreen-overlay" class="dashboard-fullscreen-overlay hidden">
+        <div class="dashboard-fullscreen-header">
+          <span id="fullscreen-container-name" class="dashboard-fullscreen-title"></span>
+          <span id="fullscreen-status-label" class="terminal-status-label"></span>
+          <button id="fullscreen-close-btn" class="cmd-btn">&#x2715; Close</button>
+        </div>
+        <div id="fullscreen-xterm-container" class="dashboard-fullscreen-body"></div>
+      </div>
+
       <section id="welcome-panel" class="panel">
```

**Documentation:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -613,6 +613,27 @@
       </section>
 
+      <!-- #dashboard-panel: top-level panel rendered by showPanel("dashboard") (DL-001).
+           #dashboard-grid: populated by renderDashboardGrid() in app.js.
+           #dashboard-fullscreen-overlay: position:fixed overlay for interactive terminal
+           sessions; hidden by default, shown by _openDashboardFullscreen() (DL-013). -->
       <section id="dashboard-panel" class="panel hidden">

```


**CC-M-001-003** (gui/static/app.js) - implements CI-M-001-002

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -59,6 +59,8 @@
 const modulesPanel           = document.getElementById("modules-panel");
 const settingsPanel          = document.getElementById("settings-panel");
+const dashboardPanel         = document.getElementById("dashboard-panel");
 const globalModuleList       = document.getElementById("global-module-list");
@@ -123,6 +125,8 @@
 function showPanel(name) {
   detailPanel.classList.add("hidden");
   newPanel.classList.add("hidden");
   welcomePanel.classList.add("hidden");
   modulesPanel.classList.add("hidden");
   settingsPanel.classList.add("hidden");
+  dashboardPanel.classList.add("hidden");
   if (name === "detail")        detailPanel.classList.remove("hidden");
   else if (name === "new")      newPanel.classList.remove("hidden");
   else if (name === "modules")  modulesPanel.classList.remove("hidden");
   else if (name === "settings") settingsPanel.classList.remove("hidden");
+  else if (name === "dashboard") dashboardPanel.classList.remove("hidden");
   else                          welcomePanel.classList.remove("hidden");
   document.getElementById("modules-nav-btn").classList.toggle("active", name === "modules");
   document.getElementById("settings-nav-btn").classList.toggle("active", name === "settings");
+  document.getElementById("dashboard-nav-btn").classList.toggle("active", name === "dashboard");
 }
@@ -3565,3 +3569,175 @@
 // --- Init ---
 
 loadContainers();
+
+// --- Dashboard (pinned container terminals) ---
+
+const _dashboardTiles = {};
+let _dashboardStatusInterval = null;
+
+function getDashboardTerminalTheme() {
+  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
+  return isDark
+    ? { background: "#0d0d0d", foreground: "#c8e6c9", cursor: "#a0cfb0" }
+    : { background: "#f8f9fa", foreground: "#1e2433", cursor: "#1e2433" };
+}
+
+function fetchPinnedContainers() {
+  return fetch("/api/containers")
+    .then(function (r) { return r.json(); })
+    .then(function (containers) { return containers.filter(function (c) { return c.pinned === true; }); });
+}
+
+function setPinned(name, pinned) {
+  return fetch("/api/containers/" + encodeURIComponent(name) + "/pin", {
+    method: "PATCH",
+    headers: { "Content-Type": "application/json" },
+    body: JSON.stringify({ pinned: pinned }),
+  });
+}
+
+function togglePinContainer(name) {
+  fetchPinnedContainers().then(function (pinned) {
+    const isPinned = pinned.some(function (c) { return c.name === name; });
+    setPinned(name, !isPinned).then(function () {
+      _updatePinBtnLabel(name);
+      if (document.getElementById("dashboard-panel") && !document.getElementById("dashboard-panel").classList.contains("hidden")) {
+        renderDashboardGrid();
+      }
+    });
+  });
+  if (document.getElementById("dashboard-panel") && !document.getElementById("dashboard-panel").classList.contains("hidden")) {
+    renderDashboardGrid();
+  }
+}
+
+function _updatePinBtnLabel(name) {
+  const btn = document.getElementById("detail-pin-btn");
+  if (!btn) return;
+  fetchPinnedContainers().then(function (pinned) {
+    btn.textContent = pinned.some(function (c) { return c.name === name; }) ? "Unpin" : "Pin";
+  });
+}
+
+function renderDashboardGrid() {
+  const grid = document.getElementById("dashboard-grid");
+  const emptyState = document.getElementById("dashboard-empty-state");
+  if (!grid) return;
+
+  fetchPinnedContainers()
+    .then(function (pinnedContainers) {
+      const pinnedNames = pinnedContainers.map(function (c) { return c.name; });
+
+      _teardownDashboardTiles(Object.keys(_dashboardTiles).filter(function (n) { return !pinnedNames.includes(n); }));
+
+      if (pinnedNames.length === 0) {
+        grid.innerHTML = "";
+        if (emptyState) emptyState.classList.remove("hidden");
+        return;
+      }
+      if (emptyState) emptyState.classList.add("hidden");
+
+      const byName = {};
+      pinnedContainers.forEach(function (c) { byName[c.name] = c; });
+
+      pinnedNames.forEach(function (name) {
+        if (_dashboardTiles[name]) return;
+        _createDashboardTile(grid, byName[name] || { name: name, status: "unknown" });
+      });
+
+      Array.from(grid.querySelectorAll(".dashboard-tile")).forEach(function (tile) {
+        const tileName = tile.dataset.container;
+        if (!pinnedNames.includes(tileName)) {
+          _teardownDashboardTiles([tileName]);
+          tile.remove();
+        }
+      });
+    })
+    .catch(function () {});
+}
+
+function _createDashboardTile(grid, container) {
+  const name = container.name;
+  const tile = document.createElement("div");
+  tile.className = "dashboard-tile";
+  tile.dataset.container = name;
+
+  const header = document.createElement("div");
+  header.className = "dashboard-tile-header";
+
+  const statusDot = document.createElement("span");
+  statusDot.className = "dashboard-status-dot status-idle";
+
+  const nameSpan = document.createElement("span");
+  nameSpan.className = "dashboard-tile-name";
+  nameSpan.textContent = name;
+
+  const unpinBtn = document.createElement("button");
+  unpinBtn.className = "dashboard-tile-unpin cmd-btn";
+  unpinBtn.textContent = "Unpin";
+  unpinBtn.addEventListener("click", function (e) {
+    e.stopPropagation();
+    setPinned(name, false).then(function () {
+      _teardownDashboardTiles([name]);
+      tile.remove();
+      _updatePinBtnLabel(name);
+      fetchPinnedContainers().then(function (pinned) {
+        const emptyState = document.getElementById("dashboard-empty-state");
+        if (emptyState) emptyState.classList.toggle("hidden", pinned.length > 0);
+      });
+    });
+  });
+
+  const fsBtn = document.createElement("button");
+  fsBtn.className = "dashboard-tile-fullscreen cmd-btn";
+  fsBtn.title = "Fullscreen";
+  fsBtn.textContent = "⛶";
+  fsBtn.addEventListener("click", function (e) {
+    e.stopPropagation();
+    _openDashboardFullscreen(name);
+  });
+
+  header.appendChild(statusDot);
+  header.appendChild(nameSpan);
+  header.appendChild(unpinBtn);
+  header.appendChild(fsBtn);
+
+  const xtermContainer = document.createElement("div");
+  xtermContainer.className = "dashboard-tile-body";
+
+  tile.appendChild(header);
+  tile.appendChild(xtermContainer);
+  grid.appendChild(tile);
+
+  if (!window.Terminal) {
+    xtermContainer.textContent = "xterm.js not available";
+    return;
+  }
+
+  const xterm = new window.Terminal({
+    theme: getDashboardTerminalTheme(),
+    fontSize: 11,
+    scrollback: 500,
+    disableStdin: true,
+  });
+  let fitAddon = null;
+  if (window.FitAddon) {
+    fitAddon = new window.FitAddon.FitAddon();
+    xterm.loadAddon(fitAddon);
+  }
+  xterm.open(xtermContainer);
+
+  if (fitAddon && typeof ResizeObserver !== "undefined") {
+    const ro = new ResizeObserver(function () {
+      if (fitAddon && xtermContainer.offsetWidth > 0) fitAddon.fit();
+    });
+    ro.observe(xtermContainer);
+    xterm._dashRo = ro;
+  }
+
+  const es = new EventSource("/api/containers/" + encodeURIComponent(name) + "/terminal/stream");
+  es.onmessage = function (evt) {
+    try {
+      const msg = JSON.parse(evt.data);
+      if (msg.data) {
+        xterm.write(atob(msg.data));
+      }
+    } catch (e) {}
+    if (_dashboardTiles[name]) _dashboardTiles[name].lastActivity = Date.now();
+  };
+
+  _dashboardTiles[name] = { xterm: xterm, fitAddon: fitAddon, eventSource: es, lastActivity: 0 };
+  requestAnimationFrame(function () {
+    if (fitAddon && xtermContainer.offsetWidth > 0) fitAddon.fit();
+  });
+}
+
+function _teardownDashboardTiles(names) {
+  names.forEach(function (name) {
+    const tile = _dashboardTiles[name];
+    if (!tile) return;
+    if (tile.eventSource) tile.eventSource.close();
+    if (tile.xterm) {
+      if (tile.xterm._dashRo) tile.xterm._dashRo.disconnect();
+      tile.xterm.dispose();
+    }
+    delete _dashboardTiles[name];
+  });
+}
+
+function _startDashboardStatusInterval() {
+  if (_dashboardStatusInterval) return;
+  _dashboardStatusInterval = setInterval(function () {
+    const now = Date.now();
+    Object.keys(_dashboardTiles).forEach(function (name) {
+      const tile = _dashboardTiles[name];
+      const tileEl = document.querySelector(".dashboard-tile[data-container='" + name + "']");
+      if (!tileEl) return;
+      const dot = tileEl.querySelector(".dashboard-status-dot");
+      if (!dot) return;
+      const elapsed = tile.lastActivity ? (now - tile.lastActivity) : Infinity;
+      dot.className = "dashboard-status-dot " + (
+        elapsed < 3000 ? "status-active" :
+        elapsed < 30000 ? "status-waiting" :
+        "status-idle"
+      );
+    });
+  }, 2000);
+}
+
+function _stopDashboardStatusInterval() {
+  if (_dashboardStatusInterval) {
+    clearInterval(_dashboardStatusInterval);
+    _dashboardStatusInterval = null;
+  }
+}
+
+function _openDashboardFullscreen(name) {
+  const overlay = document.getElementById("dashboard-fullscreen-overlay");
+  const xtermContainer = document.getElementById("fullscreen-xterm-container");
+  const nameLabel = document.getElementById("fullscreen-container-name");
+  const statusLabel = document.getElementById("fullscreen-status-label");
+  if (!overlay || !xtermContainer) return;
+
+  const tileState = _dashboardTiles[name];
+  if (tileState && tileState.eventSource) {
+    tileState.eventSource.close();
+    tileState.eventSource = null;
+  }
+
+  xtermContainer.innerHTML = "";
+  nameLabel.textContent = name;
+  statusLabel.textContent = "Connected";
+  overlay.classList.remove("hidden");
+
+  const fsXterm = new window.Terminal({
+    theme: getDashboardTerminalTheme(),
+    fontSize: 13,
+    scrollback: 1000,
+  });
+  let fsFitAddon = null;
+  if (window.FitAddon) {
+    fsFitAddon = new window.FitAddon.FitAddon();
+    fsXterm.loadAddon(fsFitAddon);
+  }
+  fsXterm.open(xtermContainer);
+
+  if (fsFitAddon && typeof ResizeObserver !== "undefined") {
+    const fsRo = new ResizeObserver(function () {
+      if (fsFitAddon && xtermContainer.offsetWidth > 0) fsFitAddon.fit();
+    });
+    fsRo.observe(xtermContainer);
+    fsXterm._fsRo = fsRo;
+  } else if (fsFitAddon) {
+    requestAnimationFrame(function () { fsFitAddon.fit(); });
+  }
+
+  const fsEs = new EventSource("/api/containers/" + encodeURIComponent(name) + "/terminal/stream");
+  fsEs.onmessage = function (evt) {
+    try {
+      const msg = JSON.parse(evt.data);
+      if (msg.data) fsXterm.write(atob(msg.data));
+    } catch (e) {}
+  };
+
+  const inputDisposable = fsXterm.onData(function (data) {
+    fetch("/api/containers/" + encodeURIComponent(name) + "/terminal/input", {
+      method: "POST",
+      headers: { "Content-Type": "application/json" },
+      body: JSON.stringify({ data: data }),
+    }).catch(function () {});
+  });
+
+  function closeFullscreen() {
+    fsEs.close();
+    inputDisposable.dispose();
+    if (fsXterm._fsRo) fsXterm._fsRo.disconnect();
+    fsXterm.dispose();
+    overlay.classList.add("hidden");
+    document.removeEventListener("keydown", escHandler);
+    const tileStateAfter = _dashboardTiles[name];
+    if (tileStateAfter && !tileStateAfter.eventSource) {
+      const newEs = new EventSource("/api/containers/" + encodeURIComponent(name) + "/terminal/stream");
+      newEs.onmessage = function (evt) {
+        try {
+          const msg2 = JSON.parse(evt.data);
+          if (msg2.data && tileStateAfter.xterm) tileStateAfter.xterm.write(atob(msg2.data));
+        } catch (e) {}
+        if (_dashboardTiles[name]) _dashboardTiles[name].lastActivity = Date.now();
+      };
+      tileStateAfter.eventSource = newEs;
+    }
+  }
+
+  function escHandler(e) {
+    if (e.key === "Escape") {
+      if (document.querySelector('.file-viewer-modal:not(.hidden)')) return;
+      closeFullscreen();
+    }
+  }
+  document.addEventListener("keydown", escHandler);
+  document.getElementById("fullscreen-close-btn").onclick = closeFullscreen;
+}
+
+document.getElementById("dashboard-nav-btn").addEventListener("click", function () {
+  document.querySelectorAll(".container-item").forEach(function (el) { el.classList.remove("active"); });
+  showPanel("dashboard");
+  renderDashboardGrid();
+  _startDashboardStatusInterval();
+});
```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3569,3 +3569,175 @@
 loadContainers();
+
+// --- Dashboard (pinned container terminals) ---
+//
+// Architecture:
+//   - Pin state: registry pinned field via PATCH /api/containers/<name>/pin (DL-005)
+//   - Grid layout: CSS auto-fill minmax(320px,1fr) — no JS column math (DL-008)
+//   - Tiles are read-only xterm.js previews; fullscreen enables input (DL-004)
+//   - Activity detection: client-side SSE timestamp diff, 30s idle threshold (DL-002)
+//   - PTY sessions shared with detail panel; unpin closes SSE but not PTY (DL-006)
+//   - Server fan-out broadcaster handles concurrent SSE readers (DL-003)
 
+const _dashboardTiles = {};
+// _dashboardTiles: keyed by container name; each entry:
+//   { xterm, fitAddon, eventSource, lastActivity }
+// eventSource is null while fullscreen overlay is open for that container.
+let _dashboardStatusInterval = null;
 
+// Returns xterm.js theme tokens for the current light/dark mode.
 function getDashboardTerminalTheme() {
+  // Reads data-theme attribute set by the theme toggle; defaults to dark.
   const isDark = document.documentElement.getAttribute("data-theme") !== "light";
   return isDark
     ? { background: "#0d0d0d", foreground: "#c8e6c9", cursor: "#a0cfb0" }
     : { background: "#f8f9fa", foreground: "#1e2433", cursor: "#1e2433" };
 }
 
+// Fetches pinned containers from the registry via GET /api/containers (DL-005).
+// Returns a Promise resolving to an array of container objects with pinned===true.
 function fetchPinnedContainers() {
   return fetch("/api/containers")
     .then(function (r) { return r.json(); })
     .then(function (containers) { return containers.filter(function (c) { return c.pinned === true; }); });
 }

+// Sets the pinned state for a container via PATCH /api/containers/<name>/pin (DL-005).
 function setPinned(name, pinned) {
   return fetch("/api/containers/" + encodeURIComponent(name) + "/pin", {
     method: "PATCH",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ pinned: pinned }),
   });
 }

+// Toggles pin state for a container by reading current state from the registry,
+// sending a PATCH to flip it, then refreshing the dashboard grid if visible.
 function togglePinContainer(name) {
   fetchPinnedContainers().then(function (pinned) {
     const isPinned = pinned.some(function (c) { return c.name === name; });
     setPinned(name, !isPinned).then(function () {
       _updatePinBtnLabel(name);
       if (!dashboardPanel.classList.contains("hidden")) renderDashboardGrid();
     });
   });
 }

+// Syncs the "Pin"/"Unpin" label on #detail-pin-btn to match current registry pin state.
 function _updatePinBtnLabel(name) {
   const btn = document.getElementById("detail-pin-btn");
   if (!btn) return;
   fetchPinnedContainers().then(function (pinned) {
     btn.textContent = pinned.some(function (c) { return c.name === name; }) ? "Unpin" : "Pin";
   });
 }

+// Renders the dashboard grid from the current pinned container list in the registry.
+// Creates tiles for newly pinned containers; removes tiles for unpinned ones.
+// Shows the empty-state element when no containers are pinned (DL-008).
 function renderDashboardGrid() {
   const grid = document.getElementById("dashboard-grid");
   const emptyState = document.getElementById("dashboard-empty-state");
   if (!grid) return;

   fetchPinnedContainers().then(function (pinnedContainers) {
     const pinned = pinnedContainers.map(function (c) { return c.name; });
     const existing = Object.keys(_dashboardTiles);
     const toAdd = pinned.filter(function (n) { return !existing.includes(n); });
     const toRemove = existing.filter(function (n) { return !pinned.includes(n); });

     _teardownDashboardTiles(toRemove);
     toRemove.forEach(function (n) {
       const el = grid.querySelector(".dashboard-tile[data-container='" + n + "']");
       if (el) el.remove();
     });

     toAdd.forEach(function (n) { _createDashboardTile(n, grid); });

     if (emptyState) emptyState.style.display = pinned.length === 0 ? "" : "none";
   });
 }
 
+// Creates one dashboard tile DOM element for container name and appends it to grid.
+//
+// Tile layout: header (status dot + name + Unpin + Fullscreen) + tile-body (xterm).
+// The xterm.js instance is configured read-only (disableStdin: true) (DL-004).
+//
+// FitAddon.fit() must be called only after the tile element is visible and has
+// non-zero dimensions. Calling fit() on a hidden or zero-sized element fails
+// silently: the terminal canvas is sized to 0x0 and subsequent output renders
+// incorrectly. A ResizeObserver on the tile-body element triggers fit() once the
+// element is laid out, ensuring correct sizing even when the dashboard panel
+// renders tiles before they become visible.
+//
+// An EventSource subscribes to /api/containers/<name>/terminal/stream (DL-007);
+// each SSE message updates lastActivity for client-side status detection (DL-002).
+// The tile state is stored in _dashboardTiles[name].
 function _createDashboardTile(name, grid) {
 }
 
+// Closes EventSources and disposes xterm.js instances for the given container names.
+// Removes entries from _dashboardTiles.
+// Closing the EventSource unsubscribes from the server broadcaster (DL-006):
+// the PTY session itself is NOT deleted here, preserving any detail panel session.
 function _teardownDashboardTiles(names) {
 }
 
+// Starts a 2-second interval that updates activity status dots on all visible tiles.
+// Status classification by elapsed time since last SSE message (DL-002):
+//   < 3s  -> status-active  (green pulse)
+//   < 30s -> status-waiting (yellow)
+//   >= 30s or never -> status-idle (grey)
+// 30s idle threshold prevents false-idle from browser background-tab SSE throttling (R-002).
 function _startDashboardStatusInterval() {
   if (_dashboardStatusInterval) return;
   _dashboardStatusInterval = setInterval(function () {
 }
 
+// Clears the status dot update interval started by _startDashboardStatusInterval().
 function _stopDashboardStatusInterval() {
   if (_dashboardStatusInterval) {
     clearInterval(_dashboardStatusInterval);
     _dashboardStatusInterval = null;
   }
 }
 
+// Opens the fullscreen overlay for container name, enabling interactive input (DL-013).
+//
+// Closes the tile's read-only EventSource before opening the overlay to avoid two
+// concurrent SSE readers on the same container from the same browser tab (DL-003).
+// A new xterm.js instance (input enabled) and EventSource are created for the overlay.
+// Keyboard input is forwarded via POST /api/containers/<name>/terminal/input.
+// On close (ESC or close button), the overlay EventSource and xterm are disposed, and
+// the tile's EventSource is re-opened to resume read-only preview (DL-004).
 function _openDashboardFullscreen(name) {
 }
 
 document.getElementById("dashboard-nav-btn").addEventListener("click", function () {
+  // Deselect container list items; show dashboard panel; render grid; start status ticker.
   document.querySelectorAll(".container-item").forEach(function (el) { el.classList.remove("active"); });
   showPanel("dashboard");
   renderDashboardGrid();
   _startDashboardStatusInterval();
 });

```


**CC-M-001-004** (gui/static/style.css) - implements CI-M-001-003

**Code:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -2894,3 +2894,78 @@
 .refs-refresh-row { margin-top: 4px; }
 .checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
 .checkbox-label input[type="checkbox"] { margin: 0; }
+
+/* --- Dashboard panel --- */
+
+#dashboard-panel {
+  padding: var(--space-md);
+}
+
+.dashboard-header {
+  display: flex;
+  align-items: center;
+  gap: var(--space-md);
+  margin-bottom: var(--space-md);
+}
+
+.dashboard-header h2 {
+  margin: 0;
+}
+
+.dashboard-grid {
+  display: grid;
+  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
+  gap: var(--space-md);
+}
+
+.dashboard-empty-state {
+  grid-column: 1 / -1;
+  text-align: center;
+  padding: var(--space-xl);
+  color: var(--text-secondary);
+  font-size: 14px;
+}
+
+.dashboard-tile {
+  border: 1px solid var(--border);
+  border-radius: 6px;
+  background: var(--bg-card);
+  overflow: hidden;
+  display: flex;
+  flex-direction: column;
+  min-height: 280px;
+}
+
+.dashboard-tile-header {
+  display: flex;
+  align-items: center;
+  gap: var(--space-sm);
+  padding: 6px var(--space-sm);
+  background: var(--bg-elevated);
+  border-bottom: 1px solid var(--border);
+  flex-shrink: 0;
+}
+
+.dashboard-tile-name {
+  flex: 1;
+  font-size: 13px;
+  font-weight: 500;
+  overflow: hidden;
+  text-overflow: ellipsis;
+  white-space: nowrap;
+}
+
+.dashboard-tile-unpin,
+.dashboard-tile-fullscreen {
+  padding: 2px 6px;
+  font-size: 11px;
+  flex-shrink: 0;
+}
+
+.dashboard-tile-body {
+  flex: 1;
+  min-height: 0;
+  overflow: hidden;
+  background: var(--bg-terminal);
+}
+
+.dashboard-status-dot {
+  width: 8px;
+  height: 8px;
+  border-radius: 50%;
+  display: inline-block;
+  flex-shrink: 0;
+}
+
+.status-active {
+  background: var(--success);
+  animation: dash-pulse 1s infinite;
+}
+
+.status-waiting {
+  background: var(--warning);
+}
+
+.status-idle {
+  background: var(--text-muted);
+}
+
+@keyframes dash-pulse {
+  0%, 100% { opacity: 1; }
+  50% { opacity: 0.4; }
+}
+
+.dashboard-fullscreen-overlay {
+  position: fixed;
+  inset: 0;
+  z-index: 1001;
+  background: var(--bg-main);
+  display: flex;
+  flex-direction: column;
+}
+
+.dashboard-fullscreen-overlay.hidden {
+  display: none;
+}
+
+.dashboard-fullscreen-header {
+  display: flex;
+  align-items: center;
+  gap: var(--space-md);
+  padding: var(--space-sm) var(--space-md);
+  background: var(--bg-elevated);
+  border-bottom: 1px solid var(--border);
+  flex-shrink: 0;
+}
+
+.dashboard-fullscreen-title {
+  flex: 1;
+  font-weight: 600;
+  font-size: 14px;
+}
+
+.dashboard-fullscreen-body {
+  flex: 1;
+  min-height: 0;
+  overflow: hidden;
+  background: var(--bg-terminal);
+  padding: 4px;
+}
+
+.dashboard-fullscreen-body .xterm {
+  flex: 1;
+  min-height: 0;
+  max-height: none;
+}
+
+.dashboard-pin-btn {
+  padding: 2px 8px;
+  font-size: 12px;
+}
+
+@media (max-width: 700px) {
+  .dashboard-grid {
+    grid-template-columns: 1fr;
+  }
+}
```

**Documentation:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -2894,3 +2894,78 @@
 .checkbox-label input[type="checkbox"] { margin: 0; }
+
+/* --- Dashboard panel ---
+   Grid: CSS auto-fill minmax(320px,1fr) — browser handles column count based on
+   viewport width; no JS column math required (DL-008). 320px minimum keeps
+   terminals readable at all viewport sizes.
+   Status dots: .status-active (green pulse), .status-waiting (yellow),
+   .status-idle (grey) — classified by client-side SSE timestamp diff (DL-002).
+   Fullscreen overlay: position:fixed over entire viewport; z-index 1001 — stacks above file-viewer modal (z-index 1000) (DL-013). */
 
+#dashboard-panel {

```


### Milestone 2: Server-side PTY fan-out broadcaster

**Files**: gui/api.py, gui/server.py

**Acceptance Criteria**:

- Single reader thread per PTY session reads from master_fd and broadcasts to subscriber queues
- SSE handler registers a queue on connect and unregisters on disconnect
- Two concurrent SSE connections for the same container both receive complete, identical output
- Detail-panel Terminal tab operates through the same broadcaster/subscriber path as dashboard tiles
- Idle reaper thread closes sessions with zero subscribers after 60s inactivity

#### Code Intent

- **CI-M-002-001** `gui/api.py::create_terminal_session`: Extend _terminal_sessions entry to include a 'subscribers' list (list of queue.Queue), a 'broadcaster' thread, and a 'last_activity' timestamp. When a new PTY session is created, start a daemon broadcaster thread that loops: select() on master_fd, os.read() into a buffer, then iterates over subscribers list and puts the bytes chunk into each queue (skip full queues with put_nowait wrapped in try/except). On read error or process exit, put None sentinel into all subscriber queues. Add subscribe_terminal(container_name) -> queue.Queue(maxsize=1024) that appends a new queue to the session's subscribers list and returns it. Add unsubscribe_terminal(container_name, q) that removes the queue from subscribers. Update last_activity on each successful read. `_start_broadcaster()` must check `thread.is_alive()` before spawning a new broadcaster thread to guard against restart on unexpected PTY closure. (refs: DL-003, DL-007)
- **CI-M-002-002** `gui/api.py::_idle_reaper`: Add a daemon reaper thread that runs every 30s. For each session in _terminal_sessions, if len(subscribers) == 0 and (now - last_activity) > 60s, call _cleanup_session(name). Thread starts on first create_terminal_session call if not already running. Thread exits when _terminal_sessions is empty. (refs: DL-006)
- **CI-M-002-003** `gui/server.py::_reader (terminal SSE handler)`: Replace the existing _reader() pattern that calls api.read_terminal() directly with: call api.subscribe_terminal(container_name) to get a queue, then loop reading from the queue (q.get with timeout). On disconnect (OSError on wfile.write), call api.unsubscribe_terminal(container_name, q). This applies to the container terminal SSE handler. The local terminal SSE handler reads its PTY fd directly and does not use the broadcaster. (refs: DL-003)

#### Code Changes

**CC-M-002-001** (gui/api.py) - implements CI-M-002-001

**Code:**

```diff
--- a/gui/api.py
+++ b/gui/api.py
@@ -11,6 +11,7 @@
 import json
 import os
 import re
+import queue
 import shlex
 import subprocess
 import tempfile
 import threading
@@ -1117,7 +1117,8 @@
 # Terminal session management (M-005)
-# Keyed by container_name; each entry: {proc, master_fd (or None), lock}
+# Keyed by container_name; each entry: {proc, master_fd (or None), lock, subscribers, last_activity}
 _terminal_sessions = {}
 _terminal_sessions_lock = threading.Lock()
+_reaper_started = False
 
 
@@ -1130,6 +1131,7 @@
     Uses pty.openpty() when available (Linux/macOS); falls back to
     subprocess.Popen with pipes when pty module is absent (Windows).
     Returns {ok: True} or {error: ...}.
     """
+    global _reaper_started
     with _terminal_sessions_lock:
         existing = _terminal_sessions.get(container_name)
@@ -1153,7 +1154,9 @@
                 os.close(slave_fd)
                 _terminal_sessions[container_name] = {
                     "proc": proc,
                     "master_fd": master_fd,
                     "lock": threading.Lock(),
+                    "subscribers": [],
+                    "last_activity": 0,
                 }
             else:
@@ -1169,7 +1172,9 @@
                 _terminal_sessions[container_name] = {
                     "proc": proc,
                     "master_fd": None,
                     "lock": threading.Lock(),
+                    "subscribers": [],
+                    "last_activity": 0,
                 }
         except Exception as e:
             return {"error": str(e)}
+        _start_broadcaster(container_name, _terminal_sessions[container_name])
+        if not _reaper_started:
+            _reaper_started = True
+            t = threading.Thread(target=_idle_reaper, daemon=True)
+            t.start()
         return {"ok": True}
+
+
+def _start_broadcaster(container_name, session):
+    """Start the single reader thread that fans out PTY output to all subscriber queues."""
+    import time as _time
+
+    def _broadcaster():
+        import select as _select
+        master_fd = session.get("master_fd")
+        if master_fd is None:
+            pipe_q = queue.Queue()
+
+            def _pipe_reader():
+                try:
+                    while True:
+                        chunk = session["proc"].stdout.read(4096)
+                        if chunk:
+                            pipe_q.put(chunk)
+                        else:
+                            pipe_q.put(None)
+                            return
+                except (OSError, AttributeError):
+                    pipe_q.put(None)
+
+            _pt = threading.Thread(target=_pipe_reader, daemon=True)
+            _pt.start()
+
+        while True:
+            master_fd = session.get("master_fd")
+            if master_fd is not None:
+                try:
+                    r, _, _ = _select.select([master_fd], [], [], 0.05)
+                    if r:
+                        chunk = os.read(master_fd, 4096)
+                    else:
+                        chunk = b""
+                except OSError:
+                    chunk = None
+            else:
+                try:
+                    chunk = pipe_q.get(timeout=0.05)
+                except queue.Empty:
+                    chunk = b""
+
+            if chunk is None:
+                with _terminal_sessions_lock:
+                    subs = list(session.get("subscribers", []))
+                for q in subs:
+                    try:
+                        q.put_nowait(None)
+                    except Exception:
+                        pass
+                return
+
+            if chunk:
+                session["last_activity"] = _time.time()
+                with _terminal_sessions_lock:
+                    subs = list(session.get("subscribers", []))
+                for q in subs:
+                    try:
+                        q.put_nowait(chunk)
+                    except queue.Full:
+                        pass
+
+            if not chunk:
+                if session["proc"].poll() is not None:
+                    with _terminal_sessions_lock:
+                        subs = list(session.get("subscribers", []))
+                    for q in subs:
+                        try:
+                            q.put_nowait(None)
+                        except Exception:
+                            pass
+                    return
+
+    t = threading.Thread(target=_broadcaster, daemon=True)
+    t.start()
+
+
+def subscribe_terminal(container_name):
+    """Register a new subscriber queue for the container's PTY output. Returns the queue."""
+    q = queue.Queue(maxsize=1024)
+    with _terminal_sessions_lock:
+        session = _terminal_sessions.get(container_name)
+        if session is not None:
+            session["subscribers"].append(q)
+    return q
+
+
+def unsubscribe_terminal(container_name, q):
+    """Remove a subscriber queue from the container's PTY session."""
+    with _terminal_sessions_lock:
+        session = _terminal_sessions.get(container_name)
+        if session is not None:
+            try:
+                session["subscribers"].remove(q)
+            except ValueError:
+                pass
+
+
+def _idle_reaper():
+    """Background daemon: close PTY sessions with zero subscribers after 60s of inactivity."""
+    import time as _time
+    while True:
+        _time.sleep(30)
+        with _terminal_sessions_lock:
+            names = list(_terminal_sessions.keys())
+        for name in names:
+            with _terminal_sessions_lock:
+                session = _terminal_sessions.get(name)
+                if session is None:
+                    continue
+                subs = session.get("subscribers", [])
+                last = session.get("last_activity", 0)
+                if len(subs) == 0 and (last == 0 or (_time.time() - last) > 60):
+                    _cleanup_session(name)
+        with _terminal_sessions_lock:
+            if not _terminal_sessions:
+                global _reaper_started
+                _reaper_started = False
+                return
@@ -1179,27 +1230,2 @@
-def read_terminal(container_name, timeout=0.05):
-    """Read available bytes from the terminal session.
-
-    Returns bytes or b'\''\''  when nothing available. Returns None if session absent.
-    """
-    session = _terminal_sessions.get(container_name)
-    if not session:
-        return None
-    if session["master_fd"] is not None:
-        import select
-        try:
-            r, _, _ = select.select([session["master_fd"]], [], [], timeout)
-            if r:
-                return os.read(session["master_fd"], 4096)
-            return b""
-        except OSError:
-            return None
-    else:
-        # pipe-based fallback: non-blocking read
-        try:
-            import fcntl
-            fd = session["proc"].stdout.fileno()
-            fl = fcntl.fcntl(fd, fcntl.F_GETFL)
-            fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
-            return session["proc"].stdout.read(4096) or b""
-        except (OSError, AttributeError):
-            return b""
+# read_terminal() removed — broadcaster fan-out replaced per-connection reads
```

**Documentation:**

```diff
--- a/gui/api.py
+++ b/gui/api.py
@@ -1117,7 +1117,8 @@
-# Terminal session management (M-005)
-# Keyed by container_name; each entry: {proc, master_fd (or None), lock, subscribers, last_activity}
+# Terminal session management
+# Keyed by container_name. Each session dict:
+#   proc          - subprocess.Popen for the docker exec process
+#   master_fd     - PTY master file descriptor, or None when using pipe fallback
+#   lock          - threading.Lock for fd write access
+#   subscribers   - list of queue.Queue instances registered by active SSE handlers (DL-003)
+#   last_activity - float timestamp (time.time()) of last PTY byte read; 0 if none (DL-006)
 _terminal_sessions = {}
 _terminal_sessions_lock = threading.Lock()
+_reaper_started = False  # True while _idle_reaper daemon thread is running (DL-006)
 
 
+def _start_broadcaster(container_name, session):
+    """Start the single reader thread that fans out PTY output to subscriber queues.
+
+    One broadcaster thread per PTY session reads from master_fd (or stdout pipe on
+    Windows) and puts each chunk into every queue in session["subscribers"].
+    Multiple concurrent SSE handlers (e.g. dashboard tile + detail panel) each register
+    a queue via subscribe_terminal() and receive identical output without racing on the
+    fd (DL-003).
+
+    Sends None sentinel to all subscribers when the PTY EOF or process exit is detected,
+    signalling SSE handlers to close their streams.
+    Updates session["last_activity"] on each non-empty read for the idle reaper (DL-006).
+    """
 def _start_broadcaster(container_name, session):
 
+
+def subscribe_terminal(container_name):
+    """Register a new subscriber queue for the named container's PTY broadcaster.
+
+    Returns a queue.Queue(maxsize=1024). The caller (SSE handler) dequeues chunks
+    and writes them to the HTTP response. Call unsubscribe_terminal() in a finally
+    block to avoid stale queue references in session["subscribers"] (DL-006).
+    Returns an empty queue if no session exists for container_name.
+    """
 def subscribe_terminal(container_name):
 
+
+def unsubscribe_terminal(container_name, q):
+    """Remove subscriber queue q from the named container's PTY session.
+
+    Safe to call if the session has already been cleaned up (no-op in that case).
+    Does NOT delete the PTY session; the idle reaper (DL-006) handles cleanup
+    when zero subscribers remain and last_activity is stale.
+    """
 def unsubscribe_terminal(container_name, q):
 
+
+def _idle_reaper():
+    """Background daemon: close PTY sessions orphaned by all consumers disconnecting.
+
+    Wakes every 30 seconds and scans _terminal_sessions. Calls _cleanup_session() on
+    any session that has zero subscribers AND whose last_activity timestamp is either
+    zero or older than 60 seconds (DL-006).
+
+    The 60-second grace period prevents premature cleanup of sessions whose last
+    subscriber just disconnected but a new one is about to connect (e.g. page reload).
+    Exits and resets _reaper_started when no sessions remain, so a new reaper thread
+    is started on the next create_terminal_session() call.
+    """
 def _idle_reaper():

```


**CC-M-002-002** (gui/api.py) - implements CI-M-002-002

**Code:**

```diff
--- a/gui/api.py
+++ b/gui/api.py
@@ -1224,6 +1224,7 @@
 def _cleanup_session(container_name):
     """Internal: close session resources. Caller must hold _terminal_sessions_lock."""
     session = _terminal_sessions.pop(container_name, None)
     if not session:
         return
+    for q in session.get("subscribers", []):
+        try:
+            q.put_nowait(None)
+        except Exception:
+            pass
     proc = session["proc"]
     master_fd = session["master_fd"]
```

**Documentation:**

```diff
--- a/gui/api.py
+++ b/gui/api.py
@@ -1224,6 +1224,7 @@
 def _cleanup_session(container_name):
     """Internal: close session resources. Caller must hold _terminal_sessions_lock."""
     session = _terminal_sessions.pop(container_name, None)
     if not session:
         return
+    # Signal all subscriber queues with None sentinel so SSE handlers exit their
+    # dequeue loops instead of blocking indefinitely after the session is removed (DL-006).
     for q in session.get("subscribers", []):

```


**CC-M-002-003** (gui/server.py) - implements CI-M-002-003

**Code:**

```diff
--- a/gui/server.py
+++ b/gui/server.py
@@ -479,31 +479,31 @@
     def _handle_terminal_stream(self, container_name):
         """SSE stream for terminal output.
 
         Creates or reuses a PTY session for container_name and streams output
         bytes base64-encoded as SSE events. A background thread reads from the
-        PTY master fd and queues chunks; this handler dequeues and sends them.
+        PTY broadcaster; this handler registers a subscriber queue and dequeues
+        from it so multiple concurrent SSE readers receive identical output.
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
 
-        q = queue.Queue(maxsize=256)
-        stop_evt = threading.Event()
-
-        def _reader():
-            while not stop_evt.is_set():
-                chunk = api.read_terminal(container_name, timeout=0.05)
-                if chunk is None:  # session gone
-                    q.put(None)
-                    return
-                if chunk:
-                    try:
-                        q.put_nowait(chunk)
-                    except queue.Full:
-                        pass
-
-        t = threading.Thread(target=_reader, daemon=True)
-        t.start()
+        q = api.subscribe_terminal(container_name)
 
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
-            stop_evt.set()
-            t.join(timeout=1)
+            api.unsubscribe_terminal(container_name, q)
```

**Documentation:**

```diff
--- a/gui/server.py
+++ b/gui/server.py
@@ -479,7 +479,7 @@
     def _handle_terminal_stream(self, container_name):
-        """SSE stream for terminal output.
-
-        Creates or reuses a PTY session for container_name and streams output
-        bytes base64-encoded as SSE events. A background thread reads from the
-        PTY broadcaster; this handler registers a subscriber queue and dequeues
-        from it so multiple concurrent SSE readers receive identical output.
-        """
+        """SSE stream for terminal output of a named container.
+
+        Creates or reuses a PTY session via api.create_terminal_session().
+        Registers a subscriber queue with api.subscribe_terminal() so this handler
+        receives a copy of all PTY output from the shared broadcaster thread (DL-003).
+        Streams output bytes base64-encoded as SSE events (format: {"data": "<b64>"}).
+        Sends "heartbeat" SSE comments every 10 seconds when idle to keep the
+        connection alive through proxies.
+        Calls api.unsubscribe_terminal() in the finally block; does NOT call DELETE,
+        preserving the PTY session for other active subscribers (DL-006).
+        """

```


**CC-M-002-004** (gui/README.md)

**Documentation:**

```diff
--- a/gui/README.md
+++ b/gui/README.md
@@ -210,3 +210,79 @@
 The normal entry point is `claudebox gui [--port <port>]`.
+
+## Dashboard Panel (Pinned Container Terminals)
+
+**Dashboard as top-level panel (DL-001)**: The dashboard is a sixth top-level panel
+activated via `showPanel("dashboard")`, following the same show/hide pattern as the
+detail, new-container, modules, settings, and welcome panels. No routing library is
+required.
+
+**Pin state in registry (DL-005)**: Pin state is stored as a `pinned` boolean field
+per container entry in `~/.claudebox/registry.json`. The registry is the authoritative
+per-container store; adding `pinned: true` is consistent with how all other container
+state is managed. `PATCH /api/containers/<name>/pin` sets or clears the field atomically.
+Automatic cleanup: when `claudebox destroy` removes a registry entry the pin is gone for
+free. localStorage was rejected — it is browser-specific and not durable across data clears.
+
+**CSS auto-fill grid (DL-008)**: `.dashboard-grid` uses
+`grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`. The browser computes
+column count from viewport width with no JS resize handlers. 320px minimum keeps
+xterm.js output readable. `ceil(sqrt(n))` column math was rejected — it requires JS
+recalculation on resize and pin changes.
+
+**Read-only tiles, fullscreen for input (DL-004)**: Grid tiles are xterm.js instances
+with `disableStdin: true`. Multiple tiles are visible simultaneously; enabling input
+on all would create keystroke ambiguity. Clicking the fullscreen button opens a
+`position:fixed` overlay (DL-013) with input re-enabled. ESC or the close button exits
+fullscreen and restores the read-only tile EventSource.
+
+**Server-side fan-out broadcaster (DL-003)**: `os.read()` on a PTY master fd is
+consuming — bytes read by one thread are lost to others. When a dashboard tile and
+the detail panel Terminal tab both have SSE streams open for the same container,
+they would race on the fd and produce interleaved incomplete output.
+
+`_start_broadcaster()` in `api.py` spawns one reader thread per PTY session. That
+thread reads from master_fd and puts each chunk into every queue in
+`session["subscribers"]`. Each SSE handler calls `subscribe_terminal()` to register
+its queue and `unsubscribe_terminal()` on disconnect — no thread racing, identical
+output to all readers. All reads go through the broadcaster via `subscribe_terminal()`/`unsubscribe_terminal()`; direct `os.read()` on the PTY fd is reserved to the single broadcaster thread.
+
+**Activity detection (DL-002)**: Claude activity status is detected client-side.
+`_startDashboardStatusInterval()` runs every 2 seconds and classifies each tile by
+elapsed time since the last SSE `onmessage` event:
+
+| Elapsed       | Status class     | Indicator            |
+| ------------- | ---------------- | -------------------- |
+| < 3 s         | `status-active`  | green pulse          |
+| 3 s – 30 s    | `status-waiting` | yellow               |
+| ≥ 30 s / none | `status-idle`    | grey                 |
+
+The 30-second idle threshold (R-002) accounts for browser background-tab
+throttling, which may buffer SSE delivery and delay `onmessage` timestamps, producing
+false idle readings. A 5-second threshold triggers false-idle on every tab switch. A server-side status endpoint was rejected (RA-004) — it adds API surface
+for a UI-only concern.
+
+**Shared PTY sessions and cleanup (DL-006)**: Dashboard tiles share one PTY session
+per container with the detail panel Terminal tab. Unpinning a tile or navigating away
+from the dashboard closes the EventSource (unsubscribing from the broadcaster) but
+does NOT call `DELETE /api/containers/<name>/terminal`. Calling DELETE would kill a
+PTY session that the detail panel may still be using.
+
+The idle reaper (`_idle_reaper()` in `api.py`) runs every 30 seconds and calls
+`_cleanup_session()` on sessions whose subscriber list is empty and whose
+`last_activity` timestamp is older than 60 seconds. The 60-second grace period
+prevents premature cleanup when the last subscriber just disconnected but a reconnect
+is imminent (e.g. page reload). The reaper thread starts on the first
+`create_terminal_session()` call and exits when no sessions remain.
+
+## Terminal Session Lifecycle
+
+1. `create_terminal_session()` reuses an existing PTY session if one is alive for the
+   container, or spawns a new `docker exec -it zsh` process (DL-007). One session per container.
+2. `_start_broadcaster()` launches one reader thread for the session.
+3. Each SSE handler (detail panel tab, dashboard tile) calls `subscribe_terminal()` and
+   receives a dedicated `queue.Queue(maxsize=256)`.
+4. Broadcaster reads PTY master fd → puts chunks into all subscriber queues.
+5. Each SSE handler dequeues chunks and streams base64-encoded `data:` events.
+6. Input: `onData` → `POST .../terminal/input` → write to PTY master fd.
+7. SSE disconnect: handler calls `unsubscribe_terminal()` in `finally`.
+8. When subscriber count reaches zero and `last_activity` > 60 s ago, idle reaper calls
+   `_cleanup_session()`, which sends None sentinel to any remaining queues and closes
+   the PTY fd and process group.
+9. On server shutdown, `signal.SIGTERM` and `atexit` handlers close all sessions.

```


**CC-M-002-005** (gui/CLAUDE.md)

**Documentation:**

```diff
--- a/gui/CLAUDE.md
+++ b/gui/CLAUDE.md
@@ -8,8 +8,10 @@
 | `server.py`           | HTTP request handler; GET/POST/DELETE routing; SSE stream handler for init, logs, and terminal | Adding API endpoints, debugging request flow        |
-| `api.py`              | Registry read/write, config merge, module CRUD, config verify, docker inspect, file content reader, terminal session management, container destroy | Modifying container list, config, module operations, terminal, file viewer |
+| `api.py`              | Registry read/write, config merge, module CRUD, config verify, docker inspect, file content reader, terminal session management (broadcaster, subscribe_terminal, unsubscribe_terminal, idle reaper), container destroy | Modifying container list, config, module operations, terminal, file viewer, dashboard backend |
-| `static/app.js`       | Vanilla JS SPA: container list, config viewer, command panel, file viewer, terminal tab | Changing frontend behavior or adding UI features    |
+| `static/app.js`       | Vanilla JS SPA: container list, config viewer, command panel, file viewer, terminal tab, dashboard panel (pin management, grid rendering, fullscreen overlay, activity status) | Changing frontend behavior or adding UI features    |

```


**CC-M-002-006** (gui/CLAUDE.md)

**Documentation:**

```diff
--- a/gui/CLAUDE.md
+++ b/gui/CLAUDE.md
@@ -8,8 +8,10 @@
 | `server.py`           | HTTP request handler; GET/POST/DELETE routing; SSE stream handler for init, logs, and terminal | Adding API endpoints, debugging request flow        |
-| `api.py`              | Registry read/write, config merge, module CRUD, config verify, docker inspect, file content reader, terminal session management, container destroy | Modifying container list, config, module operations, terminal, file viewer |
+| `api.py`              | Registry read/write, config merge, module CRUD, config verify, docker inspect, file content reader, terminal session management (broadcaster, subscribe_terminal, unsubscribe_terminal, idle reaper), container destroy | Modifying container list, config, module operations, terminal, file viewer, dashboard backend |
-| `static/app.js`       | Vanilla JS SPA: container list, config viewer, command panel, file viewer, terminal tab | Changing frontend behavior or adding UI features    |
+| `static/app.js`       | Vanilla JS SPA: container list, config viewer, command panel, file viewer, terminal tab, dashboard panel (pin management, grid rendering, fullscreen overlay, activity status) | Changing frontend behavior or adding UI features    |

```


### Milestone 3: Terminal grid tiles with SSE streaming

**Files**: gui/static/app.js, gui/static/style.css

**Acceptance Criteria**:

- Each pinned container tile shows live xterm.js terminal output via SSE
- Tiles are read-only (no keyboard input)
- FitAddon called after tile is visible via ResizeObserver
- Navigating away from dashboard closes all tile SSE connections and disposes xterm instances
- Re-entering dashboard reconnects SSE for all pinned containers
- Unpinning closes SSE (does not DELETE session) and removes tile

#### Code Intent

- **CI-M-003-001** `gui/static/app.js`: Extend renderDashboardGrid() to create an xterm.js Terminal instance inside each tile (read-only: no onData handler attached). For each pinned container, open an SSE EventSource to /api/containers/<name>/terminal/stream. Store per-tile state in a _dashboardTiles map keyed by container name: {xterm, fitAddon, eventSource, lastActivity}. On SSE onmessage, decode base64 and write to the tile xterm instance; update lastActivity to Date.now(). Use FitAddon with ResizeObserver on each tile container div — call fitAddon.fit() only after the element has non-zero dimensions. When unpinning, close the EventSource (do NOT call DELETE on terminal), dispose the xterm instance, remove from _dashboardTiles, and re-render. On showPanel() away from dashboard, close all dashboard SSE connections and dispose xterm instances to free resources. Re-entering dashboard re-connects. (refs: DL-003, DL-006)
- **CI-M-003-002** `gui/static/style.css`: Add .dashboard-tile-body with flex:1, min-height 200px, overflow hidden, containing the xterm container div. Style the xterm container inside tiles to fill the tile body. Ensure .xterm inside tiles has no extra padding. Add responsive breakpoint: below 700px viewport width, grid switches to single column. (refs: DL-003)

#### Code Changes

**CC-M-003-001** (gui/static/app.js) - implements CI-M-003-001

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -123,6 +123,10 @@
 function showPanel(name) {
   detailPanel.classList.add("hidden");
   newPanel.classList.add("hidden");
   welcomePanel.classList.add("hidden");
   modulesPanel.classList.add("hidden");
   settingsPanel.classList.add("hidden");
+  if (name !== "dashboard") {
+    _teardownDashboardTiles(Object.keys(_dashboardTiles));
+    _stopDashboardStatusInterval();
+  }
```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -123,6 +123,10 @@
 function showPanel(name) {
   detailPanel.classList.add("hidden");
   newPanel.classList.add("hidden");
   welcomePanel.classList.add("hidden");
   modulesPanel.classList.add("hidden");
   settingsPanel.classList.add("hidden");
+  // Tear down dashboard tiles when leaving the dashboard view so SSE connections
+  // are closed and xterm.js instances are disposed (DL-006).
   if (name !== "dashboard") {
     _teardownDashboardTiles(Object.keys(_dashboardTiles));
     _stopDashboardStatusInterval();
   }

```


**CC-M-003-002** (gui/static/style.css) - implements CI-M-003-002

**Code:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -2894,3 +2894,10 @@
 .checkbox-label input[type="checkbox"] { margin: 0; }
+
+/* Ensure xterm inside tile fills tile-body */
+.dashboard-tile-body .xterm {
+  flex: 1;
+  min-height: 0;
+  max-height: none;
+  overflow: hidden;
+}
```

**Documentation:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -2894,3 +2894,10 @@
 .checkbox-label input[type="checkbox"] { margin: 0; }
+
+/* xterm.js renders a flex container; these overrides ensure the terminal canvas
+   fills the tile-body height rather than collapsing to zero inside the flex column. */
+.dashboard-tile-body .xterm {

```


### Milestone 4: Fullscreen interaction mode and activity status

**Files**: gui/static/app.js, gui/static/style.css, gui/static/index.html

**Acceptance Criteria**:

- Clicking a tile opens fullscreen overlay with maximized xterm.js
- Fullscreen mode enables keyboard input via POST /terminal/input
- Escape key and close button exit fullscreen, reverting tile to read-only
- Status dots show active (green pulse, <3s), waiting (yellow, 3-30s), idle (grey, >30s)
- Status dot interval runs only while dashboard is visible

#### Code Intent

- **CI-M-004-001** `gui/static/app.js`: Add dashboard tile click handler that opens a fullscreen overlay. The overlay contains a maximized xterm.js instance connected to the same container SSE stream. In fullscreen mode, attach onData handler to POST keystrokes to /api/containers/<name>/terminal/input (same as detail-panel terminal). Add Escape key handler and close button to exit fullscreen. On close, detach onData handler (tile reverts to read-only preview). Add activity status rendering: each tile header shows a status dot (.status-dot) whose class cycles based on _dashboardTiles[name].lastActivity: active (green, last activity < 3 seconds ago via a 2-second setInterval), idle (grey, > 30 seconds), waiting (yellow, between 3-30 seconds). The interval runs only while dashboard panel is visible. (refs: DL-002, DL-004)
- **CI-M-004-002** `gui/static/style.css`: Add .dashboard-fullscreen-overlay: position fixed, inset 0, z-index 1000, background var(--bg-main), display flex flex-direction column. Add .dashboard-fullscreen-header with container name, status label, and close button. Add .dashboard-fullscreen-body with flex 1 containing the xterm container. Add .status-dot base class (8px circle, inline-block) with modifiers: .status-dot--active (green background with CSS pulse animation), .status-dot--waiting (yellow/amber background), .status-dot--idle (grey background). Add @keyframes pulse animation for the active dot. (refs: DL-002, DL-004)
- **CI-M-004-003** `gui/static/index.html`: Add the #dashboard-fullscreen-overlay div at the end of <main>, initially hidden. Contains a header div with #fullscreen-container-name span, #fullscreen-status-label span, and #fullscreen-close-btn button. Contains a #fullscreen-xterm-container div for the xterm instance. (refs: DL-004)

#### Code Changes

**CC-M-004-001** (gui/static/app.js) - implements CI-M-004-001

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3567,3 +3567,8 @@
 // --- Init ---
 
 loadContainers();
+
+// Fullscreen overlay and activity status are implemented as part of
+// the dashboard functions: _openDashboardFullscreen(), _startDashboardStatusInterval(),
+// and _stopDashboardStatusInterval().
+// The fsBtn click handler in _createDashboardTile calls _openDashboardFullscreen(name).
```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3567,3 +3567,8 @@
 // --- Init ---
 
 loadContainers();
+
+// Fullscreen overlay and activity status are implemented as part of
+// the dashboard functions: _openDashboardFullscreen(), _startDashboardStatusInterval(),
+// and _stopDashboardStatusInterval().
+// The fsBtn click handler in _createDashboardTile calls _openDashboardFullscreen(name).

```


**CC-M-004-002** (gui/static/style.css) - implements CI-M-004-002

**Code:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -2894,3 +2894,5 @@
 .checkbox-label input[type="checkbox"] { margin: 0; }
+
+/* .dashboard-fullscreen-overlay, .dashboard-fullscreen-header, .dashboard-fullscreen-body,
+   .status-active, .status-waiting, .status-idle, @keyframes dash-pulse
+   are all defined at the end of style.css */
```

**Documentation:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -2894,3 +2894,5 @@
 .checkbox-label input[type="checkbox"] { margin: 0; }
+
+/* .dashboard-fullscreen-overlay, .dashboard-fullscreen-header, .dashboard-fullscreen-body,
+   .status-active, .status-waiting, .status-idle, and @keyframes dash-pulse
+   are defined at the end of this file. */

```


**CC-M-004-003** (gui/static/index.html) - implements CI-M-004-003

**Code:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -613,3 +613,5 @@
     </main>
   </div>
+
+  <!-- #dashboard-fullscreen-overlay: fullscreen overlay for dashboard terminal tiles. -->
```

**Documentation:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -613,3 +613,5 @@
     </main>
   </div>
+
+  <!-- #dashboard-fullscreen-overlay: fullscreen overlay for dashboard terminal tiles. -->

```


### Milestone 5: Terminal session manager and dashboard panel shell

**Files**: gui/static/app.js, gui/static/index.html

#### Code Intent

- **CI-M-005-001** `gui/static/index.html`: Add a dashboard-panel section (id=dashboard-panel, class=panel hidden) inside main, alongside existing panels. Contains a header row with title and an empty grid container div (id=dashboard-grid, class=dashboard-grid). Add a sidebar navigation button (id=dashboard-nav-btn) in the sidebar-tools section to switch to the dashboard view. (refs: DL-011)
- **CI-M-005-002** `gui/static/app.js`: Implement a TerminalSessionManager class that reference-counts SSE EventSource connections per container name. Methods: acquire(containerName) returns {eventSource, id} and increments refcount (creates EventSource on first acquire); release(containerName, id) decrements refcount and closes EventSource + sends DELETE when refcount reaches zero. The detail panel terminal code (onTerminalTabActivate, _termDisconnect) is refactored to use this manager instead of directly managing _termEventSource. (refs: DL-010, DL-014)
- **CI-M-005-003** `gui/static/app.js`: Register dashboard-panel in showPanel() alongside existing panels. Add DOM ref for dashboardPanel. Wire dashboard-nav-btn click to showPanel("dashboard"). On dashboard show, call renderDashboardGrid() which calls fetchPinnedContainers() (GET /api/containers filtered by pinned===true) to get current pinned state, and populates the grid. (refs: DL-011, DL-014)
- **CI-M-005-004** `gui/static/app.js`: Implement renderDashboardGrid() which creates a tile div for each pinned container. Each tile contains: a header bar (container name, status dot, unpin button), an xterm.js container div, and a fullscreen button. xterm.js Terminal instance is created in read-only mode (no onData handler). The tile acquires a session from TerminalSessionManager and writes SSE output to its xterm instance. FitAddon.fit() is called via requestAnimationFrame after the tile is visible. Unpin button calls setPinned(name, false) (PATCH /api/containers/<name>/pin) and re-renders grid. Tile header click navigates to detail panel for that container. (refs: DL-010, DL-012, DL-013)
- **CI-M-005-005** `gui/static/app.js`: Implement activity status tracking per tile. Each tile tracks lastOutputTimestamp (updated on every SSE onmessage). A setInterval (every 3 seconds) updates the status dot CSS class: active (green, output within last 2s), idle (grey, no output for 10s+), waiting-for-user (yellow, output stopped 2-10s ago suggesting prompt). Status dot element has class dashboard-status-dot with modifier classes status-active, status-idle, status-waiting. (refs: DL-009)
- **CI-M-005-006** `gui/static/app.js`: Implement fullscreen mode. Clicking the fullscreen button on a tile creates a position:fixed overlay (class=dashboard-fullscreen-overlay) containing the xterm container moved into it. Input is enabled (onData handler attached, sending POST to terminal/input). ESC key or close button exits fullscreen: input handler disposed, xterm container moved back into tile, overlay removed. FitAddon.fit() called on both enter and exit transitions. (refs: DL-013)
- **CI-M-005-007** `gui/static/app.js`: Add a pin/unpin toggle button in the detail panel terminal header (next to existing Connect/Disconnect/Popout buttons). Clicking calls setPinned(name, !isPinned) via PATCH /api/containers/<name>/pin. Button label reflects current registry pin state. (refs: DL-014)

#### Code Changes

**CC-M-005-001** (gui/static/index.html) - implements CI-M-005-001

**Code:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -43,3 +43,5 @@
       <div class="sidebar-tools">
         <div class="sidebar-section-label"><span>Tools</span></div>
+
+        <!-- dashboard-nav-btn: sidebar button activating the dashboard panel. -->
```

**Documentation:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -43,3 +43,5 @@
       <div class="sidebar-tools">
         <div class="sidebar-section-label"><span>Tools</span></div>
+
+        <!-- dashboard-nav-btn: sidebar button activating dashboard panel. #dashboard-panel: top-level dashboard view container. -->

```


**CC-M-005-002** (gui/static/index.html) - implements CI-M-005-007

**Code:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -312,6 +312,7 @@
                 <button id="terminal-connect-btn" class="cmd-btn cmd-terminal">▶ Connect</button>
                 <button id="terminal-disconnect-btn" class="cmd-btn cmd-stop hidden">✕ Disconnect</button>
                 <button id="terminal-popout-btn" class="cmd-btn" title="Open in native terminal">↗ Popout</button>
+                <button id="detail-pin-btn" class="cmd-btn dashboard-pin-btn">Pin</button>
                 <button id="term-stop-start-btn" class="cmd-btn cmd-stop" data-terminal="1">⏹ Stop</button>
```

**Documentation:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -312,6 +312,7 @@
                 <button id="terminal-connect-btn" class="cmd-btn cmd-terminal">&#9654; Connect</button>
                 <button id="terminal-disconnect-btn" class="cmd-btn cmd-stop hidden">&#x2715; Disconnect</button>
                 <button id="terminal-popout-btn" class="cmd-btn" title="Open in native terminal">&#x2197; Popout</button>
+                <!-- Pin button: toggles container pin state in registry via PATCH /api/containers/<name>/pin (DL-005). -->
                 <button id="detail-pin-btn" class="cmd-btn dashboard-pin-btn">Pin</button>

```


**CC-M-005-003** (gui/static/index.html) - implements CI-M-005-007

**Code:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -1,3 +1,3 @@
-<!-- CC-M-005-003 retired: pin button insertion handled by CC-M-005-002 (v2) -->
+<!-- CC-M-005-003 retired: pin button insertion handled by CC-M-005-002 (v2) -->
 <!-- no change -->
```

**Documentation:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -312,0 +312,0 @@
 <!-- no documentation change: pin button is inserted by CC-M-005-002 -->

```


**CC-M-005-004** (gui/static/app.js) - implements CI-M-005-003

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3293,3 +3293,14 @@
   document.getElementById("terminal-connect-btn").classList.remove("hidden");
   document.getElementById("terminal-disconnect-btn").classList.add("hidden");
 });
+
+// --- Pin button in terminal detail header ---
+
+document.getElementById("detail-pin-btn").addEventListener("click", function () {
+  if (!selectedContainer) return;
+  togglePinContainer(selectedContainer.name);
+});
```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3293,3 +3293,14 @@
+// --- Pin button in terminal detail header ---
+// Clicking Pin/Unpin while a container detail panel is open toggles pin state in
+// the registry via PATCH /api/containers/<name>/pin (DL-005) and updates the button label.
 document.getElementById("detail-pin-btn").addEventListener("click", function () {

```


**CC-M-005-005** (gui/static/app.js) - implements CI-M-005-004

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -361,6 +361,8 @@
   activateTab("detail", (_savedState && _savedState.tab) || "overview");
 
   showPanel("detail");
+
+  _updatePinBtnLabel(c.name);
 
   if (!c.project_path) {
```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -361,6 +361,8 @@
   activateTab("detail", (_savedState && _savedState.tab) || "overview");
 
   showPanel("detail");
+
+  // Sync pin button label when navigating to a container detail view (DL-005).
   _updatePinBtnLabel(c.name);

```


**CC-M-005-006** (gui/static/app.js) - implements CI-M-005-002

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3565,3 +3565,5 @@
 // --- Init ---
 
 loadContainers();
+
+// TerminalSessionManager: ref-counted EventSource per container not needed as separate class.
+// The broadcaster in api.py (M-002) handles fan-out server-side; dashboard tiles use
+// direct EventSource instances with teardown managed by _teardownDashboardTiles().
```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3565,3 +3565,5 @@
 // --- Init ---
 
 loadContainers();
+
+// Dashboard tiles use direct EventSource instances per tile; broadcaster fan-out
+// handles multiple concurrent readers server-side (DL-003, see api.py).

```


**CC-M-005-007** (gui/static/app.js) - implements CI-M-005-005

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3565,3 +3565,4 @@
 // --- Init ---
 
 loadContainers();
+// Activity status tracking implemented in _startDashboardStatusInterval() in M-001 CI-M-001-002.
```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3565,3 +3565,4 @@
 // --- Init ---
 
 loadContainers();
+// Activity status tracking: _startDashboardStatusInterval() in dashboard section (DL-002).

```


**CC-M-005-008** (gui/static/app.js) - implements CI-M-005-006

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3565,3 +3565,4 @@
 // --- Init ---
 
 loadContainers();
+// Fullscreen mode implemented in _openDashboardFullscreen() in M-001 CI-M-001-002.
```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3565,3 +3565,4 @@
 // --- Init ---
 
 loadContainers();
+// Fullscreen interaction: _openDashboardFullscreen() in dashboard section (DL-013).

```


### Milestone 6: Terminal grid tiles with activity indicators

**Files**: gui/static/style.css

#### Code Intent

- **CI-M-006-001** `gui/static/style.css`: Add .dashboard-grid styles: CSS Grid with repeat(var(--dash-cols, 2), 1fr), gap of var(--space-md). Add .dashboard-tile styles: border, border-radius, overflow hidden, display flex column, min-height 280px. Add .dashboard-tile-header: flex row, align center, padding, background subtle. Add .dashboard-tile .terminal-xterm-container: flex 1, min-height 0 (for proper flex shrink). Add .dashboard-status-dot: 8px circle, inline-block, margin-right. Add .status-active: background green with pulse animation. Add .status-waiting: background yellow. Add .status-idle: background grey. Add .dashboard-fullscreen-overlay: position fixed, inset 0, z-index 1000, background var(--bg-main), display flex column, padding. Add @keyframes pulse for the active dot. Ensure dark and light theme compatibility using existing CSS custom properties. (refs: DL-012, DL-013, DL-009)

#### Code Changes

**CC-M-006-001** (gui/static/style.css) - implements CI-M-006-001

**Code:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -2894,3 +2894,5 @@
 .checkbox-label input[type="checkbox"] { margin: 0; }
+
+/* Dashboard grid and activity indicator styles appended at the end of this file:
+   .dashboard-grid, .dashboard-tile, .dashboard-tile-header, .dashboard-tile-body,
+   .dashboard-tile-name, .dashboard-status-dot, .status-active, .status-waiting,
+   .status-idle, @keyframes dash-pulse, .dashboard-fullscreen-overlay,
+   .dashboard-fullscreen-header, .dashboard-fullscreen-body, .dashboard-pin-btn,
+   and the responsive @media (max-width: 700px) breakpoint. */
```

**Documentation:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -2894,3 +2894,5 @@
 .checkbox-label input[type="checkbox"] { margin: 0; }
+
+/* Dashboard grid and activity indicator styles at the end of this file:
+   .dashboard-grid, .dashboard-tile, .dashboard-tile-header,
+   .dashboard-tile-body, .dashboard-tile-name, .dashboard-status-dot,
+   .status-active/.status-waiting/.status-idle, @keyframes dash-pulse,
+   .dashboard-fullscreen-overlay, .dashboard-fullscreen-header,
+   .dashboard-fullscreen-body, .dashboard-pin-btn,
+   and the responsive @media (max-width: 700px) breakpoint. */

```

