// jobpilot.pt/bye: Chrome opens it after JobPilot is uninstalled. One tap sends one anonymous event (the reason and the
// version) to JobPilot's PostHog project, with a throwaway ID that is never stored and no person profile. Nothing is sent
// when the extension's analytics were off (a=0) or it was a test build (d=1). No cookies, no storage.
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var v = /^\d{1,3}(\.\d{1,4}){0,3}$/.test(q.get("v") || "") ? q.get("v") : "unknown";
  var quiet = q.get("a") === "0" || q.get("d") === "1";
  var REASONS = ["didnt_fill_my_site", "found_a_job", "setup_too_much", "needs_ai_key", "too_many_buttons", "privacy", "other"];
  var sent = false;
  function id() { var a = new Uint8Array(16); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  document.getElementById("reasons").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-r]");
    if (!b || sent) return;
    var reason = REASONS.indexOf(b.dataset.r) >= 0 ? b.dataset.r : "other";
    sent = true;
    if (!quiet) {
      try {
        fetch("https://us.i.posthog.com/capture/", {
          method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: "phc_7N9X0JmBFzCRTkpfXhS0dMoMpZ37OUwMYyjKbAyynaQ", event: "extension_uninstalled", distinct_id: id(),
            properties: { reason: reason, extension_version: v, source: "bye_page", $process_person_profile: false } })
        }).catch(function () {});
      } catch (err) { /* nothing to do */ }
    }
    document.getElementById("reasons").hidden = true;
    document.getElementById("thanks").hidden = false;
  });
})();
