(function loadContentScript(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const SCREEN_TIME_POLL_MS = 5 * 1000;
  const MAX_SCREEN_TIME_ELAPSED_MS = 30 * 1000;
  const REFERRER_RECORD_PREFIX = "referrerRecords:";
  const REFERRER_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_REFERRER_RECORDS = 20;
  let lastSentUrl = "";
  let currentPageUrl = location.href;
  let arrival = { type: "unknown" };
  let arrivalNavigationType = currentNavigationType();
  const initPromise = initializeArrival();
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
    root.addEventListener("pageshow", pageShown);
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
    }, SCREEN_TIME_POLL_MS);
  }

  function pageShown(event) {
    updateScreenTimeUrl(Date.now());
    sendCurrentUrl(!!event.persisted);
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

  async function sendCurrentUrl(force) {
    await initPromise;

    const currentUrl = location.href;

    if (currentUrl !== currentPageUrl) {
      const previousUrl = currentPageUrl;

      currentPageUrl = currentUrl;

      // &/# changes stay on the same page, so they keep the page's arrival
      // instead of recording the page as its own referrer.
      if (pageChangeKey(previousUrl) !== pageChangeKey(currentUrl)) {
        arrival = { type: "known", url: previousUrl };
        arrivalNavigationType = "navigate";
        recordReferrer(currentUrl, previousUrl);
      }
    }

    if (!force && currentUrl === lastSentUrl) {
      return;
    }

    lastSentUrl = currentUrl;
    sendMessage(
      { type: "urlChanged", url: currentUrl, source: documentNavigationSource() },
      (error) => {
        lastSentUrl = "";
        console.error("URL Blocker could not check the current URL.", errorDetails(error));
      },
    );
  }

  function documentNavigationSource() {
    return {
      type: "document",
      referrer: arrival,
      navigationType: arrivalNavigationType
    };
  }

  async function initializeArrival() {
    switch (arrivalNavigationType) {
      case "navigate":
      case "prerender":
        arrival = { type: "known", url: documentReferrer() };
        recordReferrer(currentPageUrl, arrival.url);
        return;
      case "reload":
        arrival = await storedArrivalOrDocumentReferrer(currentPageUrl);
        return;
      case "back_forward":
        arrival = await storedArrivalOrUnknown(currentPageUrl);
        return;
      default:
        // Throwing here would reject initPromise and silently stop all URL
        // reporting, so an unrecognized navigation type fails closed instead.
        arrival = { type: "unknown" };
        return;
    }
  }

  async function storedArrivalOrDocumentReferrer(rawUrl) {
    try {
      const record = await newestReferrerRecord(rawUrl);

      if (record === null) {
        return { type: "known", url: documentReferrer() };
      }

      return { type: "known", url: record.referrer };
    } catch (error) {
      console.error("URL Blocker could not read referrer records.", errorDetails(error));

      return { type: "unknown" };
    }
  }

  async function storedArrivalOrUnknown(rawUrl) {
    try {
      const record = await newestReferrerRecord(rawUrl);

      if (record === null) {
        return { type: "unknown" };
      }

      return { type: "known", url: record.referrer };
    } catch (error) {
      console.error("URL Blocker could not read referrer records.", errorDetails(error));

      return { type: "unknown" };
    }
  }

  function documentReferrer() {
    return typeof document.referrer === "string" ? document.referrer : "";
  }

  function currentNavigationType() {
    if (!root.performance || typeof root.performance.getEntriesByType !== "function") {
      return "navigate";
    }

    const entries = root.performance.getEntriesByType("navigation");

    if (entries.length === 0 || typeof entries[0].type !== "string") {
      return "navigate";
    }

    return entries[0].type;
  }

  function recordReferrer(rawUrl, referrer) {
    writeReferrerRecord(rawUrl, referrer).catch((error) => {
      console.error("URL Blocker could not write referrer records.", errorDetails(error));
    });
  }

  async function newestReferrerRecord(rawUrl) {
    const key = referrerRecordKey(rawUrl);
    const stored = await api.storage.local.get(key);
    const records = unexpiredRecords(stored[key]);

    if (records.length === 0) {
      return null;
    }

    return records[records.length - 1];
  }

  async function writeReferrerRecord(rawUrl, referrer) {
    const key = referrerRecordKey(rawUrl);
    const stored = await api.storage.local.get(key);
    const records = [
      ...unexpiredRecords(stored[key]),
      { referrer, recordedAt: Date.now() }
    ].slice(-MAX_REFERRER_RECORDS);

    await api.storage.local.set({ [key]: { records } });
  }

  function unexpiredRecords(value) {
    if (!isPlainObject(value) || !Array.isArray(value.records)) {
      return [];
    }

    const expiresBefore = Date.now() - REFERRER_RECORD_RETENTION_MS;

    return value.records.filter((record) => isPlainObject(record)
      && typeof record.referrer === "string"
      && typeof record.recordedAt === "number"
      && record.recordedAt >= expiresBefore);
  }

  function referrerRecordKey(rawUrl) {
    return `${REFERRER_RECORD_PREFIX}${pageChangeKey(rawUrl)}`;
  }

  // Everything up to the first & or # identifies the page: extra query params
  // and fragments change on SPAs without the user leaving the page.
  function pageChangeKey(rawUrl) {
    return rawUrl.split(/[&#]/, 1)[0];
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
