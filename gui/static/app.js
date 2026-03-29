/**
 * ClaudeBox Dashboard — single-page application. (ref: DL-003)
 * ES module structure; communicates with the Python server via fetch (REST)
 * and EventSource (SSE for command streaming). (ref: DL-004)
 *
 * Tab groups use data-tab-group attribute scoping so top-level detail tabs
 * (overview/config/modules/inspect) and inner config tabs (merged/global/local)
 * operate independently via initTabGroup(). (ref: DL-001)
 */

// --- Helpers ---

/** Decode a base64 string to Uint8Array so xterm.js renders UTF-8 correctly. */
function _b64ToU8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- State ---

let selectedContainer = null;
let _modEditorIsRaw  = false;   // form=false, raw JSON=true (per-container module editor)
let _gmodEditorIsRaw = false;   // form=false, raw JSON=true (global module editor)
let _newContainerMode = "existing"; // "existing" | "clone"
let _pendingContainerPath = null;   // project path of container being initialized
const _containerUiState = {};   // keyed by container name: { tab, profileOutput, profileNoteVisible }

// --- DOM refs ---

const containerList  = document.getElementById("container-list");
const detailPanel    = document.getElementById("detail-panel");
const newPanel       = document.getElementById("new-panel");
const welcomePanel   = document.getElementById("welcome-panel");
const detailName     = document.getElementById("detail-name");
const detailStatus   = document.getElementById("detail-status");
const detailLanguage = document.getElementById("detail-language");
const detailProject  = document.getElementById("detail-project");
const detailCreated  = document.getElementById("detail-created");
const cmdOutput      = document.getElementById("cmd-output");

const linkProjectForm = document.getElementById("link-project-form");
const linkProjectDir  = document.getElementById("link-project-dir");
const linkProjectMsg  = document.getElementById("link-project-msg");

const mergedView      = document.getElementById("merged-config-view");
const globalView      = document.getElementById("global-config-view");
const globalEditor    = document.getElementById("global-config-editor");
const globalMsg       = document.getElementById("global-config-msg");
const localView       = document.getElementById("local-config-view");
const localEditor     = document.getElementById("local-config-editor");
const localMsg        = document.getElementById("local-config-msg");
const extraCmdWarning = document.getElementById("extra-commands-warning");

const verifyResults     = document.getElementById("verify-results");
const moduleList        = document.getElementById("module-list");
const moduleEditorPanel = document.getElementById("module-editor-panel");
const moduleEditorName  = document.getElementById("module-editor-name");
const moduleEditorScope = document.getElementById("module-editor-scope");
const moduleEditorBody  = document.getElementById("module-editor-body");
const moduleEditorMsg   = document.getElementById("module-editor-msg");
const moduleEditorTitle = document.getElementById("module-editor-title");
const inspectContent    = document.getElementById("inspect-content");
const moduleApplyOutput = document.getElementById("module-apply-output");
const refsList = document.getElementById("refs-list");
const refAddOutput = document.getElementById("ref-add-output");

const modulesPanel           = document.getElementById("modules-panel");
const settingsPanel          = document.getElementById("settings-panel");
const dashboardPanel         = document.getElementById("dashboard-panel");
const globalModuleList       = document.getElementById("global-module-list");
const globalModuleEditorPanel= document.getElementById("global-module-editor-panel");
const globalModuleEditorTitle= document.getElementById("global-module-editor-title");
const globalModuleEditorName = document.getElementById("global-module-editor-name");
const globalModuleEditorBody = document.getElementById("global-module-editor-body");
const globalModuleEditorMsg  = document.getElementById("global-module-editor-msg");

// --- Theme ---

(function () {
  const saved = localStorage.getItem("cb-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  updateThemeIcon();
})();

function updateThemeIcon() {
  const btn = document.getElementById("theme-toggle-btn");
  if (!btn) return;
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  btn.textContent = isDark ? "🌙" : "☀️";
  btn.title = isDark ? "Switch to light theme" : "Switch to dark theme";
}

document.getElementById("theme-toggle-btn").addEventListener("click", function () {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "light" ? "dark" : "light";
  if (next === "dark") {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem("cb-theme");
  } else {
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("cb-theme", next);
  }
  updateThemeIcon();
  // Update live terminal theme without disconnecting
  if (typeof _termXterm !== "undefined" && _termXterm) {
    const nowDark = document.documentElement.getAttribute("data-theme") !== "light";
    _termXterm.options.theme = nowDark
      ? { background: "#0d0d0d", foreground: "#c8e6c9", cursor: "#a0cfb0" }
      : { background: "#f8f9fa", foreground: "#1e2433", cursor: "#1e2433", selectionBackground: "rgba(59,130,246,0.25)" };
  }
});

// --- Utilities ---

/** Map raw Docker status string to CSS class name.
 * Abstracted so badge styles and status string parsing are co-located;
 * Docker status strings vary (e.g. "Up 2 hours") and prefix matching keeps
 * this mapping stable across Docker versions. */
function statusClass(raw) {
  if (!raw) return "unknown";
  const r = raw.toLowerCase();
  if (r.startsWith("up"))      return "running";
  if (r.startsWith("exited"))  return "exited";
  if (r.startsWith("paused"))  return "paused";
  if (r === "removed")         return "removed";
  return "unknown";
}

/** Show one panel; hide the other two.
 * Mutual exclusion enforced here so adding a new panel only requires
 * updating this function, not every call site. */
function showPanel(name) {
  detailPanel.classList.add("hidden");
  newPanel.classList.add("hidden");
  welcomePanel.classList.add("hidden");
  modulesPanel.classList.add("hidden");
  settingsPanel.classList.add("hidden");
  dashboardPanel.classList.add("hidden");
  // Tear down dashboard tiles when leaving the dashboard view so SSE connections
  // are closed and xterm.js instances are disposed (DL-006).
  if (name !== "dashboard") {
    _teardownDashboardTiles(Object.keys(_dashboardTiles));
    _stopDashboardStatusInterval();
  }
  if (name === "detail")        detailPanel.classList.remove("hidden");
  else if (name === "new")      newPanel.classList.remove("hidden");
  else if (name === "modules")  modulesPanel.classList.remove("hidden");
  else if (name === "settings") settingsPanel.classList.remove("hidden");
  else if (name === "dashboard") dashboardPanel.classList.remove("hidden");
  else                          welcomePanel.classList.remove("hidden");
  document.getElementById("modules-nav-btn").classList.toggle("active", name === "modules");
  document.getElementById("settings-nav-btn").classList.toggle("active", name === "settings");
  document.getElementById("dashboard-nav-btn").classList.toggle("active", name === "dashboard");
}

/** Set text and error/success class on a status message element. */
function setMsg(el, text, isError) {
  el.textContent = text;
  el.className = "config-msg " + (isError ? "error" : "success");
}

/** Escape HTML special characters for safe innerHTML insertion. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Container list ---

/** Fetch /api/containers and re-render the sidebar list. */
async function loadContainers() {
  try {
    const resp = await fetch("/api/containers");
    const containers = await resp.json();
    renderContainerList(containers);
  } catch (e) {
    containerList.innerHTML = '<div class="loading">Failed to load containers.</div>';
  }
}

/** Build sidebar items from containers array; attach click handler per item. */
function renderContainerList(containers) {
  if (!containers.length) {
    containerList.innerHTML = '<div class="loading">No containers found.</div>';
    return;
  }
  containerList.innerHTML = "";
  containers.forEach(function (c) {
    const cls  = statusClass(c.status);
    const item = document.createElement("div");
    item.className  = "container-item";
    item.dataset.name = c.name;

    let uptimeHtml = "";
    if (cls === "running" && c.status) {
      // Docker status string is like "Up 2 hours" or "Up 3 minutes"
      const upMatch = c.status.match(/^Up (.+)/i);
      if (upMatch) {
        uptimeHtml = '<span class="container-uptime">↑ ' + escHtml(upMatch[1]) + '</span>';
      }
    } else if (cls === "exited" && c.status) {
      const exMatch = c.status.match(/Exited \(\d+\) (.+)/i);
      if (exMatch) {
        uptimeHtml = '<span class="container-uptime">stopped ' + escHtml(exMatch[1]) + '</span>';
      }
    }

    item.innerHTML =
      '<div class="container-item-main">' +
        '<span class="name">' + escHtml(c.nickname || c.name) + "</span>" +
        '<span class="badge ' + cls + '">' + escHtml(cls) + "</span>" +
      '</div>' +
      uptimeHtml;
    item.addEventListener("click", function () { selectContainer(c); });
    containerList.appendChild(item);
  });
}

// --- Tab system ---

/** Generic scoped tab group initializer. (ref: DL-001)
 *
 * Queries [data-tab-group=groupName].tab-btn elements and attaches click
 * handlers that toggle active/hidden within that group only. Content panels
 * are identified by [data-tab-group=groupName][data-for-tab] elements.
 * This scoping prevents top-level detail tabs from interfering with the
 * nested config tabs that share the same .tab-btn class. */
function initTabGroup(groupName) {
  document.querySelectorAll('[data-tab-group="' + groupName + '"].tab-btn').forEach(function (btn) {
    btn.addEventListener("click", function () {
      const tab = btn.dataset.tab;
      document.querySelectorAll('[data-tab-group="' + groupName + '"].tab-btn').forEach(function (b) {
        b.classList.toggle("active", b.dataset.tab === tab);
      });
      document.querySelectorAll('[data-tab-group="' + groupName + '"][data-for-tab]').forEach(function (el) {
        const isActive = el.dataset.forTab === tab;
        el.classList.toggle("active", isActive);
        el.classList.toggle("hidden", !isActive);
      });
    });
  });
}

/** Programmatically activate a tab within a group (e.g. reset to overview on container select). */
function activateTab(groupName, tabName) {
  document.querySelectorAll('[data-tab-group="' + groupName + '"].tab-btn').forEach(function (b) {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });
  document.querySelectorAll('[data-tab-group="' + groupName + '"][data-for-tab]').forEach(function (el) {
    const isActive = el.dataset.forTab === tabName;
    el.classList.toggle("active", isActive);
    el.classList.toggle("hidden", !isActive);
  });
}

initTabGroup("detail");
initTabGroup("config");

// --- Container selection ---

function _saveContainerUiState() {
  if (!selectedContainer) return;
  const activeTabBtn = document.querySelector('[data-tab-group="detail"].tab-btn.active');
  const activeConfigTabBtn = document.querySelector('[data-tab-group="config"].tab-btn.active');
  _containerUiState[selectedContainer.name] = {
    tab: activeTabBtn ? activeTabBtn.dataset.tab : "overview",
    configTab: activeConfigTabBtn ? activeConfigTabBtn.dataset.tab : "merged",
    profileOutput: document.getElementById("profile-switch-output").textContent,
    profileNoteVisible: !document.getElementById("profile-env-note").classList.contains("hidden"),
    cmdOutput: cmdOutput.textContent,
    cmdOutputVisible: !cmdOutput.classList.contains("hidden"),
    verifyHtml: verifyResults.innerHTML,
    verifyVisible: !verifyResults.classList.contains("hidden"),
    filesBrowserPath: _filesBrowserPath,
  };
}

function selectContainer(c) {
  _saveContainerUiState();
  selectedContainer = c;

  document.querySelectorAll(".container-item").forEach(function (el) {
    el.classList.toggle("active", el.dataset.name === c.name);
  });

  detailName.textContent = c.nickname || c.name;
  document.getElementById("nickname-edit-btn").classList.remove("hidden");
  document.getElementById("nickname-edit-group").classList.add("hidden");
  const pinBtn = document.getElementById("detail-pin-btn");
  if (pinBtn) {
    pinBtn.classList.remove("hidden");
    _updatePinBtnLabel(c.name);
    pinBtn.onclick = function () { togglePinContainer(c.name); };
  }
  const cls = statusClass(c.status);

  // Toggle Stop ↔ Start based on container status (both Overview and Terminal tab buttons)
  const stopStartBtn = document.getElementById("cmd-stop-start-btn");
  const termStopStartBtn = document.getElementById("term-stop-start-btn");
  if (cls === "exited") {
    if (stopStartBtn) {
      stopStartBtn.textContent = "▶ Start";
      stopStartBtn.setAttribute("data-cmd", "start");
      stopStartBtn.className = "cmd-btn cmd-start";
    }
    if (termStopStartBtn) {
      termStopStartBtn.textContent = "▶ Start";
      termStopStartBtn.className = "cmd-btn cmd-start";
    }
  } else {
    if (stopStartBtn) {
      stopStartBtn.textContent = "⏹ Stop";
      stopStartBtn.setAttribute("data-cmd", "stop");
      stopStartBtn.className = "cmd-btn cmd-stop";
    }
    if (termStopStartBtn) {
      termStopStartBtn.textContent = "⏹ Stop";
      termStopStartBtn.className = "cmd-btn cmd-stop";
    }
  }
  // Terminal only usable when container is running
  const terminalBtn = document.querySelector("[data-cmd='terminal']");
  if (terminalBtn) terminalBtn.disabled = cls !== "running";
  detailStatus.textContent = cls;
  detailStatus.className   = "badge " + cls;
  detailLanguage.textContent = c.language || "—";
  detailProject.textContent  = c.project_path || "—";
  detailCreated.textContent  = c.created_at
    ? new Date(c.created_at).toLocaleString()
    : "—";

  const _savedState = _containerUiState[c.name];

  cmdOutput.textContent = (_savedState && _savedState.cmdOutput) || "";
  cmdOutput.classList.toggle("hidden", !(_savedState && _savedState.cmdOutputVisible));

  // Hide rebuild button when switching to a new container; re-show for removed containers
  const rebuildBtn = document.getElementById("cmd-rebuild-btn");
  if (rebuildBtn) {
    if (cls === "removed") {
      rebuildBtn.classList.remove("hidden");
    } else {
      rebuildBtn.classList.add("hidden");
    }
  }
  // For removed containers: hide dangerous buttons, disable interactive ones
  const destroyBtn2 = document.querySelector('[data-cmd="destroy"]');
  const unregBtn2 = document.querySelector('[data-cmd="unregister"]');
  const overflowToggleBtn = document.getElementById("cmd-overflow-toggle-btn");
  const stopStartBtn2 = document.getElementById("cmd-stop-start-btn");
  const termStopBtn2 = document.getElementById("term-stop-start-btn");
  const terminalBtn2 = document.querySelector('[data-cmd="terminal"]');
  if (cls === "removed") {
    if (destroyBtn2) destroyBtn2.classList.add("hidden");
    if (unregBtn2) unregBtn2.classList.add("hidden");
    if (overflowToggleBtn) overflowToggleBtn.classList.add("hidden");
    if (stopStartBtn2) stopStartBtn2.disabled = true;
    if (termStopBtn2) termStopBtn2.disabled = true;
    if (terminalBtn2) terminalBtn2.disabled = true;
  } else {
    if (destroyBtn2) destroyBtn2.classList.remove("hidden");
    if (unregBtn2) unregBtn2.classList.remove("hidden");
    if (overflowToggleBtn) overflowToggleBtn.classList.remove("hidden");
  }

  // Reset config views to loading state while fetches are in flight
  mergedView.textContent = "Loading…";
  globalView.textContent = "Loading…";
  localView.textContent  = "Loading…";
  linkProjectForm.classList.add("hidden");
  setMsg(linkProjectMsg, "", false);

  // Reset modules, inspect, and profile switcher; restore verify results
  moduleList.innerHTML = '<div class="loading">Loading modules…</div>';
  moduleEditorPanel.classList.add("hidden");
  inspectContent.innerHTML = '<div class="loading">Loading inspect data…</div>';
  verifyResults.innerHTML = (_savedState && _savedState.verifyHtml) || "";
  verifyResults.classList.toggle("hidden", !(_savedState && _savedState.verifyVisible));
  document.getElementById("profile-switcher").classList.add("hidden");

  // Restore last active tab for this container (default: overview)
  activateTab("detail", (_savedState && _savedState.tab) || "overview");

  showPanel("detail");

  // Sync pin button label when navigating to a container detail view (DL-005).
  _updatePinBtnLabel(c.name);

  if (!c.project_path) {
    // Auto-detection already ran on the server; if project_path is still empty
    // Docker inspect found nothing. Show the manual link form.
    mergedView.textContent = "";
    globalView.textContent = "";
    localView.textContent  = "";
    linkProjectDir.value = "";
    linkProjectForm.classList.remove("hidden");
    // Inspect only needs container name; modules loads without project scope
    loadInspect(c.name);
    loadModules(null);
    return;
  }

  loadConfigForContainer(c).catch(function (e) {
    mergedView.textContent = "Failed to load config: " + e.message;
  });
  loadModules(c.project_path);
  loadInspect(c.name);
  loadProfileSwitcher(c);
}

// --- Config loading ---

async function loadConfigForContainer(c) {
  if (!c.project_path) {
    mergedView.textContent = "(no project path — config unavailable)";
    globalView.textContent = "";
    localView.textContent  = "";
    return;
  }

  const qs = "?project_dir=" + encodeURIComponent(c.project_path);

  const [mergedResp, globalResp, localResp] = await Promise.all([
    fetch("/api/config/merged" + qs).then(function (r) { return r.json(); }),
    fetch("/api/config/global").then(function (r) { return r.json(); }),
    fetch("/api/config/local" + qs).then(function (r) { return r.json(); }),
  ]);

  mergedView.textContent = JSON.stringify(mergedResp, null, 2);
  globalView.textContent = JSON.stringify(globalResp, null, 2);
  localView.textContent  = JSON.stringify(localResp, null, 2);

  globalEditor.value = JSON.stringify(globalResp, null, 2);
  localEditor.value  = JSON.stringify(localResp, null, 2);

  _globalConfigForm.setValue(globalResp);
  _localConfigForm.setValue(localResp);

  // Restore config sub-tab (merged/global/local) for this container
  const _savedCfg = selectedContainer && _containerUiState[selectedContainer.name];
  if (_savedCfg && _savedCfg.configTab) {
    activateTab("config", _savedCfg.configTab);
  }
}

// --- Config editing: global ---

let _globalEditorIsRaw = false;

document.getElementById("global-edit-btn").addEventListener("click", function () {
  globalView.classList.add("hidden");
  document.getElementById("global-config-form-mount").classList.remove("hidden");
  document.getElementById("global-config-form-mount").classList.add("config-form-active");
  document.getElementById("global-edit-btn").classList.add("hidden");
  document.getElementById("global-save-btn").classList.remove("hidden");
  document.getElementById("global-cancel-btn").classList.remove("hidden");
  document.getElementById("global-form-raw-btn").classList.remove("hidden");
  _globalEditorIsRaw = false;
});

document.getElementById("global-cancel-btn").addEventListener("click", function () {
  document.getElementById("global-config-form-mount").classList.add("hidden");
  globalEditor.classList.add("hidden");
  globalView.classList.remove("hidden");
  document.getElementById("global-edit-btn").classList.remove("hidden");
  document.getElementById("global-save-btn").classList.add("hidden");
  document.getElementById("global-cancel-btn").classList.add("hidden");
  document.getElementById("global-form-raw-btn").classList.add("hidden");
  _globalEditorIsRaw = false;
  setMsg(globalMsg, "", false);
});

document.getElementById("global-save-btn").addEventListener("click", async function () {
  let data;
  if (_globalEditorIsRaw) {
    try { data = JSON.parse(globalEditor.value); } catch (e) {
      setMsg(globalMsg, "Invalid JSON: " + e.message, true); return;
    }
  } else {
    data = _globalConfigForm.getValue();
  }
  const resp = await fetch("/api/config/global", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const result = await resp.json();
  if (result.error) { setMsg(globalMsg, result.error, true); return; }
  setMsg(globalMsg, "Saved.", false);
  globalView.textContent = JSON.stringify(data, null, 2);
  document.getElementById("global-cancel-btn").click();
});

document.getElementById("global-form-raw-btn").addEventListener("click", function () {
  if (!_globalEditorIsRaw) {
    // form → raw
    globalEditor.value = JSON.stringify(_globalConfigForm.getValue(), null, 2);
    document.getElementById("global-config-form-mount").classList.add("hidden");
    globalEditor.classList.remove("hidden");
    document.getElementById("global-form-raw-btn").textContent = "Edit as Form ⇄";
    _globalEditorIsRaw = true;
  } else {
    // raw → form
    let data;
    try { data = JSON.parse(globalEditor.value); } catch (e) {
      setMsg(globalMsg, "Invalid JSON: " + e.message, true); return;
    }
    _globalConfigForm.setValue(data);
    globalEditor.classList.add("hidden");
    document.getElementById("global-config-form-mount").classList.remove("hidden");
    document.getElementById("global-form-raw-btn").textContent = "Edit as JSON ⇄";
    _globalEditorIsRaw = false;
    setMsg(globalMsg, "", false);
  }
});

// --- Config editing: local ---

let _localEditorIsRaw = false;

document.getElementById("local-edit-btn").addEventListener("click", function () {
  localView.classList.add("hidden");
  document.getElementById("local-config-form-mount").classList.remove("hidden");
  document.getElementById("local-edit-btn").classList.add("hidden");
  document.getElementById("local-save-btn").classList.remove("hidden");
  document.getElementById("local-cancel-btn").classList.remove("hidden");
  document.getElementById("local-form-raw-btn").classList.remove("hidden");
  _localEditorIsRaw = false;
});

document.getElementById("local-cancel-btn").addEventListener("click", function () {
  document.getElementById("local-config-form-mount").classList.add("hidden");
  localEditor.classList.add("hidden");
  localView.classList.remove("hidden");
  document.getElementById("local-edit-btn").classList.remove("hidden");
  document.getElementById("local-save-btn").classList.add("hidden");
  document.getElementById("local-cancel-btn").classList.add("hidden");
  document.getElementById("local-form-raw-btn").classList.add("hidden");
  extraCmdWarning.classList.add("hidden");
  _localEditorIsRaw = false;
  setMsg(localMsg, "", false);
});

function checkExtraCommandsWarning() {
  try {
    const parsed = JSON.parse(localEditor.value);
    const hasExtra = Array.isArray(parsed.extra_commands) && parsed.extra_commands.length > 0;
    extraCmdWarning.classList.toggle("hidden", !hasExtra);
  } catch (e) {
    extraCmdWarning.classList.add("hidden");
  }
}
localEditor.addEventListener("input", checkExtraCommandsWarning);

document.getElementById("local-save-btn").addEventListener("click", async function () {
  if (!selectedContainer || !selectedContainer.project_path) {
    setMsg(localMsg, "No project path for this container.", true); return;
  }
  let data;
  if (_localEditorIsRaw) {
    try { data = JSON.parse(localEditor.value); } catch (e) {
      setMsg(localMsg, "Invalid JSON: " + e.message, true); return;
    }
  } else {
    data = _localConfigForm.getValue();
  }
  const resp = await fetch("/api/config/local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_dir: selectedContainer.project_path, config: data }),
  });
  const result = await resp.json();
  if (result.error) { setMsg(localMsg, result.error, true); return; }
  setMsg(localMsg, "Saved.", false);
  localView.textContent = JSON.stringify(data, null, 2);
  document.getElementById("local-cancel-btn").click();
});

document.getElementById("local-form-raw-btn").addEventListener("click", function () {
  if (!_localEditorIsRaw) {
    localEditor.value = JSON.stringify(_localConfigForm.getValue(), null, 2);
    document.getElementById("local-config-form-mount").classList.add("hidden");
    localEditor.classList.remove("hidden");
    document.getElementById("local-form-raw-btn").textContent = "Edit as Form ⇄";
    _localEditorIsRaw = true;
    checkExtraCommandsWarning();
  } else {
    let data;
    try { data = JSON.parse(localEditor.value); } catch (e) {
      setMsg(localMsg, "Invalid JSON: " + e.message, true); return;
    }
    _localConfigForm.setValue(data);
    localEditor.classList.add("hidden");
    extraCmdWarning.classList.add("hidden");
    document.getElementById("local-config-form-mount").classList.remove("hidden");
    document.getElementById("local-form-raw-btn").textContent = "Edit as JSON ⇄";
    _localEditorIsRaw = false;
    setMsg(localMsg, "", false);
  }
});

// --- Config verify ---

document.getElementById("verify-config-btn").addEventListener("click", function () {
  if (!selectedContainer || !selectedContainer.project_path) {
    verifyResults.innerHTML = '<div class="verify-item verify-warn"><span class="verify-icon">⚠</span> No project path — config unavailable.</div>';
    verifyResults.classList.remove("hidden");
    return;
  }
  loadConfigVerify(selectedContainer.project_path);
});

/** Fetch GET /api/config/verify and render pass/warn results inline. */
async function loadConfigVerify(projectDir) {
  verifyResults.innerHTML = '<div class="loading">Verifying…</div>';
  verifyResults.classList.remove("hidden");
  try {
    const resp = await fetch("/api/config/verify?project_dir=" + encodeURIComponent(projectDir));
    const data = await resp.json();
    if (data.error) {
      verifyResults.innerHTML = '<div class="verify-item verify-warn"><span class="verify-icon">✗</span> ' + escHtml(data.error) + '</div>';
      return;
    }
    const issues = Array.isArray(data.issues) ? data.issues : [];
    if (issues.length === 0) {
      verifyResults.innerHTML = '<div class="verify-item verify-pass"><span class="verify-icon">✓</span> Config is valid — no issues found.</div>';
    } else {
      verifyResults.innerHTML = issues.map(function (issue) {
        const field = issue.field ? '<strong>' + escHtml(issue.field) + '</strong>: ' : '';
        const msg = escHtml(issue.message || String(issue));
        return '<div class="verify-item verify-warn"><span class="verify-icon">⚠</span> ' + field + msg + '</div>';
      }).join("");
    }
  } catch (e) {
    verifyResults.innerHTML = '<div class="verify-item verify-warn"><span class="verify-icon">✗</span> Verify failed: ' + escHtml(e.message) + '</div>';
  }
}

// --- Modules tab ---

/** Load and render the refs list for the running container. */
async function loadRefs(containerName) {
  if (!refsList) return;
  if (!containerName) {
    refsList.innerHTML = '<div class="loading">No container selected.</div>';
    return;
  }
  refsList.innerHTML = '<div class="loading">Loading refs…</div>';
  try {
    const resp = await fetch(
      "/api/containers/" + encodeURIComponent(containerName) + "/files?path=/workspace/refs"
    );
    const data = await resp.json();
    if (data.error) {
      refsList.innerHTML = '<div class="loading">' + escHtml(data.error) + '</div>';
      return;
    }
    const entries = (data.entries || []).filter(function (e) { return e.is_dir; });
    if (!entries.length) {
      refsList.innerHTML = '<div class="loading">No refs yet. Add one below.</div>';
      return;
    }
    refsList.innerHTML = "";
    entries.forEach(function (e) {
      const item = document.createElement("div");
      item.className = "ref-item";
      item.innerHTML =
        '<span class="ref-item-name">' + escHtml(e.name) + '</span>' +
        '<div class="ref-item-actions">' +
          '<button class="ref-refresh-btn">↺ Refresh</button>' +
          '<button class="ref-remove-btn">✕ Remove</button>' +
        '</div>';

      item.querySelector(".ref-refresh-btn").addEventListener("click", function () {
        // Pre-fill input with ref name as hint, check --refresh, scroll to form
        const input = document.getElementById("ref-dir-input");
        const checkbox = document.getElementById("ref-refresh-checkbox");
        if (input) input.value = e.name;
        if (checkbox) checkbox.checked = true;
        const addSection = document.querySelector(".refs-add-section");
        if (addSection) addSection.scrollIntoView({ behavior: "smooth" });
      });

      item.querySelector(".ref-remove-btn").addEventListener("click", async function () {
        const btn = item.querySelector(".ref-remove-btn");
        if (btn.dataset.confirming) {
          btn.disabled = true;
          btn.textContent = "Removing…";
          const r = await fetch(
            "/api/containers/" + encodeURIComponent(selectedContainer.name) + "/refs/" + encodeURIComponent(e.name),
            { method: "DELETE" }
          );
          const result = await r.json();
          if (result.error) {
            btn.disabled = false;
            btn.textContent = "Error";
            setTimeout(function () { btn.textContent = "✕ Remove"; delete btn.dataset.confirming; }, 2000);
          } else {
            loadRefs(selectedContainer.name);
          }
        } else {
          btn.dataset.confirming = "1";
          btn.textContent = "Confirm?";
          setTimeout(function () {
            btn.textContent = "✕ Remove";
            delete btn.dataset.confirming;
          }, 3000);
        }
      });

      refsList.appendChild(item);
    });
  } catch (err) {
    refsList.innerHTML = '<div class="loading">Failed to load refs: ' + escHtml(err.message) + '</div>';
  }
}

/** Fetch GET /api/modules and render module cards. */
async function loadModules(projectDir) {
  moduleList.innerHTML = '<div class="loading">Loading modules…</div>';
  try {
    const qs = projectDir ? "?project_dir=" + encodeURIComponent(projectDir) : "";
    const resp = await fetch("/api/modules" + qs);
    const modules = await resp.json();
    if (resp.ok && Array.isArray(modules)) {
      renderModules(modules, projectDir);
    } else {
      moduleList.innerHTML = '<div class="loading">Failed to load modules.</div>';
    }
  } catch (e) {
    moduleList.innerHTML = '<div class="loading">Failed to load modules: ' + escHtml(e.message) + '</div>';
  }
}

function renderModules(modules, projectDir) {
  if (!modules.length) {
    moduleList.innerHTML = '<div class="loading">No modules found. Use <strong>+ Create Module</strong> to add one.</div>';
    return;
  }
  moduleList.innerHTML = "";
  modules.forEach(function (mod) {
    const isBuiltin = mod.scope === "builtin";
    const card = document.createElement("div");
    card.className = "module-card";

    const appliedLabel = mod.applied ? "Applied" : "Apply";
    const appliedCls   = "module-toggle" + (mod.applied ? " applied" : "");

    let actionsHtml = "";
    if (projectDir) {
      actionsHtml += '<button class="' + appliedCls + '">' + appliedLabel + '</button>';
    }
    if (!isBuiltin) {
      actionsHtml += '<button class="module-edit-btn">Edit</button>';
      actionsHtml += '<button class="module-delete-btn">Delete</button>';
    }

    card.innerHTML =
      '<div class="module-card-header">' +
        '<span class="module-name">' + escHtml(mod.name) + '</span>' +
        '<span class="scope-badge ' + escHtml(mod.scope) + '">' + escHtml(mod.scope) + '</span>' +
      '</div>' +
      '<div class="module-description">' + escHtml(mod.description || "No description.") + '</div>' +
      '<div class="module-actions">' + actionsHtml + '</div>';

    const toggleBtn = card.querySelector(".module-toggle");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", async function () {
        await toggleModuleApplied(mod.name, mod.applied, projectDir);
        loadModules(projectDir);
      });
    }

    const editBtn = card.querySelector(".module-edit-btn");
    if (editBtn) {
      editBtn.addEventListener("click", function () {
        openModuleEditor(mod, projectDir);
      });
    }

    const deleteBtn = card.querySelector(".module-delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", function () {
        if (deleteBtn.dataset.confirming) {
          // Second click = confirmed
          deleteModule(mod.name, mod.scope, projectDir).then(function () {
            loadModules(projectDir);
          });
        } else {
          // First click = show confirmation state
          deleteBtn.dataset.confirming = "1";
          deleteBtn.textContent = "Confirm delete?";
          const cancelBtn = document.createElement("button");
          cancelBtn.className = "module-confirm-no";
          cancelBtn.textContent = "Cancel";
          cancelBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            delete deleteBtn.dataset.confirming;
            deleteBtn.textContent = "Delete";
            cancelBtn.remove();
          });
          deleteBtn.insertAdjacentElement("afterend", cancelBtn);
        }
      });
    }

    moduleList.appendChild(card);
  });
}

/** Toggle module name in the local config modules array. */
async function toggleModuleApplied(moduleName, isCurrentlyApplied, projectDir) {
  const localResp = await fetch("/api/config/local?project_dir=" + encodeURIComponent(projectDir));
  const localConfig = await localResp.json();
  const modules = Array.isArray(localConfig.modules) ? localConfig.modules : [];
  const newModules = isCurrentlyApplied
    ? modules.filter(function (m) { return m !== moduleName; })
    : (modules.indexOf(moduleName) >= 0 ? modules : modules.concat([moduleName]));
  await fetch("/api/config/local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_dir: projectDir, config: Object.assign({}, localConfig, { modules: newModules }) }),
  });
  // When removing an applied module, show a note that the tools stay installed until rebuild
  if (isCurrentlyApplied) {
    moduleApplyOutput.textContent = "Removed from config.\nModule tools remain installed in this container until it is rebuilt.";
    moduleApplyOutput.classList.remove("hidden");
    loadModules(projectDir);
    return;
  }
  // When adding a module to a running container, immediately install it via
  // `claudebox module apply` so the user doesn't have to destroy/rebuild.
  if (!isCurrentlyApplied && selectedContainer && statusClass(selectedContainer.status) === "running") {
    moduleApplyOutput.textContent = "";
    moduleApplyOutput.classList.remove("hidden");
    streamToTerminal("module apply --container " + selectedContainer.name + " " + moduleName, projectDir, moduleApplyOutput, function (ok) {
      if (ok) {
        moduleApplyOutput.textContent += "\nReload your terminal or run: source ~/.env.sh\n";
        // Push `source ~/.env.sh` into the active terminal session if one is open
        if (_termContainer === selectedContainer.name) {
          fetch(
            "/api/containers/" + encodeURIComponent(selectedContainer.name) + "/terminal/input",
            { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ data: "source ~/.env.sh\r" }) }
          ).catch(function () {});
        }
      }
      loadModules(projectDir);
    });
  }
}

/** Send DELETE /api/modules for a non-builtin module. */
async function deleteModule(name, scope, projectDir) {
  const qs = "?name=" + encodeURIComponent(name) +
    "&scope=" + encodeURIComponent(scope) +
    (projectDir ? "&project_dir=" + encodeURIComponent(projectDir) : "");
  await fetch("/api/modules" + qs, { method: "DELETE" });
}

/** Open inline JSON editor for create (mod=null) or edit (mod=existing). */
function openModuleEditor(mod, projectDir) {
  moduleEditorTitle.textContent = mod ? "Edit: " + mod.name : "New Module";
  moduleEditorName.value = mod ? mod.name : "";
  moduleEditorName.disabled = !!mod;
  moduleEditorScope.value = mod ? (mod.scope === "builtin" ? "user" : mod.scope) : "user";

  const data = mod ? (mod.data || { description: mod.description || "" }) : { description: "" };
  _modDataToForm(data);
  moduleEditorBody.value = JSON.stringify(data, null, 2);

  // Always open in form mode
  _modEditorIsRaw = false;
  document.getElementById("module-form-fields").classList.remove("hidden");
  document.getElementById("module-raw-fields").classList.add("hidden");

  moduleEditorPanel.classList.remove("hidden");
  document.getElementById("module-field-description").focus();
  setMsg(moduleEditorMsg, "", false);
}

document.getElementById("create-module-btn").addEventListener("click", function () {
  openModuleEditor(null, selectedContainer ? selectedContainer.project_path : null);
});

document.getElementById("module-editor-save-btn").addEventListener("click", async function () {
  const name = moduleEditorName.value.trim();
  const scope = moduleEditorScope.value;
  const projectDir = selectedContainer ? selectedContainer.project_path : null;

  if (!name) { setMsg(moduleEditorMsg, "Module name is required.", true); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    setMsg(moduleEditorMsg, "Name must contain only letters, digits, hyphens, underscores.", true); return;
  }

  let data;
  if (_modEditorIsRaw) {
    try { data = JSON.parse(moduleEditorBody.value); } catch (e) {
      setMsg(moduleEditorMsg, "Invalid JSON: " + e.message, true); return;
    }
  } else {
    data = _modFormToData();
  }

  const resp = await fetch("/api/modules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data, scope, project_dir: projectDir }),
  });
  const result = await resp.json();
  if (result.error) { setMsg(moduleEditorMsg, result.error, true); return; }
  setMsg(moduleEditorMsg, "Saved.", false);
  moduleEditorPanel.classList.add("hidden");
  loadModules(projectDir);
});

document.getElementById("module-editor-cancel-btn").addEventListener("click", function () {
  moduleEditorPanel.classList.add("hidden");
  setMsg(moduleEditorMsg, "", false);
});

document.getElementById("module-raw-toggle-btn").addEventListener("click", function () {
  const data = _modFormToData();
  moduleEditorBody.value = JSON.stringify(data, null, 2);
  _modEditorIsRaw = true;
  document.getElementById("module-form-fields").classList.add("hidden");
  document.getElementById("module-raw-fields").classList.remove("hidden");
});

document.getElementById("module-form-toggle-btn").addEventListener("click", function () {
  let data;
  try { data = JSON.parse(moduleEditorBody.value); } catch (e) {
    setMsg(moduleEditorMsg, "Cannot switch to form mode — invalid JSON: " + e.message, true); return;
  }
  _modDataToForm(data);
  _modEditorIsRaw = false;
  document.getElementById("module-form-fields").classList.remove("hidden");
  document.getElementById("module-raw-fields").classList.add("hidden");
  setMsg(moduleEditorMsg, "", false);
});

// --- Inspect tab ---

/** Fetch GET /api/containers/<name>/inspect and render structured sections. */
async function loadInspect(containerName) {
  inspectContent.innerHTML = '<div class="loading">Loading inspect data…</div>';
  try {
    const resp = await fetch("/api/containers/" + encodeURIComponent(containerName) + "/inspect");
    const data = await resp.json();
    if (data.error) {
      inspectContent.innerHTML = '<div class="loading">' + escHtml(data.error) + '</div>';
      return;
    }
    renderInspect(data.inspect);
  } catch (e) {
    inspectContent.innerHTML = '<div class="loading">Failed to load inspect data: ' + escHtml(e.message) + '</div>';
  }
}

/** Render a <details> inspect section with key-value rows. Returns null if rows is empty. */
function makeInspectSection(title, rows, openByDefault) {
  if (!rows.length) return null;
  const details = document.createElement("details");
  details.className = "inspect-section";
  if (openByDefault !== false) details.open = true;

  const summary = document.createElement("summary");
  summary.className = "inspect-heading";
  summary.textContent = title;
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "inspect-body";
  rows.forEach(function (row) {
    if (!row) return;
    const kv = document.createElement("div");
    kv.className = "inspect-kv";
    const val = (row[1] !== null && row[1] !== undefined) ? String(row[1]) : "—";
    kv.innerHTML =
      '<span class="inspect-key">' + escHtml(row[0]) + '</span>' +
      '<span class="inspect-val">' + escHtml(val) + '</span>';
    body.appendChild(kv);
  });
  details.appendChild(body);
  return details;
}

function renderInspect(data) {
  inspectContent.innerHTML = "";

  // Image
  const imgId  = (data.Id || "").substring(0, 12);
  const config = data.Config || {};
  const tags   = config.Image || data.Image || "—";
  const imgSec = makeInspectSection("Image", [
    ["ID",    imgId || "—"],
    ["Image", tags],
  ]);
  if (imgSec) inspectContent.appendChild(imgSec);

  // State
  const state = data.State || {};
  const finished = state.FinishedAt && state.FinishedAt !== "0001-01-01T00:00:00Z"
    ? new Date(state.FinishedAt).toLocaleString()
    : "—";
  const stateSec = makeInspectSection("State", [
    ["Status",   state.Status || "—"],
    ["PID",      state.Pid !== undefined ? state.Pid : "—"],
    ["Started",  state.StartedAt ? new Date(state.StartedAt).toLocaleString() : "—"],
    ["Finished", finished],
  ]);
  if (stateSec) inspectContent.appendChild(stateSec);

  // Network
  const net    = data.NetworkSettings || {};
  const netRows = [["IP", net.IPAddress || "—"]];
  const networks = net.Networks || {};
  Object.keys(networks).forEach(function (netName) {
    netRows.push(["Net: " + netName, networks[netName].IPAddress || "—"]);
  });
  const ports = net.Ports || {};
  const portStr = Object.keys(ports)
    .filter(function (p) { return ports[p] && ports[p].length; })
    .map(function (p) {
      return (ports[p] || []).map(function (b) { return b.HostPort; }).join(",") + "→" + p;
    }).join("  ");
  if (portStr) netRows.push(["Ports", portStr]);
  const netSec = makeInspectSection("Network", netRows);
  if (netSec) inspectContent.appendChild(netSec);

  // Mounts
  const mounts = data.Mounts || [];
  const mountRows = mounts.map(function (m) {
    return [
      m.Source || "?",
      (m.Destination || "?") + "  [" + (m.Type || "bind") + ", " + (m.RW ? "rw" : "ro") + "]",
    ];
  });
  const mountSec = makeInspectSection("Mounts", mountRows);
  if (mountSec) inspectContent.appendChild(mountSec);

  // Environment — collapsed by default (can be very long)
  const envList = config.Env || [];
  const envRows = envList.map(function (e) {
    const idx = e.indexOf("=");
    return idx < 0 ? [e, ""] : [e.substring(0, idx), e.substring(idx + 1)];
  });
  const envSec = makeInspectSection("Environment", envRows, false);
  if (envSec) inspectContent.appendChild(envSec);
}

// --- Command runner ---

document.querySelectorAll(".cmd-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    if (!selectedContainer) return;
    if (btn.dataset.terminal) return; // terminal-panel buttons handled separately
    const cmd = btn.dataset.cmd;

    if (cmd === "unregister") {
      const nameAtClick = selectedContainer.name;
      const confirmBar = document.createElement("div");
      confirmBar.className = "cmd-confirm-bar";
      confirmBar.innerHTML =
        '<span class="cmd-confirm-text">Remove <strong>' + escHtml(nameAtClick) + '</strong> from registry? (Docker container is not deleted)</span>' +
        '<button class="cmd-confirm-yes">Confirm</button>' +
        '<button class="cmd-confirm-no">Cancel</button>';
      const overflowMenu = document.getElementById("cmd-overflow-menu");
      if (overflowMenu) overflowMenu.classList.add("hidden");
      const commandButtons = document.querySelector(".command-buttons");
      commandButtons.classList.add("hidden");
      commandButtons.parentNode.insertBefore(confirmBar, commandButtons);
      confirmBar.querySelector(".cmd-confirm-yes").addEventListener("click", async function () {
        confirmBar.remove();
        commandButtons.classList.remove("hidden");
        await fetch("/api/containers/" + encodeURIComponent(nameAtClick), { method: "DELETE" });
        loadContainers();
        showPanel("welcome");
      });
      confirmBar.querySelector(".cmd-confirm-no").addEventListener("click", function () {
        confirmBar.remove();
        commandButtons.classList.remove("hidden");
      });
      return;
    }

    if (cmd === "destroy") {
      // Capture name now (user may click another container before confirming)
      const nameAtClick = selectedContainer.name;
      const containerAtClick = selectedContainer;
      const confirmBar = document.createElement("div");
      confirmBar.className = "cmd-confirm-bar";
      confirmBar.innerHTML =
        '<span class="cmd-confirm-text">Destroy <strong>' + escHtml(nameAtClick) + '</strong>? This removes the Docker container.</span>' +
        '<button class="cmd-confirm-yes cmd-btn-danger">⚠ Confirm Destroy</button>' +
        '<button class="cmd-confirm-no">Cancel</button>';

      // Hide the overflow menu when the confirm bar is shown; the confirm bar
      // replaces the command-buttons row in the DOM, so leaving the menu open
      // would leave it floating over an empty area. (PDL-002)
      const overflowMenu2 = document.getElementById("cmd-overflow-menu");
      if (overflowMenu2) overflowMenu2.classList.add("hidden");
      const commandButtons = document.querySelector(".command-buttons");
      commandButtons.classList.add("hidden");
      commandButtons.parentNode.insertBefore(confirmBar, commandButtons);

      confirmBar.querySelector(".cmd-confirm-yes").addEventListener("click", function () {
        confirmBar.remove();
        commandButtons.classList.remove("hidden");
        if (_termContainer && _termXterm) {
          _termDisconnect();
          document.getElementById("terminal-status-label").textContent = "Disconnected";
          document.getElementById("terminal-connect-btn").classList.remove("hidden");
          document.getElementById("terminal-disconnect-btn").classList.add("hidden");
        }
        runCommand("destroy", containerAtClick);
      });
      confirmBar.querySelector(".cmd-confirm-no").addEventListener("click", function () {
        confirmBar.remove();
        commandButtons.classList.remove("hidden");
      });
      return;
    }

    if (cmd === "start") {
      document.querySelectorAll(".cmd-btn").forEach(function (b) { b.disabled = true; });
      cmdOutput.textContent = "Starting container…\n";
      cmdOutput.classList.remove("hidden");
      fetch("/api/containers/" + encodeURIComponent(selectedContainer.name) + "/start", { method: "POST" })
        .then(function (r) { return r.json(); })
        .then(function (result) {
          document.querySelectorAll(".cmd-btn").forEach(function (b) { b.disabled = false; });
          if (result.error) {
            cmdOutput.textContent += "Error: " + result.error + "\n";
          } else {
            cmdOutput.textContent += "Container started.\n";
            const ssBtn = document.getElementById("cmd-stop-start-btn");
            if (ssBtn) { ssBtn.textContent = "⏹ Stop"; ssBtn.setAttribute("data-cmd", "stop"); ssBtn.className = "cmd-btn cmd-stop"; }
            const termSsBtn = document.getElementById("term-stop-start-btn");
            if (termSsBtn) { termSsBtn.textContent = "⏹ Stop"; termSsBtn.className = "cmd-btn cmd-stop"; }
            const termBtn = document.querySelector("[data-cmd='terminal']");
            if (termBtn) termBtn.disabled = false;
            loadContainers();
          }
        })
        .catch(function (e) {
          document.querySelectorAll(".cmd-btn").forEach(function (b) { b.disabled = false; });
          cmdOutput.textContent += "Error: " + e.message + "\n";
        });
      return;
    }

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

    if (cmd === "refresh") {
      runCommand("refresh", selectedContainer);
      if (_termContainer && _termXterm) {
        _termXterm.write("\r");
        fetch("/api/containers/" + encodeURIComponent(_termContainer) + "/terminal/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: "source /home/node/.env.sh\r" }),
        }).catch(function () {});
      }
      return;
    }

    runCommand(cmd, selectedContainer);
  });
});

/** Open an SSE stream for the given claudebox command and append output lines
 * to a terminal div. Passes the container name and project_dir so the server
 * can run the command in the correct working directory. */
function runCommand(cmd, container) {
  // Disable all command buttons during flight; re-enable in onDone
  document.querySelectorAll(".cmd-btn").forEach(function (b) { b.disabled = true; });

  let onDone = null;
  if (cmd === "destroy") {
    onDone = function () {
      document.querySelectorAll(".cmd-btn").forEach(function (b) { b.disabled = false; });
      // Keep detail panel open; update status to removed and show Rebuild button
      if (selectedContainer) {
        selectedContainer = Object.assign({}, selectedContainer, { stale: true, status: "removed" });
        detailStatus.textContent = "removed";
        detailStatus.className = "badge removed";
        const rebuildBtn = document.getElementById("cmd-rebuild-btn");
        if (rebuildBtn) rebuildBtn.classList.remove("hidden");
        // Hide dangerous buttons — Rebuild takes their place
        const destroyBtn = document.querySelector("[data-cmd='destroy']");
        if (destroyBtn) destroyBtn.classList.add("hidden");
        const unregBtn = document.querySelector("[data-cmd='unregister']");
        if (unregBtn) unregBtn.classList.add("hidden");
        const stopStartBtn = document.getElementById("cmd-stop-start-btn");
        if (stopStartBtn) stopStartBtn.disabled = true;
        const termSsBtn = document.getElementById("term-stop-start-btn");
        if (termSsBtn) termSsBtn.disabled = true;
        const terminalBtn = document.querySelector("[data-cmd='terminal']");
        if (terminalBtn) terminalBtn.disabled = true;
      }
      loadContainers();
    };
  } else if (cmd === "stop") {
    onDone = function () {
      document.querySelectorAll(".cmd-btn").forEach(function (b) { b.disabled = false; });
      const ssBtn = document.getElementById("cmd-stop-start-btn");
      if (ssBtn) { ssBtn.textContent = "▶ Start"; ssBtn.setAttribute("data-cmd", "start"); ssBtn.className = "cmd-btn cmd-start"; }
      const termSsBtn = document.getElementById("term-stop-start-btn");
      if (termSsBtn) { termSsBtn.textContent = "▶ Start"; termSsBtn.className = "cmd-btn cmd-start"; }
      const termBtn = document.querySelector("[data-cmd='terminal']");
      if (termBtn) termBtn.disabled = true;
      loadContainers();
    };
  } else {
    onDone = function () {
      document.querySelectorAll(".cmd-btn").forEach(function (b) { b.disabled = false; });
    };
  }

  streamToTerminal(
    cmd + " " + container.name,
    container.project_path || null,
    cmdOutput,
    onDone
  );
}

// Rebuild button: runs claudebox init in the container's project_path after destroy
document.getElementById("cmd-rebuild-btn").addEventListener("click", function () {
  if (!selectedContainer || !selectedContainer.project_path) return;
  const rebuildBtn = document.getElementById("cmd-rebuild-btn");
  document.querySelectorAll(".cmd-btn").forEach(function (b) { b.disabled = true; });
  streamToTerminal(
    "init --no-start",
    selectedContainer.project_path,
    cmdOutput,
    function (ok) {
      document.querySelectorAll(".cmd-btn").forEach(function (b) { b.disabled = false; });
      if (rebuildBtn) rebuildBtn.classList.add("hidden");
      fetch("/api/containers")
        .then(function (r) { return r.json(); })
        .then(function (containers) {
          renderContainerList(containers);
          const prevPath = selectedContainer ? selectedContainer.project_path : null;
          const match = containers.find(function (c) {
            return c.project_path === prevPath;
          });
          if (match) selectContainer(match);
        })
        .catch(function () {});
    }
  );
});

/** Generic SSE stream: sends args + optional project_dir to /api/command/stream
 * and appends output to outputEl. Calls onDone(ok) when stream ends. */
function streamToTerminal(args, projectDir, outputEl, onDone) {
  outputEl.textContent = "";
  outputEl.classList.remove("hidden");

  const qs = "args=" + encodeURIComponent(args) +
    (projectDir ? "&project_dir=" + encodeURIComponent(projectDir) : "");
  const es = new EventSource("/api/command/stream?" + qs);
  let ok = true;

  es.onmessage = function (evt) {
    const msg = JSON.parse(evt.data);
    if (msg.done)  { if (msg.rc !== undefined && msg.rc !== 0) ok = false; es.close(); if (onDone) onDone(ok); return; }
    if (msg.error) {
      outputEl.textContent += "[error] " + msg.error + "\n";
      ok = false;
      es.close();
      if (onDone) onDone(ok);
      return;
    }
    if (msg.line !== undefined) { outputEl.textContent += msg.line + "\n"; }
    outputEl.scrollTop = outputEl.scrollHeight;
  };

  es.onerror = function () {
    outputEl.textContent += "[connection closed]\n";
    ok = false;
    es.close();
    if (onDone) onDone(ok);
  };
}

function streamGitClone(url, destDir, username, token, outputEl, onDone) {
  outputEl.textContent = "";
  outputEl.classList.remove("hidden");
  let qs = "url=" + encodeURIComponent(url) + "&dest_dir=" + encodeURIComponent(destDir);
  if (username) qs += "&username=" + encodeURIComponent(username);
  if (token)    qs += "&token=" + encodeURIComponent(token);
  const es = new EventSource("/api/git-clone/stream?" + qs);
  let ok = true;
  es.onmessage = function (evt) {
    const msg = JSON.parse(evt.data);
    if (msg.done)  { if (msg.rc !== undefined && msg.rc !== 0) ok = false; es.close(); if (onDone) onDone(ok); return; }
    if (msg.error) {
      outputEl.textContent += "[error] " + msg.error + "\n";
      ok = false;
      es.close();
      if (onDone) onDone(ok);
      return;
    }
    if (msg.line !== undefined) { outputEl.textContent += msg.line + "\n"; }
    outputEl.scrollTop = outputEl.scrollHeight;
  };
  es.onerror = function () {
    outputEl.textContent += "[connection closed]\n";
    ok = false;
    es.close();
    if (onDone) onDone(ok);
  };
}

// --- Global Module Library panel ---

document.getElementById("modules-nav-btn").addEventListener("click", function () {
  document.querySelectorAll(".container-item").forEach(function (el) {
    el.classList.remove("active");
  });
  document.getElementById("modules-nav-btn").classList.add("active");
  globalModuleEditorPanel.classList.add("hidden");
  setMsg(globalModuleEditorMsg, "", false);
  loadGlobalModules();
  showPanel("modules");
});

// --- Sidebar refresh button ---

document.getElementById("refresh-list-btn").addEventListener("click", function () {
  loadContainers();
});

/** Fetch /api/modules (no project_dir) and render global module cards. */
async function loadGlobalModules() {
  globalModuleList.innerHTML = '<div class="loading">Loading modules…</div>';
  try {
    const resp = await fetch("/api/modules");
    const modules = await resp.json();
    if (resp.ok && Array.isArray(modules)) {
      renderGlobalModules(modules);
    } else {
      globalModuleList.innerHTML = '<div class="loading">Failed to load modules.</div>';
    }
  } catch (e) {
    globalModuleList.innerHTML = '<div class="loading">Failed: ' + escHtml(e.message) + '</div>';
  }
}

function renderGlobalModules(modules) {
  if (!modules.length) {
    globalModuleList.innerHTML = '<div class="loading">No modules found. Use <strong>+ Create Module</strong> to add one.</div>';
    return;
  }
  globalModuleList.innerHTML = "";
  modules.forEach(function (mod) {
    const isBuiltin = mod.scope === "builtin";
    const card = document.createElement("div");
    card.className = "module-card";

    let actionsHtml = "";
    if (!isBuiltin) {
      actionsHtml += '<button class="module-edit-btn">Edit</button>';
      actionsHtml += '<button class="module-delete-btn">Delete</button>';
    }

    card.innerHTML =
      '<div class="module-card-header">' +
        '<span class="module-name">' + escHtml(mod.name) + '</span>' +
        '<span class="scope-badge ' + escHtml(mod.scope) + '">' + escHtml(mod.scope) + '</span>' +
      '</div>' +
      '<div class="module-description">' + escHtml(mod.description || "No description.") + '</div>' +
      '<div class="module-actions">' + actionsHtml + '</div>';

    const editBtn = card.querySelector(".module-edit-btn");
    if (editBtn) {
      editBtn.addEventListener("click", function () { openGlobalModuleEditor(mod); });
    }

    const deleteBtn = card.querySelector(".module-delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", function () {
        if (deleteBtn.dataset.confirming) {
          const qs = "?name=" + encodeURIComponent(mod.name) + "&scope=" + encodeURIComponent(mod.scope);
          fetch("/api/modules" + qs, { method: "DELETE" }).then(function () {
            loadGlobalModules();
          });
        } else {
          deleteBtn.dataset.confirming = "1";
          deleteBtn.textContent = "Confirm delete?";
          const cancelBtn = document.createElement("button");
          cancelBtn.className = "module-confirm-no";
          cancelBtn.textContent = "Cancel";
          cancelBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            delete deleteBtn.dataset.confirming;
            deleteBtn.textContent = "Delete";
            cancelBtn.remove();
          });
          deleteBtn.insertAdjacentElement("afterend", cancelBtn);
        }
      });
    }

    globalModuleList.appendChild(card);
  });
}

/** Open inline editor for global (user-scope) module create/edit. */
function openGlobalModuleEditor(mod) {
  globalModuleEditorTitle.textContent = mod ? "Edit: " + mod.name : "New Module";
  globalModuleEditorName.value = mod ? mod.name : "";
  globalModuleEditorName.disabled = !!mod;

  const data = mod ? (mod.data || { description: mod.description || "" }) : { description: "" };
  _gmodDataToForm(data);
  globalModuleEditorBody.value = JSON.stringify(data, null, 2);

  // Always open in form mode
  _gmodEditorIsRaw = false;
  document.getElementById("global-module-form-fields").classList.remove("hidden");
  document.getElementById("global-module-raw-fields").classList.add("hidden");

  globalModuleEditorPanel.classList.remove("hidden");
  document.getElementById("global-module-field-description").focus();
  setMsg(globalModuleEditorMsg, "", false);
}

document.getElementById("global-create-module-btn").addEventListener("click", function () {
  openGlobalModuleEditor(null);
});

document.getElementById("global-module-editor-save-btn").addEventListener("click", async function () {
  const name  = globalModuleEditorName.value.trim();
  const scope = "user"; // global panel always creates user-scope

  if (!name) { setMsg(globalModuleEditorMsg, "Module name is required.", true); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    setMsg(globalModuleEditorMsg, "Name must contain only letters, digits, hyphens, underscores.", true); return;
  }

  let data;
  if (_gmodEditorIsRaw) {
    try { data = JSON.parse(globalModuleEditorBody.value); } catch (e) {
      setMsg(globalModuleEditorMsg, "Invalid JSON: " + e.message, true); return;
    }
  } else {
    data = _gmodFormToData();
  }

  const resp = await fetch("/api/modules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data, scope }),
  });
  const result = await resp.json();
  if (result.error) { setMsg(globalModuleEditorMsg, result.error, true); return; }
  setMsg(globalModuleEditorMsg, "Saved.", false);
  globalModuleEditorPanel.classList.add("hidden");
  loadGlobalModules();
});

document.getElementById("global-module-editor-cancel-btn").addEventListener("click", function () {
  globalModuleEditorPanel.classList.add("hidden");
  setMsg(globalModuleEditorMsg, "", false);
});

document.getElementById("global-module-raw-toggle-btn").addEventListener("click", function () {
  const data = _gmodFormToData();
  globalModuleEditorBody.value = JSON.stringify(data, null, 2);
  _gmodEditorIsRaw = true;
  document.getElementById("global-module-form-fields").classList.add("hidden");
  document.getElementById("global-module-raw-fields").classList.remove("hidden");
});

document.getElementById("global-module-form-toggle-btn").addEventListener("click", function () {
  let data;
  try { data = JSON.parse(globalModuleEditorBody.value); } catch (e) {
    setMsg(globalModuleEditorMsg, "Cannot switch to form mode — invalid JSON: " + e.message, true); return;
  }
  _gmodDataToForm(data);
  _gmodEditorIsRaw = false;
  document.getElementById("global-module-form-fields").classList.remove("hidden");
  document.getElementById("global-module-raw-fields").classList.add("hidden");
  setMsg(globalModuleEditorMsg, "", false);
});

// --- New container ---

document.getElementById("new-container-btn").addEventListener("click", function () {
  document.querySelectorAll(".container-item").forEach(function (el) {
    el.classList.remove("active");
  });
  document.getElementById("new-project-dir").value = "";
  document.querySelectorAll("#new-language-group .lang-toggle-btn").forEach(function (b) {
    b.classList.remove("active");
  });
  document.getElementById("init-output").textContent = "";
  document.getElementById("init-output").classList.add("hidden");
  setMsg(document.getElementById("new-container-msg"), "", false);
  document.getElementById("init-btn").disabled = false;
  _newConfigForm.setValue({});
  document.getElementById("new-module-checklist").innerHTML = '<div class="loading">Loading modules…</div>';
  document.getElementById("new-clone-url").value = "";
  document.getElementById("new-clone-parent").value = "";
  document.getElementById("new-clone-name").value = "";
  document.getElementById("new-clone-preview").textContent = "";
  document.getElementById("new-clone-username").value = "";
  document.getElementById("new-clone-token").value = "";
  _newContainerMode = "existing";
  document.querySelectorAll(".new-mode-btn").forEach(function (b) {
    b.classList.toggle("active", b.dataset.mode === "existing");
  });
  document.getElementById("new-existing-section").classList.remove("hidden");
  document.getElementById("new-clone-section").classList.add("hidden");
  document.getElementById("new-panel-hint").innerHTML = 'ClaudeBox will run <code>claudebox init</code> in the specified directory. Make sure the directory exists on your host machine.';
  document.getElementById("init-btn").textContent = "Initialize Container";
  _newShowForm();
  showPanel("new");
});

document.getElementById("cancel-new-btn").addEventListener("click", function () {
  showPanel("welcome");
});

// --- New container progress/result state helpers ---

function _newShowForm() {
  document.getElementById("new-container-form").classList.remove("hidden");
  document.getElementById("new-panel-hint").classList.remove("hidden");
  document.getElementById("init-output").classList.add("hidden");
  document.getElementById("init-result-actions").classList.add("hidden");
  document.getElementById("init-back-btn").classList.add("hidden");
  document.getElementById("init-open-btn").classList.add("hidden");
  document.getElementById("init-btn").disabled = false;
}

function _newShowProgress() {
  document.getElementById("new-container-form").classList.add("hidden");
  document.getElementById("new-panel-hint").classList.add("hidden");
  document.getElementById("init-output").classList.remove("hidden");
  document.getElementById("init-result-actions").classList.add("hidden");
}

function _newShowResult(ok) {
  document.getElementById("init-result-actions").classList.remove("hidden");
  if (ok) {
    document.getElementById("init-open-btn").classList.remove("hidden");
  } else {
    document.getElementById("init-back-btn").classList.remove("hidden");
  }
}

document.getElementById("init-back-btn").addEventListener("click", _newShowForm);

document.getElementById("init-open-btn").addEventListener("click", function () {
  if (!_pendingContainerPath) return;
  fetch("/api/containers")
    .then(function (r) { return r.json(); })
    .then(function (containers) {
      renderContainerList(containers);
      const match = containers.find(function (c) { return c.project_path === _pendingContainerPath; });
      if (match) { selectContainer(match); } else { showPanel("welcome"); }
    })
    .catch(function () { showPanel("welcome"); });
});

// Lazy-load module checklist when accordion is opened
document.getElementById("new-modules-accordion").addEventListener("toggle", function () {
  if (!this.open) return;
  const checklist = document.getElementById("new-module-checklist");
  if (checklist.querySelector(".module-check-item")) return; // already loaded
  checklist.innerHTML = '<div class="loading">Loading modules…</div>';
  fetch("/api/modules").then(function (r) { return r.json(); }).then(function (modules) {
    if (!Array.isArray(modules) || modules.length === 0) {
      checklist.innerHTML = '<div class="loading">No modules available.</div>';
      return;
    }
    checklist.innerHTML = "";
    modules.forEach(function (mod) {
      const item = document.createElement("label");
      item.className = "module-check-item";
      item.innerHTML =
        '<input type="checkbox" value="' + escHtml(mod.name) + '" />' +
        '<span class="module-check-name">' + escHtml(mod.name) +
          ' <span class="scope-badge ' + escHtml(mod.scope) + '">' + escHtml(mod.scope) + '</span>' +
        '</span>' +
        '<span class="module-check-desc">' + escHtml(mod.description || "") + '</span>';
      checklist.appendChild(item);
    });
  }).catch(function () {
    checklist.innerHTML = '<div class="loading">Failed to load modules.</div>';
  });
});

document.getElementById("new-container-form").addEventListener("submit", async function (evt) {
  evt.preventDefault();

  const msgEl      = document.getElementById("new-container-msg");
  const initOutput = document.getElementById("init-output");
  const initBtn    = document.getElementById("init-btn");

  // Collect config (language, modules, advanced) — shared between modes
  const _newLangs = [];
  document.querySelectorAll("#new-language-group .lang-toggle-btn.active").forEach(function (b) {
    _newLangs.push(b.dataset.lang);
  });
  const language = _newLangs.length === 1 ? _newLangs[0] : (_newLangs.length > 1 ? _newLangs : "");
  const checkedModules = [];
  document.querySelectorAll("#new-module-checklist .module-check-item input:checked").forEach(function (cb) {
    checkedModules.push(cb.value);
  });
  const preConfig = _newConfigForm.getValue();
  if (language) preConfig.language = language;
  if (checkedModules.length) preConfig.modules = checkedModules;

  if (_newContainerMode === "clone") {
    const cloneUrl    = document.getElementById("new-clone-url").value.trim();
    const cloneParent = document.getElementById("new-clone-parent").value.trim();
    const cloneName   = document.getElementById("new-clone-name").value.trim();
    if (!cloneUrl)    { setMsg(msgEl, "Git repository URL is required.", true); return; }
    if (!cloneParent) { setMsg(msgEl, "Parent directory is required.", true); return; }
    if (!cloneName)   { setMsg(msgEl, "Folder name is required.", true); return; }
    const destDir = cloneParent.replace(/\/$/, "") + "/" + cloneName;
    const cloneUsername = document.getElementById("new-clone-username").value.trim();
    const cloneToken    = document.getElementById("new-clone-token").value;
    _pendingContainerPath = destDir;
    setMsg(msgEl, "", false);
    _newShowProgress();
    streamGitClone(cloneUrl, destDir, cloneUsername || null, cloneToken || null, initOutput, async function (ok) {
      if (!ok) { _newShowResult(false); return; }
      if (Object.keys(preConfig).length > 0) {
        try {
          const cfgResp = await fetch("/api/config/local", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project_dir: destDir, config: preConfig }),
          });
          const cfgResult = await cfgResp.json();
          if (cfgResult.error) { _newShowResult(false); return; }
        } catch (e) { _newShowResult(false); return; }
      }
      streamToTerminal("init --no-start", destDir, initOutput, function (initOk) {
        _newShowResult(initOk);
        if (initOk) { fetch("/api/containers").then(function (r) { return r.json(); }).then(renderContainerList).catch(function () {}); }
      });
    });
    return;
  }

  // --- Existing folder mode ---
  const projectDir = document.getElementById("new-project-dir").value.trim();

  if (!projectDir) {
    setMsg(msgEl, "Project directory is required.", true);
    return;
  }

  _pendingContainerPath = projectDir;
  _newShowProgress();
  setMsg(msgEl, "", false);

  if (Object.keys(preConfig).length > 0) {
    try {
      const cfgResp = await fetch("/api/config/local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_dir: projectDir, config: preConfig }),
      });
      const cfgResult = await cfgResp.json();
      if (cfgResult.error) { _newShowResult(false); return; }
    } catch (e) { _newShowResult(false); return; }
  }

  streamToTerminal("init --no-start", projectDir, initOutput, function (ok) {
    _newShowResult(ok);
    if (ok) { fetch("/api/containers").then(function (r) { return r.json(); }).then(renderContainerList).catch(function () {}); }
  });
});

// --- Link project path ---

document.getElementById("link-project-dir").addEventListener("keydown", function (e) {
  if (e.key === "Enter") { e.preventDefault(); document.getElementById("link-project-btn").click(); }
});

document.getElementById("link-project-btn").addEventListener("click", async function () {
  if (!selectedContainer) return;
  const dir = linkProjectDir.value.trim();
  if (!dir) { setMsg(linkProjectMsg, "Enter a directory path.", true); return; }

  const resp = await fetch("/api/containers/" + encodeURIComponent(selectedContainer.name) + "/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_dir: dir }),
  });
  const result = await resp.json();
  if (result.error) { setMsg(linkProjectMsg, result.error, true); return; }

  // Update local state and reload all tab data
  selectedContainer = Object.assign({}, selectedContainer, { project_path: dir });
  detailProject.textContent = dir;
  linkProjectForm.classList.add("hidden");
  mergedView.textContent = "Loading…";
  globalView.textContent = "Loading…";
  localView.textContent  = "Loading…";
  loadConfigForContainer(selectedContainer).catch(function (e) {
    mergedView.textContent = "Failed to load config: " + e.message;
  });
  loadModules(dir);
});

// --- Module form helpers ---

/** Serialize per-container module form fields into a data object. */
function _modFormToData() {
  const data = {};
  const desc = document.getElementById("module-field-description").value.trim();
  if (desc) data.description = desc;
  const domains  = _modWidgets.domains.getValue();
  const suffixes = _modWidgets.suffixes.getValue();
  const packages = _modWidgets.packages.getValue();
  const env      = _modWidgets.env.getValue();
  const cmdsRaw  = document.getElementById("module-field-commands").value.trim();
  const cmds     = cmdsRaw ? cmdsRaw.split("\n").map(function (l) { return l.trimEnd(); }).filter(Boolean) : [];
  if (domains.length)          data.extra_domains       = domains;
  if (suffixes.length)         data.extra_suffixes      = suffixes;
  if (packages.length)         data.extra_apt_packages  = packages;
  if (cmds.length)             data.extra_commands      = cmds;
  const envKeys = Object.keys(env);
  if (envKeys.length)          data.extra_env           = envKeys.map(function (k) { return k + "=" + env[k]; });
  return data;
}

/** Populate per-container module form fields from a data object. */
function _modDataToForm(data) {
  document.getElementById("module-field-description").value = data.description || "";
  _modWidgets.domains.setValue(data.extra_domains || []);
  _modWidgets.suffixes.setValue(data.extra_suffixes || []);
  _modWidgets.packages.setValue(data.extra_apt_packages || []);
  document.getElementById("module-field-commands").value =
    Array.isArray(data.extra_commands) ? data.extra_commands.join("\n") : "";
  const envObj = {};
  if (Array.isArray(data.extra_env)) {
    data.extra_env.forEach(function (e) {
      const idx = e.indexOf("=");
      if (idx >= 0) envObj[e.substring(0, idx)] = e.substring(idx + 1);
    });
  }
  _modWidgets.env.setValue(envObj);
}

/** Serialize global module form fields into a data object. */
function _gmodFormToData() {
  const data = {};
  const desc = document.getElementById("global-module-field-description").value.trim();
  if (desc) data.description = desc;
  const domains  = _gmodWidgets.domains.getValue();
  const suffixes = _gmodWidgets.suffixes.getValue();
  const packages = _gmodWidgets.packages.getValue();
  const env      = _gmodWidgets.env.getValue();
  const cmdsRaw  = document.getElementById("global-module-field-commands").value.trim();
  const cmds     = cmdsRaw ? cmdsRaw.split("\n").map(function (l) { return l.trimEnd(); }).filter(Boolean) : [];
  if (domains.length)          data.extra_domains       = domains;
  if (suffixes.length)         data.extra_suffixes      = suffixes;
  if (packages.length)         data.extra_apt_packages  = packages;
  if (cmds.length)             data.extra_commands      = cmds;
  const envKeys = Object.keys(env);
  if (envKeys.length)          data.extra_env           = envKeys.map(function (k) { return k + "=" + env[k]; });
  return data;
}

/** Populate global module form fields from a data object. */
function _gmodDataToForm(data) {
  document.getElementById("global-module-field-description").value = data.description || "";
  _gmodWidgets.domains.setValue(data.extra_domains || []);
  _gmodWidgets.suffixes.setValue(data.extra_suffixes || []);
  _gmodWidgets.packages.setValue(data.extra_apt_packages || []);
  document.getElementById("global-module-field-commands").value =
    Array.isArray(data.extra_commands) ? data.extra_commands.join("\n") : "";
  const envObj = {};
  if (Array.isArray(data.extra_env)) {
    data.extra_env.forEach(function (e) {
      const idx = e.indexOf("=");
      if (idx >= 0) envObj[e.substring(0, idx)] = e.substring(idx + 1);
    });
  }
  _gmodWidgets.env.setValue(envObj);
}

// --- Widget factories ---

/** ChipInput: renders removable chips + text input inside containerEl.
 * options: { placeholder, validate(val)->bool|string, splitPaste->bool }
 * Returns { getValue()→string[], setValue(arr), focus() }
 */
function initChipInput(containerEl, options) {
  if (!containerEl) return { getValue: () => [], setValue: () => {}, focus: () => {} };
  const opts = Object.assign({ placeholder: "", validate: null, splitPaste: true }, options || {});
  let items = [];

  containerEl.innerHTML = "";
  containerEl.setAttribute("tabindex", "0");

  const draft = document.createElement("input");
  draft.type = "text";
  draft.className = "chip-draft";
  draft.placeholder = opts.placeholder;
  containerEl.appendChild(draft);

  function render() {
    // Remove all chip spans
    containerEl.querySelectorAll(".chip").forEach(function (el) { el.remove(); });
    items.forEach(function (val, idx) {
      const chip = document.createElement("span");
      chip.className = "chip";
      const isValid = opts.validate ? opts.validate(val) === true : true;
      if (!isValid) chip.classList.add("invalid");
      chip.title = isValid ? val : (typeof opts.validate(val) === "string" ? opts.validate(val) : "Invalid value");
      chip.innerHTML = '<span class="chip-label">' + escHtml(val) + '</span><button class="chip-remove" title="Remove" tabindex="-1">✕</button>';
      chip.querySelector(".chip-remove").addEventListener("click", function (e) {
        e.stopPropagation();
        items.splice(idx, 1);
        render();
      });
      containerEl.insertBefore(chip, draft);
    });
  }

  function addValue(raw) {
    const val = raw.trim();
    if (!val || items.indexOf(val) >= 0) return;
    items.push(val);
    draft.value = "";
    render();
  }

  draft.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === "," || e.key === "Tab") && draft.value.trim()) {
      e.preventDefault();
      addValue(draft.value.replace(/,$/, ""));
    } else if (e.key === "Backspace" && !draft.value && items.length > 0) {
      items.pop();
      render();
    }
  });

  draft.addEventListener("paste", function (e) {
    if (!opts.splitPaste) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text");
    const parts = text.split(/[,\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length > 1) {
      parts.forEach(addValue);
    } else {
      draft.value += text;
    }
  });

  containerEl.addEventListener("click", function () { draft.focus(); });

  render();

  // Add hint text below chip container
  const hint = document.createElement("div");
  hint.className = "chip-hint";
  hint.textContent = "Enter, comma, or Tab to add · Backspace to remove";
  containerEl.insertAdjacentElement("afterend", hint);

  return {
    getValue: function () { return items.slice(); },
    setValue: function (arr) {
      items = Array.isArray(arr) ? arr.slice() : [];
      draft.value = "";
      render();
    },
    focus: function () { draft.focus(); },
  };
}

/** KVInput: renders key=value rows inside containerEl.
 * options: { keyPlaceholder, valuePlaceholder, validateKey(k)->bool }
 * Returns { getValue()→{}, setValue(obj) }
 */
function initKVInput(containerEl, options) {
  if (!containerEl) return { getValue: () => ({}), setValue: () => {} };
  const opts = Object.assign({ keyPlaceholder: "key", valuePlaceholder: "value", validateKey: null }, options || {});
  let pairs = []; // [{key, value}]

  function renderRows() {
    containerEl.innerHTML = "";
    pairs.forEach(function (pair, idx) {
      const row = document.createElement("div");
      row.className = "kv-row";

      const keyInput = document.createElement("input");
      keyInput.type = "text";
      keyInput.className = "kv-key";
      keyInput.value = pair.key;
      keyInput.placeholder = opts.keyPlaceholder;
      keyInput.addEventListener("input", function () { pairs[idx].key = keyInput.value; });
      keyInput.addEventListener("blur", function () {
        if (opts.validateKey) {
          keyInput.classList.toggle("invalid", !opts.validateKey(keyInput.value));
        }
      });

      const sep = document.createElement("span");
      sep.className = "kv-sep";
      sep.textContent = "=";

      const valInput = document.createElement("input");
      valInput.type = "text";
      valInput.className = "kv-value";
      valInput.value = pair.value;
      valInput.placeholder = opts.valuePlaceholder;
      valInput.addEventListener("input", function () { pairs[idx].value = valInput.value; });

      const removeBtn = document.createElement("button");
      removeBtn.className = "kv-remove";
      removeBtn.textContent = "✕";
      removeBtn.title = "Remove";
      removeBtn.addEventListener("click", function () {
        pairs.splice(idx, 1);
        renderRows();
      });

      row.appendChild(keyInput);
      row.appendChild(sep);
      row.appendChild(valInput);
      row.appendChild(removeBtn);
      containerEl.appendChild(row);
    });

    const addBtn = document.createElement("button");
    addBtn.className = "kv-add";
    addBtn.textContent = "+ Add";
    addBtn.addEventListener("click", function () {
      pairs.push({ key: "", value: "" });
      renderRows();
      // Focus the new key input
      const rows = containerEl.querySelectorAll(".kv-row");
      if (rows.length > 0) {
        const lastRow = rows[rows.length - 1];
        const keyInput = lastRow.querySelector(".kv-key");
        if (keyInput) keyInput.focus();
      }
    });
    containerEl.appendChild(addBtn);
  }

  renderRows();

  return {
    getValue: function () {
      const obj = {};
      pairs.forEach(function (p) {
        if (p.key.trim()) obj[p.key.trim()] = p.value;
      });
      return obj;
    },
    setValue: function (obj) {
      pairs = Object.keys(obj || {}).map(function (k) { return { key: k, value: obj[k] }; });
      renderRows();
    },
  };
}

/** FolderBrowser: attaches to a text input + browse button.
 * When browse is clicked, shows an inline tree panel below the input row.
 * options: { onSelect(path) }
 */
function initFolderBrowser(inputEl, browseBtn, treeContainer, options) {
  if (!inputEl || !browseBtn || !treeContainer) return;
  const opts = options || {};
  let currentPath = null;
  let isOpen = false;

  function close() {
    isOpen = false;
    treeContainer.classList.add("hidden");
    treeContainer.innerHTML = "";
  }

  function renderBreadcrumb(path) {
    const parts = path.split("/").filter(Boolean);
    const crumbs = [];
    // Show last 3 segments
    const start = Math.max(0, parts.length - 3);
    if (start > 0) {
      crumbs.push({ label: "…", path: "/" + parts.slice(0, start).join("/") });
    }
    for (let i = start; i <= parts.length; i++) {
      const p = i === 0 ? "/" : "/" + parts.slice(0, i).join("/");
      crumbs.push({ label: i === 0 ? "/" : parts[i - 1], path: p, current: i === parts.length });
    }
    return crumbs;
  }

  async function navigate(path) {
    treeContainer.innerHTML = '<div class="folder-tree-empty">Loading…</div>';
    try {
      const resp = await fetch("/api/browse?path=" + encodeURIComponent(path || ""));
      const data = await resp.json();
      if (data.error) {
        treeContainer.innerHTML = '<div class="folder-tree-error">' + escHtml(data.error) + '</div>';
        return;
      }
      currentPath = data.current_path;

      treeContainer.innerHTML = "";

      // Breadcrumb
      const bc = document.createElement("div");
      bc.className = "folder-tree-breadcrumb";
      const breadcrumbPath = data.display_path || data.current_path;
      renderBreadcrumb(breadcrumbPath).forEach(function (crumb) {
        const btn = document.createElement("button");
        btn.className = "folder-tree-crumb" + (crumb.current ? " current" : "");
        btn.textContent = crumb.label;
        if (!crumb.current) {
          btn.addEventListener("click", function (e) { e.stopPropagation(); navigate(crumb.path); });
        }
        bc.appendChild(btn);
        if (!crumb.current) {
          const sep = document.createElement("span");
          sep.className = "folder-tree-breadcrumb-sep";
          sep.textContent = "/";
          bc.appendChild(sep);
        }
      });
      treeContainer.appendChild(bc);

      // Select current button
      const selBtn = document.createElement("button");
      selBtn.className = "folder-tree-select-btn";
      selBtn.textContent = "Select this folder";
      selBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (opts.onSelect) opts.onSelect(currentPath);
        close();
      });
      treeContainer.appendChild(selBtn);

      // Directory list
      const list = document.createElement("div");
      list.className = "folder-tree-list";
      if (data.dirs.length === 0) {
        list.innerHTML = '<div class="folder-tree-empty">No subdirectories</div>';
      } else {
        data.dirs.forEach(function (dir) {
          const btn = document.createElement("button");
          btn.className = "folder-tree-node";
          btn.textContent = dir.name;
          btn.addEventListener("click", function (e) {
            e.stopPropagation();
            navigate(dir.path);
          });
          list.appendChild(btn);
        });
      }
      treeContainer.appendChild(list);

      if (opts.allowMkdir) {
        const mkdirRow = document.createElement("div");
        mkdirRow.className = "folder-tree-mkdir";
        const mkdirInput = document.createElement("input");
        mkdirInput.type = "text";
        mkdirInput.placeholder = "New folder name\u2026";
        const mkdirBtn = document.createElement("button");
        mkdirBtn.type = "button";
        mkdirBtn.className = "folder-tree-mkdir-btn";
        mkdirBtn.textContent = "+ New folder";
        const mkdirErr = document.createElement("div");
        mkdirErr.className = "folder-tree-mkdir-error hidden";
        mkdirBtn.addEventListener("click", async function (e) {
          e.stopPropagation();
          const name = mkdirInput.value.trim();
          if (!name) return;
          const newPath = currentPath.replace(/\/$/, "") + "/" + name;
          const resp = await fetch("/api/mkdir", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: newPath }),
          });
          const result = await resp.json();
          if (result.error) {
            mkdirErr.textContent = result.error;
            mkdirErr.classList.remove("hidden");
          } else {
            navigate(newPath);
          }
        });
        mkdirInput.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); mkdirBtn.click(); }
        });
        mkdirRow.appendChild(mkdirInput);
        mkdirRow.appendChild(mkdirBtn);
        treeContainer.appendChild(mkdirRow);
        treeContainer.appendChild(mkdirErr);
      }
    } catch (e) {
      treeContainer.innerHTML = '<div class="folder-tree-error">Failed to load: ' + escHtml(e.message) + '</div>';
    }
  }

  browseBtn.addEventListener("click", function () {
    if (isOpen) { close(); return; }
    isOpen = true;
    treeContainer.classList.remove("hidden");
    navigate(inputEl.value.trim() || null);
  });

  // Close on outside click
  document.addEventListener("click", function (e) {
    if (isOpen && !treeContainer.contains(e.target) && e.target !== browseBtn && e.target !== inputEl) {
      close();
    }
  });
}

/**
 * ProfilesEditor: renders a list of named env-var profiles inside containerEl.
 * Each profile is an expandable card with a name field and KV rows.
 * Returns { getValue()→{profiles:{}, default:""}, setValue({profiles:{}, default:""}) }
 */
function initProfilesEditor(containerEl) {
  if (!containerEl) return { getValue: () => ({ profiles: {}, default: "" }), setValue: () => {} };

  let profiles = []; // [{name, vars:[{key,value}], isDefault}]

  function render() {
    containerEl.innerHTML = "";

    if (profiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "profiles-empty";
      empty.textContent = "No profiles yet. Add one below.";
      containerEl.appendChild(empty);
    }

    profiles.forEach(function (prof, profIdx) {
      const card = document.createElement("div");
      card.className = "profile-card" + (prof.isDefault ? " is-default" : "");

      // --- Header ---
      const header = document.createElement("div");
      header.className = "profile-card-header";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "profile-name-input";
      nameInput.value = prof.name;
      nameInput.placeholder = "profile-name";
      nameInput.addEventListener("input", function () { profiles[profIdx].name = nameInput.value.trim(); });

      const defBtn = document.createElement("button");
      defBtn.className = "profile-default-btn" + (prof.isDefault ? " active" : "");
      defBtn.textContent = prof.isDefault ? "✓ Default" : "Set Default";
      defBtn.title = "Set as default profile";
      defBtn.addEventListener("click", function () {
        profiles.forEach(function (p) { p.isDefault = false; });
        profiles[profIdx].isDefault = true;
        render();
      });

      const delBtn = document.createElement("button");
      delBtn.className = "profile-delete-btn";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", function () {
        if (delBtn.dataset.confirm) {
          profiles.splice(profIdx, 1);
          render();
        } else {
          delBtn.dataset.confirm = "1";
          delBtn.textContent = "Confirm?";
          setTimeout(function () {
            if (delBtn.dataset.confirm) {
              delete delBtn.dataset.confirm;
              delBtn.textContent = "Delete";
            }
          }, 3000);
        }
      });

      header.appendChild(nameInput);
      header.appendChild(defBtn);
      header.appendChild(delBtn);
      card.appendChild(header);

      // --- KV body ---
      const body = document.createElement("div");
      body.className = "profile-card-body";

      function renderVars() {
        body.innerHTML = "";
        prof.vars.forEach(function (pair, varIdx) {
          const row = document.createElement("div");
          row.className = "kv-row";

          const keyInput = document.createElement("input");
          keyInput.type = "text";
          keyInput.className = "kv-key";
          keyInput.value = pair.key;
          keyInput.placeholder = "KEY";
          keyInput.addEventListener("input", function () { prof.vars[varIdx].key = keyInput.value; });

          const sep = document.createElement("span");
          sep.className = "kv-sep";
          sep.textContent = "=";

          const valInput = document.createElement("input");
          valInput.type = "text";
          valInput.className = "kv-value";
          valInput.value = pair.value;
          valInput.placeholder = "value";
          valInput.addEventListener("input", function () { prof.vars[varIdx].value = valInput.value; });

          const removeBtn = document.createElement("button");
          removeBtn.className = "kv-remove";
          removeBtn.textContent = "✕";
          removeBtn.addEventListener("click", function () {
            prof.vars.splice(varIdx, 1);
            renderVars();
          });

          row.appendChild(keyInput);
          row.appendChild(sep);
          row.appendChild(valInput);
          row.appendChild(removeBtn);
          body.appendChild(row);
        });

        const addBtn = document.createElement("button");
        addBtn.className = "kv-add";
        addBtn.textContent = "+ Add Variable";
        addBtn.addEventListener("click", function () {
          prof.vars.push({ key: "", value: "" });
          renderVars();
          const rows = body.querySelectorAll(".kv-row");
          if (rows.length) rows[rows.length - 1].querySelector(".kv-key").focus();
        });
        body.appendChild(addBtn);
      }

      renderVars();
      card.appendChild(body);
      containerEl.appendChild(card);
    });

    // --- Add profile button ---
    const addBtn = document.createElement("button");
    addBtn.className = "profiles-add-btn";
    addBtn.textContent = "+ Add Profile";
    addBtn.addEventListener("click", function () {
      profiles.push({ name: "", vars: [{ key: "", value: "" }], isDefault: profiles.length === 0 });
      render();
      // focus the new name input
      const cards = containerEl.querySelectorAll(".profile-card");
      if (cards.length) {
        const inp = cards[cards.length - 1].querySelector(".profile-name-input");
        if (inp) inp.focus();
      }
    });
    containerEl.appendChild(addBtn);
  }

  render();

  return {
    getValue: function () {
      const profilesObj = {};
      let defaultName = "";
      profiles.forEach(function (prof) {
        const name = prof.name.trim();
        if (!name) return;
        const vars = {};
        prof.vars.forEach(function (p) {
          if (p.key.trim()) vars[p.key.trim()] = p.value;
        });
        profilesObj[name] = vars;
        if (prof.isDefault) defaultName = name;
      });
      return { profiles: profilesObj, default: defaultName };
    },
    setValue: function (data) {
      const profilesObj = data.profiles || {};
      const defaultName = data.default || "";
      profiles = Object.keys(profilesObj).map(function (name) {
        const vars = Object.keys(profilesObj[name]).map(function (k) {
          return { key: k, value: profilesObj[name][k] };
        });
        return { name: name, vars: vars, isDefault: name === defaultName };
      });
      render();
    },
  };
}

/**
 * ConfigForm: creates a full structured editor for a ClaudeBox config object.
 * options: { showEnvProfile: bool (show env_profile field, local-only) }
 * Returns { getValue()→obj, setValue(obj), focus() }
 */
function initConfigForm(containerEl, options) {
  if (!containerEl) return { getValue: () => ({}), setValue: () => {}, focus: () => {} };
  const opts = Object.assign({ showEnvProfile: false, hideLang: false, showCloneDir: false }, options || {});

  // Helper: create a labeled form field row
  function makeRow(labelText, hintText) {
    const row = document.createElement("div");
    row.className = "form-field-row";
    const label = document.createElement("label");
    label.className = "form-field-label";
    label.textContent = labelText;
    if (hintText) {
      const hint = document.createElement("span");
      hint.className = "form-field-hint";
      hint.textContent = " " + hintText;
      label.appendChild(hint);
    }
    row.appendChild(label);
    return row;
  }

  // Helper: create a text input
  function makeTextInput(placeholder) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "form-field-input";
    inp.placeholder = placeholder;
    inp.autocomplete = "off";
    return inp;
  }

  // Helper: create a select element
  function makeSelect(options) {
    const sel = document.createElement("select");
    sel.className = "form-field-input";
    options.forEach(function (o) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    return sel;
  }

  containerEl.innerHTML = "";

  // --- Default Clone Directory (settings only) ---
  let cloneDirInput = null;
  if (opts.showCloneDir) {
    const cloneDirRow = makeRow("Default Clone Directory", "Pre-fills the parent directory in the Clone from Git form");
    const cloneDirPathRow = document.createElement("div");
    cloneDirPathRow.className = "path-input-row";
    cloneDirInput = makeTextInput("/home/you/projects");
    const cloneDirBrowseBtn = document.createElement("button");
    cloneDirBrowseBtn.type = "button";
    cloneDirBrowseBtn.className = "browse-btn";
    cloneDirBrowseBtn.textContent = "Browse…";
    cloneDirPathRow.appendChild(cloneDirInput);
    cloneDirPathRow.appendChild(cloneDirBrowseBtn);
    const cloneDirTree = document.createElement("div");
    cloneDirTree.className = "folder-tree hidden";
    cloneDirRow.appendChild(cloneDirPathRow);
    cloneDirRow.appendChild(cloneDirTree);
    containerEl.appendChild(cloneDirRow);
    initFolderBrowser(cloneDirInput, cloneDirBrowseBtn, cloneDirTree, {
      allowMkdir: true,
      onSelect: function (path) { cloneDirInput.value = path; },
    });
  }

  // --- Language (multi-select toggle buttons) ---
  const langRow = makeRow("Language", "Select one or more. Combinations like Node.js + Python are supported.");
  const _langDefs = [
    { value: "node",   label: "Node.js" },
    { value: "python", label: "Python" },
    { value: "dotnet", label: ".NET" },
    { value: "go",     label: "Go" },
    { value: "rust",   label: "Rust" },
    { value: "java",   label: "Java" },
    { value: "none",   label: "None" },
  ];
  const langToggleGroup = document.createElement("div");
  langToggleGroup.className = "lang-toggle-group";
  let _selectedLangs = [];
  _langDefs.forEach(function (def) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lang-toggle-btn";
    btn.textContent = def.label;
    btn.dataset.lang = def.value;
    btn.addEventListener("click", function () {
      const idx = _selectedLangs.indexOf(def.value);
      if (idx >= 0) {
        _selectedLangs.splice(idx, 1);
        btn.classList.remove("active");
      } else {
        // "none" is mutually exclusive with real languages
        if (def.value === "none") {
          _selectedLangs = ["none"];
          langToggleGroup.querySelectorAll(".lang-toggle-btn").forEach(function (b) {
            b.classList.toggle("active", b.dataset.lang === "none");
          });
          return;
        }
        // Selecting a real language clears "none"
        _selectedLangs = _selectedLangs.filter(function (l) { return l !== "none"; });
        langToggleGroup.querySelector('[data-lang="none"]').classList.remove("active");
        _selectedLangs.push(def.value);
        btn.classList.add("active");
      }
    });
    langToggleGroup.appendChild(btn);
  });
  langRow.appendChild(langToggleGroup);
  if (!opts.hideLang) containerEl.appendChild(langRow);

  // --- Extra Domains ---
  const domainsRow = makeRow("Extra Domains", "Hostnames allowed through the firewall");
  const domainsEl = document.createElement("div");
  domainsEl.className = "chip-input-container";
  domainsRow.appendChild(domainsEl);
  containerEl.appendChild(domainsRow);
  const domainsInput = initChipInput(domainsEl, { placeholder: "packages.microsoft.com" });

  // --- Extra Domain Suffixes ---
  const suffixesRow = makeRow("Extra Domain Suffixes", "Wildcard suffixes");
  const suffixesEl = document.createElement("div");
  suffixesEl.className = "chip-input-container";
  suffixesRow.appendChild(suffixesEl);
  containerEl.appendChild(suffixesRow);
  const suffixesInput = initChipInput(suffixesEl, { placeholder: "trafficmanager.net" });

  // --- Extra APT Packages ---
  const packagesRow = makeRow("Extra APT Packages", "Debian packages installed at init");
  const packagesEl = document.createElement("div");
  packagesEl.className = "chip-input-container";
  packagesRow.appendChild(packagesEl);
  containerEl.appendChild(packagesRow);
  const packagesInput = initChipInput(packagesEl, { placeholder: "curl" });

  // --- Extra Hosts ---
  const hostsRow = makeRow("Extra Hosts", "Added to /etc/hosts (host:ip or just hostname)");
  const hostsEl = document.createElement("div");
  hostsEl.className = "chip-input-container";
  hostsRow.appendChild(hostsEl);
  containerEl.appendChild(hostsRow);
  const hostsInput = initChipInput(hostsEl, { placeholder: "myhost:192.168.1.1" });

  // --- Extra Env ---
  const envRow = makeRow("Extra Environment Variables");
  const envEl = document.createElement("div");
  envEl.className = "kv-input";
  envRow.appendChild(envEl);
  containerEl.appendChild(envRow);
  const envInput = initKVInput(envEl, { keyPlaceholder: "KEY", valuePlaceholder: "value" });

  // --- Extra Volumes ---
  const volRow = makeRow("Extra Volumes", "Host path → Container path");
  const volEl = document.createElement("div");
  volEl.className = "kv-input";
  volRow.appendChild(volEl);
  containerEl.appendChild(volRow);
  const volInput = initKVInput(volEl, { keyPlaceholder: "/host/path", valuePlaceholder: "/container/path" });

  // --- Advanced: Extra Commands, Claude Config Path, Env Profile ---
  const adv = document.createElement("details");
  adv.className = "form-advanced";
  const advSummary = document.createElement("summary");
  advSummary.className = "form-advanced-toggle";
  advSummary.textContent = "Advanced";
  adv.appendChild(advSummary);
  const advBody = document.createElement("div");
  advBody.className = "form-advanced-body";

  // Extra Commands
  const cmdsRow = makeRow("Extra Commands");
  const cmdsWarn = document.createElement("div");
  cmdsWarn.className = "extra-commands-warning";
  cmdsWarn.textContent = "⚠ These commands run as ROOT during container initialization — verify before saving.";
  cmdsRow.appendChild(cmdsWarn);
  const cmdsTA = document.createElement("textarea");
  cmdsTA.className = "config-editor";
  cmdsTA.style.minHeight = "80px";
  cmdsTA.style.fontSize = "12px";
  cmdsTA.placeholder = "One shell command per line\napt-get update && apt-get install -y curl";
  cmdsRow.appendChild(cmdsTA);
  advBody.appendChild(cmdsRow);

  // Claude Config Path
  const ccpRow = makeRow("Claude Config Path", "Path to claude config file (leave blank to use default)");
  const ccpInput = makeTextInput("~/.config/claude/claude.json");
  ccpRow.appendChild(ccpInput);
  advBody.appendChild(ccpRow);

  const pcdRow = makeRow("Persist Claude Data", "Bind-mount .claudebox/claude-data/ to /home/node/.claude — survives destroy/rebuild (auth + conversation history)");
  const pcdCheck = document.createElement("input");
  pcdCheck.type = "checkbox";
  pcdCheck.className = "form-checkbox";
  pcdRow.appendChild(pcdCheck);
  advBody.appendChild(pcdRow);

  // Default Env Profile
  const defProfRow = makeRow("Default Env Profile", "Profile activated automatically on container start");
  const defProfInput = makeTextInput("dev");
  defProfRow.appendChild(defProfInput);
  advBody.appendChild(defProfRow);

  // Env Profile (local only — currently active)
  let envProfInput = null;
  if (opts.showEnvProfile) {
    const envProfRow = makeRow("Active Env Profile", "Currently injected profile (set via use-profile)");
    envProfInput = makeTextInput("");
    envProfRow.appendChild(envProfInput);
    advBody.appendChild(envProfRow);
  }

  adv.appendChild(advBody);
  containerEl.appendChild(adv);

  // --- Profiles editor ---
  const profSection = document.createElement("div");
  profSection.className = "form-field-row";
  const profLabel = document.createElement("label");
  profLabel.className = "form-field-label";
  profLabel.textContent = "Environment Profiles";
  profSection.appendChild(profLabel);
  const profEl = document.createElement("div");
  profEl.className = "profiles-editor";
  profSection.appendChild(profEl);
  containerEl.appendChild(profSection);
  const profEditor = initProfilesEditor(profEl);

  return {
    getValue: function () {
      const data = {};
      if (!opts.hideLang && _selectedLangs.length > 0) {
        data.language = _selectedLangs.length === 1 ? _selectedLangs[0] : _selectedLangs.slice();
      }
      const domains  = domainsInput.getValue();
      const suffixes = suffixesInput.getValue();
      const packages = packagesInput.getValue();
      const hosts    = hostsInput.getValue();
      if (domains.length)  data.extra_domains       = domains;
      if (suffixes.length) data.extra_suffixes      = suffixes;
      if (packages.length) data.extra_apt_packages  = packages;
      if (hosts.length)    data.extra_hosts         = hosts;

      // env: KV → KEY=VALUE strings
      const envObj = envInput.getValue();
      const envArr = Object.keys(envObj).map(function (k) { return k + "=" + envObj[k]; });
      if (envArr.length) data.extra_env = envArr;

      // volumes: KV → object
      const volObj = volInput.getValue();
      if (Object.keys(volObj).length) data.extra_volumes = volObj;

      const cmds = cmdsTA.value.trim()
        ? cmdsTA.value.split("\n").map(function (l) { return l.trimEnd(); }).filter(Boolean)
        : [];
      if (cmds.length) data.extra_commands = cmds;
      if (ccpInput.value.trim()) data.claude_config_path = ccpInput.value.trim();
      if (pcdCheck.checked) data.persist_claude_data = true;
      if (defProfInput.value.trim()) data.default_env_profile = defProfInput.value.trim();
      if (cloneDirInput && cloneDirInput.value.trim()) data.default_clone_dir = cloneDirInput.value.trim();
      if (envProfInput && envProfInput.value.trim()) data.env_profile = envProfInput.value.trim();

      // profiles
      const profData = profEditor.getValue();
      if (Object.keys(profData.profiles).length) data.env_profiles = profData.profiles;

      return data;
    },
    setValue: function (obj) {
      // language may be a string or array
      _selectedLangs = [];
      const rawLang = obj.language;
      if (rawLang) {
        _selectedLangs = Array.isArray(rawLang) ? rawLang.slice() : [rawLang];
      }
      langToggleGroup.querySelectorAll(".lang-toggle-btn").forEach(function (b) {
        b.classList.toggle("active", _selectedLangs.indexOf(b.dataset.lang) >= 0);
      });
      domainsInput.setValue(obj.extra_domains || []);
      suffixesInput.setValue(obj.extra_suffixes || []);
      packagesInput.setValue(obj.extra_apt_packages || []);
      hostsInput.setValue(obj.extra_hosts || []);

      // extra_env: KEY=VALUE[] → {KEY: value}
      const envObj = {};
      if (Array.isArray(obj.extra_env)) {
        obj.extra_env.forEach(function (e) {
          const idx = e.indexOf("=");
          if (idx >= 0) envObj[e.substring(0, idx)] = e.substring(idx + 1);
        });
      }
      envInput.setValue(envObj);

      // volumes: object (may already be obj)
      volInput.setValue(typeof obj.extra_volumes === "object" && obj.extra_volumes !== null
        ? obj.extra_volumes : {});

      cmdsTA.value = Array.isArray(obj.extra_commands) ? obj.extra_commands.join("\n") : "";
      ccpInput.value = obj.claude_config_path || "";
      pcdCheck.checked = obj.persist_claude_data === true;
      defProfInput.value = obj.default_env_profile || "";
      if (envProfInput) envProfInput.value = obj.env_profile || "";
      if (cloneDirInput) cloneDirInput.value = obj.default_clone_dir || "";

      profEditor.setValue({
        profiles: obj.env_profiles || {},
        default: obj.default_env_profile || "",
      });
    },
    focus: function () { langSel.focus(); },
  };
}

// --- Widget init ---

// Widget handle objects — populated here so helpers above can reference them
const _modWidgets = {
  domains:  initChipInput(document.getElementById("module-field-domains"),          { placeholder: "packages.microsoft.com" }),
  suffixes: initChipInput(document.getElementById("module-field-suffixes"),         { placeholder: "trafficmanager.net" }),
  packages: initChipInput(document.getElementById("module-field-packages"),         { placeholder: "curl" }),
  env:      initKVInput  (document.getElementById("module-field-env"),              { keyPlaceholder: "KEY", valuePlaceholder: "value" }),
};

const _gmodWidgets = {
  domains:  initChipInput(document.getElementById("global-module-field-domains"),   { placeholder: "packages.microsoft.com" }),
  suffixes: initChipInput(document.getElementById("global-module-field-suffixes"),  { placeholder: "trafficmanager.net" }),
  packages: initChipInput(document.getElementById("global-module-field-packages"),  { placeholder: "curl" }),
  env:      initKVInput  (document.getElementById("global-module-field-env"),       { keyPlaceholder: "KEY", valuePlaceholder: "value" }),
};

const _newConfigForm = initConfigForm(
  document.getElementById("new-advanced-form-mount"),
  { hideLang: true, showEnvProfile: false }
);

initFolderBrowser(
  document.getElementById("new-project-dir"),
  document.getElementById("new-browse-btn"),
  document.getElementById("new-folder-tree"),
  { onSelect: function (path) { document.getElementById("new-project-dir").value = path; } }
);

initFolderBrowser(
  document.getElementById("new-clone-parent"),
  document.getElementById("new-clone-browse-btn"),
  document.getElementById("new-clone-folder-tree"),
  {
    allowMkdir: true,
    onSelect: function (path) {
      document.getElementById("new-clone-parent").value = path;
      _updateClonePreview();
    }
  }
);

// --- New container mode toggle ---

document.querySelectorAll(".new-mode-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    _newContainerMode = btn.dataset.mode;
    document.querySelectorAll(".new-mode-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.mode === _newContainerMode);
    });
    document.getElementById("new-existing-section").classList.toggle("hidden", _newContainerMode !== "existing");
    document.getElementById("new-clone-section").classList.toggle("hidden", _newContainerMode !== "clone");
    const hint = document.getElementById("new-panel-hint");
    const initBtn = document.getElementById("init-btn");
    if (_newContainerMode === "clone") {
      hint.innerHTML = 'ClaudeBox will <code>git clone</code> the repo then run <code>claudebox init</code> in the new directory.';
      initBtn.textContent = "Clone & Initialize";
      // Pre-fill parent dir from global default_clone_dir if field is still empty
      const parentInput = document.getElementById("new-clone-parent");
      if (!parentInput.value.trim()) {
        fetch("/api/config/global").then(function (r) { return r.json(); }).then(function (cfg) {
          if (cfg.default_clone_dir && !parentInput.value.trim()) {
            parentInput.value = cfg.default_clone_dir;
            _updateClonePreview();
          }
        }).catch(function () {});
      }
    } else {
      hint.innerHTML = 'ClaudeBox will run <code>claudebox init</code> in the specified directory. Make sure the directory exists on your host machine.';
      initBtn.textContent = "Initialize Container";
    }
  });
});

function _updateClonePreview() {
  const url = document.getElementById("new-clone-url").value.trim();
  const parent = document.getElementById("new-clone-parent").value.trim();
  const nameInput = document.getElementById("new-clone-name");
  const preview = document.getElementById("new-clone-preview");
  if (url && !nameInput.value.trim()) {
    const seg = url.replace(/\.git$/, "").split("/").filter(Boolean).pop() || "";
    nameInput.value = seg;
  }
  const name = nameInput.value.trim();
  if (parent && name) {
    preview.textContent = parent.replace(/\/$/, "") + "/" + name;
  } else {
    preview.textContent = "";
  }
}

document.getElementById("new-clone-url").addEventListener("input", _updateClonePreview);
document.getElementById("new-clone-url").addEventListener("blur", _updateClonePreview);
document.getElementById("new-clone-parent").addEventListener("input", _updateClonePreview);
document.getElementById("new-clone-name").addEventListener("input", _updateClonePreview);

// Wire up new-container language toggle buttons (None is mutually exclusive)
document.querySelectorAll("#new-language-group .lang-toggle-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    const lang = btn.dataset.lang;
    const isActive = btn.classList.contains("active");
    if (lang === "none") {
      // None clears all others
      document.querySelectorAll("#new-language-group .lang-toggle-btn").forEach(function (b) {
        b.classList.remove("active");
      });
      if (!isActive) btn.classList.add("active");
    } else {
      // Real language: clear "none", toggle self
      document.querySelector("#new-language-group [data-lang='none']").classList.remove("active");
      btn.classList.toggle("active");
    }
  });
});

const _globalConfigForm = initConfigForm(
  document.getElementById("global-config-form-mount"),
  { showEnvProfile: false }
);
const _localConfigForm = initConfigForm(
  document.getElementById("local-config-form-mount"),
  { showEnvProfile: true }
);
const _settingsConfigForm = initConfigForm(
  document.getElementById("settings-config-form-mount"),
  { showEnvProfile: false, showCloneDir: true }
);

// --- Settings panel ---

let _settingsIsRaw = false;

function _settingsFormToData() {
  return _settingsConfigForm.getValue();
}

function _settingsDataToForm(data) {
  _settingsConfigForm.setValue(data);
}

async function loadSettings() {
  const msgEl = document.getElementById("settings-msg");
  setMsg(msgEl, "Loading…", false);
  try {
    const resp = await fetch("/api/config/global");
    const data = await resp.json();
    if (data.error) { setMsg(msgEl, data.error, true); return; }
    _settingsDataToForm(data);
    document.getElementById("settings-config-editor").value = JSON.stringify(data, null, 2);
    setMsg(msgEl, "", false);
  } catch (e) {
    setMsg(msgEl, "Failed to load: " + e.message, true);
  }
}

// Restore terminal app preference on page load
(function () {
  const sel = document.getElementById("settings-terminal-app");
  if (sel) {
    sel.value = localStorage.getItem("cb-terminal") || "auto";
    sel.addEventListener("change", function () {
      localStorage.setItem("cb-terminal", sel.value);
    });
  }
})();

document.getElementById("settings-nav-btn").addEventListener("click", function () {
  document.querySelectorAll(".container-item").forEach(function (el) { el.classList.remove("active"); });
  _settingsIsRaw = false;
  document.getElementById("settings-raw-fields").classList.add("hidden");
  document.querySelector(".settings-global-form").classList.remove("hidden");
  loadSettings();
  showPanel("settings");
});

document.getElementById("settings-raw-toggle-btn").addEventListener("click", function () {
  const data = _settingsFormToData();
  document.getElementById("settings-config-editor").value = JSON.stringify(data, null, 2);
  _settingsIsRaw = true;
  document.querySelector(".settings-global-form").classList.add("hidden");
  document.getElementById("settings-raw-fields").classList.remove("hidden");
});

document.getElementById("settings-form-toggle-btn").addEventListener("click", function () {
  let data;
  try { data = JSON.parse(document.getElementById("settings-config-editor").value); } catch (e) {
    setMsg(document.getElementById("settings-msg"), "Invalid JSON: " + e.message, true); return;
  }
  _settingsDataToForm(data);
  _settingsIsRaw = false;
  document.querySelector(".settings-global-form").classList.remove("hidden");
  document.getElementById("settings-raw-fields").classList.add("hidden");
  setMsg(document.getElementById("settings-msg"), "", false);
});

document.getElementById("settings-save-btn").addEventListener("click", async function () {
  const msgEl = document.getElementById("settings-msg");
  let data;
  if (_settingsIsRaw) {
    try { data = JSON.parse(document.getElementById("settings-config-editor").value); } catch (e) {
      setMsg(msgEl, "Invalid JSON: " + e.message, true); return;
    }
  } else {
    data = _settingsFormToData();
  }
  try {
    const resp = await fetch("/api/config/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const result = await resp.json();
    if (result.error) { setMsg(msgEl, result.error, true); return; }
    setMsg(msgEl, "Saved.", false);
    // refresh raw editor too
    document.getElementById("settings-config-editor").value = JSON.stringify(data, null, 2);
  } catch (e) {
    setMsg(msgEl, "Save failed: " + e.message, true);
  }
});


// --- Nickname ---

document.getElementById("nickname-edit-btn").addEventListener("click", function () {
  if (!selectedContainer) return;
  document.getElementById("nickname-input").value = selectedContainer.nickname || "";
  document.getElementById("nickname-edit-group").classList.remove("hidden");
  document.getElementById("nickname-edit-btn").classList.add("hidden");
  document.getElementById("nickname-input").focus();
});

document.getElementById("nickname-cancel-btn").addEventListener("click", function () {
  document.getElementById("nickname-edit-group").classList.add("hidden");
  document.getElementById("nickname-edit-btn").classList.remove("hidden");
});

async function saveNickname() {
  if (!selectedContainer) return;
  const nickname = document.getElementById("nickname-input").value.trim();
  const resp = await fetch(
    "/api/containers/" + encodeURIComponent(selectedContainer.name) + "/nickname",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname }),
    }
  );
  const result = await resp.json();
  if (result.error) return; // silent fail
  selectedContainer = Object.assign({}, selectedContainer, { nickname });
  detailName.textContent = nickname || selectedContainer.name;
  document.getElementById("nickname-edit-group").classList.add("hidden");
  document.getElementById("nickname-edit-btn").classList.remove("hidden");
  // refresh sidebar to reflect new nickname
  loadContainers();
}

document.getElementById("nickname-save-btn").addEventListener("click", saveNickname);
document.getElementById("nickname-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") { e.preventDefault(); saveNickname(); }
  if (e.key === "Escape") { document.getElementById("nickname-cancel-btn").click(); }
});

// --- Profiles ---

/** Load profile switcher in Overview tab — shows activate buttons for each defined profile. */
async function loadProfileSwitcher(c) {
  const switcher = document.getElementById("profile-switcher");
  const btnsEl   = document.getElementById("profile-switcher-btns");
  const activeEl = document.getElementById("profile-active-name");
  const outputEl = document.getElementById("profile-switch-output");

  switcher.classList.add("hidden");
  btnsEl.innerHTML = "";
  const _saved = _containerUiState[c.name];
  outputEl.textContent = (_saved && _saved.profileOutput) || "";
  outputEl.classList.toggle("hidden", !(_saved && _saved.profileOutput));
  const noteEl = document.getElementById("profile-env-note");
  noteEl.classList.toggle("hidden", !(_saved && _saved.profileNoteVisible));

  if (!c.project_path) return;

  try {
    const qs = "?project_dir=" + encodeURIComponent(c.project_path);
    const resp = await fetch("/api/config/merged" + qs);
    const config = await resp.json();
    if (config.error) return;

    const profiles = config.env_profiles || {};
    const names = Object.keys(profiles);
    if (names.length === 0) return;

    const activeProfile = config.env_profile || config.default_env_profile || "";
    activeEl.textContent = activeProfile || "none";
    switcher.classList.remove("hidden");

    names.forEach(function (name) {
      const btn = document.createElement("button");
      btn.className = "profile-switch-btn" + (name === activeProfile ? " active" : "");
      btn.textContent = name;
      btn.title = "Activate profile: " + name;
      btn.addEventListener("click", function () {
        if (!selectedContainer) return;
        outputEl.textContent = "";
        outputEl.classList.remove("hidden");
        activeEl.textContent = name;
        btnsEl.querySelectorAll(".profile-switch-btn").forEach(function (b) {
          b.classList.toggle("active", b.textContent === name);
        });
        streamToTerminal(
          "use-profile " + name,
          selectedContainer.project_path || null,
          outputEl,
          function (ok) {
            if (!ok) activeEl.textContent = activeProfile; // revert on failure
          }
        );
        showEnvPickupNote(document.getElementById("profile-env-note"));
      });
      btnsEl.appendChild(btn);
    });
  } catch (e) {
    // non-fatal: profile switcher stays hidden
  }
}

// --- Container file browser ---

let _filesBrowserContainer = null;
let _filesBrowserPath = "/workspace";

async function loadContainerFiles(containerName, filePath) {
  _filesBrowserContainer = containerName;
  _filesBrowserPath = filePath || "/workspace";
  const filesContent = document.getElementById("files-content");
  const breadcrumb = document.getElementById("files-breadcrumb");

  filesContent.innerHTML = '<div class="loading">Loading…</div>';

  try {
    const qs = "?path=" + encodeURIComponent(_filesBrowserPath);
    const resp = await fetch("/api/containers/" + encodeURIComponent(containerName) + "/files" + qs);
    const data = await resp.json();

    if (data.error) {
      filesContent.innerHTML = '<div class="loading">Error: ' + escHtml(data.error) + '</div>';
      return;
    }

    _filesBrowserPath = data.current_path;
    breadcrumb.textContent = data.current_path;

    const entries = data.entries || [];
    if (!entries.length) {
      filesContent.innerHTML = '<div class="loading">(empty directory)</div>';
      return;
    }

    filesContent.innerHTML = "";

    // Parent dir entry
    if (data.current_path !== "/" && data.parent_path !== data.current_path) {
      const parentRow = document.createElement("div");
      parentRow.className = "file-entry file-entry-dir";
      parentRow.innerHTML = '<span class="file-icon">📁</span><span class="file-name">..</span>';
      parentRow.addEventListener("click", function () {
        loadContainerFiles(containerName, data.parent_path);
      });
      filesContent.appendChild(parentRow);
    }

    entries.forEach(function (entry) {
      const row = document.createElement("div");
      row.className = "file-entry" + (entry.is_dir ? " file-entry-dir" : "");
      const icon = entry.is_dir ? "📁" : "📄";
      row.innerHTML = '<span class="file-icon">' + icon + '</span><span class="file-name">' + escHtml(entry.name) + '</span>';
      if (entry.is_dir) {
        row.addEventListener("click", function () {
          loadContainerFiles(containerName, entry.path);
        });
      }
      if (!entry.is_dir) {
        row.classList.add("file-entry-file");
        row.addEventListener("click", function () {
          openFileViewer(containerName, entry.path);
        });
      }
      filesContent.appendChild(row);
    });
  } catch (e) {
    filesContent.innerHTML = '<div class="loading">Failed: ' + escHtml(e.message) + '</div>';
  }
}

// Load files when files tab is activated (terminal tab does NOT auto-connect)
document.querySelectorAll('[data-tab-group="detail"].tab-btn').forEach(function (btn) {
  if (btn.dataset.tab === "files") {
    btn.addEventListener("click", function () {
      if (selectedContainer) {
        const _savedFiles = _containerUiState[selectedContainer.name];
        loadContainerFiles(selectedContainer.name, (_savedFiles && _savedFiles.filesBrowserPath) || "/workspace");
      }
    });
  }
  if (btn.dataset.tab === "refs") {
    btn.addEventListener("click", async function () {
      if (selectedContainer && statusClass(selectedContainer.status) === "running") {
        loadRefs(selectedContainer.name);
        // Pre-fill browse input with default_clone_dir if input is empty
        const refInput = document.getElementById("ref-dir-input");
        if (refInput && !refInput.value && selectedContainer.project_path) {
          try {
            const resp = await fetch("/api/config/merged?project_dir=" + encodeURIComponent(selectedContainer.project_path));
            const cfg = await resp.json();
            if (cfg.default_clone_dir) refInput.value = cfg.default_clone_dir;
          } catch (e) { /* non-fatal */ }
        }
      } else {
        refsList.innerHTML = '<div class="loading">Container must be running to view or add refs.</div>';
      }
    });
  }
  // Terminal tab: do NOT auto-connect; user must click Connect button manually
});

document.getElementById("files-home-btn").addEventListener("click", function () {
  if (_filesBrowserContainer) {
    loadContainerFiles(_filesBrowserContainer, "/workspace");
  }
});

// --- File viewer modal ---

async function openFileViewer(containerName, filePath) {
  const modal = document.getElementById("file-viewer-modal");
  const pathEl = document.getElementById("file-viewer-path");
  const sizeEl = document.getElementById("file-viewer-size");
  const content = document.getElementById("file-viewer-content");

  pathEl.textContent = filePath;
  sizeEl.textContent = "";
  content.textContent = "Loading...";
  modal.classList.remove("hidden");

  try {
    const resp = await fetch(
      "/api/containers/" + encodeURIComponent(containerName) +
      "/files/content?path=" + encodeURIComponent(filePath)
    );
    const data = await resp.json();
    if (data.error) {
      content.textContent = "Error: " + data.error;
      return;
    }
    if (data.size !== undefined) {
      sizeEl.textContent = data.size < 1024
        ? data.size + " B"
        : (data.size / 1024).toFixed(1) + " KB";
    }
    content.textContent = data.content;
  } catch (e) {
    content.textContent = "Failed: " + e.message;
  }
}

document.getElementById("file-viewer-close-btn").addEventListener("click", function () {
  document.getElementById("file-viewer-modal").classList.add("hidden");
});

document.getElementById("file-viewer-modal").addEventListener("click", function (e) {
  if (e.target.classList.contains("file-viewer-backdrop")) {
    document.getElementById("file-viewer-modal").classList.add("hidden");
  }
});

document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    const modal = document.getElementById("file-viewer-modal");
    if (!modal.classList.contains("hidden")) modal.classList.add("hidden");
  }
});

// --- Terminal tab (xterm.js + SSE+POST) ---

let _termXterm = null;          // xterm.Terminal instance
let _termFitAddon = null;       // FitAddon instance
let _termEventSource = null;    // SSE EventSource
let _termContainer = null;      // container name currently connected

let _localTermFitAddon = null;

let _localTermXterm = null;
let _localTermEventSource = null;

/** Load env-profile buttons in the terminal tab. Clicking injects export commands into the PTY. */
async function loadTerminalProfiles() {
  const row = document.getElementById("term-profile-row");
  const btnsEl = document.getElementById("term-profile-btns");
  row.classList.add("hidden");
  btnsEl.innerHTML = "";
  if (!selectedContainer || !selectedContainer.project_path) return;
  try {
    const qs = "?project_dir=" + encodeURIComponent(selectedContainer.project_path);
    const resp = await fetch("/api/config/merged" + qs);
    const config = await resp.json();
    if (config.error) return;
    const profiles = config.env_profiles || {};
    const names = Object.keys(profiles);
    if (!names.length) return;
    const activeProfile = config.env_profile || config.default_env_profile || "";
    row.classList.remove("hidden");
    names.forEach(function (name) {
      const btn = document.createElement("button");
      btn.className = "profile-switch-btn" + (name === activeProfile ? " active" : "");
      btn.textContent = name;
      btn.title = "Activate profile: " + name + " (injects export commands into terminal)";
      btn.addEventListener("click", function () {
        if (!_termContainer) return;
        const vars = profiles[name] || {};
        const exports = Object.keys(vars).map(function (k) {
          return "export " + k + "=" + String(vars[k]).replace(/'/g, "'\\''");
        });
        if (!exports.length) return;
        const cmd = exports.join(" && ") + "\r";
        fetch("/api/containers/" + encodeURIComponent(_termContainer) + "/terminal/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: cmd }),
        }).catch(function () {});
        btnsEl.querySelectorAll(".profile-switch-btn").forEach(function (b) {
          b.classList.toggle("active", b.textContent === name);
        });
        showEnvPickupNote(document.getElementById("term-env-note"));
      });
      btnsEl.appendChild(btn);
    });
  } catch (e) { /* non-fatal */ }
}

function onTerminalTabActivate() {
  if (!selectedContainer) return;
  loadTerminalProfiles();
  const container = document.getElementById("terminal-xterm-container");
  const fallback = document.getElementById("terminal-xterm-fallback");
  const statusLabel = document.getElementById("terminal-status-label");

  // Check CDN load
  if (window._xtermJsFailed || typeof window.Terminal === "undefined") {
    fallback.classList.remove("hidden");
    container.classList.add("hidden");
    return;
  }

  // If already connected (SSE active) to this container, do nothing
  if (_termContainer === selectedContainer.name && _termXterm && _termEventSource) return;

  // If xterm exists for this container but SSE is closed, reconnect the stream
  if (_termContainer === selectedContainer.name && _termXterm && !_termEventSource) {
    statusLabel.textContent = "Connecting...";
    document.getElementById("terminal-connect-btn").classList.add("hidden");
    document.getElementById("terminal-disconnect-btn").classList.remove("hidden");
    _termReconnectSSE(selectedContainer.name, statusLabel);
    return;
  }

  // Switching to a different container — full teardown of previous
  _termDisconnect();

  container.innerHTML = "";
  statusLabel.textContent = "Connecting...";
  document.getElementById("terminal-connect-btn").classList.add("hidden");
  document.getElementById("terminal-disconnect-btn").classList.remove("hidden");

  const _termIsDark = document.documentElement.getAttribute("data-theme") !== "light";
  _termXterm = new window.Terminal({
    theme: _termIsDark
      ? { background: "#0d0d0d", foreground: "#c8e6c9", cursor: "#a0cfb0" }
      : { background: "#f8f9fa", foreground: "#1e2433", cursor: "#1e2433", selectionBackground: "rgba(59,130,246,0.25)" },
    cursorBlink: true,
    fontFamily: '"Fira Code", "Cascadia Code", monospace',
    fontSize: 13,
    convertEol: false,
    scrollback: 5000,
    scrollSensitivity: 3,
  });

  if (window.FitAddon) {
    _termFitAddon = new window.FitAddon.FitAddon();
    _termXterm.loadAddon(_termFitAddon);
  }
  _termXterm.open(container);
  // requestAnimationFrame defers fit() until after the browser has completed
  // flex layout so FitAddon measures settled dimensions. (ref: DL-002)
  if (_termFitAddon) requestAnimationFrame(function () { if (_termFitAddon) _termFitAddon.fit(); });

  // Re-fit when user drags the container to resize it
  if (typeof ResizeObserver !== "undefined" && _termFitAddon) {
    const ro = new ResizeObserver(function () { if (_termFitAddon) _termFitAddon.fit(); });
    ro.observe(container);
    _termXterm._ro = ro;
  }

  // _termConnected gates resize dispatches -- onResize fires during open() before
  // the SSE connection exists, which would POST to a session that is not yet
  // started. Set to true only after EventSource.onopen fires. (ref: DL-004)
  var _termConnected = false;
  _termXterm._onResizeDisposable = _termXterm.onResize(function (evt) {
    if (!_termConnected) return;
    var name = _termContainer;
    fetch("/api/containers/" + encodeURIComponent(name) + "/terminal/resize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cols: evt.cols, rows: evt.rows }),
    }).catch(function () {});
  });

  _termContainer = selectedContainer.name;

  // Send keystrokes to backend
  _termXterm.onData(function (data) {
    if (!_termContainer) return;
    fetch("/api/containers/" + encodeURIComponent(_termContainer) + "/terminal/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: data }),
    }).catch(function () {});
  });

  // Stream output from backend
  _termEventSource = new EventSource(
    "/api/containers/" + encodeURIComponent(_termContainer) + "/terminal/stream"
  );

  _termEventSource.onopen = function () {
    statusLabel.textContent = "Connected";
    _termConnected = true;
    // Fit after connect so the PTY receives the correct initial dimensions
    // on the same tick that _termConnected is set, triggering the onResize handler. (ref: DL-004)
    if (_termFitAddon) _termFitAddon.fit();
  };

  _termEventSource.onmessage = function (evt) {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.data) {
        _termXterm.write(_b64ToU8(msg.data));
        _termXterm.scrollToBottom();
      }
    } catch (e) {}
  };

  _termEventSource.onerror = function () {
    statusLabel.textContent = "Disconnected";
    document.getElementById("terminal-connect-btn").classList.remove("hidden");
    document.getElementById("terminal-disconnect-btn").classList.add("hidden");
  };
}

// Reconnect: reopen SSE stream on an existing xterm instance (preserving scrollback).
function _termReconnectSSE(containerName, statusLabel) {
  _termEventSource = new EventSource(
    "/api/containers/" + encodeURIComponent(containerName) + "/terminal/stream"
  );
  _termEventSource.onopen = function () {
    statusLabel.textContent = "Connected";
    if (_termFitAddon) _termFitAddon.fit();
  };
  _termEventSource.onmessage = function (evt) {
    try {
      var msg = JSON.parse(evt.data);
      if (msg.data && _termXterm) {
        _termXterm.write(_b64ToU8(msg.data));
        _termXterm.scrollToBottom();
      }
    } catch (e) {}
  };
  _termEventSource.onerror = function () {
    statusLabel.textContent = "Disconnected";
    document.getElementById("terminal-connect-btn").classList.remove("hidden");
    document.getElementById("terminal-disconnect-btn").classList.add("hidden");
  };
}

// Soft disconnect: close the SSE stream but keep xterm instance and PTY alive.
// Reconnecting will reuse the existing xterm scrollback and PTY session.
function _termSoftDisconnect() {
  if (_termEventSource) {
    _termEventSource.close();
    _termEventSource = null;
  }
}

// Full teardown: dispose xterm, close SSE. Used when switching containers.
// Does NOT send DELETE — the PTY session stays alive for dashboard tiles
// and future reconnection. The idle reaper handles cleanup.
function _termDisconnect() {
  _termSoftDisconnect();
  if (_termXterm) {
    if (_termXterm._ro) _termXterm._ro.disconnect();
    if (_termXterm._onResizeDisposable) _termXterm._onResizeDisposable.dispose();
    _termXterm.dispose();
    _termXterm = null;
    _termFitAddon = null;
  }
  _termContainer = null;
}


document.getElementById("terminal-connect-btn").addEventListener("click", function () {
  onTerminalTabActivate();
});

document.getElementById("terminal-disconnect-btn").addEventListener("click", function () {
  _termSoftDisconnect();
  document.getElementById("terminal-status-label").textContent = "Disconnected";
  document.getElementById("terminal-connect-btn").classList.remove("hidden");
  document.getElementById("terminal-disconnect-btn").classList.add("hidden");
});

// --- Pin button in terminal detail header ---
// Clicking Pin/Unpin while a container detail panel is open toggles pin state in
// the registry via PATCH /api/containers/<name>/pin (DL-005) and updates the button label.
document.getElementById("detail-pin-btn").addEventListener("click", function () {
  if (!selectedContainer) return;
  togglePinContainer(selectedContainer.name);
});

// --- Popout button ---

document.getElementById("terminal-popout-btn").addEventListener("click", function () {
  if (!selectedContainer) return;
  const btn = this;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Opening…";
  fetch("/api/containers/" + encodeURIComponent(selectedContainer.name) + "/terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ terminal: "auto" }),
  })
    .then(function (r) { return r.json(); })
    .then(function (result) {
      btn.disabled = false;
      if (result.error) {
        btn.textContent = "Failed";
        setTimeout(function () { btn.textContent = origText; }, 2000);
      } else {
        btn.textContent = origText;
      }
    })
    .catch(function () {
      btn.disabled = false;
      btn.textContent = origText;
    });
});

/** Show an env-pickup note with a Copy button that dismisses the note on click. */
function showEnvPickupNote(noteEl) {
  noteEl.classList.remove("hidden");
  const copyBtn = noteEl.querySelector(".env-pickup-copy");
  copyBtn.textContent = "Copy";
  // Replace to drop any previous listener
  const fresh = copyBtn.cloneNode(true);
  copyBtn.parentNode.replaceChild(fresh, copyBtn);
  fresh.addEventListener("click", function () {
    const cmd = noteEl.querySelector(".env-pickup-cmd").textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(cmd).then(function () {
        fresh.textContent = "✓ Copied";
        setTimeout(function () { noteEl.classList.add("hidden"); }, 1200);
      });
    } else {
      noteEl.classList.add("hidden");
    }
  });
}

// --- Terminal tab command buttons (Stop/Start, Refresh, Destroy) ---

// Overflow menu for destructive command panel actions (Destroy, Unregister).
// Toggles hidden class on #cmd-overflow-menu. Closes on outside click or
// on any click inside the menu. Destructive actions are placed behind this
// toggle to add one extra click of friction. (PDL-002)
(function () {
  var toggleBtn = document.getElementById("cmd-overflow-toggle-btn");
  var menu = document.getElementById("cmd-overflow-menu");
  if (!toggleBtn || !menu) return;

  toggleBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });

  document.addEventListener("click", function (e) {
    if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target !== toggleBtn) {
      menu.classList.add("hidden");
    }
  });

  menu.addEventListener("click", function () {
    menu.classList.add("hidden");
  });
}());

// term-refresh-btn and term-destroy-btn have no listeners here.
// Sync Config and Destroy live in the Overview tab command panel. (PDL-003)
// Stop/Start (#term-stop-start-btn) belongs in the terminal header: it stops
// the container process without navigating away from the terminal view.
document.getElementById("term-stop-start-btn").addEventListener("click", function () {
  if (!selectedContainer) return;
  const isStart = this.textContent.indexOf("Start") >= 0;
  if (isStart) {
    document.querySelectorAll(".cmd-btn").forEach(function (b) { b.disabled = true; });
    cmdOutput.textContent = "Starting container…\n";
    cmdOutput.classList.remove("hidden");
    fetch("/api/containers/" + encodeURIComponent(selectedContainer.name) + "/start", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        document.querySelectorAll(".cmd-btn").forEach(function (b) { b.disabled = false; });
        if (result.error) {
          cmdOutput.textContent += "Error: " + result.error + "\n";
        } else {
          cmdOutput.textContent += "Container started.\n";
          const ss1 = document.getElementById("cmd-stop-start-btn");
          const ss2 = document.getElementById("term-stop-start-btn");
          if (ss1) { ss1.textContent = "⏹ Stop"; ss1.setAttribute("data-cmd", "stop"); ss1.className = "cmd-btn cmd-stop"; }
          if (ss2) { ss2.textContent = "⏹ Stop"; ss2.className = "cmd-btn cmd-stop"; }
          const terminalBtn = document.querySelector("[data-cmd='terminal']");
          if (terminalBtn) terminalBtn.disabled = false;
          loadContainers();
        }
      })
      .catch(function (e) {
        document.querySelectorAll(".cmd-btn").forEach(function (b) { b.disabled = false; });
        cmdOutput.textContent += "Error: " + e.message + "\n";
      });
  } else {
    runCommand("stop", selectedContainer);
  }
});

function _onLocalTermSubtabActivate() {
  const container = document.getElementById("local-terminal-xterm-container");
  if (!container) return;
  // If SSE is already active, do nothing
  if (_localTermXterm && _localTermEventSource) return;

  // If xterm exists but SSE is closed, reconnect the stream
  if (_localTermXterm && !_localTermEventSource) {
    document.getElementById("local-term-status").textContent = "Connecting...";
    document.getElementById("local-term-connect-btn").classList.add("hidden");
    document.getElementById("local-term-disconnect-btn").classList.remove("hidden");
    _localTermReconnectSSE();
    return;
  }

  document.getElementById("local-term-status").textContent = "Connecting...";
  document.getElementById("local-term-connect-btn").classList.add("hidden");
  document.getElementById("local-term-disconnect-btn").classList.remove("hidden");

  const _termIsDark = document.documentElement.getAttribute("data-theme") !== "light";
  _localTermXterm = new window.Terminal({
    theme: _termIsDark
      ? { background: "#0d0d0d", foreground: "#c8e6c9", cursor: "#a0cfb0" }
      : { background: "#f8f9fa", foreground: "#1e2433", cursor: "#1e2433", selectionBackground: "rgba(59,130,246,0.25)" },
    cursorBlink: true,
    fontFamily: '"Fira Code", "Cascadia Code", monospace',
    fontSize: 13,
    convertEol: false,
    scrollback: 5000,
    scrollSensitivity: 3,
  });

  if (window.FitAddon) {
    _localTermFitAddon = new window.FitAddon.FitAddon();
    _localTermXterm.loadAddon(_localTermFitAddon);
  }
  _localTermXterm.open(container);
  // requestAnimationFrame defers fit() until after the browser has completed
  // flex layout so FitAddon measures settled dimensions. (ref: DL-002)
  if (_localTermFitAddon) requestAnimationFrame(function () { if (_localTermFitAddon) _localTermFitAddon.fit(); });

  if (typeof ResizeObserver !== "undefined" && _localTermFitAddon) {
    const ro = new ResizeObserver(function () { if (_localTermFitAddon) _localTermFitAddon.fit(); });
    ro.observe(container);
    _localTermXterm._ro = ro;
  }

  // _localTermConnected gates resize dispatches -- onResize fires during open()
  // before the SSE connection exists. Set to true only after EventSource.onopen. (ref: DL-004)
  var _localTermConnected = false;
  _localTermXterm._onResizeDisposable = _localTermXterm.onResize(function (evt) {
    if (!_localTermConnected) return;
    fetch("/api/local-terminal/resize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cols: evt.cols, rows: evt.rows }),
    }).catch(function () {});
  });

  _localTermXterm.onData(function (data) {
    fetch("/api/local-terminal/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: data }),
    }).catch(function () {});
  });

  _localTermEventSource = new EventSource("/api/local-terminal/stream");

  _localTermEventSource.onopen = function () {
    document.getElementById("local-term-status").textContent = "Connected";
    _localTermConnected = true;
    // Fit after connect so the PTY receives the correct initial dimensions. (ref: DL-004)
    if (_localTermFitAddon) _localTermFitAddon.fit();
  };

  _localTermEventSource.onmessage = function (evt) {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.data) {
        _localTermXterm.write(_b64ToU8(msg.data));
        _localTermXterm.scrollToBottom();
      }
    } catch (e) {}
  };

  _localTermEventSource.onerror = function () {
    document.getElementById("local-term-status").textContent = "Disconnected";
    document.getElementById("local-term-connect-btn").classList.remove("hidden");
    document.getElementById("local-term-disconnect-btn").classList.add("hidden");
  };
}

// Reconnect: reopen SSE stream on an existing local xterm instance.
function _localTermReconnectSSE() {
  _localTermEventSource = new EventSource("/api/local-terminal/stream");
  _localTermEventSource.onopen = function () {
    document.getElementById("local-term-status").textContent = "Connected";
    if (_localTermFitAddon) _localTermFitAddon.fit();
  };
  _localTermEventSource.onmessage = function (evt) {
    try {
      var msg = JSON.parse(evt.data);
      if (msg.data && _localTermXterm) {
        _localTermXterm.write(_b64ToU8(msg.data));
        _localTermXterm.scrollToBottom();
      }
    } catch (e) {}
  };
  _localTermEventSource.onerror = function () {
    document.getElementById("local-term-status").textContent = "Disconnected";
    document.getElementById("local-term-connect-btn").classList.remove("hidden");
    document.getElementById("local-term-disconnect-btn").classList.add("hidden");
  };
}

// Soft disconnect: close the SSE stream but keep xterm instance and PTY alive.
function _localTermSoftDisconnect() {
  if (_localTermEventSource) {
    _localTermEventSource.close();
    _localTermEventSource = null;
  }
}

// Full teardown: dispose xterm, close SSE. Does NOT send DELETE.
function _localTermDisconnect() {
  _localTermSoftDisconnect();
  if (_localTermXterm) {
    if (_localTermXterm._ro) _localTermXterm._ro.disconnect();
    if (_localTermXterm._onResizeDisposable) _localTermXterm._onResizeDisposable.dispose();
    _localTermXterm.dispose();
    _localTermXterm = null;
    _localTermFitAddon = null;
  }
}

// --- Terminal sub-tabs ---

document.querySelectorAll(".terminal-subtab-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    document.querySelectorAll(".terminal-subtab-btn").forEach(function (b) {
      b.classList.toggle("active", b === btn);
    });
    document.querySelectorAll(".terminal-subtab-pane").forEach(function (pane) {
      pane.classList.toggle("hidden", pane.id !== "term-subtab-" + btn.dataset.subtab);
    });
    // ResizeObserver does not fire when a pane transitions from hidden to visible.
    // requestAnimationFrame defers fit() until after the class toggle has taken
    // effect and the browser has laid out the now-visible pane. (ref: DL-002)
    if (btn.dataset.subtab === "container" && _termFitAddon) {
      requestAnimationFrame(function () { if (_termFitAddon) _termFitAddon.fit(); });
    }
    if (btn.dataset.subtab === "local" && _localTermFitAddon) {
      requestAnimationFrame(function () { if (_localTermFitAddon) _localTermFitAddon.fit(); });
    }
  });
});

document.getElementById("local-term-connect-btn").addEventListener("click", function () {
  _onLocalTermSubtabActivate();
});

document.getElementById("local-term-disconnect-btn").addEventListener("click", function () {
  _localTermSoftDisconnect();
  document.getElementById("local-term-status").textContent = "Disconnected";
  document.getElementById("local-term-connect-btn").classList.remove("hidden");
  document.getElementById("local-term-disconnect-btn").classList.add("hidden");
});

// --- Refs tab ---

// Wire up the host directory folder browser for refs
initFolderBrowser(
  document.getElementById("ref-dir-input"),
  document.getElementById("ref-browse-btn"),
  document.getElementById("ref-dir-tree"),
  {}
);

document.getElementById("ref-add-btn").addEventListener("click", function () {
  if (!selectedContainer) return;
  const dir = (document.getElementById("ref-dir-input").value || "").trim();
  if (!dir) { refAddOutput.textContent = "Please enter a host directory path."; refAddOutput.classList.remove("hidden"); return; }
  const refresh = document.getElementById("ref-refresh-checkbox").checked;
  const args = "ref " + dir + (refresh ? " --refresh" : "");
  refAddOutput.textContent = "";
  refAddOutput.classList.remove("hidden");
  streamToTerminal(args, selectedContainer.project_path || null, refAddOutput, function (ok) {
    if (ok) loadRefs(selectedContainer.name);
  });
});

// --- Init ---

loadContainers();

// Dashboard tiles use direct EventSource instances per tile; broadcaster fan-out
// handles multiple concurrent readers server-side (DL-003, see api.py).

// Activity status tracking: _startDashboardStatusInterval() in dashboard section (DL-002).

// Fullscreen interaction: _openDashboardFullscreen() in dashboard section (DL-013).

// Fullscreen overlay and activity status are implemented as part of
// the dashboard functions: _openDashboardFullscreen(), _startDashboardStatusInterval(),
// and _stopDashboardStatusInterval().
// The fsBtn click handler in _createDashboardTile calls _openDashboardFullscreen(name).

// --- Dashboard (pinned container terminals) ---
//
// Architecture:
//   - Pin state: registry pinned field via PATCH /api/containers/<name>/pin (DL-005)
//   - Grid layout: CSS auto-fill minmax(320px,1fr) — no JS column math (DL-008)
//   - Tiles are read-only xterm.js previews; fullscreen enables input (DL-004)
//   - Activity detection: client-side SSE timestamp diff, 30s idle threshold (DL-002)
//   - PTY sessions shared with detail panel; unpin closes SSE but not PTY (DL-006)
//   - Server fan-out broadcaster handles concurrent SSE readers (DL-003)

const _dashboardTiles = {};
// _dashboardTiles: keyed by container name; each entry:
//   { xterm, fitAddon, eventSource, lastActivity }
// eventSource is null while fullscreen overlay is open for that container.
let _dashboardStatusInterval = null;

// Returns xterm.js theme tokens for the current light/dark mode.
function getDashboardTerminalTheme() {
  // Reads data-theme attribute set by the theme toggle; defaults to dark.
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  return isDark
    ? { background: "#0d0d0d", foreground: "#c8e6c9", cursor: "#a0cfb0" }
    : { background: "#f8f9fa", foreground: "#1e2433", cursor: "#1e2433" };
}

// Fetches pinned containers from the registry via GET /api/containers (DL-005).
// Returns a Promise resolving to an array of container objects with pinned===true.
function fetchPinnedContainers() {
  return fetch("/api/containers")
    .then(function (r) { return r.json(); })
    .then(function (containers) { return containers.filter(function (c) { return c.pinned === true; }); });
}

// Sets the pinned state for a container via PATCH /api/containers/<name>/pin (DL-005).
function setPinned(name, pinned) {
  return fetch("/api/containers/" + encodeURIComponent(name) + "/pin", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned: pinned }),
  });
}

// Toggles pin state for a container by reading current state from the registry,
// sending a PATCH to flip it, then refreshing the dashboard grid if visible.
function togglePinContainer(name) {
  fetchPinnedContainers().then(function (pinned) {
    const isPinned = pinned.some(function (c) { return c.name === name; });
    setPinned(name, !isPinned).then(function () {
      _updatePinBtnLabel(name);
      if (!dashboardPanel.classList.contains("hidden")) renderDashboardGrid();
    });
  });
}

// Syncs the "Pin"/"Unpin" label on #detail-pin-btn to match current registry pin state.
function _updatePinBtnLabel(name) {
  const btn = document.getElementById("detail-pin-btn");
  if (!btn) return;
  fetchPinnedContainers().then(function (pinned) {
    btn.textContent = pinned.some(function (c) { return c.name === name; }) ? "Unpin" : "Pin";
  });
}

// Renders the dashboard grid from the current pinned container list in the registry.
// Creates tiles for newly pinned containers; removes tiles for unpinned ones.
// Shows the empty-state element when no containers are pinned (DL-008).
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
  }).catch(function () {});
}

// Creates one dashboard tile DOM element for container name and appends it to grid.
//
// Tile layout: header (status dot + name + Unpin + Fullscreen) + tile-body (xterm).
// The xterm.js instance is configured read-only (disableStdin: true) (DL-004).
//
// FitAddon.fit() must be called only after the tile element is visible and has
// non-zero dimensions. Calling fit() on a hidden or zero-sized element fails
// silently: the terminal canvas is sized to 0x0 and subsequent output renders
// incorrectly. A ResizeObserver on the tile-body element triggers fit() once the
// element is laid out, ensuring correct sizing even when the dashboard panel
// renders tiles before they become visible.
//
// An EventSource subscribes to /api/containers/<name>/terminal/stream (DL-007);
// each SSE message updates lastActivity for client-side status detection (DL-002).
// The tile state is stored in _dashboardTiles[name].
function _createDashboardTile(name, grid) {
  const tile = document.createElement("div");
  tile.className = "dashboard-tile";
  tile.dataset.container = name;

  const header = document.createElement("div");
  header.className = "dashboard-tile-header";

  const statusDot = document.createElement("span");
  statusDot.className = "dashboard-status-dot status-idle";

  const nameSpan = document.createElement("span");
  nameSpan.className = "dashboard-tile-name";
  nameSpan.textContent = name;

  const unpinBtn = document.createElement("button");
  unpinBtn.className = "dashboard-tile-unpin cmd-btn";
  unpinBtn.textContent = "Unpin";
  unpinBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    setPinned(name, false).then(function () {
      _teardownDashboardTiles([name]);
      tile.remove();
      _updatePinBtnLabel(name);
      fetchPinnedContainers().then(function (pinned) {
        const emptyState = document.getElementById("dashboard-empty-state");
        if (emptyState) emptyState.style.display = pinned.length === 0 ? "" : "none";
      });
    });
  });

  const fsBtn = document.createElement("button");
  fsBtn.className = "dashboard-tile-fullscreen cmd-btn";
  fsBtn.title = "Fullscreen";
  fsBtn.textContent = "\u26F6";
  fsBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    _openDashboardFullscreen(name);
  });

  header.appendChild(statusDot);
  header.appendChild(nameSpan);
  header.appendChild(unpinBtn);
  header.appendChild(fsBtn);

  const xtermContainer = document.createElement("div");
  xtermContainer.className = "dashboard-tile-body";

  tile.appendChild(header);
  tile.appendChild(xtermContainer);
  grid.appendChild(tile);

  if (!window.Terminal) {
    xtermContainer.textContent = "xterm.js not available";
    return;
  }

  const xterm = new window.Terminal({
    theme: getDashboardTerminalTheme(),
    fontSize: 11,
    scrollback: 500,
    disableStdin: true,
  });
  let fitAddon = null;
  if (window.FitAddon) {
    fitAddon = new window.FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);
  }
  xterm.open(xtermContainer);

  if (fitAddon && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(function () {
      if (fitAddon && xtermContainer.offsetWidth > 0) fitAddon.fit();
    });
    ro.observe(xtermContainer);
    xterm._dashRo = ro;
  }

  const es = new EventSource("/api/containers/" + encodeURIComponent(name) + "/terminal/stream");
  es.onmessage = function (evt) {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.data) {
        xterm.write(_b64ToU8(msg.data));
      }
    } catch (e) {}
    if (_dashboardTiles[name]) _dashboardTiles[name].lastActivity = Date.now();
  };

  _dashboardTiles[name] = { xterm: xterm, fitAddon: fitAddon, eventSource: es, lastActivity: 0 };
  requestAnimationFrame(function () {
    if (fitAddon && xtermContainer.offsetWidth > 0) fitAddon.fit();
  });
}

// Closes EventSources and disposes xterm.js instances for the given container names.
// Removes entries from _dashboardTiles.
// Closing the EventSource unsubscribes from the server broadcaster (DL-006):
// the PTY session itself is NOT deleted here, preserving any detail panel session.
function _teardownDashboardTiles(names) {
  names.forEach(function (name) {
    const tile = _dashboardTiles[name];
    if (!tile) return;
    if (tile.eventSource) tile.eventSource.close();
    if (tile.xterm) {
      if (tile.xterm._dashRo) tile.xterm._dashRo.disconnect();
      tile.xterm.dispose();
    }
    delete _dashboardTiles[name];
  });
}

// Starts a 2-second interval that updates activity status dots on all visible tiles.
// Status classification by elapsed time since last SSE message (DL-002):
//   < 3s  -> status-active  (green pulse)
//   < 30s -> status-waiting (yellow)
//   >= 30s or never -> status-idle (grey)
// 30s idle threshold prevents false-idle from browser background-tab SSE throttling (R-002).
function _startDashboardStatusInterval() {
  if (_dashboardStatusInterval) return;
  _dashboardStatusInterval = setInterval(function () {
    const now = Date.now();
    Object.keys(_dashboardTiles).forEach(function (name) {
      const tile = _dashboardTiles[name];
      const tileEl = document.querySelector(".dashboard-tile[data-container='" + name + "']");
      if (!tileEl) return;
      const dot = tileEl.querySelector(".dashboard-status-dot");
      if (!dot) return;
      const elapsed = tile.lastActivity ? (now - tile.lastActivity) : Infinity;
      dot.className = "dashboard-status-dot " + (
        elapsed < 3000 ? "status-active" :
        elapsed < 30000 ? "status-waiting" :
        "status-idle"
      );
    });
  }, 2000);
}

// Clears the status dot update interval started by _startDashboardStatusInterval().
function _stopDashboardStatusInterval() {
  if (_dashboardStatusInterval) {
    clearInterval(_dashboardStatusInterval);
    _dashboardStatusInterval = null;
  }
}

// Opens the fullscreen overlay for container name, enabling interactive input (DL-013).
//
// Reparents the tile's xterm body element into the overlay so the same xterm instance,
// scrollback, and EventSource are preserved. Input is enabled via onData while fullscreen.
// On close, the xterm body is moved back to the tile and input is detached.
function _openDashboardFullscreen(name) {
  var overlay = document.getElementById("dashboard-fullscreen-overlay");
  var fsContainer = document.getElementById("fullscreen-xterm-container");
  var nameLabel = document.getElementById("fullscreen-container-name");
  var statusLabel = document.getElementById("fullscreen-status-label");
  if (!overlay || !fsContainer) return;

  var tileState = _dashboardTiles[name];
  if (!tileState || !tileState.xterm) return;

  // Find the tile's xterm body element and reparent it into the overlay.
  var tileEl = document.querySelector(".dashboard-tile[data-container='" + name + "']");
  var tileBody = tileEl ? tileEl.querySelector(".dashboard-tile-body") : null;
  if (!tileBody) return;

  fsContainer.innerHTML = "";
  fsContainer.appendChild(tileBody);
  nameLabel.textContent = name;
  statusLabel.textContent = "Connected";
  overlay.classList.remove("hidden");

  // Refit xterm to the larger fullscreen container.
  if (tileState.fitAddon) requestAnimationFrame(function () { if (tileState.fitAddon) tileState.fitAddon.fit(); });

  // Enable keyboard input while fullscreen.
  var inputDisposable = tileState.xterm.onData(function (data) {
    fetch("/api/containers/" + encodeURIComponent(name) + "/terminal/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: data }),
    }).catch(function () {});
  });

  // Wire resize propagation while fullscreen.
  var resizeDisposable = tileState.xterm.onResize(function (evt) {
    fetch("/api/containers/" + encodeURIComponent(name) + "/terminal/resize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cols: evt.cols, rows: evt.rows }),
    }).catch(function () {});
  });

  function closeFullscreen() {
    inputDisposable.dispose();
    resizeDisposable.dispose();
    overlay.classList.add("hidden");
    document.removeEventListener("keydown", escHandler);
    // Move xterm body back to the tile.
    if (tileEl) tileEl.appendChild(tileBody);
    // Refit xterm to the smaller tile container.
    if (tileState.fitAddon) requestAnimationFrame(function () { if (tileState.fitAddon) tileState.fitAddon.fit(); });
  }

  function escHandler(e) {
    if (e.key === "Escape") {
      if (document.querySelector('.file-viewer-modal:not(.hidden)')) return;
      closeFullscreen();
    }
  }
  document.addEventListener("keydown", escHandler);
  document.getElementById("fullscreen-close-btn").onclick = closeFullscreen;
}

document.getElementById("dashboard-nav-btn").addEventListener("click", function () {
  // Deselect container list items; show dashboard panel; render grid; start status ticker.
  document.querySelectorAll(".container-item").forEach(function (el) { el.classList.remove("active"); });
  showPanel("dashboard");
  renderDashboardGrid();
  _startDashboardStatusInterval();
});
