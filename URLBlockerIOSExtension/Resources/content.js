(function loadContentScript(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const core = root.BlockerCore;
  let state = core.emptyState();
  let lastCheckedUrl = "";
  let pendingBlockedUrl = "";
  let queuedCheck = 0;

  start().catch((error) => {
    console.error("URL Blocker content script failed to start.", error);
  });

  async function start() {
    await reloadState();
    checkCurrentUrl();
    watchPage();
  }

  async function reloadState() {
    const response = await api.runtime.sendMessage({ type: "getState" });

    switch (response.type) {
      case "state":
        state = response.state;
        return;
      case "stateError":
      case "error":
        throw new Error(response.error);
      default:
        throw new Error(`Unknown getState response: ${response.type}`);
    }
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

      reloadState()
        .then(() => {
          lastCheckedUrl = "";
          pendingBlockedUrl = "";
          checkCurrentUrl();
        })
        .catch((error) => console.error("URL Blocker could not reload state.", error));
    }, 1500);

    api.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== "blocklistChanged") {
        return;
      }

      reloadState()
        .then(() => {
          lastCheckedUrl = "";
          pendingBlockedUrl = "";
          checkCurrentUrl();
        })
        .catch((error) => console.error("URL Blocker could not reload state.", error));
    });
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
    const currentUrl = location.href;

    if (currentUrl === lastCheckedUrl) {
      return;
    }

    lastCheckedUrl = currentUrl;

    const match = core.findMatchingEntry(state, currentUrl);

    switch (match.type) {
      case "none":
        pendingBlockedUrl = "";
        return;
      case "match":
        sendMatchedUrl(currentUrl);
        return;
      default:
        throw new Error(`Unknown match type: ${match.type}`);
    }
  }

  function sendMatchedUrl(url) {
    if (url === pendingBlockedUrl) {
      return;
    }

    pendingBlockedUrl = url;
    api.runtime.sendMessage({ type: "urlMatched", url })
      .then(handleUrlMatchedResponse)
      .catch((error) => {
        lastCheckedUrl = "";
        pendingBlockedUrl = "";
        console.error("URL Blocker could not redirect blocked URL.", error);
      });
  }

  function handleUrlMatchedResponse(response) {
    if (!response || typeof response.type !== "string") {
      throw new Error("urlMatched response must include a type.");
    }

    switch (response.type) {
      case "redirected":
        return;
      case "notRedirected":
        pendingBlockedUrl = "";
        return;
      case "error":
        pendingBlockedUrl = "";
        throw new Error(response.error);
      default:
        throw new Error(`Unknown urlMatched response: ${response.type}`);
    }
  }
})(globalThis);
