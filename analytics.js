// jobpilot.pt: anonymous page views and clicks, plus optional session recording. Public pages only: this file must never
// be added to login, signup, settings or bye, or to the extension.
//
// Anonymous events run for everyone: no cookies, no storage, no IDs stored, no person profile. They live in page memory.
// Recording starts only after a visitor presses "I agree". Ignoring the bar means no recording, and the site works the
// same. It runs in its own named PostHog instance, and the choice is kept in this browser; privacy.html turns it off.
(function () {
  "use strict";
  var KEY = "phc_7N9X0JmBFzCRTkpfXhS0dMoMpZ37OUwMYyjKbAyynaQ"; // public ingestion key, the same one the extension ships
  var HOST = "https://us.i.posthog.com";
  var LIVE = /^(www\.)?jobpilot\.pt$/.test(location.hostname);
  var BRAND = "JobPilot";
  var PRIVACY = "privacy.html#recording";
  var CHOICE = "jp_replay_choice"; // "on" or "off". Saved only after a visitor acts.
  var NAME = "replay";
  var BLOCK = "[data-private], .ph-no-capture, #jaf-fill-all-panel, .jaf-ai-chatbox, #jaf-job-tracker-panel, " +
    "[data-jp-ui], .jaf-btn-wrapper, .jaf-field-btn, #jp-pilot-host";
  var slug = (location.pathname.replace(/^\/+|\.html$|\/+$/g, "") || "home");

  var ANON = {
    api_host: HOST,
    persistence: "memory",        // no cookies and no local storage
    person_profiles: "never",     // no person profile for any visitor
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    disable_surveys: true,
    advanced_disable_feature_flags: true
  };
  var REPLAY = {
    api_host: HOST,
    opt_out_capturing_by_default: true,
    disable_session_recording: true,
    opt_out_capturing_cookie_prefix: "jp_replay",
    consent_persistence_name: "jp_replay_consent",
    persistence: "sessionStorage",
    persistence_name: "jp_replay",
    person_profiles: "identified_only",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    capture_exceptions: false,
    rageclick: false,
    disable_surveys: true,
    session_recording: {
      maskAllInputs: true,
      maskInputOptions: { password: true },
      maskTextSelector: "[data-private]",
      blockSelector: BLOCK,
      recordHeaders: false,
      recordBody: false
    }
  };
  window.__jpAnonConfig = ANON;
  window.__jpReplayConfig = REPLAY;
  window.__jpEvents = [];

  function loadPosthog() {
    /* PostHog's standard web snippet, with the method list cut to what this site calls. */
    !function (t, e) {
      var o, n, p, r;
      e.__SV || (window.posthog = e, e._i = [], e.init = function (i, s, a) {
        function g(t, e) { var o = e.split("."); 2 == o.length && (t = t[o[0]], e = o[1]), t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; }
        (p = t.createElement("script")).type = "text/javascript", p.crossOrigin = "anonymous", p.async = !0,
        p.src = s.api_host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js",
        (r = t.getElementsByTagName("script")[0]).parentNode.insertBefore(p, r);
        var u = e;
        for (void 0 !== a ? u = e[a] = [] : a = "posthog", u.people = u.people || [], u.toString = function (t) { var e = "posthog"; return "posthog" !== a && (e += "." + a), t || (e += " (stub)"), e; }, u.people.toString = function () { return u.toString(1) + ".people (stub)"; }, o = "init capture register unregister opt_in_capturing opt_out_capturing has_opted_out_capturing".split(" "), n = 0; n < o.length; n++) g(u, o[n]);
        e._i.push([i, s, a]);
      }, e.__SV = 1);
    }(document, window.posthog || []);
    window.posthog.init(KEY, ANON);
  }
  function track(event, props) {
    window.__jpEvents.push({ event: event, properties: props });
    if (LIVE && window.posthog) window.posthog.capture(event, props, { transport: "sendBeacon", send_instantly: true });
  }

  if (LIVE) loadPosthog();
  track("landing_view", { page_type: "jobpilot_site", page_slug: slug });
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href*="chromewebstore.google.com"], a[href*="chrome.google.com/webstore"]');
    if (a) track("install_click", { placement: "jobpilot_site", page_slug: slug });
  });

  // ---- optional session recording ----
  function saved() { try { return localStorage.getItem(CHOICE); } catch (e) { return null; } }
  function save(value) { try { localStorage.setItem(CHOICE, value); } catch (e) { /* the choice lasts this page */ } }
  var instance = null;

  function library(done) {
    function ready() { return window.posthog && typeof window.posthog.startSessionRecording === "function"; }
    if (ready()) return done();
    var tries = 0;
    var wait = setInterval(function () {
      if (ready()) { clearInterval(wait); done(); }
      else if (++tries > 60) clearInterval(wait); // blocked: no recording, and nothing else changes
    }, 100);
  }
  function start() {
    if (!LIVE) { window.__jpEvents.push({ event: "replay_started_preview" }); return; }
    library(function () {
      instance = window.posthog.init(KEY, REPLAY, NAME);
      if (!instance) return;
      instance.opt_in_capturing({ captureEventName: false });
      instance.startSessionRecording();
    });
  }
  function stop() {
    save("off");
    if (instance) {
      instance.stopSessionRecording();
      instance.opt_out_capturing();
      instance = null;
    }
    try {
      Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf("jp_replay") !== -1) sessionStorage.removeItem(k); });
    } catch (e) { /* nothing was stored */ }
    if (!LIVE) window.__jpEvents.push({ event: "replay_stopped_preview" });
  }
  function hideBar() { var bar = document.getElementById("jpReplayBar"); if (bar) bar.remove(); }
  function showBar() {
    var css = document.createElement("style");
    css.textContent =
      "#jpReplayBar{position:fixed;left:12px;bottom:12px;z-index:30;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);" +
      "padding:7px 8px 7px 12px;border:1px solid #e4e4e7;border-radius:8px;background:#fff;color:#3f3f46;font:400 12.5px/1.35 Geist,ui-sans-serif,system-ui,sans-serif;" +
      "box-shadow:0 1px 2px rgba(10,10,11,.06),0 6px 18px -8px rgba(10,10,11,.22)}" +
      "#jpReplayBar a{color:inherit}" +
      "#jpReplayBar button{flex:none;height:26px;padding:0 10px;border:1px solid #0a0a0b;border-radius:6px;background:#0a0a0b;color:#fff;font:500 12.5px Geist,ui-sans-serif,system-ui,sans-serif;cursor:pointer}";
    document.head.appendChild(css);
    var bar = document.createElement("div");
    bar.id = "jpReplayBar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Session recording");
    var text = document.createElement("span");
    text.appendChild(document.createTextNode("Record this visit to help improve " + BRAND + ". Typed text stays hidden. "));
    var link = document.createElement("a");
    link.href = PRIVACY;
    link.textContent = "Privacy";
    text.appendChild(link);
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "I agree";
    button.addEventListener("click", function () { save("on"); hideBar(); start(); renderControl(); });
    bar.appendChild(text);
    bar.appendChild(button);
    document.body.appendChild(bar);
  }
  var control = document.getElementById("replayControl");
  function renderControl() {
    if (!control) return;
    var on = saved() === "on";
    control.textContent = "";
    var state = document.createElement("p");
    state.textContent = on ? "Recording is on in this browser." : "Recording is off in this browser.";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-primary btn-sm";
    button.textContent = on ? "Turn off recording" : "Turn on recording";
    button.addEventListener("click", function () {
      if (saved() === "on") { stop(); }
      else { save("on"); hideBar(); start(); }
      renderControl();
    });
    control.appendChild(state);
    control.appendChild(button);
  }
  var choice = saved();
  if (choice === "on") start();
  else if (choice !== "off") showBar();
  renderControl();
})();
