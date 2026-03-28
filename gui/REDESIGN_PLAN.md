# Plan

## Overview

The ClaudeBox GUI detail panel has 7 flat tabs with no visual grouping, a command panel that mixes session/config/destructive actions with only a CSS spacer, duplicate buttons in the terminal pane, and inner config tabs that are visually identical to outer detail tabs -- all contributing to visual clutter and poor hierarchy.

**Approach**: Two-milestone redesign: (M-001) CSS foundation with spacing tokens, tab group visual separators, and distinct inner-tab styling; (M-002) HTML restructuring of command panel into grouped sections with overflow menu for destructive actions, tab separator class hooks, and removal of duplicate terminal pane buttons with corresponding JS updates.

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| PDL-001 | Tab visual grouping via CSS separators, not HTML restructuring | Changing tab order requires updating data-tab/data-for-tab attributes in HTML and JS activateTab calls (app.js initTabGroup function scopes queries by data-tab-group) -> restructuring HTML adds risk of breaking initTabGroup scoping -> CSS gap/margin separators between tab groups achieve visual hierarchy without touching the tab group machinery. Validated: tab reorder is safe only if data-tab/data-for-tab stay consistent (gui/static/index.html detail tabs, gui/README.md 'Detail Panel Tab Architecture') |
| PDL-002 | Command panel reorganized into labeled action groups with overflow menu for destructive actions | Users scan command panel (gui/static/index.html .command-buttons) as flat list of 6 buttons including destructive Destroy next to safe Terminal -> grouping by intent (session, config, danger) reduces accidental clicks -> moving Destroy/Unregister behind a ... overflow toggle adds friction proportional to severity while keeping them accessible. The overflow dropdown requires small JS addition in app.js (validated: no existing overflow pattern to reuse). |
| PDL-003 | Remove duplicate buttons from terminal pane header | Terminal pane .terminal-cmd-row (gui/static/index.html) has #term-stop-start-btn / #term-refresh-btn / #term-destroy-btn that duplicate Overview tab commands -> users in terminal context rarely need config sync -> removing #term-refresh-btn and #term-destroy-btn reduces visual clutter -> #term-stop-start-btn remains as it has terminal-specific meaning. Button IDs in HTML must stay stable OR app.js must be updated simultaneously (validated: app.js wires listeners by getElementById around line 3358) |
| PDL-004 | Inner config tabs get distinct visual treatment from outer detail tabs | Both config subtabs and detail tabs use identical .tab-btn styling -> users cannot distinguish nesting level visually -> smaller font, pill/chip style for inner tabs creates clear hierarchy -> config-tabs already has its own container (.config-tabs) making CSS scoping straightforward |
| PDL-005 | Add spacing design tokens as CSS custom properties | All spacing is hardcoded px values scattered across gui/static/style.css (~2756 lines) -> inconsistent spacing contributes to visual clutter -> adding --space-xs through --space-xl tokens enables systematic spacing -> tokens are additive (new CSS variables alongside existing values won't break current rules) and can be adopted incrementally |
| PDL-006 | Implement as two milestones: CSS foundation first, then HTML+JS restructuring | CSS token and styling changes have zero JS interaction risk -> separating them allows validating visual improvements before touching interaction logic -> if M-002 fails, M-001 improvements still stand |
| PDL-007 | Plan decision IDs use PDL- prefix to avoid collision with gui/README.md DL-001 through DL-008 namespace | gui/README.md already defines DL-001 (Python stdlib only) through DL-008 (Destroy/Rebuild) -> plan decisions DL-001 to DL-006 describe different things (e.g. plan DL-001=CSS tab separators vs README DL-001=Python stdlib) -> using PDL- prefix eliminates ambiguity for future readers referencing decision IDs |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Svelte rewrite of the SPA | DL-003 in gui/README.md requires no build step; vanilla JS only. Svelte requires a compile step. (ref: PDL-001) |
| Tabs overlay/popover for overflow menu on tab bar | Requires complex JS positioning logic disproportionate to Pass 1 goals; deferred to future pass (ref: PDL-001) |
| Removing Inspect/Files/Refs tabs to reduce clutter | Violates MUST NOT remove features constraint — all 7 tabs must remain accessible (ref: PDL-001) |
| HTML restructuring of tab bar order instead of CSS separators | Risks breaking initTabGroup scoping via data-tab-group attributes; CSS separators achieve same visual grouping safely without DOM changes (ref: PDL-001) |

### Constraints

- MUST NOT remove any feature or functionality — all 7 detail tabs, all command buttons must remain accessible
- MUST NOT change backend API contracts — scope is frontend-only (index.html, style.css, app.js)
- MUST NOT introduce a build step — vanilla JS, no framework (gui/README.md DL-003)
- MUST preserve scoped tab group pattern — data-tab-group attributes on buttons and panels are required by initTabGroup() in app.js
- MUST keep xterm.js CDN loading pattern and SSE terminal architecture unchanged
- SHOULD use /frontend-design skill for implementation to get high-quality output
- SHOULD implement in priority order — Pass 1 (high impact / low risk) first

### Known Risks

- **Button ID breakage: restructuring command panel HTML may change or lose button IDs that app.js queries by getElementById**: All existing button IDs and data-cmd attributes are preserved in CI-M-002-001; code intent explicitly states IDs must not change. Implementer must verify all getElementById calls in app.js still resolve after HTML changes.
- **CSS specificity conflicts: new .config-tabs .tab-btn styles may conflict with existing .tab-btn rules or light-mode overrides**: Scope inner tab styles under .config-tabs descendant selector which already exists as a container. Test both dark and light themes. CI-M-001-003 specifies both theme variants.
- **Theme regression: adding spacing tokens and restyling components may break light-mode sidebar overrides or other theme-specific rules**: Spacing tokens are additive (new --space-* variables alongside existing values). Light-mode sidebar overrides use [data-theme=light] .sidebar selector which is unaffected by spacing token additions. Visual QA in both themes required.

## Invisible Knowledge

### System

DL-003 (gui/README.md): no build step — all JS/CSS must be vanilla, served as static files from gui/static/. The gui/frontend/ Svelte source compiles to static/ but served files must work without a build.

### Invariants

- Scoped tab groups: data-tab-group attribute on both buttons and panels prevents nested tab interference — initTabGroup(groupName) scopes DOM queries to that group (gui/README.md 'Detail Panel Tab Architecture')
- Confirm bars already exist as .cmd-confirm-bar in CSS — reuse for Destroy/Unregister overflow menu styling rather than inventing new patterns
- Light-mode sidebar uses explicit [data-theme=light] .sidebar overrides because --bg-sidebar is dark-valued in both themes (gui/README.md 'Light mode sidebar')
- Registry + Docker are dual source of truth — UI state reflects both; neither alone is sufficient (gui/README.md DL-002)
- extra_commands in config runs as root during container init — warning must remain visible when editing config in the GUI (gui/README.md Invariants)

### Tradeoffs

- CSS-only tab separators (DL-001 in plan) avoid touching initTabGroup scoping but require class hooks added in M-002 HTML changes, creating a cross-milestone dependency
- Overflow menu for destructive actions adds friction proportional to severity but requires new JS toggle logic that didn't exist before

## Milestones

### Milestone 1: CSS foundation: spacing tokens, tab hierarchy, inner tab distinction

**Files**: gui/static/style.css

#### Code Intent

- **CI-M-001-001** `gui/static/style.css`: Add spacing design tokens (--space-xs: 4px, --space-sm: 8px, --space-md: 16px, --space-lg: 24px, --space-xl: 32px) to :root and [data-theme=light] blocks. Replace hardcoded spacing values in .detail-grid, .command-panel, .command-buttons, .detail-tab-content, .config-section, .module-list with token references. (refs: PDL-005)
- **CI-M-001-002** `gui/static/style.css`: Add visual separators between tab groups in .detail-tabs: insert a wider gap (using margin-left on the 4th and 6th tab buttons via nth-child or a CSS class) to create visual clusters: [Overview Config Modules] | [Inspect Files] | [Refs Terminal]. Use a left border or increased gap, not a DOM element. (refs: PDL-001)
- **CI-M-001-003** `gui/static/style.css`: Restyle inner config tabs (.config-tabs .tab-btn) to be visually distinct from outer detail tabs: smaller font-size (12px vs 13px), pill/chip border-radius (12px), background tint on active state instead of bottom-border, and reduced padding. Both dark and light theme variants. (refs: PDL-004)
- **CI-M-001-004** `gui/static/style.css`: Add styles for new command grouping structure: .cmd-group (flex row with gap), .cmd-group-label (small uppercase label above button group), .cmd-overflow-toggle (... button that toggles a .cmd-overflow-menu dropdown containing Destroy and Unregister buttons). Menu positioned below the toggle button with absolute positioning. (refs: PDL-002)
- **CI-M-001-005** `gui/static/style.css`: Reduce terminal-panel-header button density: the .terminal-cmd-row in the container subtab gets gap: 6px and buttons get compact padding (4px 10px). No specific CSS rules exist for term-destroy-btn or term-refresh-btn as those buttons use the generic .cmd-btn class; their removal from HTML in CC-M-002-003 is sufficient to clean up the terminal pane. (refs: PDL-003)

#### Code Changes

**CC-M-001-001** (gui/static/style.css) - implements CI-M-001-001

**Code:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -3,6 +3,13 @@
 /* === Design tokens (dark theme default) === */
 :root {
   --bg-main:       #1a1a1a;
+  --space-xs: 4px;
+  --space-sm: 8px;
+  --space-md: 16px;
+  --space-lg: 24px;
+  --space-xl: 32px;
   --bg-sidebar:    #111111;
   --bg-card:       #1e1e1e;
@@ -707,15 +714,15 @@
 /* --- Detail panel --- */
 
-.detail-grid { margin: 16px 0; }
+.detail-grid { margin: var(--space-md) 0; }
 
 .detail-row {
   display: flex;
   gap: 16px;
@@ -732,9 +739,9 @@
 /* --- Command runner --- */
 
-.command-panel { margin-top: 24px; }
+.command-panel { margin-top: var(--space-lg); }
 
 .command-buttons {
   display: flex;
   gap: 8px;
   flex-wrap: wrap;
-  margin-bottom: 12px;
+  margin-bottom: var(--space-sm);
 }
@@ -1008,7 +1015,7 @@
 /* Top-level tab content panels */
 .detail-tab-content {
-  padding-top: 20px;
+  padding-top: var(--space-md);
 }
@@ -791,9 +798,9 @@
 /* --- Config section (inside detail panel) --- */
 
 .config-section {
-  margin-top: 32px;
-  padding-top: 24px;
+  margin-top: var(--space-xl);
+  padding-top: var(--space-lg);
   border-top: 1px solid var(--border);
 }
@@ -1105,7 +1112,7 @@
 /* Module list container */
 .module-list {
   display: flex;
   flex-direction: column;
-  gap: 8px;
-  margin-bottom: 16px;
+  gap: var(--space-sm);
+  margin-bottom: var(--space-md);
 }

```

**Documentation:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -3,6 +3,11 @@
 /* === Design tokens (dark theme default) === */
 :root {
   --bg-main:       #1a1a1a;
+  /* Spacing scale — use these instead of hardcoded px values.
+     Defined as an additive set; existing hardcoded values remain valid
+     until migrated. (PDL-005) */
   --space-xs: 4px;
   --space-sm: 8px;
   --space-md: 16px;
   --space-lg: 24px;
   --space-xl: 32px;

```


**CC-M-001-002** (gui/static/style.css) - implements CI-M-001-002

**Code:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -988,6 +988,14 @@ .detail-tabs {
 /* Top-level tab bar — slightly bolder than inner config tabs */
 .detail-tabs {
   display: flex;
   gap: 2px;
 }
 
+/* Visual separation between tab clusters via left margin on group-start tabs.
+   Clusters: [Overview Config Modules] | [Inspect Files] | [Refs Terminal].
+   CSS-only approach avoids touching initTabGroup scoping (PDL-001). */
+.detail-tabs .tab-btn.tab-group-sep {
+  margin-left: 12px;
+  border-left: 1px solid var(--border-strong);
+  padding-left: 14px;
+}
+
 /* Override .tab-btn defaults for detail-level tab buttons */
 .detail-tabs .tab-btn {
   font-size: 13px;

```

**Documentation:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -988,6 +988,8 @@
 .detail-tabs {
   display: flex;
   gap: 2px;
 }
 
+/* Tabs marked tab-group-sep are the first tab in a visual cluster.
+   Clusters: [Overview Config Modules] | [Inspect Files] | [Refs Terminal].
+   Margin+border separator is applied via CSS to avoid touching the
+   initTabGroup scoping machinery (data-tab-group attributes). (PDL-001) */
 .detail-tabs .tab-btn.tab-group-sep {
   margin-left: 12px;
   border-left: 1px solid var(--border-strong);
   padding-left: 14px;
 }

```


**CC-M-001-003** (gui/static/style.css) - implements CI-M-001-003

**Code:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -1045,6 +1045,30 @@ .config-tabs-toolbar .config-tabs {
 .config-tabs-toolbar .config-tabs {
   border-bottom: none;
   margin-bottom: 0;
 }
 
+/* Inner config subtabs use pill/chip style to visually distinguish them from
+   outer detail tabs; same bottom-border approach on outer tabs would cause
+   confusion between nesting levels (PDL-004). */
+.config-tabs .tab-btn {
+  font-size: 12px;
+  padding: 4px 12px;
+  border-radius: 12px;
+  border-bottom: none;
+  background: none;
+}
+
+.config-tabs .tab-btn.active {
+  background: var(--accent-bg);
+  color: var(--accent);
+  border-bottom: none;
+}
+
+[data-theme="light"] .config-tabs .tab-btn {
+  color: #475569;
+}
+
+[data-theme="light"] .config-tabs .tab-btn.active {
+  background: #dbeafe;
+  color: #1d4ed8;
+  border-bottom: none;
+}
+
 .verify-btn {
   font-size: 12px;

```

**Documentation:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -1045,6 +1045,10 @@
 .config-tabs-toolbar .config-tabs {
   border-bottom: none;
   margin-bottom: 0;
 }
 
+/* Config subtabs use pill/chip style to visually distinguish nesting level
+   from outer detail tabs. Both sets were using identical .tab-btn styling,
+   causing confusion between nesting levels. (PDL-004)
+   Light-mode overrides below use explicit background tokens to match
+   the [data-theme=light] sidebar override pattern already in this file. */
 .config-tabs .tab-btn {
   font-size: 12px;
   padding: 4px 12px;

```


**CC-M-001-004** (gui/static/style.css) - implements CI-M-001-004

**Code:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -736,6 +736,58 @@ .command-buttons {
 .command-buttons {
   display: flex;
   gap: 8px;
   flex-wrap: wrap;
   margin-bottom: 12px;
 }
-.cmd-spacer { flex: 1; }
 
+/* Command grouping: actions organized by intent (session, config, danger).
+   Overflow menu for destructive actions adds friction proportional to severity
+   while keeping them accessible (PDL-002). */
+.cmd-group {
+  display: flex;
+  align-items: center;
+  gap: 6px;
+  flex-wrap: wrap;
+}
+
+.cmd-group-sep {
+  width: 1px;
+  height: 24px;
+  background: var(--border-strong);
+  flex-shrink: 0;
+  align-self: center;
+}
+
+.cmd-overflow-toggle {
+  position: relative;
+  background: none;
+  border: 1px solid var(--border-strong);
+  color: var(--text-muted);
+  padding: 6px 10px;
+  font-size: 13px;
+  border-radius: 4px;
+  cursor: pointer;
+  flex-shrink: 0;
+}
+
+.cmd-overflow-toggle:hover {
+  background: var(--bg-card);
+  color: var(--text-primary);
+}
+
+.cmd-overflow-menu {
+  position: absolute;
+  top: calc(100% + 4px);
+  right: 0;
+  background: var(--bg-elevated);
+  border: 1px solid var(--border-strong);
+  border-radius: 6px;
+  padding: 4px;
+  z-index: 200;
+  min-width: 160px;
+  display: flex;
+  flex-direction: column;
+  gap: 2px;
+  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
+}
+
+.cmd-overflow-menu.hidden { display: none !important; }
+
+.cmd-overflow-menu .cmd-btn {
+  width: 100%;
+  text-align: left;
+  border-radius: 4px;
+  border: none;
+  background: none;
+  padding: 6px 10px;
+}
+
+.cmd-overflow-menu .cmd-btn:hover {
+  background: var(--bg-card);
+}
+
+[data-theme="light"] .cmd-overflow-menu {
+  background: #ffffff;
+  border-color: #e2e8f0;
+  box-shadow: 0 4px 12px rgba(0,0,0,0.12);
+}
+
 /* --- Buttons --- */
 
 button {

```

**Documentation:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -736,6 +736,10 @@
 .command-buttons {
   display: flex;
   gap: 8px;
   flex-wrap: wrap;
   margin-bottom: 12px;
 }
 
+/* Command actions grouped by intent: session (Stop/Terminal/Rebuild),
+   config (Sync Config), danger (Destroy/Unregister via overflow menu).
+   The overflow toggle hides destructive actions behind one click to add
+   friction proportional to severity. (PDL-002) */
 .cmd-group {

```


**CC-M-001-005** (gui/static/style.css) - implements CI-M-001-005

**Code:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -2615,7 +2615,13 @@ .terminal-cmd-row {
 .terminal-cmd-row {
   display: flex;
   align-items: center;
-  gap: 8px;
+  gap: 6px;
   flex-wrap: wrap;
   flex: 1;
 }
+
+.terminal-cmd-row .cmd-btn {
+  padding: 4px 10px;
+}

```

**Documentation:**

```diff
--- a/gui/static/style.css
+++ b/gui/static/style.css
@@ -2615,7 +2615,10 @@
 .terminal-cmd-row {
   display: flex;
   align-items: center;
   gap: 6px;
   flex-wrap: wrap;
   flex: 1;
 }
 
+/* Terminal header buttons are sized smaller than command panel buttons
+   because the terminal header shares vertical space with the status label.
+   Only Stop/Start and Connect/Disconnect remain here; Sync Config and
+   Destroy were removed as duplicates of Overview tab commands. (PDL-003) */
 .terminal-cmd-row .cmd-btn {
   padding: 4px 10px;
 }

```


**CC-M-001-006** (gui/README.md)

**Documentation:**

```diff
--- a/gui/README.md
+++ b/gui/README.md
@@ -64,9 +64,48 @@ The container detail panel has four top-level tabs (Overview, Config, Modules,
-The container detail panel has four top-level tabs (Overview, Config, Modules,
-Inspect) implemented with a scoped tab group pattern (ref: DL-001).
+The container detail panel has seven top-level tabs (Overview, Config, Modules,
+Inspect, Files, Refs, Terminal) implemented with a scoped tab group pattern.
 Each tab group is identified by a `data-tab-group` attribute on
 both buttons and content panels, so `initTabGroup(groupName)` in `app.js`
 scopes all DOM queries to that group. This prevents nested tab groups from
 interfering: the Config tab contains its own inner Merged/Global/Local sub-tabs
 using `data-tab-group="config"` while the outer detail tabs use
 `data-tab-group="detail"`.
+
+Tabs are organized into three visual clusters separated by CSS left-border
+markers on `.tab-btn.tab-group-sep` elements:
+- **[Overview Config Modules]** — container state and configuration
+- **[Inspect Files]** — read-only introspection
+- **[Refs Terminal]** — advanced/session tools
+
+The separator is applied via CSS margin+border on `tab-group-sep` class
+rather than HTML restructuring, to avoid touching the `initTabGroup` scoping
+machinery (data-tab-group attributes). (PDL-001)
+
+**Command panel (PDL-002)**: Overview tab command buttons are organized into
+three intent groups divided by `.cmd-group-sep` vertical rule dividers:
+- Session actions: Stop/Start, Terminal, Rebuild
+- Config actions: Sync Config
+- Destructive actions: Destroy, Unregister (behind `.cmd-overflow-menu` toggle)
+
+Destructive actions are placed behind the overflow toggle to add friction
+proportional to severity while keeping them accessible. The toggle closes on
+any outside click or on selection. When a confirm bar is shown, the overflow
+menu is hidden (it would otherwise float over the replaced DOM node).
+
+**Terminal header (PDL-003)**: The terminal panel header retains only
+session-control buttons (Connect, Disconnect, Stop/Start, Popout). Sync Config
+and Destroy are not present in the terminal header; those actions live in
+the Overview tab command panel. Stop/Start belongs here: it stops the
+container process without navigating away from the terminal view.
+
+**Config subtab style (PDL-004)**: Inner config subtabs (Merged/Global/Local)
+use a pill/chip visual style (smaller font, border-radius, no bottom border)
+to distinguish their nesting level from the outer detail tabs. Outer and inner
+tabs share the `.tab-btn` base class; the inner tabs are further scoped under
+`.config-tabs .tab-btn` so inner styles do not affect outer detail tabs.
+
+**Spacing tokens (PDL-005)**: CSS custom properties `--space-xs` through
+`--space-xl` are defined in `:root` alongside existing hardcoded `px` values.
+Existing rules are migrated to tokens incrementally; hardcoded values in
+unmigrated rules remain valid and coexist without conflict.

```


### Milestone 2: Command panel grouping, terminal button cleanup, tab separators

**Files**: gui/static/index.html, gui/static/app.js

#### Code Intent

- **CI-M-002-001** `gui/static/index.html`: Restructure the command panel (lines 98-108) into grouped sections: wrap Stop/Terminal/Rebuild in a .cmd-group with implicit session label; wrap Sync Config in a .cmd-group for config actions; replace the .cmd-spacer + Destroy + Unregister with a .cmd-overflow-toggle button (label: ...) and a hidden .cmd-overflow-menu containing the Destroy and Unregister buttons. All existing button IDs and data-cmd attributes preserved. (refs: PDL-002)
- **CI-M-002-002** `gui/static/index.html`: Add CSS class hooks for tab group visual separators: add class tab-group-sep to the Inspect tab button (4th) and Refs tab button (6th) in the detail tabs bar. These classes trigger the CSS left-margin separators from M-001. (refs: PDL-001)
- **CI-M-002-003** `gui/static/index.html`: Remove duplicate action buttons from the container terminal pane header: remove #term-refresh-btn (Sync Config) and #term-destroy-btn (Destroy) from the .terminal-cmd-row. Keep #term-stop-start-btn (Stop) as it has terminal-specific utility. Keep Connect/Disconnect/Popout buttons unchanged. (refs: PDL-003)
- **CI-M-002-004** `gui/static/app.js`: Add overflow menu toggle logic: clicking the .cmd-overflow-toggle button toggles visibility of .cmd-overflow-menu. Clicking outside the menu closes it (document click listener that checks if target is inside the menu). Close the menu when any button inside it is clicked. (refs: PDL-002)
- **CI-M-002-005** `gui/static/app.js`: Remove JS references to #term-refresh-btn and #term-destroy-btn: remove the event listener wiring for these buttons in the terminal panel section. The term-destroy-btn confirm bar logic (around line 3358) is removed. The #term-stop-start-btn logic remains unchanged. (refs: PDL-003)
- **CI-M-002-006** `gui/static/app.js`: Update the showContainerButtons helper (or equivalent logic that shows/hides command buttons based on container state) to handle the new .cmd-overflow-toggle and .cmd-overflow-menu. The Rebuild button visibility logic remains as-is since it is inside a cmd-group, not the overflow menu. (refs: PDL-002)

#### Code Changes

**CC-M-002-001** (gui/static/index.html) - implements CI-M-002-001

**Code:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -98,14 +98,21 @@
           <div class="command-panel">
             <h3 class="section-heading">Commands</h3>
-            <div class="command-buttons">
-              <button id="cmd-stop-start-btn" class="cmd-btn cmd-stop" data-cmd="stop">⏹ Stop</button>
-              <button class="cmd-btn cmd-terminal" data-cmd="terminal">&gt;_ Terminal</button>
-              <button class="cmd-btn cmd-refresh" data-cmd="refresh">↺ Sync Config</button>
-              <button class="cmd-btn cmd-rebuild hidden" data-cmd="rebuild" id="cmd-rebuild-btn">🔧 Rebuild</button>
-              <div class="cmd-spacer"></div>
-              <button class="cmd-btn cmd-destroy" data-cmd="destroy">🗑 Destroy</button>
-              <button class="cmd-btn cmd-unregister" data-cmd="unregister">✕ Unregister</button>
-            </div>
+            <div class="command-buttons">
+              <div class="cmd-group">
+                <button id="cmd-stop-start-btn" class="cmd-btn cmd-stop" data-cmd="stop">⏹ Stop</button>
+                <button class="cmd-btn cmd-terminal" data-cmd="terminal">&gt;_ Terminal</button>
+                <button class="cmd-btn cmd-rebuild hidden" data-cmd="rebuild" id="cmd-rebuild-btn">🔧 Rebuild</button>
+              </div>
+              <div class="cmd-group-sep"></div>
+              <div class="cmd-group">
+                <button class="cmd-btn cmd-refresh" data-cmd="refresh">↺ Sync Config</button>
+              </div>
+              <div class="cmd-group-sep"></div>
+              <div class="cmd-group" style="position:relative">
+                <button class="cmd-overflow-toggle" id="cmd-overflow-toggle-btn" title="More actions">&#8230;</button>
+                <div class="cmd-overflow-menu hidden" id="cmd-overflow-menu">
+                  <button class="cmd-btn cmd-destroy" data-cmd="destroy">🗑 Destroy</button>
+                  <button class="cmd-btn cmd-unregister" data-cmd="unregister">✕ Unregister</button>
+                </div>
+              </div>
+            </div>
             <div id="cmd-output" class="terminal hidden"></div>
           </div>

```

**Documentation:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -98,6 +98,10 @@
           <div class="command-panel">
             <h3 class="section-heading">Commands</h3>
+            <!-- Command buttons organized into three intent groups separated by
+                 .cmd-group-sep dividers: session actions, config actions, and
+                 destructive actions. Destructive actions (Destroy, Unregister)
+                 are placed inside a .cmd-overflow-menu toggle to add friction.
+                 All button IDs and data-cmd values are preserved for app.js
+                 event bindings. (PDL-002) -->
             <div class="command-buttons">
               <div class="cmd-group">

```


**CC-M-002-002** (gui/static/index.html) - implements CI-M-002-002

**Code:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -77,10 +77,10 @@
           <!-- Top-level tab bar; scoped with data-tab-group="detail" -->
           <div class="detail-tabs">
             <button class="tab-btn active" data-tab-group="detail" data-tab="overview">Overview</button>
             <button class="tab-btn" data-tab-group="detail" data-tab="config">Config</button>
             <button class="tab-btn" data-tab-group="detail" data-tab="modules">Modules</button>
-            <button class="tab-btn" data-tab-group="detail" data-tab="inspect">Inspect</button>
-            <button class="tab-btn" data-tab-group="detail" data-tab="files">Files</button>
-            <button class="tab-btn" data-tab-group="detail" data-tab="refs">Refs</button>
+            <button class="tab-btn tab-group-sep" data-tab-group="detail" data-tab="inspect">Inspect</button>
+            <button class="tab-btn" data-tab-group="detail" data-tab="files">Files</button>
+            <button class="tab-btn tab-group-sep" data-tab-group="detail" data-tab="refs">Refs</button>
             <button class="tab-btn" data-tab-group="detail" data-tab="terminal">Terminal</button>
           </div>

```

**Documentation:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -77,6 +77,10 @@
           <!-- Top-level tab bar; scoped with data-tab-group="detail" -->
           <div class="detail-tabs">
             <button class="tab-btn active" data-tab-group="detail" data-tab="overview">Overview</button>
             <button class="tab-btn" data-tab-group="detail" data-tab="config">Config</button>
             <button class="tab-btn" data-tab-group="detail" data-tab="modules">Modules</button>
+            <!-- tab-group-sep marks the first tab in a visual cluster.
+                 CSS applies a left border+margin to create separation.
+                 Clusters: [Overview Config Modules] | [Inspect Files] | [Refs Terminal].
+                 data-tab and data-for-tab values are unchanged. (PDL-001) -->
             <button class="tab-btn tab-group-sep" data-tab-group="detail" data-tab="inspect">Inspect</button>

```


**CC-M-002-003** (gui/static/index.html) - implements CI-M-002-003

**Code:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -284,11 +284,9 @@
           <!-- Container pane -->
           <div id="term-subtab-container" class="terminal-subtab-pane">
             <div class="terminal-panel-header">
               <span id="terminal-status-label" class="terminal-status-label">Disconnected</span>
               <div class="terminal-cmd-row">
                 <button id="terminal-connect-btn" class="cmd-btn cmd-terminal">▶ Connect</button>
                 <button id="terminal-disconnect-btn" class="cmd-btn cmd-stop hidden">✕ Disconnect</button>
                 <button id="terminal-popout-btn" class="cmd-btn" title="Open in native terminal">↗ Popout</button>
                 <button id="term-stop-start-btn" class="cmd-btn cmd-stop" data-terminal="1">⏹ Stop</button>
-                <button id="term-refresh-btn" class="cmd-btn" data-terminal="1">↺ Sync Config</button>
-                <button id="term-destroy-btn" class="cmd-btn cmd-destroy" data-terminal="1">🗑 Destroy</button>
               </div>
             </div>

```

**Documentation:**

```diff
--- a/gui/static/index.html
+++ b/gui/static/index.html
@@ -284,6 +284,9 @@
           <div id="term-subtab-container" class="terminal-subtab-pane">
             <div class="terminal-panel-header">
               <span id="terminal-status-label" class="terminal-status-label">Disconnected</span>
               <div class="terminal-cmd-row">
+                <!-- Terminal header: session-control buttons only.
+                     Sync Config and Destroy are not present here; those actions
+                     live in the Overview tab command panel. (PDL-003) -->
                 <button id="terminal-connect-btn" class="cmd-btn cmd-terminal">▶ Connect</button>

```


**CC-M-002-004** (gui/static/app.js) - implements CI-M-002-004

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3305,6 +3305,29 @@
 // --- Terminal tab command buttons (Stop/Start, Refresh, Destroy) ---

+// Overflow menu toggle: clicking ... shows/hides the destructive action menu.
+// Document click listener closes the menu when clicking outside it (PDL-002).
+(function () {
+  var toggleBtn = document.getElementById("cmd-overflow-toggle-btn");
+  var menu = document.getElementById("cmd-overflow-menu");
+  if (!toggleBtn || !menu) return;
+
+  toggleBtn.addEventListener("click", function (e) {
+    e.stopPropagation();
+    menu.classList.toggle("hidden");
+  });
+
+  document.addEventListener("click", function (e) {
+    if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target !== toggleBtn) {
+      menu.classList.add("hidden");
+    }
+  });
+
+  menu.addEventListener("click", function () {
+    menu.classList.add("hidden");
+  });
+}());
+
 document.getElementById("term-stop-start-btn").addEventListener("click", function () {

```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3305,6 +3305,12 @@
 // --- Terminal tab command buttons (Stop/Start, Refresh, Destroy) ---
+// Overflow menu for destructive command panel actions (Destroy, Unregister).
+// Toggles hidden class on #cmd-overflow-menu. Closes on outside click or
+// on any click inside the menu. Destructive actions are placed behind this
+// toggle to add one extra click of friction. (PDL-002)
+(function () {

```


**CC-M-002-005** (gui/static/app.js) - implements CI-M-002-005

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3338,42 +3338,6 @@
 });

-document.getElementById("term-refresh-btn").addEventListener("click", function () {
-  if (!selectedContainer) return;
-  runCommand("refresh", selectedContainer);
-  // If terminal is connected, source env vars so the active shell picks up changes
-  if (_termContainer && _termXterm) {
-    _termXterm.write("\r");
-    fetch("/api/containers/" + encodeURIComponent(_termContainer) + "/terminal/input", {
-      method: "POST",
-      headers: { "Content-Type": "application/json" },
-      body: JSON.stringify({ data: "source /home/node/.env.sh\r" }),
-    }).catch(function () {});
-  }
-});
-
-document.getElementById("term-destroy-btn").addEventListener("click", function () {
-  if (!selectedContainer) return;
-  const nameAtClick = selectedContainer.name;
-  const termDestroyBar = document.createElement("div");
-  termDestroyBar.className = "cmd-confirm-bar";
-  termDestroyBar.innerHTML =
-    '<span class="cmd-confirm-text">Destroy <strong>' + escHtml(nameAtClick) + '</strong>?</span>' +
-    '<button class="cmd-confirm-yes cmd-btn-danger">⚠ Confirm</button>' +
-    '<button class="cmd-confirm-no">Cancel</button>';
-  const termCmdRow = document.querySelector(".terminal-cmd-row");
-  termCmdRow.classList.add("hidden");
-  termCmdRow.parentNode.insertBefore(termDestroyBar, termCmdRow);
-  termDestroyBar.querySelector(".cmd-confirm-yes").addEventListener("click", function () {
-    termDestroyBar.remove();
-    termCmdRow.classList.remove("hidden");
-    _termDisconnect();
-    document.getElementById("terminal-status-label").textContent = "Disconnected";
-    document.getElementById("terminal-connect-btn").classList.remove("hidden");
-    document.getElementById("terminal-disconnect-btn").classList.add("hidden");
-    runCommand("destroy", selectedContainer);
-  });
-  termDestroyBar.querySelector(".cmd-confirm-no").addEventListener("click", function () {
-    termDestroyBar.remove();
-    termCmdRow.classList.remove("hidden");
-  });
-});
-
 window.addEventListener("resize", function () {
@@ -1112,6 +1112,17 @@
     if (cmd === "terminal") {
       const terminalType = localStorage.getItem("cb-terminal") || "auto";
       fetch(
         "/api/containers/" + encodeURIComponent(selectedContainer.name) + "/terminal",
         {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({ terminal: terminalType }),
         }
       )
         .then(function (r) { return r.json(); })
         .then(function (result) {
           if (result.error) {
             cmdOutput.textContent = "Terminal error: " + result.error + "\n";
             cmdOutput.classList.remove("hidden");
           }
         })
         .catch(function (e) {
           cmdOutput.textContent = "Terminal error: " + e.message + "\n";
           cmdOutput.classList.remove("hidden");
         });
       return;
     }
+    if (cmd === "refresh") {
+      runCommand("refresh", selectedContainer);
+      if (_termContainer && _termXterm) {
+        _termXterm.write("\r");
+        fetch("/api/containers/" + encodeURIComponent(_termContainer) + "/terminal/input", {
+          method: "POST",
+          headers: { "Content-Type": "application/json" },
+          body: JSON.stringify({ data: "source /home/node/.env.sh\r" }),
+        }).catch(function () {});
+      }
+      return;
+    }
     runCommand(cmd, selectedContainer);
   });
 });

```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -3358,6 +3358,9 @@
 document.getElementById("term-stop-start-btn").addEventListener("click", function () {
+// term-refresh-btn and term-destroy-btn have no listeners here.
+// Sync Config and Destroy live in the Overview tab command panel. (PDL-003)
+// Stop/Start (#term-stop-start-btn) belongs in the terminal header: it stops
+// the container process without navigating away from the terminal view.

```


**CC-M-002-006** (gui/static/app.js) - implements CI-M-002-006

**Code:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -1033,7 +1033,9 @@
     if (cmd === "unregister") {
       const nameAtClick = selectedContainer.name;
       const confirmBar = document.createElement("div");
       confirmBar.className = "cmd-confirm-bar";
       confirmBar.innerHTML =
         '<span class="cmd-confirm-text">Remove <strong>' + escHtml(nameAtClick) + '</strong> from registry? (Docker container is not deleted)</span>' +
         '<button class="cmd-confirm-yes">Confirm</button>' +
         '<button class="cmd-confirm-no">Cancel</button>';
+      const overflowMenu = document.getElementById("cmd-overflow-menu");
+      if (overflowMenu) overflowMenu.classList.add("hidden");
       const commandButtons = document.querySelector(".command-buttons");
       commandButtons.classList.add("hidden");
       commandButtons.parentNode.insertBefore(confirmBar, commandButtons);
@@ -1061,7 +1065,17 @@
       const confirmBar = document.createElement("div");
       confirmBar.className = "cmd-confirm-bar";
       confirmBar.innerHTML =
         '<span class="cmd-confirm-text">Destroy <strong>' + escHtml(nameAtClick) + '</strong>? This removes the Docker container.</span>' +
         '<button class="cmd-confirm-yes cmd-btn-danger">⚠ Confirm Destroy</button>' +
         '<button class="cmd-confirm-no">Cancel</button>';
 
+      const overflowMenu2 = document.getElementById("cmd-overflow-menu");
+      if (overflowMenu2) overflowMenu2.classList.add("hidden");
       const commandButtons = document.querySelector(".command-buttons");
       commandButtons.classList.add("hidden");
       commandButtons.parentNode.insertBefore(confirmBar, commandButtons);
 
       confirmBar.querySelector(".cmd-confirm-yes").addEventListener("click", function () {
         confirmBar.remove();
         commandButtons.classList.remove("hidden");
+        if (_termContainer && _termXterm) {
+          _termDisconnect();
+          document.getElementById("terminal-status-label").textContent = "Disconnected";
+          document.getElementById("terminal-connect-btn").classList.remove("hidden");
+          document.getElementById("terminal-disconnect-btn").classList.add("hidden");
+        }
         runCommand("destroy", selectedContainer);

```

**Documentation:**

```diff
--- a/gui/static/app.js
+++ b/gui/static/app.js
@@ -1065,6 +1065,9 @@
       const overflowMenu2 = document.getElementById("cmd-overflow-menu");
+      // Hide the overflow menu when the confirm bar is shown; the confirm bar
+      // replaces the command-buttons row in the DOM, so leaving the menu open
+      // would leave it floating over an empty area. (PDL-002)
       if (overflowMenu2) overflowMenu2.classList.add("hidden");

```

