// ============================================================
// JobPilot AI — Web Settings Page (Live-Connected)
// Communicates with the extension via chrome.runtime.sendMessage
// or falls back to postMessage bridge through content script
// ============================================================

const DEFAULT_EXTENSION_ID = "kbmpbhhhdojgjnpfpnoehafmllfejgll";
let EXTENSION_ID =
  new URLSearchParams(window.location.search).get("ext") ||
  localStorage.getItem("jobpilot_extension_id") ||
  DEFAULT_EXTENSION_ID;

// ─── PostMessage Bridge (fallback via content script) ───
// If chrome.runtime.sendMessage doesn't work (e.g. externally_connectable issues),
// we talk to the content script which proxies chrome.storage operations.
let _usePostMessageBridge = false;
let _reqCounter = 0;
const _pendingRequests = new Map();

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data || {};
  if (data.type !== "JAF_BRIDGE_RESPONSE" || !data.reqId) return;
  const pending = _pendingRequests.get(data.reqId);
  if (!pending) return;
  _pendingRequests.delete(data.reqId);
  clearTimeout(pending.timer);
  if (data.error) {
    pending.reject(new Error(data.error));
  } else {
    pending.resolve(data);
  }
});

function postMessageSend(action, params = {}) {
  return new Promise((resolve, reject) => {
    const reqId = `jaf_${++_reqCounter}_${Date.now()}`;
    const timer = setTimeout(() => {
      _pendingRequests.delete(reqId);
      reject(new Error("PostMessage bridge timeout"));
    }, 3000);
    _pendingRequests.set(reqId, { resolve, reject, timer });
    window.postMessage(
      { type: "JAF_BRIDGE_REQUEST", reqId, action, ...params },
      "*",
    );
  });
}

// ─── Bridge: Talk to Chrome Extension ───
const Bridge = {
  connected: false,
  version: null,

  async send(action, params = {}) {
    // If postMessage bridge is active, use it directly
    if (_usePostMessageBridge) {
      return postMessageSend(action, params);
    }

    return new Promise((resolve, reject) => {
      if (!chrome?.runtime?.sendMessage) {
        reject(
          new Error(
            "Chrome runtime API not available. Open this page in Chrome with the extension installed.",
          ),
        );
        return;
      }

      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            "Extension bridge timeout. Reload the extension in chrome://extensions and refresh this page.",
          ),
        );
      }, 2500);

      try {
        chrome.runtime.sendMessage(
          EXTENSION_ID,
          { action, ...params },
          (response) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (response?.error) {
              reject(new Error(response.error));
            } else {
              resolve(response);
            }
          },
        );
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  },

  async ping() {
    try {
      const res = await this.send("ping");
      this.connected = true;
      this.version = res.version;
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  },

  async getAll(area = "sync") {
    const res = await this.send("getAll", { area });
    return res.data || {};
  },

  async get(keys, area = "sync") {
    const res = await this.send("get", { keys, area });
    return res.data || {};
  },

  async set(data, area = "sync") {
    return this.send("set", { data, area });
  },

  async remove(keys, area = "sync") {
    return this.send("remove", { keys, area });
  },
};

// ─── State ───
let profileData = {};
let localData = {};
let saveTimer = null;
let pollTimer = null;

// ─── UI Helpers ───
function $(sel) {
  return document.querySelector(sel);
}
function $$(sel) {
  return document.querySelectorAll(sel);
}

function toast(message, type = "success") {
  const container = $("#toastContainer");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `${type === "success" ? "✓" : type === "error" ? "✗" : "ℹ"} ${message}`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function showAutosave(state) {
  const el = $("#autosaveIndicator");
  el.className = `autosave-indicator ${state}`;
  el.textContent = state === "saving" ? "Saving..." : "Saved ✓";
  if (state === "saved") {
    setTimeout(() => {
      el.className = "autosave-indicator";
    }, 1500);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function setAuthUI(connected) {
  const gate = $("#loginGate");
  const app = $("#appContent");
  if (!gate || !app) return;

  if (connected) {
    gate.style.display = "none";
    app.classList.add("authenticated");
  } else {
    gate.style.display = "flex";
    app.classList.remove("authenticated");
  }
}

function promptForExtensionId() {
  const input = window.prompt(
    "Enter your extension ID (leave blank to use default store ID)",
    EXTENSION_ID || DEFAULT_EXTENSION_ID,
  );
  if (input === null) return; // cancelled

  const trimmed = (input || "").trim();
  EXTENSION_ID = trimmed || DEFAULT_EXTENSION_ID;
  localStorage.setItem("jobpilot_extension_id", EXTENSION_ID);
}

async function detectExtensionIdFromContentScript(timeoutMs = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data || {};
      if (data.type !== "JAF_EXTENSION_ID_RESPONSE" || !data.runtimeId) return;

      done = true;
      window.removeEventListener("message", onMessage);
      resolve({ runtimeId: data.runtimeId, version: data.version || null });
    };

    window.addEventListener("message", onMessage);
    window.postMessage({ type: "JAF_REQUEST_EXTENSION_ID" }, "*");

    setTimeout(() => {
      if (done) return;
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, timeoutMs);
  });
}

// ─── Connection ───
const _diagLog = [];
function diag(msg) {
  const ts = new Date().toLocaleTimeString();
  _diagLog.push(`[${ts}] ${msg}`);
  console.log(`[Settings Diag] ${msg}`);
}

async function checkConnection() {
  const banner = $("#connectionBanner");
  const text = $("#connectionText");
  const meta = $("#connectionMeta");

  _diagLog.length = 0;
  banner.className = "connection-banner connecting";
  text.textContent = "Connecting to JobPilot AI extension...";

  // Step 1: Check chrome.runtime availability
  diag(`chrome exists: ${typeof chrome !== "undefined"}`);
  diag(
    `chrome.runtime exists: ${typeof chrome !== "undefined" && !!chrome.runtime}`,
  );
  diag(
    `chrome.runtime.sendMessage exists: ${typeof chrome !== "undefined" && !!chrome?.runtime?.sendMessage}`,
  );
  diag(`Trying extension ID: ${EXTENSION_ID}`);

  // Step 2: Try direct ping
  let pingError = null;
  let ok = false;
  try {
    ok = await Bridge.ping();
    diag(`Direct ping result: ${ok}`);
  } catch (e) {
    pingError = e;
    diag(`Direct ping error: ${e.message}`);
  }

  // Step 3: Auto-discover real extension ID from content script
  if (!ok) {
    diag("Attempting content-script auto-discovery...");
    const discovered = await detectExtensionIdFromContentScript();
    diag(`Auto-discovery result: ${JSON.stringify(discovered)}`);
    if (discovered?.runtimeId && discovered.runtimeId !== EXTENSION_ID) {
      diag(`Switching to discovered ID: ${discovered.runtimeId}`);
      EXTENSION_ID = discovered.runtimeId;
      localStorage.setItem("jobpilot_extension_id", EXTENSION_ID);
      try {
        ok = await Bridge.ping();
        diag(`Re-ping with discovered ID: ${ok}`);
      } catch (e) {
        diag(`Re-ping error: ${e.message}`);
      }
    } else if (discovered?.runtimeId === EXTENSION_ID) {
      diag(
        "Discovered same ID as already tried — extension installed but not responding to external messages",
      );
    } else {
      diag(
        "No content script response — extension may not be installed or content scripts not loaded",
      );
    }
  }

  // Step 4: If direct messaging still failed but content script responded,
  // try postMessage bridge as fallback (bypasses externally_connectable)
  if (!ok) {
    diag("Trying postMessage bridge fallback...");
    try {
      const pmResult = await postMessageSend("ping");
      if (pmResult?.success) {
        _usePostMessageBridge = true;
        ok = true;
        Bridge.connected = true;
        Bridge.version = pmResult.version || "?";
        diag(`PostMessage bridge works! version: ${pmResult.version}`);
      }
    } catch (e) {
      diag(`PostMessage bridge failed: ${e.message}`);
    }
  }

  if (ok) {
    banner.className = "connection-banner connected";
    text.textContent = "Connected to JobPilot AI extension";
    meta.textContent = `v${Bridge.version}${_usePostMessageBridge ? " · bridge mode" : ""} · ${EXTENSION_ID}`;
    setAuthUI(true);
    return true;
  } else {
    banner.className = "connection-banner disconnected";
    text.textContent = "Not connected to extension.";
    const diagHtml = _diagLog.map((l) => escapeHtml(l)).join("<br>");
    meta.innerHTML = `ID: ${EXTENSION_ID} · <a href="https://chrome.google.com/webstore/detail/${DEFAULT_EXTENSION_ID}" target="_blank" style="color:inherit; text-decoration:underline;">Install</a> · <a href="#" id="changeExtIdLink" style="color:inherit; text-decoration:underline;">Change ID</a><br><details style="margin-top:6px; font-size:10px; text-align:left; max-width:600px;"><summary style="cursor:pointer; opacity:0.8;">Connection log</summary><div style="margin-top:4px; padding:6px 8px; background:rgba(0,0,0,0.15); border-radius:4px; line-height:1.6; font-family:monospace; word-break:break-all;">${diagHtml}</div></details>`;
    const changeLink = document.getElementById("changeExtIdLink");
    if (changeLink) {
      changeLink.addEventListener("click", async (e) => {
        e.preventDefault();
        promptForExtensionId();
        await checkConnection();
      });
    }
    setAuthUI(false);
    return false;
  }
}

// ─── Load all data from extension ───
async function loadAllData() {
  try {
    profileData = await Bridge.getAll("sync");
    // Also get local data (CV content, file data)
    try {
      localData = await Bridge.getAll("local");
    } catch {
      localData = {};
    }
    populateUI();
    toast("Data synced from extension", "info");
  } catch (err) {
    toast(`Failed to load: ${err.message}`, "error");
  }
}

// ─── Populate UI from loaded data ───
function populateUI() {
  // Fill all input/textarea/select with data-key
  $$("[data-key]").forEach((el) => {
    const key = el.dataset.key;
    let value = profileData[key];

    // CV content: prefer local (source of truth for large text)
    if (key === "cvContent" && localData.cvContent) {
      value = localData.cvContent;
    }

    if (value !== undefined && value !== null) {
      if (el.tagName === "SELECT") {
        el.value = value;
      } else {
        el.value = value;
      }
    }
  });

  // Toggles
  $$("[data-toggle]").forEach((el) => {
    const key = el.dataset.toggle;
    if (profileData[key]) {
      el.classList.add("active");
    } else {
      el.classList.remove("active");
    }
  });

  // Languages
  const spokenInput = $("#spokenLanguagesInput");
  if (spokenInput && profileData.spokenLanguages) {
    spokenInput.value = Array.isArray(profileData.spokenLanguages)
      ? profileData.spokenLanguages.join(", ")
      : profileData.spokenLanguages;
  }
  const respLang = $("#responseLanguageSelect");
  if (respLang && profileData.responseLanguage) {
    respLang.value = profileData.responseLanguage;
  }

  // Stats
  $("#statFillCount").textContent = profileData.fillCount || 0;
  $("#statPageCount").textContent = profileData.pageCount || 0;

  // Custom Params
  renderCustomParams();

  // Timeline
  renderTimeline();

  // Tracker
  renderTracker();

  // Learned Responses
  renderLearned();

  // Docs (CVs, Cover Letters, Context Docs)
  renderDocs();

  // Jobs4U
  renderJobs4u();

  // Assistant pending items
  checkPendingItems();
}

// ─── Auto-save on field change (debounced) ───
function setupAutosave() {
  $$("[data-key]").forEach((el) => {
    const saveField = () => {
      const key = el.dataset.key;
      const value = el.value;

      // Update local state
      profileData[key] = value;

      // Auto-compute fullName
      if (key === "firstName" || key === "lastName") {
        const first = profileData.firstName || "";
        const last = profileData.lastName || "";
        profileData.fullName = `${first} ${last}`.trim();
      }

      // Debounced save
      showAutosave("saving");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          const saveData = { [key]: value };
          if (key === "firstName" || key === "lastName") {
            saveData.fullName = profileData.fullName;
          }

          // CV content goes to both sync (truncated) and local (full)
          if (key === "cvContent") {
            await Bridge.set({ cvContent: value }, "local");
            // Sync gets truncated version
            saveData.cvContent = value.substring(0, 7000);
          }

          await Bridge.set(saveData);
          showAutosave("saved");
        } catch (err) {
          toast(`Save failed: ${err.message}`, "error");
        }
      }, 800);
    };

    el.addEventListener("input", saveField);
    el.addEventListener("change", saveField);
  });
}

// ─── Toggle switches ───
function setupToggles() {
  $$("[data-toggle]").forEach((el) => {
    el.addEventListener("click", async () => {
      const key = el.dataset.toggle;
      const newVal = !el.classList.contains("active");
      el.classList.toggle("active", newVal);
      profileData[key] = newVal;
      try {
        await Bridge.set({ [key]: newVal });
        toast(`${key} ${newVal ? "enabled" : "disabled"}`);
      } catch (err) {
        toast(`Failed: ${err.message}`, "error");
        el.classList.toggle("active", !newVal);
      }
    });
  });
}

// ─── Tab switching ───
function setupTabs() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      $$(".tab-content").forEach((c) => c.classList.remove("active"));
      $(`#tab-${tab.dataset.tab}`)?.classList.add("active");
    });
  });
}

// ─── Collapsible sections ───
function setupCollapsible() {
  $$(".card-header[data-section]").forEach((header) => {
    header.addEventListener("click", () => {
      const body = header.nextElementSibling;
      const chevron = header.querySelector(".chevron");
      header.classList.toggle("collapsed");
      body.classList.toggle("collapsed");
    });
  });
}

// ─── Custom Parameters ───
function renderCustomParams() {
  const container = $("#customParamsList");
  if (!container) return;
  container.innerHTML = "";

  const customParams = profileData.customParams || [];
  if (customParams.length === 0) {
    container.innerHTML =
      '<p style="font-size:12px; color:var(--text-muted); grid-column:1/-1;">No custom parameters yet.</p>';
    return;
  }

  customParams.forEach((param) => {
    const group = document.createElement("div");
    group.className = "field-group";
    const value = profileData[param.key] || "";
    group.innerHTML = `
      <label style="display:flex; align-items:center; justify-content:space-between;">
        ${escapeHtml(param.label)}
        <span class="param-tag" style="font-size:9px; padding:1px 5px;">
          ${escapeHtml(param.section || "custom")}
          <span class="remove" data-key="${escapeHtml(param.key)}" title="Delete">×</span>
        </span>
      </label>
      <input type="text" data-key="${escapeHtml(param.key)}" value="${escapeHtml(value)}" placeholder="Enter value...">
    `;
    container.appendChild(group);

    // Autosave for this new input
    const input = group.querySelector("input");
    input.addEventListener("input", () => {
      profileData[param.key] = input.value;
      showAutosave("saving");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          await Bridge.set({ [param.key]: input.value });
          showAutosave("saved");
        } catch (err) {
          toast(`Save failed: ${err.message}`, "error");
        }
      }, 800);
    });

    // Delete button
    group.querySelector(".remove").addEventListener("click", async (e) => {
      const key = e.target.dataset.key;
      if (!confirm(`Delete custom parameter "${param.label}"?`)) return;
      const updated = (profileData.customParams || []).filter(
        (p) => p.key !== key,
      );
      profileData.customParams = updated;
      try {
        await Bridge.set({ customParams: updated });
        await Bridge.remove([key]);
        delete profileData[key];
        renderCustomParams();
        toast("Parameter deleted");
      } catch (err) {
        toast(`Delete failed: ${err.message}`, "error");
      }
    });
  });
}

function setupAddCustomParam() {
  $("#addCustomParamBtn")?.addEventListener("click", () => {
    $("#addParamModal").classList.add("active");
    $("#newParamLabel").value = "";
    $("#newParamLabel").focus();
  });

  $("#confirmAddParam")?.addEventListener("click", async () => {
    const label = $("#newParamLabel").value.trim();
    const section = $("#newParamSection").value;
    if (!label) {
      toast("Enter a label", "error");
      return;
    }

    const key = "custom_" + label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const params = profileData.customParams || [];

    if (params.some((p) => p.key === key)) {
      toast("Parameter already exists", "error");
      return;
    }

    params.push({ key, label, section });
    profileData.customParams = params;

    try {
      await Bridge.set({ customParams: params });
      renderCustomParams();
      $("#addParamModal").classList.remove("active");
      toast(`Added "${label}"`);
    } catch (err) {
      toast(`Failed: ${err.message}`, "error");
    }
  });
}

// ─── Timeline ───
function renderTimeline() {
  const list = $("#timelineList");
  const empty = $("#timelineEmpty");
  if (!list) return;

  const entries = profileData.timelineEntries || [];
  if (entries.length === 0) {
    list.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";

  list.innerHTML = entries
    .map(
      (entry, idx) => `
    <div class="timeline-entry" data-idx="${idx}">
      <div class="timeline-dot ${entry.type === "education" ? "education" : "work"}"></div>
      <div class="timeline-content">
        <h4>${escapeHtml(entry.position || "Untitled Role")}</h4>
        <div class="meta">
          ${escapeHtml(entry.company || "Unknown")} · ${escapeHtml(entry.year || "?")}${entry.endYear ? " – " + escapeHtml(entry.endYear) : " – Present"}
          ${entry.city ? " · " + escapeHtml(entry.city) : ""}${entry.country ? ", " + escapeHtml(entry.country) : ""}
        </div>
        ${entry.description ? `<div class="desc">${escapeHtml(entry.description)}</div>` : ""}
      </div>
      <div class="timeline-actions">
        <button title="Edit" data-action="edit-timeline" data-idx="${idx}">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
        </button>
        <button title="Delete" data-action="del-timeline" data-idx="${idx}">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        </button>
      </div>
    </div>
  `,
    )
    .join("");

  // Attach handlers
  list.querySelectorAll("[data-action='del-timeline']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.idx);
      const entries = profileData.timelineEntries || [];
      const entry = entries[idx];
      if (!confirm(`Delete "${entry?.position || "this entry"}"?`)) return;
      entries.splice(idx, 1);
      profileData.timelineEntries = entries;
      try {
        await Bridge.set({ timelineEntries: entries });
        renderTimeline();
        toast("Timeline entry deleted");
      } catch (err) {
        toast(`Failed: ${err.message}`, "error");
      }
    });
  });

  list.querySelectorAll("[data-action='edit-timeline']").forEach((btn) => {
    btn.addEventListener("click", () =>
      editTimelineEntry(parseInt(btn.dataset.idx)),
    );
  });
}

function editTimelineEntry(idx) {
  const entries = profileData.timelineEntries || [];
  const entry = entries[idx];
  if (!entry) return;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay active";
  overlay.innerHTML = `
    <div class="modal">
      <h3>Edit Timeline Entry</h3>
      <div class="field-group" style="margin-bottom:10px;">
        <label>Position / Title</label>
        <input type="text" id="tlEditPosition" value="${escapeHtml(entry.position || "")}">
      </div>
      <div class="field-group" style="margin-bottom:10px;">
        <label>Company / Institution</label>
        <input type="text" id="tlEditCompany" value="${escapeHtml(entry.company || "")}">
      </div>
      <div class="field-grid" style="margin-bottom:10px;">
        <div class="field-group">
          <label>Start Year</label>
          <input type="text" id="tlEditYear" value="${escapeHtml(entry.year || "")}">
        </div>
        <div class="field-group">
          <label>End Year</label>
          <input type="text" id="tlEditEndYear" value="${escapeHtml(entry.endYear || "")}" placeholder="Present">
        </div>
      </div>
      <div class="field-grid" style="margin-bottom:10px;">
        <div class="field-group">
          <label>City</label>
          <input type="text" id="tlEditCity" value="${escapeHtml(entry.city || "")}">
        </div>
        <div class="field-group">
          <label>Country</label>
          <input type="text" id="tlEditCountry" value="${escapeHtml(entry.country || "")}">
        </div>
      </div>
      <div class="field-group" style="margin-bottom:10px;">
        <label>Description</label>
        <textarea id="tlEditDesc" rows="4">${escapeHtml(entry.description || "")}</textarea>
      </div>
      <div class="field-group" style="margin-bottom:10px;">
        <label>Type</label>
        <select id="tlEditType">
          <option value="work" ${entry.type !== "education" ? "selected" : ""}>Work</option>
          <option value="education" ${entry.type === "education" ? "selected" : ""}>Education</option>
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline btn-sm" id="tlEditCancel">Cancel</button>
        <button class="btn btn-green btn-sm" id="tlEditSave">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay
    .querySelector("#tlEditCancel")
    .addEventListener("click", () => overlay.remove());
  overlay.querySelector("#tlEditSave").addEventListener("click", async () => {
    entries[idx] = {
      ...entry,
      position: overlay.querySelector("#tlEditPosition").value.trim(),
      company: overlay.querySelector("#tlEditCompany").value.trim(),
      year: overlay.querySelector("#tlEditYear").value.trim(),
      endYear: overlay.querySelector("#tlEditEndYear").value.trim(),
      city: overlay.querySelector("#tlEditCity").value.trim(),
      country: overlay.querySelector("#tlEditCountry").value.trim(),
      description: overlay.querySelector("#tlEditDesc").value.trim(),
      type: overlay.querySelector("#tlEditType").value,
    };
    profileData.timelineEntries = entries;
    try {
      await Bridge.set({ timelineEntries: entries });
      renderTimeline();
      overlay.remove();
      toast("Timeline entry updated");
    } catch (err) {
      toast(`Failed: ${err.message}`, "error");
    }
  });
}

function setupTimelineAdd() {
  $("#timelineAddBtn")?.addEventListener("click", () => {
    const entries = profileData.timelineEntries || [];
    entries.unshift({
      id: Date.now().toString(),
      position: "",
      company: "",
      year: new Date().getFullYear().toString(),
      endYear: "",
      city: "",
      country: "",
      description: "",
      type: "work",
    });
    profileData.timelineEntries = entries;
    renderTimeline();
    editTimelineEntry(0);
  });
}

// ─── Tracker ───
const STATUS_COLORS = {
  "not-started": { bg: "#f3f4f6", text: "#6b7280" },
  researching: { bg: "#ede9fe", text: "#7c3aed" },
  "waiting-referral": { bg: "#fef3c7", text: "#d97706" },
  applied: { bg: "#dbeafe", text: "#2563eb" },
  interview: { bg: "#d1fae5", text: "#059669" },
  offer: { bg: "#d1fae5", text: "#047857" },
  rejected: { bg: "#fee2e2", text: "#dc2626" },
};

function renderTracker() {
  const grid = $("#trackerGrid");
  const empty = $("#trackerEmpty");
  const count = $("#trackerCount");
  if (!grid) return;

  const positions = profileData.jobTrackerPositions || [];
  if (positions.length === 0) {
    grid.innerHTML = "";
    if (empty) empty.style.display = "block";
    if (count) count.textContent = "";
    return;
  }

  if (empty) empty.style.display = "none";
  if (count) count.textContent = `(${positions.length})`;

  grid.innerHTML = positions
    .map((pos, idx) => {
      const sc = STATUS_COLORS[pos.status] || STATUS_COLORS["not-started"];
      return `
      <div class="tracker-card">
        <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:6px;">
          <div>
            <div style="font-size:13px; font-weight:600; color:var(--text);">${escapeHtml(pos.title || "Unknown Role")}</div>
            <div style="font-size:12px; color:var(--text-secondary);">${escapeHtml(pos.company || "Unknown")}</div>
          </div>
          <span class="tracker-status" style="background:${sc.bg}; color:${sc.text};">${escapeHtml(pos.status || "unknown")}</span>
        </div>
        <div style="font-size:10px; color:var(--text-muted);">
          ${pos.dateAdded ? "Added: " + new Date(pos.dateAdded).toLocaleDateString() : ""}
          ${pos.dateApplied ? " · Applied: " + new Date(pos.dateApplied).toLocaleDateString() : ""}
        </div>
        ${pos.url ? `<a href="${escapeHtml(pos.url)}" target="_blank" style="font-size:11px; color:var(--purple); display:block; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Open listing →</a>` : ""}
        ${pos.notes ? `<div style="font-size:11px; color:var(--text-secondary); margin-top:6px; background:var(--border-light); padding:6px 8px; border-radius:6px;">${escapeHtml(pos.notes)}</div>` : ""}
        <div style="display:flex; gap:4px; margin-top:8px;">
          <select data-tracker-idx="${idx}" class="tracker-status-select" style="font-size:10px; padding:3px 6px; border:1px solid var(--border); border-radius:4px; background:white;">
            ${Object.keys(STATUS_COLORS)
              .map(
                (s) =>
                  `<option value="${s}" ${pos.status === s ? "selected" : ""}>${s}</option>`,
              )
              .join("")}
          </select>
          <button class="btn btn-danger btn-sm" data-action="del-tracker" data-idx="${idx}" style="font-size:9px; padding:3px 8px;">Delete</button>
        </div>
      </div>
    `;
    })
    .join("");

  // Status change handlers
  grid.querySelectorAll(".tracker-status-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const idx = parseInt(sel.dataset.trackerIdx);
      positions[idx].status = sel.value;
      profileData.jobTrackerPositions = positions;
      try {
        await Bridge.set({ jobTrackerPositions: positions });
        renderTracker();
        toast("Status updated");
      } catch (err) {
        toast(`Failed: ${err.message}`, "error");
      }
    });
  });

  // Delete handlers
  grid.querySelectorAll("[data-action='del-tracker']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.idx);
      if (!confirm(`Delete "${positions[idx]?.title || "this"}" from tracker?`))
        return;
      positions.splice(idx, 1);
      profileData.jobTrackerPositions = positions;
      try {
        await Bridge.set({ jobTrackerPositions: positions });
        renderTracker();
        toast("Application removed");
      } catch (err) {
        toast(`Failed: ${err.message}`, "error");
      }
    });
  });
}

function setupTrackerExport() {
  $("#trackerExportBtn")?.addEventListener("click", () => {
    const positions = profileData.jobTrackerPositions || [];
    if (positions.length === 0) {
      toast("No applications to export", "error");
      return;
    }
    const headers = [
      "Company",
      "Title",
      "Status",
      "Priority",
      "URL",
      "Date Added",
      "Date Applied",
      "Notes",
    ];
    const rows = positions.map((p) =>
      [
        p.company,
        p.title,
        p.status,
        p.priority,
        p.url,
        p.dateAdded,
        p.dateApplied,
        p.notes,
      ].map((v) => `"${(v || "").replace(/"/g, '""')}"`),
    );
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jobpilot-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast("CSV exported");
  });
}

// ─── Learned Responses ───
function renderLearned() {
  const list = $("#learnedList");
  const empty = $("#learnedEmpty");
  const count = $("#learnedCount");
  if (!list) return;

  const learned = profileData.learnedResponses || {};
  const entries = Object.entries(learned);

  if (entries.length === 0) {
    list.innerHTML = "";
    if (empty) empty.style.display = "block";
    if (count) count.textContent = "";
    return;
  }

  if (empty) empty.style.display = "none";
  if (count) count.textContent = `(${entries.length})`;

  list.innerHTML = entries
    .map(
      ([key, value]) => `
    <div class="learned-item">
      <div class="learned-key">${escapeHtml(key)}</div>
      <div class="learned-value">${escapeHtml(typeof value === "string" ? value : JSON.stringify(value))}</div>
      <button class="btn btn-outline btn-sm" data-action="del-learned" data-lkey="${escapeHtml(key)}" style="flex-shrink:0; font-size:9px; padding:3px 8px;">×</button>
    </div>
  `,
    )
    .join("");

  // Delete individual learned response
  list.querySelectorAll("[data-action='del-learned']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const lkey = btn.dataset.lkey;
      delete learned[lkey];
      profileData.learnedResponses = learned;
      try {
        await Bridge.set({ learnedResponses: learned });
        renderLearned();
        toast("Response removed");
      } catch (err) {
        toast(`Failed: ${err.message}`, "error");
      }
    });
  });
}

function setupClearLearned() {
  $("#clearLearnedBtn")?.addEventListener("click", async () => {
    if (!confirm("Clear all learned responses? This cannot be undone.")) return;
    profileData.learnedResponses = {};
    try {
      await Bridge.set({ learnedResponses: {} });
      renderLearned();
      toast("All learned responses cleared");
    } catch (err) {
      toast(`Failed: ${err.message}`, "error");
    }
  });
}

// ─── Languages ───
function setupLanguages() {
  const spokenInput = $("#spokenLanguagesInput");
  const respSelect = $("#responseLanguageSelect");

  spokenInput?.addEventListener("change", async () => {
    const languages = spokenInput.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    profileData.spokenLanguages = languages;
    try {
      await Bridge.set({ spokenLanguages: languages });
      toast("Languages saved");
    } catch (err) {
      toast(`Failed: ${err.message}`, "error");
    }
  });

  respSelect?.addEventListener("change", async () => {
    profileData.responseLanguage = respSelect.value;
    try {
      await Bridge.set({ responseLanguage: respSelect.value });
      toast("Response language saved");
    } catch (err) {
      toast(`Failed: ${err.message}`, "error");
    }
  });
}

// ─── Assistant Tab ───
function addAssistantMessage(text, isUser = false) {
  const container = $("#assistantChatMessages");
  if (!container) return;
  const msg = document.createElement("div");
  msg.style.cssText = isUser
    ? "background:#e0f2fe;border:1px solid #bae6fd;border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.5;color:#333;max-width:90%;align-self:flex-end;"
    : "background:linear-gradient(135deg,#f5f3ff,#ede9fe);border:1px solid #ddd6fe;border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.5;color:#333;max-width:90%;";
  msg.textContent = text;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

async function sendAssistantMessage(text) {
  if (!text.trim()) return;
  addAssistantMessage(text, true);
  try {
    const res = await Bridge.send("aiChat", {
      message: text,
      context: "assistant",
    });
    addAssistantMessage(
      res.reply ||
        res.data ||
        "I received your message. For full AI responses, make sure you have an API key configured in the AI Providers tab.",
    );
  } catch {
    // Fallback static responses for common queries
    const lower = text.toLowerCase();
    if (lower.includes("how") && lower.includes("use")) {
      addAssistantMessage(
        "To use JobPilot AI: 1) Fill in your profile parameters, 2) Add API keys in the AI Providers tab, 3) Navigate to any job application page and the extension will detect form fields and offer to fill them automatically.",
      );
    } else if (
      lower.includes("setup") ||
      lower.includes("set up") ||
      lower.includes("ai")
    ) {
      addAssistantMessage(
        "To set up AI features: Go to the AI Providers tab and add at least one API key (OpenAI, Anthropic, or Google Gemini). Google Gemini has a free tier! Then the extension will use AI for cover letters, field filling, and smart suggestions.",
      );
    } else if (lower.includes("cover letter")) {
      addAssistantMessage(
        "Cover letter tips: 1) Add your CV in the Docs tab, 2) Add context about your career goals, 3) The extension generates tailored cover letters when you're on a job page. It uses premium AI models for best quality.",
      );
    } else if (lower.includes("new") || lower.includes("what")) {
      addAssistantMessage(
        "What's new in v1.1: AI chatbox is always visible, multi-provider support (OpenAI, Claude, Gemini), AI Job Curator with company-specific APIs, career timeline, and the settings page you're using right now!",
      );
    } else {
      addAssistantMessage(
        "I'm currently operating in offline mode. For full AI-powered responses, ensure you have an API key configured in the AI Providers tab and the extension is connected. Try one of the Quick Actions below for common questions!",
      );
    }
  }
}

function checkPendingItems() {
  const card = $("#assistantPendingCard");
  const list = $("#assistantPendingList");
  if (!card || !list) return;

  const missing = [];
  const required = [
    { key: "firstName", label: "First Name" },
    { key: "lastName", label: "Last Name" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "city", label: "Location / City" },
  ];
  const aiKeys = ["openaiKey", "anthropicKey", "googleAiKey"];

  required.forEach((f) => {
    if (!profileData[f.key]) missing.push(`⚠ ${f.label} is empty`);
  });

  const hasAnyKey = aiKeys.some((k) => profileData[k]);
  if (!hasAnyKey) missing.push("⚠ No AI provider API key configured");
  if (
    !profileData.cvContent &&
    !(profileData.cvFiles && profileData.cvFiles.length)
  ) {
    missing.push("⚠ No CV uploaded or pasted");
  }

  if (missing.length === 0) {
    card.style.display = "none";
    return;
  }

  card.style.display = "";
  list.innerHTML = missing
    .map(
      (m) =>
        `<div style="padding:4px 0;border-bottom:1px solid var(--border-light, #f0f0f0);">${escapeHtml(m)}</div>`,
    )
    .join("");
}

function setupAssistant() {
  const sendBtn = $("#assistantChatSend");
  const input = $("#assistantChatInput");

  sendBtn?.addEventListener("click", () => {
    sendAssistantMessage(input.value);
    input.value = "";
  });

  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendAssistantMessage(input.value);
      input.value = "";
    }
  });

  // Quick actions
  $$(".assistant-quick-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      const map = {
        "how-to-use": "How do I use this extension?",
        "setup-ai": "How do I set up AI features?",
        "cover-letter-tips": "Give me cover letter tips",
        "whats-new": "What's new in this version?",
      };
      sendAssistantMessage(map[btn.dataset.action] || btn.textContent);
    });
  });

  // File upload
  const fileInput = $("#assistantFileInput");
  fileInput?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    addAssistantMessage(
      `Attached: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`,
      true,
    );
    if (
      file.type === "text/plain" ||
      file.name.endsWith(".txt") ||
      file.name.endsWith(".rtf")
    ) {
      const reader = new FileReader();
      reader.onload = () => {
        addAssistantMessage(
          `I've received the text from "${file.name}". To use this as context for AI features, paste it in the CV / Context section of the AI Providers tab.`,
        );
      };
      reader.readAsText(file);
    } else {
      addAssistantMessage(
        `I've received "${file.name}". For full PDF/DOCX processing, use the Docs tab to upload your CV, or paste the text content in the AI Providers tab.`,
      );
    }
    e.target.value = "";
  });

  checkPendingItems();
}

// ─── Docs Tab ───
function renderSettingsCvList() {
  const container = $("#settingsCvList");
  const empty = $("#settingsCvEmpty");
  if (!container) return;

  const cvFiles = profileData.cvFiles || [];
  if (!cvFiles.length) {
    container.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";

  container.innerHTML = cvFiles
    .map((cv, idx) => {
      const tags = (cv.tags || [])
        .map(
          (t) =>
            `<span style="display:inline-block;background:#e0f2fe;color:#0369a1;font-size:9px;padding:1px 6px;border-radius:8px;margin-right:3px;">${escapeHtml(t)}</span>`,
        )
        .join("");
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;${cv.isDefault ? "background:rgba(16,185,129,0.06);border-color:#10b981;" : ""}">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0;"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(cv.name)}</div>
        <div style="font-size:10px;color:var(--text-muted);">${cv.isDefault ? "⭐ Default · " : ""}${cv.addedAt ? new Date(cv.addedAt).toLocaleDateString() : ""} ${tags}</div>
      </div>
      <button data-action="default-cv" data-idx="${idx}" style="background:none;border:none;cursor:pointer;padding:4px;color:${cv.isDefault ? "#10b981" : "#999"};" title="Set as default">
        <svg width="14" height="14" fill="${cv.isDefault ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>
      </button>
      <button data-action="delete-cv" data-idx="${idx}" style="background:none;border:none;cursor:pointer;padding:4px;color:#ef4444;" title="Delete">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
      </button>
    </div>`;
    })
    .join("");

  container.querySelectorAll("[data-action='delete-cv']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.idx);
      const files = profileData.cvFiles || [];
      if (!confirm(`Delete "${files[idx]?.name}"?`)) return;
      files.splice(idx, 1);
      profileData.cvFiles = files;
      try {
        await Bridge.set({ cvFiles: files });
        renderSettingsCvList();
        toast("CV deleted");
      } catch (err) {
        toast(`Failed: ${err.message}`, "error");
      }
    });
  });

  container.querySelectorAll("[data-action='default-cv']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.idx);
      const files = profileData.cvFiles || [];
      files.forEach((f, i) => (f.isDefault = i === idx));
      profileData.cvFiles = files;
      try {
        await Bridge.set({ cvFiles: files });
        renderSettingsCvList();
        toast("Default CV updated");
      } catch (err) {
        toast(`Failed: ${err.message}`, "error");
      }
    });
  });
}

function renderSettingsClList() {
  const container = $("#settingsClList");
  const empty = $("#settingsClEmpty");
  if (!container) return;

  const clFiles = profileData.coverLetterFiles || [];
  if (!clFiles.length) {
    container.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";

  container.innerHTML = clFiles
    .map(
      (
        cl,
        idx,
      ) => `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;">
    <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0;"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"/></svg>
    <div style="flex:1;min-width:0;">
      <div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(cl.name)}</div>
      <div style="font-size:10px;color:var(--text-muted);">${cl.addedAt ? new Date(cl.addedAt).toLocaleDateString() : ""}</div>
    </div>
    <button data-action="delete-cl" data-idx="${idx}" style="background:none;border:none;cursor:pointer;padding:4px;color:#ef4444;" title="Delete">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
    </button>
  </div>`,
    )
    .join("");

  container.querySelectorAll("[data-action='delete-cl']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.idx);
      const files = profileData.coverLetterFiles || [];
      if (!confirm(`Delete "${files[idx]?.name}"?`)) return;
      files.splice(idx, 1);
      profileData.coverLetterFiles = files;
      try {
        await Bridge.set({ coverLetterFiles: files });
        renderSettingsClList();
        toast("Cover letter deleted");
      } catch (err) {
        toast(`Failed: ${err.message}`, "error");
      }
    });
  });
}

function renderSettingsCtxDocList() {
  const container = $("#settingsCtxDocList");
  const empty = $("#settingsCtxDocEmpty");
  if (!container) return;

  const docs = profileData.contextDocs || [];
  if (!docs.length) {
    container.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";

  container.innerHTML = docs
    .map(
      (
        doc,
        idx,
      ) => `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;">
    <svg width="16" height="16" fill="none" stroke="var(--purple)" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0;"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"/></svg>
    <div style="flex:1;min-width:0;">
      <div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(doc.name || doc.label || "Context Document")}</div>
      <div style="font-size:10px;color:var(--text-muted);">${doc.addedAt ? new Date(doc.addedAt).toLocaleDateString() : ""} ${doc.type === "text" ? "· Typed" : doc.type === "file" ? "· Uploaded" : ""}</div>
    </div>
    <button data-action="delete-ctx" data-idx="${idx}" style="background:none;border:none;cursor:pointer;padding:4px;color:#ef4444;" title="Delete">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
    </button>
  </div>`,
    )
    .join("");

  container.querySelectorAll("[data-action='delete-ctx']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.idx);
      const docs = profileData.contextDocs || [];
      if (!confirm(`Delete "${docs[idx]?.name || "this document"}"?`)) return;
      docs.splice(idx, 1);
      profileData.contextDocs = docs;
      try {
        await Bridge.set({ contextDocs: docs });
        renderSettingsCtxDocList();
        toast("Document deleted");
      } catch (err) {
        toast(`Failed: ${err.message}`, "error");
      }
    });
  });
}

function renderDocs() {
  renderSettingsCvList();
  renderSettingsClList();
  renderSettingsCtxDocList();
}

function setupDocs() {
  // Add CV
  $("#settingsAddCvBtn")?.addEventListener("click", () => {
    $("#settingsCvFileInput")?.click();
  });
  $("#settingsCvFileInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const files = profileData.cvFiles || [];
    const reader = new FileReader();
    reader.onload = async () => {
      const newCv = {
        name: file.name,
        size: file.size,
        type: file.type,
        addedAt: new Date().toISOString(),
        isDefault: files.length === 0,
        tags: [],
      };
      files.push(newCv);
      profileData.cvFiles = files;
      try {
        await Bridge.set({ cvFiles: files });
        // Store file data in local
        const cvFileData = localData.cvFileData || {};
        cvFileData[file.name] = reader.result;
        localData.cvFileData = cvFileData;
        await Bridge.set({ cvFileData }, "local");
        renderSettingsCvList();
        toast(`CV "${file.name}" added`);
      } catch (err) {
        toast(`Upload failed: ${err.message}`, "error");
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  });

  // Add Cover Letter
  $("#settingsAddClBtn")?.addEventListener("click", () => {
    $("#settingsClFileInput")?.click();
  });
  $("#settingsClFileInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const files = profileData.coverLetterFiles || [];
    const reader = new FileReader();
    reader.onload = async () => {
      files.push({
        name: file.name,
        size: file.size,
        type: file.type,
        addedAt: new Date().toISOString(),
      });
      profileData.coverLetterFiles = files;
      try {
        await Bridge.set({ coverLetterFiles: files });
        const clFileData = localData.clFileData || {};
        clFileData[file.name] = reader.result;
        localData.clFileData = clFileData;
        await Bridge.set({ clFileData }, "local");
        renderSettingsClList();
        toast(`Cover letter "${file.name}" added`);
      } catch (err) {
        toast(`Upload failed: ${err.message}`, "error");
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  });

  // Add Context Doc (file)
  $("#settingsAddCtxDocBtn")?.addEventListener("click", () => {
    $("#settingsCtxDocFileInput")?.click();
  });
  $("#settingsCtxDocFileInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const docs = profileData.contextDocs || [];
    const reader = new FileReader();
    reader.onload = async () => {
      docs.push({
        name: file.name,
        type: "file",
        content: reader.result.substring(0, 8000),
        addedAt: new Date().toISOString(),
      });
      profileData.contextDocs = docs;
      try {
        await Bridge.set({ contextDocs: docs });
        renderSettingsCtxDocList();
        toast(`Context doc "${file.name}" added`);
      } catch (err) {
        toast(`Upload failed: ${err.message}`, "error");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  // Save context doc from textarea
  $("#settingsSaveCtxDocTextBtn")?.addEventListener("click", async () => {
    const text = $("#settingsCtxDocText")?.value?.trim();
    if (!text) {
      toast("Nothing to save", "error");
      return;
    }
    const docs = profileData.contextDocs || [];
    docs.push({
      name: `Context (${new Date().toLocaleDateString()})`,
      type: "text",
      content: text.substring(0, 8000),
      addedAt: new Date().toISOString(),
    });
    profileData.contextDocs = docs;
    try {
      await Bridge.set({ contextDocs: docs });
      renderSettingsCtxDocList();
      $("#settingsCtxDocText").value = "";
      toast("Context doc saved");
    } catch (err) {
      toast(`Save failed: ${err.message}`, "error");
    }
  });

  renderDocs();
}

// ─── Jobs4U Tab (state) ───
let j4uCurrentView = "all"; // "all" | "saved" | "dismissed"
let j4uSortNewFirst = true; // Default: new (green) jobs on top
let j4uSavedJobs = [];
let j4uDismissedUrls = [];

function isJ4uSaved(url) {
  return j4uSavedJobs.some((j) => j.url === url);
}
function isJ4uDismissed(url) {
  return j4uDismissedUrls.includes(url);
}
async function j4uSaveJob(job) {
  if (!job.url || isJ4uSaved(job.url)) return;
  j4uSavedJobs.push({ ...job, savedAt: new Date().toISOString() });
  await Bridge.set({ savedJobs: j4uSavedJobs }, "local");
}
async function j4uUnsaveJob(url) {
  j4uSavedJobs = j4uSavedJobs.filter((j) => j.url !== url);
  await Bridge.set({ savedJobs: j4uSavedJobs }, "local");
}
async function j4uDismissJob(url) {
  if (!url || isJ4uDismissed(url)) return;
  j4uDismissedUrls.push(url);
  j4uSavedJobs = j4uSavedJobs.filter((j) => j.url !== url);
  await Bridge.set(
    { dismissedJobUrls: j4uDismissedUrls, savedJobs: j4uSavedJobs },
    "local",
  );
}
async function j4uUndismissJob(url) {
  j4uDismissedUrls = j4uDismissedUrls.filter((u) => u !== url);
  await Bridge.set({ dismissedJobUrls: j4uDismissedUrls }, "local");
}

// ─── Jobs4U Tab ───
function renderJobs4u() {
  const container = $("#settingsJobs4uList");
  const count = $("#settingsJobs4uCount");
  const empty = $("#settingsJobs4uEmpty");
  const lastUpdated = $("#settingsJobs4uLastUpdated");
  if (!container) return;

  // Load saved/dismissed state from local storage
  j4uSavedJobs = localData.savedJobs || [];
  j4uDismissedUrls = localData.dismissedJobUrls || [];

  const allJobs = profileData.scraperResults || localData.scraperResults || [];
  const search = ($("#settingsJobs4uSearch")?.value || "").toLowerCase();

  // ── View Tabs ──
  let viewTabsEl = document.getElementById("j4uViewTabs");
  if (!viewTabsEl) {
    viewTabsEl = document.createElement("div");
    viewTabsEl.id = "j4uViewTabs";
    viewTabsEl.style.cssText = "display:flex;gap:4px;margin-bottom:12px;";
    container.parentElement.insertBefore(viewTabsEl, container);
  }
  const allCount = allJobs.filter((j) => !isJ4uDismissed(j.url)).length;
  const savedCount = j4uSavedJobs.length;
  const dismissedCount = j4uDismissedUrls.length;
  viewTabsEl.innerHTML = ["all", "saved", "dismissed"]
    .map((v) => {
      const active = j4uCurrentView === v;
      const label =
        v === "all"
          ? `All (${allCount})`
          : v === "saved"
            ? `Saved (${savedCount})`
            : `Dismissed (${dismissedCount})`;
      return `<button data-j4uview="${v}" style="padding:4px 10px;border-radius:6px;font-size:11px;font-weight:${active ? "600" : "400"};cursor:pointer;border:1px solid ${active ? "#8b5cf6" : "#e2e8f0"};background:${active ? "#f5f3ff" : "#fff"};color:${active ? "#7c3aed" : "#666"};transition:all 0.15s;">${label}</button>`;
    })
    .join("");
  viewTabsEl.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      j4uCurrentView = btn.dataset.j4uview;
      renderJobs4u();
    });
  });

  // ── Sort toggle + Delete bar ──
  let sortBarEl = document.getElementById("j4uSortBar");
  if (!sortBarEl) {
    sortBarEl = document.createElement("div");
    sortBarEl.id = "j4uSortBar";
    sortBarEl.style.cssText =
      "display:flex;gap:6px;margin-bottom:12px;align-items:center;";
    container.parentElement.insertBefore(sortBarEl, container);
  }
  sortBarEl.innerHTML = `
    <button id="j4uSortToggle" style="padding:4px 10px;border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;border:1px solid ${j4uSortNewFirst ? "#10b981" : "#9ca3af"};background:${j4uSortNewFirst ? "#ecfdf5" : "#f9fafb"};color:${j4uSortNewFirst ? "#059669" : "#6b7280"};white-space:nowrap;display:inline-flex;align-items:center;gap:3px;transition:all 0.15s;">${j4uSortNewFirst ? "New ↑" : "Old ↑"}</button>
    <button id="j4uDeleteFiltered" style="padding:4px 10px;border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;border:1px solid #e0e0e0;background:#fff;color:#dc2626;white-space:nowrap;display:inline-flex;align-items:center;gap:3px;transition:all 0.15s;">Delete Visible</button>
  `;
  sortBarEl.querySelector("#j4uSortToggle").addEventListener("click", () => {
    j4uSortNewFirst = !j4uSortNewFirst;
    renderJobs4u();
  });
  sortBarEl
    .querySelector("#j4uDeleteFiltered")
    .addEventListener("click", async () => {
      if (!displayJobs.length) return;
      if (
        !confirm(
          "Delete " +
            displayJobs.length +
            " visible job(s)? This cannot be undone.",
        )
      )
        return;

      const urlsToDelete = new Set(displayJobs.map((j) => j.url));
      if (j4uCurrentView === "saved") {
        j4uSavedJobs = j4uSavedJobs.filter((j) => !urlsToDelete.has(j.url));
        await Bridge.send("set", {
          key: "savedJobs",
          value: j4uSavedJobs,
          area: "local",
        });
      } else if (j4uCurrentView === "dismissed") {
        j4uDismissedUrls = j4uDismissedUrls.filter((u) => !urlsToDelete.has(u));
        await Bridge.send("set", {
          key: "dismissedJobUrls",
          value: j4uDismissedUrls,
          area: "local",
        });
      } else {
        const stored = localData.scraperResults || [];
        localData.scraperResults = stored.filter(
          (j) => !urlsToDelete.has(j.url),
        );
        await Bridge.send("set", {
          key: "scraperResults",
          value: localData.scraperResults,
          area: "local",
        });
      }
      renderJobs4u();
    });

  // ── Filter by view ──
  let displayJobs;
  if (j4uCurrentView === "saved") {
    displayJobs = j4uSavedJobs;
  } else if (j4uCurrentView === "dismissed") {
    displayJobs = allJobs.filter((j) => isJ4uDismissed(j.url));
  } else {
    displayJobs = allJobs.filter((j) => !isJ4uDismissed(j.url));
  }

  // Search filter
  if (search) {
    displayJobs = displayJobs.filter((j) => {
      const text =
        `${j.title} ${j.company} ${j.location} ${j.aiReason || ""}`.toLowerCase();
      return text.includes(search);
    });
  }

  // Sort
  displayJobs = [...displayJobs].sort((a, b) => {
    // Career-page placeholders always at the bottom
    const aCareer = a.source === "career-page" ? 1 : 0;
    const bCareer = b.source === "career-page" ? 1 : 0;
    if (aCareer !== bCareer) return aCareer - bCareer;
    // New vs Existing (green on top when j4uSortNewFirst)
    const aNew = a._isNew ? 1 : 0;
    const bNew = b._isNew ? 1 : 0;
    if (aNew !== bNew) return j4uSortNewFirst ? bNew - aNew : aNew - bNew;
    const aTarget = a.isTargetCompany !== false ? 1 : 0;
    const bTarget = b.isTargetCompany !== false ? 1 : 0;
    if (aTarget !== bTarget) return bTarget - aTarget;
    const pWeight = { High: 3, Med: 2, Low: 1 };
    const aP = pWeight[a.priority] || 2;
    const bP = pWeight[b.priority] || 2;
    if (aP !== bP) return bP - aP;
    return 0;
  });

  if (count)
    count.textContent = `${displayJobs.length} job${displayJobs.length !== 1 ? "s" : ""}`;

  if (!displayJobs.length) {
    if (empty) empty.style.display = "block";
    container.querySelectorAll(".job-card-item").forEach((el) => el.remove());
    return;
  }
  if (empty) empty.style.display = "none";

  container.innerHTML = displayJobs
    .map((job) => {
      const isNewJob = !!job._isNew;
      const isSaved = isJ4uSaved(job.url);
      const isCareerPage = job.source === "career-page";
      const cardBg = isNewJob ? "#f0fdf4" : "#f8f9fa";
      const cardBorder = isNewJob ? "#a7f3d0" : "#e5e7eb";
      const newBorderLeft = isNewJob ? "border-left:3px solid #10b981;" : "";

      // Age calculation
      let ageStr = "";
      if (job.firstSeenAt) {
        const d = Math.floor(
          (Date.now() - new Date(job.firstSeenAt).getTime()) / 86400000,
        );
        ageStr = d < 1 ? "Today" : d === 1 ? "1d" : d + "d";
      }

      return `<div class="job-card-item" style="padding:14px;border:1px solid ${cardBorder};border-radius:12px;display:flex;flex-direction:column;justify-content:space-between;background:${cardBg};transition:all 0.15s;height:100%;box-sizing:border-box;${newBorderLeft}" onmouseover="this.style.borderColor='#8b5cf6'" onmouseout="this.style.borderColor='${cardBorder}'">
      <div>
        <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:6px;">
          <div style="flex:1;min-width:0;padding-right:8px;">
            <div style="font-size:13px;font-weight:600;color:var(--text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;cursor:pointer;" onclick="window.open('${(job.url || "").replace(/'/g, "\\'")}','_blank')">${escapeHtml(job.title || "Unknown Role")}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:3px;">${escapeHtml(job.company || "Unknown")}${job.location ? " · " + escapeHtml(job.location).substring(0, 30) : ""}${job.yearsRequired !== undefined ? " · Exp: " + escapeHtml(String(job.yearsRequired)) : ""}</div>
          </div>
          <div style="display:flex;gap:3px;flex-shrink:0;">
            ${
              j4uCurrentView === "dismissed"
                ? `<button class="j4u-undismiss-btn" data-url="${(job.url || "").replace(/"/g, "&quot;")}" style="width:24px;height:24px;border:1px solid #e0e0e0;border-radius:6px;background:#fff;color:#666;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="Restore">↩</button>`
                : j4uCurrentView === "saved"
                  ? `<button class="j4u-remove-saved-btn" data-url="${(job.url || "").replace(/"/g, "&quot;")}" style="width:24px;height:24px;border:1px solid #fecaca;border-radius:6px;background:#fef2f2;color:#dc2626;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="Remove from saved">✕</button>`
                  : `<button class="j4u-save-btn" data-url="${(job.url || "").replace(/"/g, "&quot;")}" data-job='${JSON.stringify(job).replace(/'/g, "&#39;")}' style="width:24px;height:24px;border:1px solid ${isSaved ? "#8b5cf6" : "#e0e0e0"};border-radius:6px;background:${isSaved ? "#f5f3ff" : "#fff"};color:${isSaved ? "#8b5cf6" : "#ccc"};font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="${isSaved ? "Unsave" : "Save"}">${isSaved ? "★" : "☆"}</button>
                   <button class="j4u-dismiss-btn" data-url="${(job.url || "").replace(/"/g, "&quot;")}" style="width:24px;height:24px;border:1px solid #e0e0e0;border-radius:6px;background:#fff;color:#999;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="Dismiss">✕</button>`
            }
          </div>
        </div>
        ${job.aiReason ? `<div style="font-size:10px;color:#8b5cf6;line-height:1.4;margin-bottom:4px;">${escapeHtml(job.aiReason)}</div>` : ""}
        <div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:8px;">
          ${job.source ? `<span style="font-size:9px;padding:2px 6px;border-radius:8px;background:#f3f4f6;color:#4b5563;text-transform:uppercase;">${escapeHtml(job.source)}</span>` : ""}
          ${
            job.seniority
              ? (() => {
                  const s = job.seniority;
                  const hi = s === "Director+" || s === "Staff+";
                  const mid = s === "Senior" || s === "Manager";
                  return `<span style="font-size:9px;padding:2px 6px;border-radius:8px;background:${hi ? "#ede9fe" : mid ? "#d1fae5" : "#f3f4f6"};color:${hi ? "#7c3aed" : mid ? "#065f46" : "#374151"};border:1px solid ${hi ? "#c4b5fd" : mid ? "#6ee7b7" : "#e5e7eb"};font-weight:500;">${s}</span>`;
                })()
              : ""
          }
          ${job.priority ? `<span style="font-size:9px;padding:2px 6px;border-radius:8px;color:white;background:${job.priority === "High" ? "#10b981" : job.priority === "Med" ? "#8b5cf6" : "#6b7280"};">${escapeHtml(job.priority)}</span>` : ""}
          ${job.isTargetCompany !== false ? `<span style="font-size:9px;padding:2px 6px;border-radius:8px;background:#8b5cf6;color:white;">Target</span>` : `<span style="font-size:9px;padding:2px 6px;border-radius:8px;background:#6b7280;color:white;">Non-Target</span>`}
          ${job.live === false ? `<span style="font-size:9px;padding:2px 6px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;color:#dc2626;">⚠ Dead Link</span>` : ""}
          ${isNewJob ? `<span style="font-size:9px;padding:2px 6px;border-radius:8px;background:#d1fae5;border:1px solid #6ee7b7;color:#065f46;font-weight:600;">✦ New</span>` : ""}
          ${ageStr ? `<span style="font-size:8px;color:#b0b0b0;">${ageStr}</span>` : ""}
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        ${job.url ? `<a href="${escapeHtml(job.url)}" target="_blank" rel="noopener" style="flex:1;padding:6px 0;background:${job.live === false ? "#dc2626" : job.isTargetCompany !== false ? "#10b981" : "#6b7280"};color:#fff;border:none;border-radius:8px;font-size:11px;font-weight:500;cursor:pointer;text-decoration:none;text-align:center;display:block;${job.live === false ? "opacity:0.7;" : ""}">${job.live === false ? "Check" : "Apply"}</a>` : ""}
        ${!isCareerPage && j4uCurrentView !== "dismissed" && j4uCurrentView !== "saved" ? `<button class="j4u-track-btn" data-company="${(job.company || "").replace(/"/g, "&quot;")}" data-title="${(job.title || "").replace(/"/g, "&quot;")}" data-url="${(job.url || "").replace(/"/g, "&quot;")}" style="padding:6px 12px;background:#f3f4f6;color:#333;border:1px solid #e0e0e0;border-radius:8px;font-size:10px;cursor:pointer;">Track</button>` : ""}
      </div>
    </div>`;
    })
    .join("");

  // ── Attach event handlers ──
  container.querySelectorAll(".j4u-save-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const url = btn.dataset.url;
      if (isJ4uSaved(url)) {
        await j4uUnsaveJob(url);
        if (j4uCurrentView === "saved") {
          renderJobs4u();
          return;
        }
        btn.textContent = "☆";
        btn.style.color = "#ccc";
        btn.style.borderColor = "#e0e0e0";
        btn.style.background = "#fff";
      } else {
        try {
          const job = JSON.parse(btn.dataset.job.replace(/&#39;/g, "'"));
          await j4uSaveJob(job);
          btn.textContent = "★";
          btn.style.color = "#8b5cf6";
          btn.style.borderColor = "#8b5cf6";
          btn.style.background = "#f5f3ff";
        } catch (err) {
          console.error("[J4U] Save error:", err);
        }
      }
    });
  });
  container.querySelectorAll(".j4u-dismiss-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await j4uDismissJob(btn.dataset.url);
      renderJobs4u();
    });
  });
  container.querySelectorAll(".j4u-undismiss-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await j4uUndismissJob(btn.dataset.url);
      renderJobs4u();
    });
  });
  container.querySelectorAll(".j4u-remove-saved-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await j4uUnsaveJob(btn.dataset.url);
      renderJobs4u();
    });
  });
  container.querySelectorAll(".j4u-track-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const data = await Bridge.get(["trackedPositions"], "local");
      const positions = data.trackedPositions || [];
      positions.push({
        id: Date.now().toString(),
        company: btn.dataset.company,
        title: btn.dataset.title,
        url: btn.dataset.url,
        status: "researching",
        priority: "medium",
        addedAt: new Date().toISOString(),
      });
      await Bridge.set({ trackedPositions: positions }, "local");
      btn.textContent = "✓ Tracked";
      btn.disabled = true;
      btn.style.background = "#10b981";
      btn.style.color = "#fff";
      btn.style.border = "1px solid #10b981";
    });
  });

  if (lastUpdated && (profileData.scraperLastRun || localData.scraperLastRun)) {
    const ts = profileData.scraperLastRun || localData.scraperLastRun;
    lastUpdated.textContent = `Last updated: ${new Date(ts).toLocaleString()} · `;
  }
}

function renderFilters() {
  const container = $("#settingsFiltersList");
  if (!container) return;
  const filters = profileData.scraperConfig || {};
  if (!Object.keys(filters).length) {
    container.innerHTML =
      '<p style="color:var(--text-muted);">No filters configured yet. Use "Set Up with AI" to get started.</p>';
    return;
  }
  const items = [];
  if (filters.queries?.length)
    items.push(
      `<strong>Roles:</strong> ${filters.queries.map(escapeHtml).join(", ")}`,
    );
  if (filters.locations?.length)
    items.push(
      `<strong>Locations:</strong> ${filters.locations.map(escapeHtml).join(", ")}`,
    );
  if (filters.targetCompanies?.length)
    items.push(
      `<strong>Companies:</strong> ${filters.targetCompanies.map(escapeHtml).join(", ")}`,
    );
  if (filters.targetRoles?.length)
    items.push(
      `<strong>Keywords:</strong> ${filters.targetRoles.map(escapeHtml).join(", ")}`,
    );
  if (filters.maxExperience)
    items.push(
      `<strong>Experience:</strong> ${escapeHtml(filters.maxExperience)}`,
    );
  container.innerHTML = items.length
    ? items
        .map(
          (i) =>
            `<div style="padding:4px 0;border-bottom:1px solid var(--border-light, #f0f0f0);">${i}</div>`,
        )
        .join("")
    : '<p style="color:var(--text-muted);">No filters configured yet.</p>';
}

function addCalibratorMessage(text, isUser = false) {
  const container = $("#settingsCalibratorMessages");
  if (!container) return;
  const msg = document.createElement("div");
  msg.style.cssText = isUser
    ? "background:#e0f2fe;border:1px solid #bae6fd;border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.5;color:#333;max-width:90%;align-self:flex-end;"
    : "background:linear-gradient(135deg,#f5f3ff,#ede9fe);border:1px solid #ddd6fe;border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.5;color:#333;max-width:90%;";
  msg.textContent = text;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function setupJobs4u() {
  // Search
  $("#settingsJobs4uSearch")?.addEventListener("input", () => renderJobs4u());

  // Frequency
  const freq = $("#settingsJobs4uFrequency");
  if (freq && profileData.scraperFrequency)
    freq.value = profileData.scraperFrequency;
  freq?.addEventListener("change", async () => {
    profileData.scraperFrequency = parseInt(freq.value) || 0;
    try {
      await Bridge.set("sync", {
        scraperFrequency: profileData.scraperFrequency,
      });
      toast("Scrape frequency updated");
    } catch (err) {
      toast(`Failed: ${err.message}`, "error");
    }
  });

  // Refresh — trigger actual scrape via background.js
  $("#settingsJobs4uRefreshBtn")?.addEventListener("click", async () => {
    const btn = $("#settingsJobs4uRefreshBtn");
    const container = $("#settingsJobs4uList");
    btn.disabled = true;

    // ── Progress UI (mirrors popup's progress display) ──
    const STEPS = [
      { key: "Preparing", label: "Preparing" },
      { key: "Scraping", label: "Scraping" },
      { key: "Filtering", label: "Merging" },
      { key: "Saving", label: "Saving" },
    ];
    const scrapeStart = Date.now();
    let lastPercent = 0;

    function elapsed() {
      const s = Math.floor((Date.now() - scrapeStart) / 1000);
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
    }

    function buildProgressHTML(stepIdx, detail, percent) {
      if (percent != null) lastPercent = percent;
      else if (lastPercent < 95) {
        const ceiling = stepIdx <= 1 ? 64 : stepIdx === 2 ? 91 : 99;
        if (lastPercent < ceiling)
          lastPercent = Math.min(lastPercent + 0.4, ceiling);
      }
      const pct = Math.round(lastPercent);

      const stepsHTML = STEPS.map((s, i) => {
        let color, bg, border;
        if (i < stepIdx) {
          color = "#10b981";
          bg = "#ecfdf5";
          border = "#10b981";
        } else if (i === stepIdx) {
          color = "#8b5cf6";
          bg = "#f5f3ff";
          border = "#8b5cf6";
        } else {
          color = "#cbd5e1";
          bg = "#f8fafc";
          border = "#e2e8f0";
        }
        const check =
          i < stepIdx
            ? '<svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>'
            : s.key.charAt(0);
        return `<div style="display:flex;flex-direction:column;align-items:center;flex:1;opacity:${i > stepIdx ? 0.6 : 1};">
          <div style="width:22px;height:22px;border-radius:50%;background:${bg};border:1.5px solid ${border};display:flex;align-items:center;justify-content:center;font-size:10px;color:${color};font-weight:600;">${check}</div>
          <span style="font-size:8px;margin-top:3px;color:${color};font-weight:${i === stepIdx ? 600 : 400};white-space:nowrap;">${s.label}</span>
        </div>`;
      }).join(
        '<div style="flex:0 0 auto;height:1.5px;width:16px;background:#e2e8f0;margin-top:11px;"></div>',
      );

      return `<div style="padding:24px 16px;text-align:center;">
        <div style="display:flex;align-items:flex-start;justify-content:center;margin-bottom:14px;">${stepsHTML}</div>
        <div style="background:#f1f5f9;border-radius:6px;height:6px;overflow:hidden;margin-bottom:6px;">
          <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#8b5cf6,#7c3aed);border-radius:6px;transition:width 0.4s ease;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-size:9px;color:#64748b;font-weight:500;">${pct}%</span>
          <span style="font-size:9px;color:#94a3b8;">⏱ ${elapsed()}</span>
        </div>
        <div style="font-size:10px;color:#8b5cf6;font-weight:500;">${detail || "Starting..."}</div>
      </div>`;
    }

    container.innerHTML = buildProgressHTML(0, "Preparing scraper...", 5);

    // Tick timer every 2s for elapsed time
    const tickInterval = setInterval(() => {
      // Don't overwrite if already done
      if (!btn.disabled) {
        clearInterval(tickInterval);
        return;
      }
      container.innerHTML = buildProgressHTML(_lastStep, _lastDetail, null);
    }, 2000);

    let _lastStep = 0;
    let _lastDetail = "Preparing...";

    try {
      // Trigger the actual scrape via background.js Bridge
      await Bridge.send("triggerScrape");

      // Poll for progress
      let done = false;
      let pollCount = 0;
      const maxPolls = 300; // 5 minutes max (300 * 1000ms)
      while (!done && pollCount < maxPolls) {
        await new Promise((r) => setTimeout(r, 1000));
        pollCount++;
        try {
          const res = await Bridge.send("getScrapeProgress");
          const prog = res.data;
          if (!prog) continue;

          if (prog.status === "done") {
            done = true;
            container.innerHTML = buildProgressHTML(3, "Done!", 100);
          } else if (prog.status === "error") {
            done = true;
            throw new Error(prog.detail || "Scrape failed");
          } else {
            _lastStep = prog.step || 0;
            _lastDetail = prog.detail || "Working...";
            container.innerHTML = buildProgressHTML(
              _lastStep,
              _lastDetail,
              prog.percent,
            );
          }
        } catch (pollErr) {
          // Bridge timeout during poll — keep trying
          if (pollCount > 10) {
            done = true;
            throw pollErr;
          }
        }
      }

      // Reload fresh data from storage
      await new Promise((r) => setTimeout(r, 500));
      const data = await Bridge.getAll("sync");
      const local = await Bridge.getAll("local");
      profileData = { ...profileData, ...data };
      localData = { ...localData, ...local };
      renderJobs4u();
      toast("Scrape complete! Jobs refreshed.");
    } catch (err) {
      // Fallback: just reload from storage
      try {
        const data = await Bridge.getAll("sync");
        const local = await Bridge.getAll("local");
        profileData = { ...profileData, ...data };
        localData = { ...localData, ...local };
        renderJobs4u();
      } catch (_) {}
      toast(`Scrape error: ${err.message}`, "error");
    }
    clearInterval(tickInterval);
    btn.disabled = false;
    btn.innerHTML = `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Update`;
  });

  // Calibrator modal
  $("#settingsJobs4uCalibrateBtn")?.addEventListener("click", () => {
    $("#settingsCalibratorModal")?.classList.add("active");
  });
  $("#settingsCalibratorClose")?.addEventListener("click", () => {
    $("#settingsCalibratorModal")?.classList.remove("active");
  });
  $("#settingsCalibratorModal")?.addEventListener("click", (e) => {
    if (e.target.id === "settingsCalibratorModal") {
      e.target.classList.remove("active");
    }
  });

  // Calibrator chat
  const calSend = $("#settingsCalibratorSend");
  const calInput = $("#settingsCalibratorInput");
  const calSendHandler = async () => {
    const text = calInput?.value?.trim();
    if (!text) return;
    addCalibratorMessage(text, true);
    calInput.value = "";
    try {
      const res = await Bridge.send("aiChat", {
        message: text,
        context: "calibrator",
      });
      addCalibratorMessage(
        res.reply || res.data || "Filters updated based on your input.",
      );
    } catch {
      addCalibratorMessage(
        "AI calibration requires a connected extension with API keys configured. You can manually set filters or try connecting again.",
      );
    }
  };
  calSend?.addEventListener("click", calSendHandler);
  calInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      calSendHandler();
    }
  });

  // Filters modal
  $("#settingsJobs4uFiltersBtn")?.addEventListener("click", async () => {
    const data = await Bridge.getAll("sync");
    const config = data.scraperConfig || {};

    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:10000; display:flex; align-items:center; justify-content:center; padding:16px;";

    const form = document.createElement("div");
    form.style.cssText =
      "background:#fff; border-radius:12px; padding:16px; width:100%; max-width:340px; box-shadow:0 8px 32px rgba(0,0,0,0.15); max-height:90vh; overflow-y:auto;";
    form.innerHTML = `
      <div style="font-size:13px; font-weight:600; color:#7c3aed; margin-bottom:12px;">Edit Job Filters</div>
      <label style="display:block; font-size:11px; font-weight:500; color:#555; margin-bottom:3px;">Job Roles</label>
      <input id="j4uEditRoles" type="text" value="${(config.queries || []).join(", ")}" placeholder="e.g. Software Engineer, PM" style="width:100%; padding:7px 8px; border:1px solid #e0e0e0; border-radius:6px; font-size:11px; box-sizing:border-box; margin-bottom:8px; outline:none;" />
      <label style="display:block; font-size:11px; font-weight:500; color:#555; margin-bottom:3px;">Locations</label>
      <input id="j4uEditLocations" type="text" value="${(config.locations || []).join(", ")}" placeholder="e.g. London, Remote" style="width:100%; padding:7px 8px; border:1px solid #e0e0e0; border-radius:6px; font-size:11px; box-sizing:border-box; margin-bottom:8px; outline:none;" />
      <label style="display:block; font-size:11px; font-weight:500; color:#555; margin-bottom:3px;">Include Keywords</label>
      <input id="j4uEditInclude" type="text" value="${(config.targetRoles || []).join(", ")}" placeholder="e.g. React, backend" style="width:100%; padding:7px 8px; border:1px solid #e0e0e0; border-radius:6px; font-size:11px; box-sizing:border-box; margin-bottom:8px; outline:none;" />
      <label style="display:block; font-size:11px; font-weight:500; color:#555; margin-bottom:3px;">Exclude Keywords</label>
      <input id="j4uEditExclude" type="text" value="${(config.excludeRoles || []).join(", ")}" placeholder="e.g. Senior, Staff" style="width:100%; padding:7px 8px; border:1px solid #e0e0e0; border-radius:6px; font-size:11px; box-sizing:border-box; margin-bottom:8px; outline:none;" />
      <label style="display:block; font-size:11px; font-weight:500; color:#555; margin-bottom:3px;">Languages Spoken</label>
      <input id="j4uEditLanguages" type="text" value="${(config.languages || []).join(", ")}" placeholder="e.g. English, Portuguese, Spanish" style="width:100%; padding:7px 8px; border:1px solid #e0e0e0; border-radius:6px; font-size:11px; box-sizing:border-box; margin-bottom:8px; outline:none;" />
      <label style="display:block; font-size:11px; font-weight:500; color:#555; margin-bottom:3px;">Target Companies</label>
      <input id="j4uEditCompanies" type="text" value="${(config.targetCompanies || []).join(", ")}" placeholder="e.g. Google, Stripe, Figma" style="width:100%; padding:7px 8px; border:1px solid #e0e0e0; border-radius:6px; font-size:11px; box-sizing:border-box; margin-bottom:8px; outline:none;" />
        <div style="display:flex; align-items:center; gap:6px; margin-bottom: 12px;">
          <input type="checkbox" id="j4uScrapeNonTarget" ${config.scrapeNonTarget !== false ? "checked" : ""} />
          <label for="j4uScrapeNonTarget" style="font-size:11px; font-weight:500; color:#555;cursor:pointer;">Include Non-Target Companies</label>
        </div>
      <label style="display:block; font-size:11px; font-weight:500; color:#555; margin-bottom:3px;">Max Experience (years)</label>
      <input id="j4uEditMaxExp" type="number" value="${config.maxExperience || ""}" placeholder="5" style="width:80px; padding:7px 8px; border:1px solid #e0e0e0; border-radius:6px; font-size:11px; box-sizing:border-box; margin-bottom:12px; outline:none;" />
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button id="j4uEditCancel" style="padding:6px 14px; border:1px solid #ddd; border-radius:6px; background:#fff; color:#666; font-size:11px; cursor:pointer;">Cancel</button>
        <button id="j4uEditSave" style="padding:6px 14px; border:none; border-radius:6px; background:linear-gradient(135deg,#8b5cf6,#7c3aed); color:#fff; font-size:11px; font-weight:500; cursor:pointer;">Save</button>
      </div>
    `;

    overlay.appendChild(form);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    form
      .querySelector("#j4uEditCancel")
      .addEventListener("click", () => overlay.remove());
    form.querySelector("#j4uEditSave").addEventListener("click", async () => {
      const split = (id) =>
        form
          .querySelector(id)
          .value.split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      const newConfig = {
        queries: split("#j4uEditRoles"),
        locations: split("#j4uEditLocations"),
        targetRoles: split("#j4uEditInclude"),
        excludeRoles: split("#j4uEditExclude"),
        languages: split("#j4uEditLanguages"),
        targetCompanies: split("#j4uEditCompanies"),
        scrapeNonTarget: form.querySelector("#j4uScrapeNonTarget").checked,
        maxExperience:
          parseInt(form.querySelector("#j4uEditMaxExp").value) || null,
      };
      profileData.scraperConfig = newConfig;
      await Bridge.set("sync", { scraperConfig: newConfig });

      toast("Filters updated!", "success");
      renderFilters();
      overlay.remove();
    });
  });

  renderJobs4u();
}

// ─── Export / Import ───
function setupExportImport() {
  $("#exportBtn")?.addEventListener("click", async () => {
    try {
      const data = await Bridge.getAll("sync");
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `jobpilot-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("Settings exported");
    } catch (err) {
      toast(`Export failed: ${err.message}`, "error");
    }
  });

  $("#importBtn")?.addEventListener("click", () => {
    $("#importFileInput").click();
  });

  $("#importFileInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (
        !confirm(
          `Import ${Object.keys(data).length} settings? This will overwrite current values.`,
        )
      )
        return;
      await Bridge.set(data);
      profileData = { ...profileData, ...data };
      populateUI();
      toast("Settings imported successfully");
    } catch (err) {
      toast(`Import failed: ${err.message}`, "error");
    }
    e.target.value = "";
  });
}

// ─── Refresh / Save All ───
function setupHeaderButtons() {
  $("#refreshBtn")?.addEventListener("click", async () => {
    const btn = $("#refreshBtn");
    btn.disabled = true;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" style="animation: spin 1s linear infinite"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="40 60" stroke-linecap="round"/></svg> Syncing...`;
    await loadAllData();
    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Sync`;
  });

  $("#saveAllBtn")?.addEventListener("click", async () => {
    const btn = $("#saveAllBtn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    try {
      // Collect all field values
      const data = {};
      $$("[data-key]").forEach((el) => {
        data[el.dataset.key] = el.value;
      });

      // Toggles
      $$("[data-toggle]").forEach((el) => {
        data[el.dataset.toggle] = el.classList.contains("active");
      });

      // fullName
      data.fullName = `${data.firstName || ""} ${data.lastName || ""}`.trim();

      // Save CV to local too
      if (data.cvContent) {
        await Bridge.set({ cvContent: data.cvContent }, "local");
        data.cvContent = data.cvContent.substring(0, 7000); // Truncate for sync
      }

      await Bridge.set(data);
      toast("All settings saved!");
    } catch (err) {
      toast(`Save failed: ${err.message}`, "error");
    }

    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> Save All`;
  });
}

// ─── Polling for changes (live sync from extension) ───
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  // Poll every 5 seconds for changes
  pollTimer = setInterval(async () => {
    if (!Bridge.connected) return;
    try {
      const freshSync = await Bridge.getAll("sync");
      const freshLocal = await Bridge.getAll("local");
      // Only update if something changed (compare JSON)
      const oldJSON = JSON.stringify(profileData) + JSON.stringify(localData);
      const newJSON = JSON.stringify(freshSync) + JSON.stringify(freshLocal);
      if (oldJSON !== newJSON) {
        profileData = freshSync;
        localData = freshLocal;
        populateUI();
        console.log("[Settings] Live update detected, UI refreshed");
      }
    } catch {
      // Connection lost
      Bridge.connected = false;
      $("#connectionBanner").className = "connection-banner disconnected";
      $("#connectionText").textContent =
        "Connection lost — trying to reconnect...";
      // Try to reconnect
      const ok = await Bridge.ping();
      if (ok) {
        $("#connectionBanner").className = "connection-banner connected";
        $("#connectionText").textContent =
          "Reconnected to JobPilot AI extension";
      }
    }
  }, 5000);
}

// ─── Init ───
async function init() {
  setupTabs();
  setupCollapsible();

  // Login gate button: attempt reconnect manually
  const loginBtn = $("#loginCheckBtn");
  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      loginBtn.disabled = true;
      const original = loginBtn.innerHTML;
      loginBtn.textContent = "Connecting...";
      const ok = await checkConnection();
      if (ok) {
        await loadAllData();
        setupAutosave();
        setupToggles();
        startPolling();
        toast("Connected to extension");
      }
      loginBtn.innerHTML = original;
      loginBtn.disabled = false;
    });
  }

  const connected = await checkConnection();
  if (connected) {
    await loadAllData();
    setupAutosave();
    setupToggles();
    setupAddCustomParam();
    setupTimelineAdd();
    setupTrackerExport();
    setupClearLearned();
    setupLanguages();
    setupExportImport();
    setupHeaderButtons();
    setupAssistant();
    setupDocs();
    setupJobs4u();
    startPolling();
  } else {
    setAuthUI(false);
    // Still set up UI interactions in case they connect later
    setupHeaderButtons();
    setupExportImport();
    setupAddCustomParam();
    setupTimelineAdd();
    setupTrackerExport();
    setupClearLearned();
    setupLanguages();
    setupAssistant();
    setupDocs();
    setupJobs4u();

    // Retry connection every 3 seconds
    const retryInterval = setInterval(async () => {
      const ok = await checkConnection();
      if (ok) {
        clearInterval(retryInterval);
        await loadAllData();
        setupAutosave();
        setupToggles();
        startPolling();
      }
    }, 3000);
  }
}

document.addEventListener("DOMContentLoaded", init);
