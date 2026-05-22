(function loadContentScript(root) {
  "use strict";

  const api = root.browser || root.chrome;
  let lastSentUrl = "";
  let queuedCheck = 0;

  start();

  function start() {
    checkCurrentUrl();
    watchPage();
  }

  function watchPage() {
    root.addEventListener("pageshow", checkCurrentUrl);
    root.addEventListener("popstate", checkCurrentUrl);
    root.addEventListener("hashchange", checkCurrentUrl);
    root.addEventListener("visibilitychange", checkWhenVisible);
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

  function checkWhenVisible() {
    if (!document.hidden) {
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
    sendCurrentUrl(false);
  }

  function recheckCurrentUrl() {
    sendCurrentUrl(true);
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
