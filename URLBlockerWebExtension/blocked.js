(function loadBlockedPage(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const blockedCard = document.getElementById("blockedCard");
  const blockedMessage = document.getElementById("blockedMessage");
  const blockedReason = document.getElementById("blockedReason");
  const blockedTarget = document.getElementById("blockedTarget");
  const closeButton = document.getElementById("closeButton");
  const blockedUrl = decodeBlockedUrl();
  const reasonText = root.BlockerCore.blockedReasonText(decodeBlockedReason());
  const fallbackHtml = "<h1>Blocked</h1><p>This page is on your blocklist.</p>";

  closeButton.addEventListener("click", closeCurrentTab);
  blockedTarget.addEventListener("click", () => {
    openBlockedTarget().catch((error) => console.error(`URL Blocker could not open the blocked page. ${errorLogText(error)}`));
  });
  loadBlockedPageHtml().catch((error) => {
    renderBlockedPage(fallbackHtml);
    console.warn(`URL Blocker could not load the blocked page settings. ${errorLogText(error)}`);
  });

  async function loadBlockedPageHtml() {
    const response = await api.runtime.sendMessage({ type: "getBlockedPageHtml" });

    switch (response.type) {
      case "blockedPageHtml":
        renderBlockedPage(response.html);
        return;
      case "blockedPageHtmlError":
      case "error":
        renderBlockedPage(fallbackHtml);
        console.warn(`URL Blocker could not load custom blocked page HTML. ${response.error} (${response.errorCode || response.type})`);
        return;
      default:
        throw new Error(`Unknown getBlockedPageHtml response: ${response.type}`);
    }
  }

  function renderBlockedPage(html) {
    blockedMessage.innerHTML = html;
    blockedMessage.hidden = html === "";
    blockedReason.textContent = reasonText;
    blockedTarget.hidden = blockedUrl === "";
    blockedTarget.textContent = blockedUrl;
    blockedCard.removeAttribute("data-loading");
  }

  function decodeBlockedUrl() {
    if (location.hash.length <= 1) {
      return "";
    }

    return decodeURIComponent(location.hash.slice(1));
  }

  function decodeBlockedReason() {
    const reason = new URLSearchParams(location.search).get("reason");

    if (reason === null) {
      throw new Error("Blocked page reason is required.");
    }

    return reason;
  }

  // The worker opens the target only if it is no longer blocked.
  async function openBlockedTarget() {
    const response = await api.runtime.sendMessage({ type: "openBlockedTarget", url: blockedUrl });

    switch (response.type) {
      case "opened":
      case "redirected":
        return;
      case "error":
        throw response;
      default:
        throw new Error(`Unknown openBlockedTarget response: ${response.type}`);
    }
  }

  async function closeCurrentTab() {
    const tab = await api.tabs.getCurrent();

    if (!tab || typeof tab.id !== "number") {
      return;
    }

    await api.tabs.remove(tab.id);
  }

  // Browser extension error panes stringify console arguments, so log errors as
  // one formatted string instead of an object that renders as [object Object].
  function errorLogText(error) {
    if (error instanceof Error) {
      return `${error.message} (${error.errorCode || error.code || error.name})`;
    }

    if (isPlainObject(error)) {
      const code = typeof error.errorCode === "string" ? error.errorCode : error.code;

      return `${JSON.stringify(error)} (${code === undefined ? "UnknownError" : String(code)})`;
    }

    return `${String(error)} (UnknownError)`;
  }

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
})(globalThis);
