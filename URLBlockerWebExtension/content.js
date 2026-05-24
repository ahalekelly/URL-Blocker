(function loadContentScript(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const MAX_SCREEN_TIME_ELAPSED_MS = 10 * 1000;
  let lastSentUrl = "";
  let queuedCheck = 0;
  let screenTimeUrl = "";
  let screenTimeStartedAt = 0;
  let pollId = 0;
  let stopped = false;

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

    pollId = root.setInterval(() => {
      if (document.hidden) {
        return;
      }

      recheckCurrentUrl();
    }, 1500);
  }

  function teardown() {
    stopped = true;
    if (pollId !== 0) {
      root.clearInterval(pollId);
      pollId = 0;
    }
    if (queuedCheck !== 0) {
      root.clearTimeout(queuedCheck);
      queuedCheck = 0;
    }
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
    screenTimeStartedAt = now;

    if (elapsedMs <= 0) {
      return;
    }

    if (elapsedMs > MAX_SCREEN_TIME_ELAPSED_MS) {
      return;
    }

    const url = screenTimeUrl;
    sendMessage(
      { type: "screenTimeElapsed", url, elapsedMs },
      (error) => console.error("URL Blocker could not log screen time.", errorDetails(error)),
    );
  }

  function sendCurrentUrl(force) {
    const currentUrl = location.href;

    if (!force && currentUrl === lastSentUrl) {
      return;
    }

    lastSentUrl = currentUrl;
    sendMessage(
      { type: "urlChanged", url: currentUrl },
      (error) => {
        lastSentUrl = "";
        console.error("URL Blocker could not check the current URL.", errorDetails(error));
      },
    );
  }

  function sendMessage(payload, onError) {
    if (stopped || !api.runtime?.id) {
      teardown();
      return;
    }

    try {
      api.runtime.sendMessage(payload).catch((error) => {
        if (!api.runtime?.id) {
          teardown();
          return;
        }
        onError(error);
      });
    } catch {
      teardown();
    }
  }

  function errorDetails(error) {
    if (error instanceof Error) {
      return { message: error.message, code: error.errorCode || error.code || error.name };
    }

    return { message: String(error), code: "UnknownError" };
  }
})(globalThis);
