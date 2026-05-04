(function loadContentScript(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const core = root.BlockerCore;
  const BLOCKED_PAGE_CSS = `
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; }
    body.blocked-page { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #121512; color: #f7f7f2; }
    .blocked-card { width: min(420px, calc(100vw - 32px)); padding: 28px; border: 1px solid #30382f; border-radius: 8px; background: #1e241e; text-align: center; }
    #blockedMessage { font-size: 17px; line-height: 1.4; }
    #blockedMessage h1 { margin: 0 0 6px; font-size: 28px; line-height: 1.1; }
    #blockedMessage p { margin: 0; }
    #blockedTarget { margin: 16px 0 20px; color: #c7cec4; overflow-wrap: anywhere; }
    #closeButton { min-height: 40px; border: 0; border-radius: 8px; padding: 0 18px; background: #0f766e; color: white; font: inherit; }
  `;
  let state = core.emptyState();
  let lastCheckedUrl = "";
  let queuedCheck = 0;
  let blockedPageVisible = false;

  start().catch((error) => {
    console.error("URL Blocker content script failed to start.", error);
  });

  async function start() {
    await reloadState();
    checkCurrentUrl();
    watchPage();
  }

  async function reloadState() {
    const stored = await api.storage.local.get(core.STATE_KEY);
    state = core.parseStoredState(stored[core.STATE_KEY]);
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
      if (!document.hidden) {
        checkCurrentUrl();
      }
    }, 750);

    api.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== "blocklistChanged") {
        return;
      }

      reloadState()
        .then(() => {
          lastCheckedUrl = "";
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

    if (currentUrl === lastCheckedUrl && blockedPageVisible) {
      return;
    }

    lastCheckedUrl = currentUrl;

    const match = core.findMatchingEntry(state, currentUrl);

    if (match.type === "none") {
      reloadUnblockedPage();
      return;
    }

    renderBlockedPage(currentUrl);
  }

  function renderBlockedPage(url) {
    if (blockedPageVisible) {
      return;
    }

    if (!document.documentElement) {
      throw new Error("Blocked page needs a document element.");
    }

    const head = document.createElement("head");
    const body = document.createElement("body");
    const charset = document.createElement("meta");
    const viewport = document.createElement("meta");
    const style = document.createElement("style");
    const title = document.createElement("title");
    const card = document.createElement("main");
    const message = document.createElement("div");
    const target = document.createElement("p");
    const closeButton = document.createElement("button");

    charset.setAttribute("charset", "utf-8");
    viewport.name = "viewport";
    viewport.content = "width=device-width, initial-scale=1";
    style.textContent = BLOCKED_PAGE_CSS;
    title.textContent = "Blocked";
    body.className = "blocked-page";
    card.className = "blocked-card";
    message.id = "blockedMessage";
    target.id = "blockedTarget";
    target.textContent = url;
    closeButton.id = "closeButton";
    closeButton.type = "button";
    closeButton.textContent = "Close";

    message.innerHTML = state.blockedPageHtml;
    message.hidden = state.blockedPageHtml === "";
    closeButton.addEventListener("click", closeCurrentTab);

    head.append(charset, viewport, title, style);
    card.append(message, target, closeButton);
    body.append(card);
    document.documentElement.replaceChildren(head, body);
    blockedPageVisible = true;
    stopPageLoad();
  }

  function stopPageLoad() {
    root.stop();
    root.requestAnimationFrame(() => root.stop());
    root.setTimeout(() => root.stop(), 50);
  }

  function reloadUnblockedPage() {
    if (!blockedPageVisible) {
      return;
    }

    location.reload();
  }

  function closeCurrentTab() {
    api.runtime.sendMessage({ type: "closeCurrentTab" }).catch(() => undefined);
  }
})(globalThis);
