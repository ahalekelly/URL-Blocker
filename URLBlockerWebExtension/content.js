(function loadContentScript(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const SCREEN_TIME_POLL_MS = 5 * 1000;
  const MAX_SCREEN_TIME_ELAPSED_MS = 30 * 1000;
  const SHORT_VIDEO_SITE_ATTRIBUTE = "data-url-blocker-short-video";
  const PATH_ATTRIBUTE = "data-url-blocker-path";
  const SINGLE_SHORT_VIDEO_ATTRIBUTE = "data-url-blocker-single-short-video";
  const SINGLE_VIDEO_NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp"]);
  let singleVideoLocked = false;
  let currentPageUrl = location.href;
  // Back/Forward reloads a page with the referrer of the document's first
  // load, which on SPAs is the outside link that opened an earlier page.
  let arrival = historyLoad()
    ? { type: "history" }
    : { type: "referrer", url: document.referrer };
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
      root.navigation.addEventListener("currententrychange", (event) => {
        // Sites rewrite their own URL in place, like Reddit adding a title
        // slug, so a replace keeps the page's referrer.
        if (event.navigationType === "replace") {
          currentPageUrl = location.href;
        }

        checkCurrentUrl();
      });
    } else {
      console.error("URL Blocker needs the Navigation API to check in-page URL changes immediately. They are checked every 5 seconds instead.");
    }

    // The poll logs screen time and rechecks the page so it blocks soon after
    // the hard schedule starts, or a feed runs out its limit.
    pollId = root.setInterval(() => {
      if (document.hidden) {
        return;
      }

      const now = Date.now();

      updateScreenTimeUrl(now);
      sendScreenTime(now);
      sendCurrentUrl();
    }, SCREEN_TIME_POLL_MS);
  }

  function pageShown(event) {
    updateScreenTimeUrl(Date.now());

    if (event.persisted) {
      arrival = { type: "history" };
      sendCurrentUrl();
    }
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
    sendCurrentUrl();
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

    sendMessage(
      { type: "screenTimeElapsed", url: screenTimeUrl, elapsedMs },
      (error) => console.error(`URL Blocker could not log screen time. ${errorLogText(error)}`),
    );
  }

  function sendCurrentUrl() {
    const currentUrl = location.href;

    // After an in-page URL change the previous URL is the referrer, so the
    // worker counts it as a hop inside the site unless the tab holds a pass.
    if (currentUrl !== currentPageUrl) {
      arrival = { type: "referrer", url: currentPageUrl };
      currentPageUrl = currentUrl;
    }

    sendMessage(
      { type: "checkPage", url: currentUrl, arrival },
      (error) => console.error(`URL Blocker could not check the current URL. ${errorLogText(error)}`),
      (response) => applyCheckPageResponse(response, currentUrl),
    );
  }

  function historyLoad() {
    const [entry] = performance.getEntriesByType("navigation");

    return entry !== undefined && entry.type === "back_forward";
  }

  function applyCheckPageResponse(response, checkedUrl) {
    if (!isPlainObject(response) || typeof response.type !== "string") {
      throw new Error("URL check response must include a type.");
    }

    switch (response.type) {
      case "allowed":
        // A newer check covers the current URL, so a response for an earlier
        // URL would tag the page with stale settings.
        if (checkedUrl !== location.href) {
          return;
        }

        setShortVideo(response.shortVideo, new URL(checkedUrl).pathname);
        return;
      case "redirected":
        return;
      case "error":
        console.error(`URL Blocker could not check the current URL. ${response.error} (${response.errorCode || response.type})`);
        return;
      default:
        throw new Error(`Unknown URL check response: ${response.type}`);
    }
  }

  // content.css hides short videos with rules keyed on these attributes; the
  // path lets a rule target one page type, like a site's home feed.
  function setShortVideo(shortVideo, path) {
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
        html.setAttribute(PATH_ATTRIBUTE, path);
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
