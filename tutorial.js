// ============================================================
// JobPilot: the getting-started tutorial on the settings page.
// JobPilot is used through the Chrome extension, so right after you sign in (login.html and signup.html
// send you here) a short dialog walks you through it: add the extension, pin it, finish its setup,
// fill a first application. Step 1 moves on by itself once this page reaches the extension through the
// bridge (background.js onMessageExternal "ping", or the content script's postMessage bridge); step 3
// moves on once the extension reports its setup done (the popup's own test: sync storage onboardingComplete,
// or a saved CV in cvFiles / cvContent). Progress is kept in localStorage per signed-in user, so it never repeats.
// Opens again from any [data-tutorial-open] button, or with settings.html?tutorial=1.
// ============================================================
(function () {
  "use strict";

  const STORE_URL = "https://chromewebstore.google.com/detail/kbmpbhhhdojgjnpfpnoehafmllfejgll";
  const DEFAULT_EXTENSION_ID = "kbmpbhhhdojgjnpfpnoehafmllfejgll";
  const POLL_MS = 2000;
  const KEY_PREFIX = "jobpilot_tutorial_v1:";
  const STEP_COUNT = 5;

  // ─── Signed-in user and saved progress ───
  function readUser() {
    try {
      const u = JSON.parse(localStorage.getItem("jobpilot_user") || "null");
      return u && (u.uid || u.email) ? u : null;
    } catch {
      return null;
    }
  }
  function keyFor(user) {
    return KEY_PREFIX + (user ? String(user.uid || user.email) : "guest");
  }
  function loadState(key) {
    try {
      const s = JSON.parse(localStorage.getItem(key) || "null");
      return s && typeof s === "object" ? s : null;
    } catch {
      return null;
    }
  }
  function saveState(key, s) {
    try {
      localStorage.setItem(key, JSON.stringify(Object.assign({}, s, { updatedAt: Date.now() })));
    } catch {
      // storage full or blocked: the tutorial still works for this visit
    }
  }

  // ─── Extension bridge (the same messages settings.js uses) ───
  const Ext = {
    id: null,
    via: null, // "runtime" (externally_connectable) or "page" (content script postMessage)
    _n: 0,

    runtimeSend(id, msg, ms = 1500) {
      return new Promise((resolve) => {
        const rt = window.chrome && window.chrome.runtime;
        if (!rt || typeof rt.sendMessage !== "function") return resolve(null);
        let done = false;
        const timer = setTimeout(() => {
          if (!done) { done = true; resolve(null); }
        }, ms);
        try {
          rt.sendMessage(id, msg, (res) => {
            const err = rt.lastError; // read it, so Chrome does not log an unchecked error when nothing answers
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(err || !res || res.error ? null : res);
          });
        } catch {
          if (!done) { done = true; clearTimeout(timer); resolve(null); }
        }
      });
    },

    _await(match, post, ms) {
      return new Promise((resolve) => {
        const onMsg = (e) => {
          if (e.source !== window) return;
          const v = match(e.data || {});
          if (v !== undefined) finish(v);
        };
        const finish = (v) => {
          window.removeEventListener("message", onMsg);
          clearTimeout(timer);
          resolve(v);
        };
        const timer = setTimeout(() => finish(null), ms);
        window.addEventListener("message", onMsg);
        window.postMessage(post, "*");
      });
    },

    pageSend(action, params = {}, ms = 1500) {
      const reqId = `jpt_${++this._n}_${Date.now()}`;
      return this._await(
        (d) => (d.type === "JAF_BRIDGE_RESPONSE" && d.reqId === reqId ? (d.error ? null : d) : undefined),
        Object.assign({ type: "JAF_BRIDGE_REQUEST", reqId, action }, params),
        ms,
      );
    },

    discover(ms = 800) {
      return this._await(
        (d) => (d.type === "JAF_EXTENSION_ID_RESPONSE" && d.runtimeId ? d.runtimeId : undefined),
        { type: "JAF_REQUEST_EXTENSION_ID" },
        ms,
      );
    },

    // Is the extension installed and reachable from this page?
    async detect() {
      let stored = null;
      try { stored = localStorage.getItem("jobpilot_extension_id"); } catch { /* blocked */ }
      const ids = [...new Set([this.id, stored, DEFAULT_EXTENSION_ID].filter(Boolean))];
      for (const id of ids) {
        const res = await this.runtimeSend(id, { action: "ping" });
        if (res && res.success) { this.id = id; this.via = "runtime"; return true; }
      }
      // an unpacked or renamed build: its content script on this page tells us its ID
      const found = await this.discover();
      if (found) {
        this.id = found;
        const res = await this.runtimeSend(found, { action: "ping" });
        this.via = res && res.success ? "runtime" : "page";
        return true;
      }
      this.via = null;
      return false;
    },

    // Has the extension's own setup finished? The same test popup.js initOnboarding runs before it hides
    // its setup guide: onboardingComplete, or a CV already saved.
    async setupComplete() {
      const keys = ["onboardingComplete", "cvFiles", "cvContent"];
      let res = null;
      if (this.via === "runtime") res = await this.runtimeSend(this.id, { action: "get", keys, area: "sync" });
      else if (this.via === "page") res = await this.pageSend("get", { keys, area: "sync" });
      const d = (res && res.data) || {};
      return (
        d.onboardingComplete === true ||
        (Array.isArray(d.cvFiles) && d.cvFiles.length > 0) ||
        (typeof d.cvContent === "string" && d.cvContent.trim().length > 50)
      );
    },
  };

  // ─── Browser: extensions need desktop Chrome or another Chromium browser ───
  let _browser = null;
  function browserInfo() {
    if (_browser) return _browser;
    const ua = navigator.userAgent || "";
    const uad = navigator.userAgentData;
    const mobile = uad && typeof uad.mobile === "boolean" ? uad.mobile : /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    let chromium;
    if (uad && Array.isArray(uad.brands) && uad.brands.length) {
      chromium = uad.brands.some((b) => /Chromium|Google Chrome|Microsoft Edge|Brave|Opera/i.test(b.brand));
    } else {
      chromium = /(Chrome|Chromium|Edg)\//.test(ua) && !/(Firefox|FxiOS|CriOS|EdgiOS)\//.test(ua);
    }
    _browser = { chromium, mobile };
    return _browser;
  }

  // ─── Small drawings, one per step (flat greys and black, no screenshots) ───
  const ICON = {
    puzzle: '<path d="M19.44 7.85c-.05.32.06.65.29.88l1.57 1.57c.47.47.7 1.09.7 1.7s-.23 1.24-.7 1.71l-1.61 1.61a.98.98 0 0 1-.84.27c-.47-.07-.8-.48-.97-.92a2.5 2.5 0 1 0-3.21 3.21c.44.17.85.5.92.97a.98.98 0 0 1-.27.84l-1.61 1.61a2.4 2.4 0 0 1-3.41 0l-1.57-1.57a1.03 1.03 0 0 0-.88-.29c-.49.07-.84.5-1.02.97a2.5 2.5 0 1 1-3.24-3.24c.46-.18.89-.53.97-1.02a1.03 1.03 0 0 0-.29-.88l-1.57-1.57a2.4 2.4 0 0 1 0-3.41l1.53-1.53c.24-.24.58-.35.92-.3.51.08.88.53 1.07 1.01a2.5 2.5 0 1 0 3.26-3.26c-.48-.2-.93-.56-1.01-1.07-.05-.34.06-.68.3-.92l1.53-1.53a2.4 2.4 0 0 1 3.41 0l1.57 1.57c.23.23.56.34.88.29.49-.07.84-.5 1.02-.97a2.5 2.5 0 1 1 3.24 3.24c-.46.18-.89.53-.97 1.02Z"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  };
  const MARK_PATHS =
    '<path d="M37.5 100L75 100L75 130C75 137 75 140.5 73.6 143.2C72.4 145.5 70.5 147.4 68.2 148.6C65.5 150 62 150 55 150L20 150C13 150 9.5 150 6.8 148.6C4.5 147.4 2.6 145.5 1.4 143.2C0 140.5 0 137 0 130L0 120C0 113 0 109.5 1.4 106.8C2.6 104.5 4.5 102.6 6.8 101.4C9.5 100 13 100 20 100Z"/>' +
    '<path d="M112.5 50L150 50L150 80C150 87 150 90.5 148.6 93.2C147.4 95.5 145.5 97.4 143.2 98.6C140.5 100 137 100 130 100L75 100L75 70C75 63 75 59.5 76.4 56.8C77.6 54.5 79.5 52.6 81.8 51.4C84.5 50 88 50 95 50Z"/>' +
    '<path d="M187.5 0L205 0C212 0 215.5 0 218.2 1.4C220.5 2.6 222.4 4.5 223.6 6.8C225 9.5 225 13 225 20L225 30C225 37 225 40.5 223.6 43.2C222.4 45.5 220.5 47.4 218.2 48.6C215.5 50 212 50 205 50L150 50L150 20C150 13 150 9.5 151.4 6.8C152.6 4.5 154.5 2.6 156.8 1.4C159.5 0 163 0 170 0Z"/>' +
    '<path d="M50 100C75 100 75 100 75 75L75 100Z"/><path d="M75 125C75 100 75 100 100 100L75 100Z"/><path d="M125 50C150 50 150 50 150 25L150 50Z"/><path d="M150 75C150 50 150 50 175 50L150 50Z"/>';
  const INK = "#0A0A0B", LINE = "#E4E4E7", BAR = "#D4D4D8", FILL = "#F4F4F5", WHITE = "#FFFFFF", DARK = "#3F3F46";
  const mark = (x, y, w, color) => `<svg x="${x}" y="${y}" width="${w}" height="${(w * 150) / 225}" viewBox="0 0 225 150" fill="${color}">${MARK_PATHS}</svg>`;
  const icon = (name, cx, cy, size, color) =>
    `<svg x="${cx - size / 2}" y="${cy - size / 2}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
  const svg = (inner) => `<svg viewBox="0 0 400 132" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" focusable="false">${inner}</svg>`;
  const toolbar = (items) =>
    `<rect x="40" y="14" width="320" height="32" rx="10" fill="${WHITE}"/><rect x="54" y="24" width="168" height="12" rx="6" fill="${FILL}"/>` + items;
  const step = (n, x, y) => `<text x="${x}" y="${y}" font-size="10" font-weight="600" fill="#71717A" text-anchor="middle">${n}</text>`;

  const ART = [
    // 1. add it: the extension's store card in a browser window
    svg(
      `<rect x="60" y="14" width="280" height="104" rx="10" fill="${WHITE}"/>` +
        `<circle cx="76" cy="28" r="3" fill="${LINE}"/><circle cx="86" cy="28" r="3" fill="${LINE}"/><circle cx="96" cy="28" r="3" fill="${LINE}"/>` +
        `<rect x="110" y="22" width="150" height="12" rx="6" fill="${FILL}"/>` +
        `<rect x="80" y="54" width="44" height="44" rx="10" fill="${INK}"/>` + mark(90, 68, 24, WHITE) +
        `<rect x="136" y="62" width="76" height="8" rx="4" fill="${BAR}"/><rect x="136" y="78" width="52" height="6" rx="3" fill="${LINE}"/>` +
        `<rect x="224" y="64" width="98" height="26" rx="13" fill="${INK}"/>` +
        `<text x="273" y="81" font-size="10.5" font-weight="600" fill="${WHITE}" text-anchor="middle">Add to Chrome</text>`,
    ),
    // 2. pin it: the puzzle piece, then the pin next to JobPilot
    svg(
      toolbar(
        `<circle cx="300" cy="30" r="12" fill="${INK}"/>` + icon("puzzle", 300, 30, 14, WHITE) +
          `<circle cx="330" cy="30" r="8" fill="${LINE}"/>` + step("1", 280, 34),
      ) +
        `<rect x="172" y="54" width="188" height="66" rx="10" fill="${WHITE}"/>` +
        `<rect x="186" y="66" width="58" height="6" rx="3" fill="${LINE}"/>` +
        `<rect x="186" y="82" width="26" height="26" rx="7" fill="${INK}"/>` + mark(192, 90.5, 14, WHITE) +
        `<text x="220" y="99" font-size="11" font-weight="600" fill="${INK}">JobPilot</text>` +
        `<circle cx="336" cy="95" r="12" fill="${INK}"/>` + icon("pin", 336, 95, 14, WHITE) + step("2", 316, 99),
    ),
    // 3. open it and finish setup: the JobPilot icon, its popup asking for your CV
    svg(
      toolbar(
        `<circle cx="276" cy="30" r="12" fill="${INK}"/>` + mark(268, 25, 16, WHITE) +
          icon("puzzle", 304, 30, 14, "#71717A") + `<circle cx="332" cy="30" r="8" fill="${LINE}"/>`,
      ) +
        `<clipPath id="jptPop"><rect x="172" y="54" width="188" height="68" rx="10"/></clipPath>` +
        `<g clip-path="url(#jptPop)"><rect x="172" y="54" width="188" height="68" fill="${WHITE}"/><rect x="172" y="54" width="188" height="30" fill="${INK}"/></g>` +
        mark(184, 62, 15, WHITE) +
        `<rect x="208" y="74" width="30" height="3" rx="1.5" fill="${WHITE}"/><rect x="242" y="74" width="30" height="3" rx="1.5" fill="${WHITE}"/>` +
        `<rect x="276" y="74" width="30" height="3" rx="1.5" fill="${DARK}"/><rect x="310" y="74" width="38" height="3" rx="1.5" fill="${DARK}"/>` +
        `<rect x="184" y="92" width="164" height="22" rx="6" fill="${FILL}"/>` +
        `<text x="266" y="107" font-size="10" font-weight="500" fill="#71717A" text-anchor="middle">Add your CV</text>`,
    ),
    // 4. fill an application: a form filled in, the Fill with Pilot button
    svg(
      `<rect x="70" y="12" width="260" height="108" rx="10" fill="${WHITE}"/>` +
        `<rect x="86" y="24" width="40" height="5" rx="2.5" fill="${BAR}"/><rect x="86" y="33" width="110" height="16" rx="5" fill="${FILL}"/><rect x="94" y="39" width="56" height="4" rx="2" fill="${DARK}"/>` +
        `<rect x="206" y="24" width="34" height="5" rx="2.5" fill="${BAR}"/><rect x="206" y="33" width="108" height="16" rx="5" fill="${FILL}"/><rect x="214" y="39" width="70" height="4" rx="2" fill="${DARK}"/>` +
        `<rect x="86" y="58" width="52" height="5" rx="2.5" fill="${BAR}"/><rect x="86" y="67" width="228" height="16" rx="5" fill="${FILL}"/><rect x="94" y="73" width="120" height="4" rx="2" fill="${DARK}"/>` +
        `<rect x="206" y="92" width="108" height="20" rx="10" fill="${INK}"/>` + mark(215, 98.7, 10, WHITE) +
        `<text x="268" y="105.5" font-size="9.5" font-weight="600" fill="${WHITE}" text-anchor="middle">Fill with Pilot</text>`,
    ),
    // 5. you're set: this page and the extension, in sync
    svg(
      `<rect x="106" y="30" width="92" height="72" rx="10" fill="${WHITE}"/>` +
        `<rect x="118" y="44" width="40" height="5" rx="2.5" fill="${BAR}"/><rect x="118" y="56" width="68" height="12" rx="4" fill="${FILL}"/><rect x="118" y="74" width="68" height="12" rx="4" fill="${FILL}"/>` +
        `<path d="M214 58h36m-6-6 6 6-6 6M250 76h-36m6-6-6 6 6 6" fill="none" stroke="#71717A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<rect x="266" y="44" width="44" height="44" rx="10" fill="${INK}"/>` + mark(276, 58, 24, WHITE) +
        `<circle cx="196" cy="32" r="12" fill="${INK}"/><path d="m190.5 32 3.8 3.8 7.2-7.6" fill="none" stroke="${WHITE}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    ),
  ];

  // ─── The steps ───
  const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const STEPS = [
    {
      title: "Start by adding JobPilot to Chrome",
      body: () => {
        const b = browserInfo();
        let html = "<p>JobPilot lives in your browser and fills applications on job sites. Add it from the Chrome Web Store, then come back to this page.</p>";
        if (b.mobile) html += '<p class="jpt-note" id="jptBrowserNote">JobPilot runs on a computer, in Chrome, Edge, Brave or Arc. Open jobpilot.pt there to add it.</p>';
        else if (!b.chromium) html += '<p class="jpt-note" id="jptBrowserNote">JobPilot needs Chrome, Edge, Brave or Arc. Open this page in one of them to add it.</p>';
        return html;
      },
    },
    {
      title: "Pin it",
      body: () => "<p>Click the <strong>puzzle piece</strong> at the top right of your browser, then the <strong>pin</strong> next to JobPilot. It stays one click away.</p>",
    },
    {
      title: "Open JobPilot and finish setup",
      body: () => "<p>Click the <strong>JobPilot icon</strong> in the toolbar and follow the setup. Add your CV and JobPilot fills in your profile.</p>",
    },
    {
      title: "Fill your first application",
      body: () =>
        "<p>Open a job application and press <strong>Fill with Pilot</strong> in the JobPilot panel. Pilot fills the form with you and talks you through every step.</p>" +
        "<p>It works on sites like Greenhouse, Lever, Workday and LinkedIn.</p>",
    },
    {
      title: "You're set",
      body: () => "<p>This page syncs with the extension. Manage your profile, AI keys and tracker here.</p>",
    },
  ];

  // ─── State ───
  let key = keyFor(readUser());
  let state = null; // { status: "active" | "dismissed" | "done", step, completed: {0: true, ...} }
  let replay = false; // opened again by hand: steps that are already done wait for Next instead of moving on
  let fresh = false; // the first showing after sign-in, untouched so far: a set-up extension skips ahead to step 4
  let detected = null; // last bridge result: null unknown, true, false
  let setupDone = false;
  let pollTimer = null;
  let polling = false;
  let again = false; // a check was asked for while one was running: run one more after it
  let renderToken = 0;
  let advanceTimer = null;
  let lastFocus = null;
  let inerted = [];
  let el = null; // the dialog's parts

  function persist() {
    saveState(key, state);
  }

  function build() {
    if (el) return el;
    const overlay = document.createElement("div");
    overlay.className = "jpt-overlay";
    overlay.id = "jpTutorial";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="jpt-dialog" role="dialog" aria-modal="true" aria-labelledby="jptTitle" aria-describedby="jptBody">
        <div class="jpt-bars" role="progressbar" aria-label="Tutorial progress" aria-valuemin="1" aria-valuemax="${STEP_COUNT}">
          ${'<span class="jpt-bar"></span>'.repeat(STEP_COUNT)}
        </div>
        <div class="jpt-head">
          <span class="jpt-kicker" id="jptKicker" aria-live="polite" aria-atomic="true"></span>
          <button type="button" class="jpt-skip" data-act="skip" aria-label="Skip the tutorial">Skip</button>
        </div>
        <div class="jpt-art" aria-hidden="true"></div>
        <h2 class="jpt-title" id="jptTitle" tabindex="-1"></h2>
        <div class="jpt-body" id="jptBody"></div>
        <p class="jpt-status" id="jptStatus" role="status" aria-live="polite"></p>
        <div class="jpt-actions">
          <button type="button" class="jpt-btn jpt-back" data-act="back">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
            Back
          </button>
          <div class="jpt-actions-end"></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    el = {
      overlay,
      dialog: overlay.querySelector(".jpt-dialog"),
      bars: overlay.querySelector(".jpt-bars"),
      kicker: overlay.querySelector("#jptKicker"),
      skip: overlay.querySelector(".jpt-skip"),
      art: overlay.querySelector(".jpt-art"),
      title: overlay.querySelector("#jptTitle"),
      body: overlay.querySelector("#jptBody"),
      status: overlay.querySelector("#jptStatus"),
      back: overlay.querySelector(".jpt-back"),
      end: overlay.querySelector(".jpt-actions-end"),
    };
    overlay.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeydown);
    return el;
  }

  function button(label, act, kind) {
    return `<button type="button" class="jpt-btn jpt-${kind}" data-act="${act}">${label}</button>`;
  }

  function statusHtml(kind, text) {
    if (!kind) return "";
    return (kind === "ok" ? CHECK : '<span class="jpt-dot" aria-hidden="true"></span>') + `<span>${text}</span>`;
  }

  // the buttons and status of the open step, from what we know about the extension;
  // only touches the page when something changed, so the 2 s checks never move your focus
  function renderActions() {
    const i = state.step;
    let status = null;
    let end = "";
    if (i === 0) {
      if (state.completed[0] && detected) {
        status = ["ok", "JobPilot is in Chrome."];
        end = button("Next", "next", "primary");
      } else {
        const b = browserInfo();
        const canAdd = b.chromium && !b.mobile;
        if (canAdd) status = ["wait", "Waiting for JobPilot. This step moves on by itself once it's added."];
        // a link, since it opens another page; it looks like the other buttons
        end =
          (canAdd ? button("I've added it", "added", "secondary") : button("Next", "next", "secondary")) +
          `<a class="jpt-btn jpt-primary" href="${STORE_URL}" target="_blank" rel="noopener" data-act="store">Add to Chrome<span class="sr-only"> (opens the Chrome Web Store in a new tab)</span></a>`;
      }
    } else if (i === 2) {
      if (setupDone) status = ["ok", "Setup is done."];
      else if (detected) status = ["wait", "Waiting for setup. This step moves on by itself when it's done."];
      end = button(setupDone ? "Next" : "Done", "next", "primary");
    } else if (i === STEP_COUNT - 1) {
      end = button("Done", "finish", "primary");
    } else {
      end = button("Next", "next", "primary");
    }

    const sHtml = status ? statusHtml(status[0], status[1]) : "";
    if (el.status.dataset.html !== sHtml) {
      el.status.className = "jpt-status" + (status && status[0] === "ok" ? " is-ok" : "");
      el.status.innerHTML = sHtml;
      el.status.dataset.html = sHtml;
    }
    if (el.end.dataset.html !== end) {
      const focused = el.end.contains(document.activeElement) ? document.activeElement.dataset.act : null;
      el.end.innerHTML = end;
      el.end.dataset.html = end;
      if (focused) (el.end.querySelector(`[data-act="${focused}"]`) || el.end.querySelector(".jpt-primary"))?.focus();
    }
  }

  function render(focusTitle = true) {
    const i = state.step;
    const s = STEPS[i];
    renderToken++;
    clearTimeout(advanceTimer);
    el.bars.querySelectorAll(".jpt-bar").forEach((b, n) => b.classList.toggle("is-on", n <= i));
    el.bars.setAttribute("aria-valuenow", String(i + 1));
    el.bars.setAttribute("aria-valuetext", `Step ${i + 1} of ${STEP_COUNT}`);
    el.kicker.textContent = `Step ${i + 1} of ${STEP_COUNT}`;
    el.skip.hidden = i === STEP_COUNT - 1;
    el.art.innerHTML = ART[i];
    el.title.textContent = s.title;
    el.body.innerHTML = s.body();
    const first = i === 0;
    el.back.setAttribute("aria-hidden", first ? "true" : "false");
    el.back.tabIndex = first ? -1 : 0;
    renderActions();
    if (focusTitle) el.title.focus({ preventScroll: true });
    if (i === 0 || i === 2) startPolling();
    else stopPolling();
  }

  function goTo(i) {
    state.step = Math.max(0, Math.min(STEP_COUNT - 1, i));
    persist();
    render();
  }

  function complete(i) {
    if (!state.completed[i]) { state.completed[i] = true; persist(); }
  }

  // ─── Live checks while step 1 or step 3 is open ───
  async function tick() {
    if (polling) { again = true; return; }
    if (!state || !el || el.overlay.hidden) return;
    const i = state.step;
    if (i !== 0 && i !== 2) return;
    polling = true;
    const token = renderToken;
    try {
      const was = state.completed[i];
      detected = await Ext.detect();
      // step 3 waits for setup; on the first showing, step 1 also asks, to skip what is already done
      if (detected && (i === 2 || (i === 0 && fresh && !was))) setupDone = await Ext.setupComplete();
      if (token !== renderToken || el.overlay.hidden) return; // the step changed meanwhile
      if (i === 0 && detected) complete(0);
      if (i === 2 && setupDone) complete(2);
      renderActions();
      // moves on by itself, once: not when you came back to a step that was done, and not on a replay
      const moveOn = (i === 0 && detected) || (i === 2 && setupDone);
      if (moveOn && !was && !replay) {
        // JobPilot already in and set up when you first get here: pinning and setup are behind you
        let to = i + 1;
        if (i === 0 && fresh && setupDone) {
          complete(1);
          complete(2);
          to = 3;
        }
        fresh = false;
        stopPolling();
        advanceTimer = setTimeout(() => {
          if (token === renderToken && !el.overlay.hidden) goTo(to);
        }, 1100);
      }
    } finally {
      polling = false;
      if (again) { again = false; if (pollTimer) tick(); }
    }
  }

  function startPolling() {
    stopPolling();
    tick();
    pollTimer = setInterval(tick, POLL_MS);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ─── Open, close, keyboard ───
  function open() {
    build();
    if (!el.overlay.hidden) { render(); return; }
    lastFocus = document.activeElement;
    inerted = [...document.body.children].filter((n) => n !== el.overlay && !n.inert && n.tagName !== "SCRIPT");
    inerted.forEach((n) => (n.inert = true));
    document.documentElement.classList.add("jpt-lock");
    el.overlay.hidden = false;
    render();
  }

  function close(status) {
    if (!el || el.overlay.hidden) return;
    stopPolling();
    clearTimeout(advanceTimer);
    renderToken++;
    state.status = status;
    persist();
    el.overlay.hidden = true;
    inerted.forEach((n) => (n.inert = false));
    inerted = [];
    document.documentElement.classList.remove("jpt-lock");
    if (lastFocus && document.contains(lastFocus) && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function onClick(e) {
    if (e.target === el.overlay) return; // a click outside the dialog does nothing; Skip or Esc closes it
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    fresh = false;
    if (act === "skip") close("dismissed");
    else if (act === "back") goTo(state.step - 1);
    else if (act === "next") { complete(state.step); goTo(state.step + 1); }
    else if (act === "added") { complete(0); goTo(1); }
    else if (act === "finish") { complete(state.step); close("done"); }
  }

  function onKeydown(e) {
    if (!el || el.overlay.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close("dismissed");
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...el.dialog.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
      (n) => n.getClientRects().length && getComputedStyle(n).visibility !== "hidden" && n.getAttribute("aria-hidden") !== "true",
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    // the title takes focus on each step but sits outside the Tab order: from it, Shift+Tab goes to
    // Skip when Skip is there, and wraps to the last button when it isn't (the last step)
    const nothingBefore = at === el.title && !items.some((n) => n.compareDocumentPosition(el.title) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (e.shiftKey && (at === first || !el.dialog.contains(at) || nothingBefore)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || !el.dialog.contains(at))) {
      e.preventDefault();
      first.focus();
    }
  }

  function onReturn() {
    // back from the Chrome Web Store tab: check right away instead of waiting for the next poll
    if (document.visibilityState === "visible" && el && !el.overlay.hidden && state && (state.step === 0 || state.step === 2)) tick();
  }

  // ─── Entry points ───
  function replayTutorial() {
    key = keyFor(readUser());
    const prev = loadState(key);
    state = { status: "active", step: 0, completed: (prev && prev.completed) || {} };
    replay = true;
    fresh = false;
    persist();
    open();
  }

  function boot() {
    document.querySelectorAll("[data-tutorial-open]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.preventDefault();
        replayTutorial();
      }),
    );
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    // the extension's content script (the page bridge) arrives at document_idle, around the load event:
    // check again then instead of waiting for the next poll
    if (document.readyState !== "complete") window.addEventListener("load", () => setTimeout(onReturn, 150), { once: true });

    const params = new URLSearchParams(location.search);
    if (params.get("tutorial") === "1") {
      params.delete("tutorial");
      const q = params.toString();
      history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
      replayTutorial();
      return;
    }

    const user = readUser();
    if (!user) return; // the tutorial follows a site sign-in; the extension's own "Edit on Website" visitors skip it
    key = keyFor(user);
    const saved = loadState(key);
    if (saved && (saved.status === "done" || saved.status === "dismissed")) return;
    if (saved && saved.status === "active" && Number.isInteger(saved.step)) {
      state = { status: "active", step: saved.step, completed: saved.completed || {} };
      open();
      return;
    }

    // first visit after signing in: open at step 1 right away. It completes itself once the extension
    // answers; if the extension is already set up too, it goes straight on to step 4.
    state = { status: "active", step: 0, completed: {} };
    fresh = true;
    persist();
    open();
  }

  window.JobPilotTutorial = { open: replayTutorial };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
