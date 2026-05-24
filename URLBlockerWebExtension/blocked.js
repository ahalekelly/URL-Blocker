(function loadBlockedPage(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const blockedMessage = document.getElementById("blockedMessage");
  const blockedTarget = document.getElementById("blockedTarget");
  const closeButton = document.getElementById("closeButton");
  const blockedUrl = decodeBlockedUrl();
  const fallbackHtml = "<h1>Blocked</h1><p>This page is on your blocklist.</p>";

  closeButton.addEventListener("click", closeCurrentTab);
  loadState().catch((error) => {
    console.error("URL Blocker could not load the blocked page settings.", errorDetails(error));
    renderBlockedPage(fallbackHtml);
  });

  async function loadState() {
    const response = await api.runtime.sendMessage({ type: "getState" });

    switch (response.type) {
      case "state":
        renderBlockedPage(response.state.blockedPageHtml);
        return;
      case "stateError":
      case "error":
        console.error("URL Blocker could not load custom blocked page HTML.", {
          message: response.error,
          code: response.errorCode || response.type
        });
        renderBlockedPage(fallbackHtml);
        return;
      default:
        throw new Error(`Unknown getState response: ${response.type}`);
    }
  }

  function renderBlockedPage(html) {
    blockedMessage.innerHTML = html;
    blockedMessage.hidden = html === "";
    blockedTarget.hidden = blockedUrl === "";
    blockedTarget.textContent = blockedUrl;
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
