(function loadContentScript(root) {
  "use strict";

  const api = root.browser || root.chrome;
  let lastSentUrl = "";
  let queuedCheck = 0;
  let screenTimeUrl = "";
  let screenTimeStartedAt = 0;

  start();

  function start() {
    checkCurrentUrl();
    watchPage();
  }

  function watchPage() {
    root.addEventListener("pageshow", checkCurrentUrl);
    root.addEventListener("pagehide", stopScreenTime);
    root.addEventListener("popstate", checkCurrentUrl);
    root.addEventListener("hashchange", checkCurrentUrl);
    root.addEventListener("visibilitychange", syncVisibility);
    root.addEventListener("focus", checkCurrentUrl);
    root.addEventListener("click", queueCheck, true);
    root.addEventListener("submit", queueCheck, true);
    root.addEventListener("keydown", queueKeyboardCheck, true);

    root.setInterval(() => {
      if (document.hidden) {
        return;
      }

      recheckCurrentUrl();
    }, 1500);
  }

  function syncVisibility() {
    if (document.hidden) {
      stopScreenTime();
    } else {
      checkCurrentUrl();
    }
  }

  function queueKeyboardCheck(event) {
    if (event.key === "Enter" || event.key === " ") {
      queueCheck();
    }
  }

  function queueCheck() {
    if (queuedCheck !== 0) {
      root.clearTimeout(queuedCheck);
    }

    queuedCheck = root.setTimeout(() => {
      queuedCheck = 0;
      checkCurrentUrl();
    }, 75);
  }

  function checkCurrentUrl() {
    updateScreenTimeUrl(Date.now());
    sendCurrentUrl(false);
  }

  function recheckCurrentUrl() {
    const now = Date.now();

    updateScreenTimeUrl(now);
    sendScreenTime(now);
    sendCurrentUrl(true);
  }

  function updateScreenTimeUrl(now) {
    if (document.hidden) {
      return;
    }

    const currentUrl = location.href;

    if (screenTimeUrl === "") {
      screenTimeUrl = currentUrl;
      screenTimeStartedAt = now;
      return;
    }

    if (screenTimeUrl === currentUrl) {
      return;
    }

    sendScreenTime(now);
    screenTimeUrl = currentUrl;
    screenTimeStartedAt = now;
  }

  function stopScreenTime() {
    sendScreenTime(Date.now());
    screenTimeUrl = "";
    screenTimeStartedAt = 0;
  }

  function sendScreenTime(now) {
    if (screenTimeUrl === "") {
      return;
    }

    const elapsedMs = now - screenTimeStartedAt;

    if (elapsedMs <= 0) {
      return;
    }

    const url = screenTimeUrl;
    screenTimeStartedAt = now;
    api.runtime.sendMessage({ type: "screenTimeElapsed", url, elapsedMs })
      .catch((error) => console.error("URL Blocker could not log screen time.", error));
  }

  function sendCurrentUrl(force) {
    const currentUrl = location.href;

    if (!force && currentUrl === lastSentUrl) {
      return;
    }

    lastSentUrl = currentUrl;
    api.runtime.sendMessage({ type: "urlChanged", url: currentUrl })
      .catch((error) => {
        lastSentUrl = "";
        console.error("URL Blocker could not check the current URL.", error);
      });
  }
})(globalThis);
