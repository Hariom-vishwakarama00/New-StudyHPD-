// StudyHPD boot: runs before the first paint. Inside the Android app (or an installed PWA) it turns on
// the brand splash in index.html, so the native splash hands over to the same purple screen instead of a
// white flash. The splash never blocks: it ignores taps, app.js removes it as soon as the page renders,
// and it removes itself after a few seconds no matter what.
(function () {
  try {
    var d = document.documentElement, mm = window.matchMedia, s = null;
    try { s = window.sessionStorage; } catch (e) {}
    // The Android app v1.0.2+ opens the site with ?sr=1: it has the native Secure Reader, so notes open there
    // (this tab only; sessionStorage is per tab, a normal Chrome tab never gets it). The flag is removed from the URL.
    try {
      var q = new URLSearchParams(location.search);
      if (q.get("sr") === "1") {
        if (s) { s.setItem("shpd-sr", "1"); s.setItem("shpd-app", "1"); }
        q.delete("sr"); var qs = q.toString();
        history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
      }
    } catch (e) {}
    var app = (mm && (mm("(display-mode: standalone)").matches || mm("(display-mode: fullscreen)").matches)) ||
      /^android-app:\/\//.test(document.referrer) || window.navigator.standalone === true ||
      (s && s.getItem("shpd-app") === "1");
    if (!app) return;
    if (s) s.setItem("shpd-app", "1");
    d.className += " app-boot";
    setTimeout(function () { d.className += " booted"; }, 5000); // safety net
  } catch (e) {}
})();
