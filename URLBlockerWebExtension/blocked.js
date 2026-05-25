(function loadBlockedPage(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const blockedCard = document.getElementById("blockedCard");
  const blockedMessage = document.getElementById("blockedMessage");
  const blockedTarget = document.getElementById("blockedTarget");
  const closeButton = document.getElementById("closeButton");
  const blockedUrl = decodeBlockedUrl();
  const fallbackHtml = "<h1>Blocked</h1><p>This page is on your blocklist.</p>";

  closeButton.addEventListener("click", closeCurrentTab);
  loadBlockedPageHtml().catch((error) => {
    renderBlockedPage(fallbackHtml);
    console.warn("URL Blocker could not load the blocked page settings.", errorDetails(error));
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
        console.warn("URL Blocker could not load custom blocked page HTML.", {
          message: response.error,
          code: response.errorCode || response.type
        });
        return;
      default:
        throw new Error(`Unknown getBlockedPageHtml response: ${response.type}`);
    }
  }

  function renderBlockedPage(html) {
    blockedMessage.innerHTML = html;
    blockedMessage.hidden = html === "";
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

  async function closeCurrentTab() {
    const tab = await api.tabs.getCurrent();

    if (!tab || typeof tab.id !== "number") {
      return;
    }

    await api.tabs.remove(tab.id);
  }

  function errorDetails(error) {
    if (error instanceof Error) {
      return { message: error.message, code: error.errorCode || error.code || error.name };
    }

    return { message: String(error), code: "UnknownError" };
  }
})(globalThis);
