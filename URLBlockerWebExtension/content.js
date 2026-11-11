(function loadContentScript(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const SCREEN_TIME_POLL_MS = 5 * 1000;
  const MAX_SCREEN_TIME_ELAPSED_MS = 30 * 1000;
  const SHORT_VIDEO_SITE_ATTRIBUTE = "data-url-blocker-short-video";
  const PATH_ATTRIBUTE = "data-url-blocker-path";
  const SINGLE_SHORT_VIDEO_ATTRIBUTE = "data-url-blocker-single-short-video";
  const SINGLE_VIDEO_NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp"]);
  const SILENT_POLLS_BEFORE_COVER = 2;
  const COVER_ID = "url-blocker-cover";
  // Chromium injects a new script into open tabs after an update, so the
  // orphaned one must not cover a page the new one now watches.
  const SCRIPT_ATTRIBUTE = "data-url-blocker-script";
  const scriptId = String(Math.random());
  const COVER_STYLE = [
    "all: initial",
    "position: fixed",
    "inset: 0",
    "z-index: 2147483647",
    "display: flex",
    "align-items: center",
    "justify-content: center",
    "padding: 24px",
    "background: #fff",
    "color: #111",
    "font: 600 20px/1.5 -apple-system, system-ui, sans-serif",
    "text-align: center",
    "white-space: pre-line"
  ].map((rule) => `${rule} !important`).join("; ");
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
  // answered: the last page check got a reply. waiting: checks have gone
  // unanswered since sinceMs, through `polls` visible polls. covered: the
  // page is covered until a check gets a reply.
  let silence = { type: "answered" };

  start();

  function start() {
    document.documentElement.setAttribute(SCRIPT_ATTRIBUTE, scriptId);
    removeCover();
    watchPage();
    checkCurrentUrl();
  }

  function watchPage() {
    root.addEventListener("pageshow", pageShown);
    root.addEventListener("pagehide", pageHidden);
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

      countSilentPoll();
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

  // The extension was updated, reloaded, or removed, so nothing checks this
  // page until it reloads.
  function teardown() {
    if (stopped) {
      return;
    }

    stopped = true;
    setSingleVideoLock(false);
    root.clearInterval(pollId);
    showCover("URL Blocker stopped running on this page.\nReload the page to continue.");
  }

  function syncVisibility() {
    if (document.hidden) {
      pageHidden();
    } else {
      checkCurrentUrl();
    }
  }

  // A hidden page may be frozen with a check in flight, so the count starts
  // over once it is visible again.
  function pageHidden() {
    stopScreenTime();

    if (silence.type === "waiting") {
      silence = { ...silence, polls: 0 };
    }
  }

  function countSilentPoll() {
    if (silence.type !== "waiting") {
      return;
    }

    if (silence.polls + 1 < SILENT_POLLS_BEFORE_COVER) {
      silence = { ...silence, polls: silence.polls + 1 };
      return;
    }

    silence = { type: "covered", sinceMs: silence.sinceMs };
    showCover("URL Blocker isn't responding.\nThis page stays covered until it answers.");
  }

  function checkAnswered() {
    if (silence.type === "covered") {
      removeCover();
      sendMessage(
        { type: "reportSilence", url: location.href, sinceMs: silence.sinceMs },
        (error) => console.error(`URL Blocker could not report its silence. ${errorLogText(error)}`),
      );
    }

    silence = { type: "answered" };
  }

  function showCover(text) {
    if (document.documentElement.getAttribute(SCRIPT_ATTRIBUTE) !== scriptId) {
      return;
    }

    removeCover();

    const cover = document.createElement("div");

    cover.id = COVER_ID;
    cover.setAttribute("style", COVER_STYLE);
    cover.textContent = text;
    document.documentElement.append(cover);
    document.querySelectorAll("video, audio").forEach((media) => media.pause());
  }

  function removeCover() {
    document.getElementById(COVER_ID)?.remove();
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

    if (silence.type === "answered") {
      silence = { type: "waiting", sinceMs: Date.now(), polls: 0 };
    }

    sendMessage(
      { type: "checkPage", url: currentUrl, arrival },
      (error) => console.error(`URL Blocker could not check the current URL. ${errorLogText(error)}`),
      (response) => {
        checkAnswered();
        applyCheckPageResponse(response, currentUrl);
      },
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
