(function loadBlockedPage(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const blockedCard = document.getElementById("blockedCard");
  const blockedMessage = document.getElementById("blockedMessage");
  const blockedReason = document.getElementById("blockedReason");
  const blockedTarget = document.getElementById("blockedTarget");
  const closeButton = document.getElementById("closeButton");
  const blockedUrl = decodeBlockedUrl();
  const reasonText = blockedReasonText(decodeBlockedReason());
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

  function blockedReasonText(reason) {
    switch (reason) {
      case "hardScheduleDomain":
        return "All pages on this site are blocked during your hard block schedule.";
      case "scheduleDirectMatch":
        return "This page is blocked during your schedule.";
      case "limitDirectMatch":
        return "You've reached your time limit for this site.";
      case "scheduleRootDirectNavigation":
        return "Direct visits to this blocked site are blocked during your schedule.";
      case "limitRootDirectNavigation":
        return "Direct visits to this site are blocked because you've reached your time limit.";
      case "scheduleRootSameDomainNavigation":
        return "Links within this blocked site are blocked during your schedule.";
      case "limitRootSameDomainNavigation":
        return "Links within this site are blocked because you've reached your time limit.";
      default:
        throw new Error(`Unknown blocked page reason: ${reason}`);
    }
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

    if (isPlainObject(error)) {
      const code = typeof error.errorCode === "string" ? error.errorCode : error.code;

      return { message: JSON.stringify(error), code: code === undefined ? "UnknownError" : String(code) };
    }

    return { message: String(error), code: "UnknownError" };
  }

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
})(globalThis);
