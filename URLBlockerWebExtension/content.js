(function loadContentScript(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const SCREEN_TIME_POLL_MS = 5 * 1000;
  const MAX_SCREEN_TIME_ELAPSED_MS = 30 * 1000;
  const REFERRER_RECORD_PREFIX = "referrerRecords:";
  const REFERRER_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_REFERRER_RECORDS = 20;
  const YOUTUBE_FOCUS_ATTRIBUTE = "data-url-blocker-youtube-focus";
  const SHORT_VIDEO_SITE_ATTRIBUTE = "data-url-blocker-short-video";
  const PATH_ATTRIBUTE = "data-url-blocker-path";
  const SINGLE_SHORT_VIDEO_ATTRIBUTE = "data-url-blocker-single-short-video";
  const SINGLE_VIDEO_NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp"]);
  let lastSentUrl = "";
  let singleVideoLocked = false;
  let currentPageUrl = location.href;
  let arrival = { type: "unknown" };
  let arrivalNavigationType = currentNavigationType();
  const initPromise = initializeArrival();
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
    root.addEventListener("visibilitychange", syncVisibility);

    // The Navigation API reports every same-document URL change, including
    // pushState and replaceState calls from the page's own scripts.
    if (root.navigation) {
      root.navigation.addEventListener("currententrychange", checkCurrentUrl);
    } else {
      console.error("URL Blocker needs the Navigation API to check in-page URL changes immediately. They are checked every 5 seconds instead.");
    }

    // The poll logs screen time and rechecks the page so it blocks soon after
    // a time limit runs out.
    pollId = root.setInterval(() => {
      if (document.hidden) {
        return;
      }

      recheckCurrentUrl();
    }, SCREEN_TIME_POLL_MS);
  }

  function pageShown(event) {
    updateScreenTimeUrl(Date.now());
    sendCurrentUrl(event.persisted ? "document" : "none");
  }

  function teardown() {
    stopped = true;
    setSingleVideoLock(false);
    if (pollId !== 0) {
      root.clearInterval(pollId);
      pollId = 0;
    }
  }

  function syncVisibility() {
    if (document.hidden) {
      stopScreenTime();
    } else {
      checkCurrentUrl();
    }
  }

  function checkCurrentUrl() {
    updateScreenTimeUrl(Date.now());
    sendCurrentUrl("none");
  }

  function recheckCurrentUrl() {
    const now = Date.now();

    updateScreenTimeUrl(now);
    sendScreenTime(now);
    sendCurrentUrl("document");
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

    // The arrival lets the worker block the page right away if this time runs
    // out its limit. It is read after initialization and before a pending URL
    // change replaces it.
    initPromise.then(() => sendMessage(
      { type: "screenTimeElapsed", url, elapsedMs, source: documentNavigationSource() },
      (error) => console.error(`URL Blocker could not log screen time. ${errorLogText(error)}`),
    ));
  }

  async function sendCurrentUrl(sourceMode) {
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

    const source = urlCheckSource(sourceMode, currentUrl === lastSentUrl);

    if (source.type === "none") {
      return;
    }

    lastSentUrl = currentUrl;
    sendMessage(
      { type: "urlChanged", url: currentUrl, source },
      (error) => {
        lastSentUrl = "";
        console.error(`URL Blocker could not check the current URL. ${errorLogText(error)}`);
      },
      applyUrlChangedResponse,
    );
  }

  function urlCheckSource(sourceMode, sameUrl) {
    if (!sameUrl) {
      return documentNavigationSource();
    }

    switch (sourceMode) {
      case "none":
        return { type: "none" };
      case "document":
        return documentNavigationSource();
      default:
        throw new Error(`Unknown URL check source: ${sourceMode}`);
    }
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
        // A stored record is the page's real arrival, so the reload is judged
        // like that arrival. Without one the reload never expands root URLs.
        arrival = await storedArrivalOrUnknown(currentPageUrl);

        if (arrival.type === "known") {
          arrivalNavigationType = "navigate";
        } else {
          arrival = { type: "known", url: documentReferrer() };
        }

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

  async function storedArrivalOrUnknown(rawUrl) {
    try {
      const record = await newestReferrerRecord(rawUrl);

      if (record === null) {
        return { type: "unknown" };
      }

      return { type: "known", url: record.referrer };
    } catch (error) {
      console.error(`URL Blocker could not read referrer records. ${errorLogText(error)}`);

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
      console.error(`URL Blocker could not write referrer records. ${errorLogText(error)}`);
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

  function applyUrlChangedResponse(response) {
    if (!isPlainObject(response) || typeof response.type !== "string") {
      throw new Error("URL check response must include a type.");
    }

    switch (response.type) {
      case "allowed":
        setYoutubeFocus(response.youtubeFocus === true);
        setShortVideo(response.shortVideo);
        return;
      case "redirected":
        return;
      case "error":
        setYoutubeFocus(false);
        lastSentUrl = "";
        console.error(`URL Blocker could not check the current URL. ${response.error} (${response.errorCode || response.type})`);
        return;
      default:
        throw new Error(`Unknown URL check response: ${response.type}`);
    }
  }

  function setYoutubeFocus(enabled) {
    if (enabled) {
      document.documentElement.setAttribute(YOUTUBE_FOCUS_ATTRIBUTE, "true");
      return;
    }

    document.documentElement.removeAttribute(YOUTUBE_FOCUS_ATTRIBUTE);
  }

  // content.css hides short videos with rules keyed on these attributes; the
  // path lets a rule target one page type, like a site's home feed.
  function setShortVideo(shortVideo) {
    if (!isPlainObject(shortVideo) || typeof shortVideo.type !== "string") {
      throw new Error("URL check response must include short video handling.");
    }

    const html = document.documentElement;

    switch (shortVideo.type) {
      case "none":
        html.removeAttribute(SHORT_VIDEO_SITE_ATTRIBUTE);
        html.removeAttribute(PATH_ATTRIBUTE);
        setSingleVideoLock(false);
        return;
      case "feed":
      case "singleVideo":
        html.setAttribute(SHORT_VIDEO_SITE_ATTRIBUTE, shortVideo.site);
        html.setAttribute(PATH_ATTRIBUTE, location.pathname);
        setSingleVideoLock(shortVideo.type === "singleVideo");
        return;
      default:
        throw new Error(`Unknown short video handling: ${shortVideo.type}`);
    }
  }

  // On a single short video page, wheel, swipe, and arrow keys would move to
  // the next video, so they are swallowed before the page sees them.
  function setSingleVideoLock(locked) {
    if (locked === singleVideoLocked) {
      return;
    }

    singleVideoLocked = locked;

    if (locked) {
      document.documentElement.setAttribute(SINGLE_SHORT_VIDEO_ATTRIBUTE, "true");
      root.addEventListener("wheel", swallowScroll, { capture: true, passive: false });
      root.addEventListener("touchmove", swallowScroll, { capture: true, passive: false });
      root.addEventListener("keydown", swallowNavigationKey, true);
      return;
    }

    document.documentElement.removeAttribute(SINGLE_SHORT_VIDEO_ATTRIBUTE);
    root.removeEventListener("wheel", swallowScroll, true);
    root.removeEventListener("touchmove", swallowScroll, true);
    root.removeEventListener("keydown", swallowNavigationKey, true);
  }

  function swallowScroll(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function swallowNavigationKey(event) {
    const target = event.target;

    if (!SINGLE_VIDEO_NAVIGATION_KEYS.has(event.key) || target.isContentEditable || ["INPUT", "TEXTAREA"].includes(target.tagName)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function sendMessage(payload, onError, onResponse = null) {
    if (stopped || !api.runtime?.id) {
      teardown();
      return;
    }

    try {
      api.runtime.sendMessage(payload).then((response) => {
        if (!api.runtime?.id) {
          teardown();
          return;
        }

        if (onResponse) {
          onResponse(response);
        }
      }).catch((error) => {
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
