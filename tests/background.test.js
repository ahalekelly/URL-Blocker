const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../URLBlockerWebExtension/blocker.js");
const defaultBlockedPages = require("../URLBlockerWebExtension/default-blocked-pages.json");
const manifest = require("../URLBlockerWebExtension/manifest.json");
const sync = require("../URLBlockerWebExtension/supabase-sync.js");
const { createBackgroundController } = require("../URLBlockerWebExtension/background.js");

const id = "11111111-1111-4111-8111-111111111111";
const referrerRecordPrefix = "referrerRecords:";
const referrerRecordRetentionMs = 30 * 24 * 60 * 60 * 1000;
const defaultDocumentSource = { type: "document", referrer: knownReferrer("https://other.example/from"), navigationType: "navigate" };
const internalYoutubeSource = { type: "document", referrer: knownReferrer("https://www.youtube.com/"), navigationType: "navigate" };

function knownReferrer(url) {
  return { type: "known", url };
}

function unknownReferrer() {
  return { type: "unknown" };
}

function urlChangedMessage(url, source = defaultDocumentSource) {
  return { type: "urlChanged", url, source };
}

function blockedUrl(url, reason, scheme = "safari-web-extension") {
  return `${scheme}://extension/blocked.html?reason=${reason}#${encodeURIComponent(url)}`;
}

test("saveState validates, writes storage, and queues settings activation", async () => {
  const api = fakeApi({ now: 0 });
  const controller = createBackgroundController(api);
  const defaultState = core.emptyState(defaultBlockedPages);
  const response = await controller.handleMessage({
    type: "saveState",
    state: validState([{ id, kind: "url", value: "https://x.com/home?foo=bar" }])
  }, {});

  assert.equal(response.type, "saved");
  assert.equal(response.state.entries[0].value, "x.com");
  assert.equal(response.state.blockedPageHtml, "<p>Blocked.</p>");
  assert.equal(api.storageData[core.STATE_KEY].entries[0].value, "x.com");
  assert.deepEqual(api.storageData[core.BLOCKED_PAGE_HTML_KEY], { html: defaultState.blockedPageHtml });
  assert.deepEqual(api.storageData.settingsActivation.activeState, defaultState);
  assert.deepEqual(api.storageData.settingsActivation.pending, {
    type: "pending",
    state: response.state,
    effectiveAtMs: 60 * 60 * 1000
  });
  assert.deepEqual(api.registeredScripts[0].js, ["content.js"]);
  assert.deepEqual(api.registeredScripts[0].css, ["content.css"]);
  assert.deepEqual(api.registeredScripts[0].matches, core.permissionOriginsForState(defaultState));

  api.nowValue = 60 * 60 * 1000;

  assert.deepEqual(await controller.loadState(), response.state);
  assert.deepEqual(api.storageData[core.BLOCKED_PAGE_HTML_KEY], { html: "<p>Blocked.</p>" });
});

test("saveState settles zero-minute settings delay through activation", async () => {
  const api = fakeApi({ now: 5000 });
  const controller = createBackgroundController(api);
  const activeState = {
    ...core.emptyState(defaultBlockedPages),
    settingsDelay: { delayMinutes: 0 }
  };
  const nextState = validState([{ id, kind: "url", value: "https://x.com/home" }]);

  api.storageData[core.STATE_KEY] = activeState;
  api.storageData.settingsActivation = {
    schemaVersion: 1,
    activeState,
    pending: { type: "none" }
  };
  api.storageData[core.BLOCKED_PAGE_HTML_KEY] = { html: activeState.blockedPageHtml };

  const response = await controller.handleMessage({ type: "saveState", state: nextState }, {});

  assert.equal(response.type, "saved");
  assert.deepEqual(response.activation, { type: "active" });
  assert.deepEqual(api.storageData.settingsActivation, {
    schemaVersion: 1,
    activeState: response.state,
    pending: { type: "none" }
  });
  assert.deepEqual(api.storageData[core.BLOCKED_PAGE_HTML_KEY], { html: response.state.blockedPageHtml });
  assert.deepEqual(api.registeredScripts.at(-1).matches, core.contentScriptOriginsForState(response.state));
});

test("saveState keeps matching content script registration", async () => {
  const api = fakeApi();
  const controller = createBackgroundController(api);
  const state = validState([{ id, kind: "url", value: "https://x.com/home" }]);
  const defaultState = core.emptyState(defaultBlockedPages);

  api.registeredScripts = [{
    id: "url-blocker-content",
    js: ["content.js"],
    css: ["content.css"],
    matches: core.permissionOriginsForState(defaultState),
    runAt: "document_start"
  }];

  const response = await controller.handleMessage({ type: "saveState", state }, {});

  assert.equal(response.type, "saved");
  assert.deepEqual(api.scriptRegistrations, []);
  assert.deepEqual(api.scriptUnregistrations, []);
  assert.deepEqual(api.registeredScripts[0].matches, core.permissionOriginsForState(defaultState));
});

test("getState loads default blocked pages when storage is empty", async () => {
  const controller = createBackgroundController(fakeApi());
  const response = await controller.getState();

  assert.equal(response.type, "state");
  assert.deepEqual(response.state.entries, core.emptyState(defaultBlockedPages).entries);
  assert.deepEqual(response.state.schedule, { type: "dailyWindow", startMinute: 1380, endMinute: 1140 });
  assert.deepEqual(response.state.hardSchedule, { type: "off" });
  assert.deepEqual(response.state.limitReset, { type: "rollingWindow", windowHours: 24 });
  assert.deepEqual(response.state.domainLimits, core.emptyState(defaultBlockedPages).domainLimits);
});

test("getState reports plain object errors with details", async () => {
  const api = fakeApi();

  api.storage.local.get = async () => {
    throw { message: "Storage request failed.", code: "StorageTestError" };
  };

  const response = await createBackgroundController(api).getState();

  assert.deepEqual(response, {
    type: "stateError",
    error: JSON.stringify({ message: "Storage request failed.", code: "StorageTestError" }),
    errorCode: "StorageTestError"
  });
});

test("getLocalState resets unsupported stored blocklist versions", async () => {
  const api = fakeApi();
  const defaultState = core.emptyState(defaultBlockedPages);

  api.storageData[core.STATE_KEY] = {
    ...validState([]),
    schemaVersion: core.SCHEMA_VERSION + 1
  };

  const response = await createBackgroundController(api).getLocalState();

  assert.equal(response.type, "state");
  assert.deepEqual(response.state, defaultState);
  assert.deepEqual(api.storageData[core.STATE_KEY], defaultState);
  assert.deepEqual(api.storageData[core.BLOCKED_PAGE_HTML_KEY], { html: defaultState.blockedPageHtml });
  assert.equal(api.storageData.settingsSync.dirty, true);
  assert.deepEqual(api.registeredScripts[0].matches, core.permissionOriginsForState(defaultState));
});

test("getBlockedPageHtml reads the cached HTML without remote settings sync", async () => {
  const fetch = globalThis.fetch;
  const userSettingsUrls = [];
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });

  api.storageData[core.BLOCKED_PAGE_HTML_KEY] = { html: "<p>Fast.</p>" };
  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/user_settings")) {
      userSettingsUrls.push(String(url));
      return jsonResponse([]);
    }

    return fetch(url, options);
  };

  try {
    const response = await createBackgroundController(api).handleMessage({ type: "getBlockedPageHtml" }, {});

    assert.deepEqual(response, { type: "blockedPageHtml", html: "<p>Fast.</p>" });
    assert.equal(userSettingsUrls.length, 0);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("getBlockedPageHtml backfills the cached HTML", async () => {
  const api = fakeApi();
  const state = validState([]);

  api.storageData[core.STATE_KEY] = state;
  const response = await createBackgroundController(api).getBlockedPageHtml();

  assert.deepEqual(response, { type: "blockedPageHtml", html: state.blockedPageHtml });
  assert.deepEqual(api.storageData[core.BLOCKED_PAGE_HTML_KEY], { html: state.blockedPageHtml });
});

test("getState loads default blocked pages without runtime getURL", async () => {
  const api = fakeApi();
  const fetch = globalThis.fetch;
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");

  delete api.runtime.getURL;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "safari-web-extension://extension/background.js" }
  });
  globalThis.fetch = async (url) => {
    if (url === "safari-web-extension://extension/supabase-config.json") {
      return jsonResponse({
        schemaVersion: 1,
        supabaseUrl: "",
        publishableKey: "",
        redirectScheme: "urlblocker",
        screenTimeSyncAgeMs: 60000
      });
    }

    assert.equal(url, "safari-web-extension://extension/default-blocked-pages.json");

    return {
      ok: true,
      async json() {
        return defaultBlockedPages;
      }
    };
  };

  try {
    const response = await createBackgroundController(api).getState();

    assert.equal(response.type, "state");
    assert.deepEqual(response.state.entries, core.emptyState(defaultBlockedPages).entries);
  } finally {
    globalThis.fetch = fetch;

    if (location) {
      Object.defineProperty(globalThis, "location", location);
    } else {
      delete globalThis.location;
    }
  }
});

test("saveState rejects unsupported old state", async () => {
  const api = fakeApi();
  const controller = createBackgroundController(api);
  const response = await controller.saveState({
    schemaVersion: 3,
    entries: [{ id, kind: "domain", value: "example.com" }],
    blockedPageHtml: "<p>Blocked.</p>",
    useSafariBlockingApi: true
  });

  assert.equal(response.type, "validationError");
  assert.match(response.errors[0].message, /Unsupported/);
  assert.equal(api.storageData[core.STATE_KEY], undefined);
});

test("saveState removes access for sites no longer blocked", async () => {
  const api = fakeApi();
  const controller = createBackgroundController(api);
  const response = await controller.saveState(validState([
    { id, kind: "domain", value: "reddit.com" },
    { id: "22222222-2222-4222-8222-222222222222", kind: "url", value: "https://x.com/home" }
  ]));
  const finishResponse = await controller.finishSavedState();

  assert.equal(response.type, "saved");
  assert.equal(finishResponse.type, "finishedSavedState");
  assert.deepEqual(api.registeredScripts[0].matches, core.permissionOriginsForState(core.emptyState(defaultBlockedPages)));
  assert.deepEqual(api.removedOrigins, ["*://*.example.com/*"]);
});

test("saveState keeps install-time permissions when they are no longer blocked", async () => {
  const api = fakeApi({ grantedOrigins: ["*://*.example.com/*", "*://*.youtube.com/*"] });
  const controller = createBackgroundController(api);
  const response = await controller.saveState(validState([]));
  const finishResponse = await controller.finishSavedState();

  assert.equal(response.type, "saved");
  assert.equal(finishResponse.type, "finishedSavedState");
  assert.deepEqual(api.removedOrigins, ["*://*.example.com/*"]);
  assert.deepEqual(api.grantedOrigins, ["*://*.youtube.com/*"]);
});

test("getDefaultState returns default blocked pages without saving", async () => {
  const api = fakeApi();
  const storedState = validState([]);

  api.storageData[core.STATE_KEY] = storedState;
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "getDefaultState" }, {});

  assert.equal(response.type, "state");
  assert.deepEqual(response.state.entries, core.emptyState(defaultBlockedPages).entries);
  assert.equal(api.storageData[core.STATE_KEY], storedState);
});

test("getDefaultState returns debug codes when default pages fail to load", async () => {
  const api = fakeApi();
  const fetch = globalThis.fetch;

  api.runtime.getURL = (path) => `file:///extension/${path}`;
  globalThis.fetch = async (url) => {
    const error = new TypeError("Load failed");

    assert.equal(url, "file:///extension/default-blocked-pages.json");
    error.code = -1001;
    throw error;
  };

  try {
    const response = await createBackgroundController(api).getDefaultState();

    assert.equal(response.type, "error");
    assert.match(response.error, /Load failed/);
    assert.match(response.errorCode, /DefaultBlockedPagesLoadFailed/);
    assert.match(response.errorCode, /-1001/);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("saveState registers the literal regex host", async () => {
  const api = fakeApi({ grantedOrigins: ["*://*.x.com/*", "*://*.example.com/*"] });
  const controller = createBackgroundController(api);
  const response = await controller.saveState(validState([
    { id, kind: "regex", value: "^https://x\\.com/(home|explore)/?$" }
  ]));
  const finishResponse = await controller.finishSavedState();

  assert.equal(response.type, "saved");
  assert.equal(finishResponse.type, "finishedSavedState");
  assert.deepEqual(api.registeredScripts[0].matches, core.permissionOriginsForState(core.emptyState(defaultBlockedPages)));
  assert.deepEqual(api.removedOrigins, ["*://*.example.com/*"]);
});

test("missing website access returns an error response", async () => {
  const api = fakeApi({ grantedOrigins: [] });
  const controller = createBackgroundController(api);
  await assert.rejects(() => controller.handleMessage({
    type: "saveState",
    state: validState([{ id, kind: "url", value: "https://x.com/home" }])
  }, {}), /Website access/);

  assert.equal(api.storageData[core.STATE_KEY], undefined);
});

test("failed validation leaves storage untouched", async () => {
  const api = fakeApi();
  const controller = createBackgroundController(api);
  const response = await controller.saveState({
    schemaVersion: 1,
    entries: [{ id, kind: "domain", value: "https://example.com" }]
  });

  assert.equal(response.type, "validationError");
  assert.equal(api.storageData[core.STATE_KEY], undefined);
});

test("unknown messages raise errors", async () => {
  const controller = createBackgroundController(fakeApi());

  await assert.rejects(() => controller.handleMessage({ type: "mystery" }, {}), /Unknown message type/);
});

test("openOptions opens the options page in a tab", async () => {
  const api = fakeApi();
  const controller = createBackgroundController(api);
  const response = await controller.openOptions();

  assert.equal(response.type, "opened");
  assert.equal(api.createdTab, "safari-web-extension://extension/options.html");
});

test("syncWebsiteAccess registers content scripts for the saved blocklist", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com/home" }
  ]);

  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "syncWebsiteAccess" }, {});

  assert.equal(response.type, "synced");
  assert.deepEqual(api.registeredScripts[0].matches, ["*://*.facebook.com/*", "*://*.instagram.com/*", "*://*.linkedin.com/*", "*://*.twitter.com/*", "*://*.x.com/*", "*://*.youtube.com/*"]);
});

test("urlChanged redirects matching sender tab to the blocked page", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage(urlChangedMessage("https://x.com/home"), { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://x.com/home", "scheduleDirectMatch")
  }]);
});

test("urlChanged allows URLs that no longer match saved state", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com" }
  ]);
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage(urlChangedMessage("https://x.com/messages"), { tab: { id: 7 } });

  assert.equal(response.type, "allowed");
  assert.deepEqual(api.updatedTabs, []);
});

test("urlChanged redirects deep links during the hard schedule", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com" }
  ], inactiveSchedule(), undefined, core.DEFAULT_LIMIT_RESET, activeSchedule());
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage(urlChangedMessage("https://x.com/messages"), { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://x.com/messages", "hardScheduleDomain")
  }]);
});

test("urlChanged opens YouTube Shorts as single videos despite a blocking Shorts entry", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "urlWithSubpaths", value: "youtube.com/shorts" }
  ], activeSchedule());
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage(urlChangedMessage("https://www.youtube.com/shorts/abc"), { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{ tabId: 7, url: "https://www.youtube.com/watch?v=abc" }]);
});

test("urlChanged reports short video hiding for allowed pages", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com" }
  ], inactiveSchedule());
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage(urlChangedMessage("https://www.facebook.com/reel/123"), { tab: { id: 7 } }), {
    type: "allowed",
    youtubeFocus: false,
    shortVideo: { type: "singleVideo", site: "facebook" }
  });
  assert.deepEqual(await controller.handleMessage(urlChangedMessage("https://x.com/home"), { tab: { id: 7 } }), {
    type: "allowed",
    youtubeFocus: false,
    shortVideo: { type: "none" }
  });
});

test("urlChanged allows matching URLs outside the schedule", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com" }
  ], inactiveSchedule());
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage(urlChangedMessage("https://x.com"), { tab: { id: 7 } });

  assert.equal(response.type, "allowed");
  assert.deepEqual(api.updatedTabs, []);
});

test("urlChanged redirects matching URLs inside the schedule", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com" }
  ], activeSchedule());
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage(urlChangedMessage("https://x.com"), { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://x.com", "scheduleDirectMatch")
  }]);
});

test("urlChanged expands root URL blocks for Safari empty referrers", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage(urlChangedMessage("https://example.com/path", {
    type: "document",
    referrer: knownReferrer(""),
    navigationType: "navigate"
  }), { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://example.com/path", "scheduleRootDirectNavigation")
  }]);
});

test("urlChanged blocks back and forward returns to a root URL page", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage(urlChangedMessage("https://example.com/path", {
    type: "document",
    referrer: knownReferrer(""),
    navigationType: "back_forward"
  }), { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://example.com/path", "scheduleRootDirectNavigation")
  }]);
});

test("urlChanged allows root URL subpage reloads on Safari", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage(urlChangedMessage("https://example.com/path", {
    type: "document",
    referrer: knownReferrer(""),
    navigationType: "reload"
  }), { tab: { id: 7 } });

  assert.equal(response.type, "allowed");
  assert.deepEqual(api.updatedTabs, []);
});

test("urlChanged expands root URL blocks for Chromium same-domain referrers", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage(urlChangedMessage("https://example.com/path", {
    type: "document",
    referrer: knownReferrer("https://www.example.com/start"),
    navigationType: "navigate"
  }), { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://example.com/path", "scheduleRootSameDomainNavigation", "chrome-extension")
  }]);
});

test("urlChanged allows root URL subpage reloads on Chromium", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage(urlChangedMessage("https://example.com/path", {
    type: "document",
    referrer: knownReferrer("https://example.com/start"),
    navigationType: "reload"
  }), { tab: { id: 7 } });

  assert.equal(response.type, "allowed");
  assert.deepEqual(api.updatedTabs, []);
});

test("urlChanged rejects malformed document referrers", async () => {
  const controller = createBackgroundController(fakeApi());
  const malformedReferrers = [
    { type: "known" },
    { type: "known", url: "https://example.com/", extra: true },
    { type: "unknown", url: "https://example.com/" },
    { type: "mystery", url: "https://example.com/" },
    "https://example.com/"
  ];

  for (const referrer of malformedReferrers) {
    await assert.rejects(() => controller.handleMessage(urlChangedMessage("https://example.com/path", {
      type: "document",
      referrer,
      navigationType: "navigate"
    }), { tab: { id: 7 } }), { errorCode: "NavigationSourceInvalid" });
  }
});

test("root URL rechecks after reaching a domain limit block only direct and internal arrivals", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], inactiveSchedule(), [
    { domain: "example.com", limitMinutes: 1 }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": { 20: 60000 }
  });
  const controller = createBackgroundController(api);
  const external = await controller.handleMessage(urlChangedMessage("https://example.com/watch?v=1"), { tab: { id: 7 } });
  const internal = await controller.handleMessage(urlChangedMessage("https://example.com/watch?v=2", {
    type: "document",
    referrer: knownReferrer("https://example.com/"),
    navigationType: "navigate"
  }), { tab: { id: 8 } });
  const direct = await controller.handleMessage(urlChangedMessage("https://example.com/watch?v=3", {
    type: "document",
    referrer: knownReferrer(""),
    navigationType: "navigate"
  }), { tab: { id: 9 } });

  assert.equal(external.type, "allowed");
  assert.equal(internal.type, "redirected");
  assert.equal(direct.type, "redirected");
  assert.deepEqual(api.updatedTabs, [
    { tabId: 8, url: blockedUrl("https://example.com/watch?v=2", "limitRootSameDomainNavigation") },
    { tabId: 9, url: blockedUrl("https://example.com/watch?v=3", "limitRootDirectNavigation") }
  ]);
});

test("Chromium rechecks judge empty referrers by the committed transition", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000, runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], inactiveSchedule(), [
    { domain: "example.com", limitMinutes: 1 }
  ]);
  const controller = createBackgroundController(api);
  const emptyReferrer = { type: "document", referrer: knownReferrer(""), navigationType: "navigate" };

  await controller.redirectCommittedNavigation({ frameId: 0, tabId: 7, url: "https://example.com/typed", transitionType: "typed" });
  await controller.redirectCommittedNavigation({ frameId: 0, tabId: 8, url: "https://example.com/linked", transitionType: "link" });
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": { 20: 60000 }
  });
  const typed = await controller.handleMessage(urlChangedMessage("https://example.com/typed#top", emptyReferrer), { tab: { id: 7 } });
  const linked = await controller.handleMessage(urlChangedMessage("https://example.com/linked", emptyReferrer), { tab: { id: 8 } });

  assert.equal(typed.type, "redirected");
  assert.equal(linked.type, "allowed");
  assert.deepEqual(api.updatedTabs, [
    { tabId: 7, url: blockedUrl("https://example.com/typed#top", "limitRootDirectNavigation", "chrome-extension") }
  ]);
});

test("Chromium reloads keep the committed transition until the tab closes", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000, runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], inactiveSchedule(), [
    { domain: "example.com", limitMinutes: 1 }
  ]);
  const controller = createBackgroundController(api);
  const emptyReferrer = { type: "document", referrer: knownReferrer(""), navigationType: "navigate" };

  await controller.redirectCommittedNavigation({ frameId: 0, tabId: 7, url: "https://example.com/typed", transitionType: "typed" });
  await controller.redirectCommittedNavigation({ frameId: 0, tabId: 7, url: "https://example.com/typed", transitionType: "reload" });
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": { 20: 60000 }
  });
  const reloaded = await controller.handleMessage(urlChangedMessage("https://example.com/typed", emptyReferrer), { tab: { id: 7 } });

  controller.forgetTab(7);
  const forgotten = await controller.handleMessage(urlChangedMessage("https://example.com/typed", emptyReferrer), { tab: { id: 7 } });

  assert.equal(reloaded.type, "redirected");
  assert.equal(forgotten.type, "allowed");
});

test("urlChanged blocks a Short instead of redirecting when the watch page would be blocked", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "youtube.com" }
  ], inactiveSchedule(), [
    { domain: "youtube.com", limitMinutes: 1 }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "youtube.com": { 20: 60000 }
  });
  const controller = createBackgroundController(api);
  const blocked = await controller.handleMessage(urlChangedMessage("https://www.youtube.com/shorts/abc", internalYoutubeSource), { tab: { id: 7 } });
  const redirected = await controller.handleMessage(urlChangedMessage("https://www.youtube.com/shorts/def"), { tab: { id: 8 } });

  assert.equal(blocked.type, "redirected");
  assert.equal(redirected.type, "redirected");
  assert.deepEqual(api.updatedTabs, [
    { tabId: 7, url: blockedUrl("https://www.youtube.com/shorts/abc", "limitRootSameDomainNavigation") },
    { tabId: 8, url: "https://www.youtube.com/watch?v=def" }
  ]);
});

test("screenTimeElapsed blocks internal arrivals but not external ones when the limit runs out", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], inactiveSchedule(), [
    { domain: "example.com", limitMinutes: 1 }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": { 20: 50000 }
  });
  const controller = createBackgroundController(api);

  await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://example.com/external",
    elapsedMs: 10000,
    source: defaultDocumentSource
  }, { tab: { id: 7 } });
  await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://example.com/internal",
    elapsedMs: 1000,
    source: { type: "document", referrer: knownReferrer("https://example.com/"), navigationType: "navigate" }
  }, { tab: { id: 8 } });

  assert.deepEqual(api.updatedTabs, [
    { tabId: 8, url: blockedUrl("https://example.com/internal", "limitRootSameDomainNavigation") }
  ]);
});

test("urlChanged fails closed for unknown referrers on root URL pages", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage(urlChangedMessage("https://example.com/path", {
    type: "document",
    referrer: unknownReferrer(),
    navigationType: "back_forward"
  }), { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://example.com/path", "scheduleRootSameDomainNavigation", "chrome-extension")
  }]);
});

test("openBlockedTarget keeps root URL subpages blocked", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "openBlockedTarget", tabId: 7, url: "https://example.com/path" }, {});

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://example.com/path", "scheduleRootSameDomainNavigation", "chrome-extension")
  }]);
});

test("openBlockedTarget opens targets that are no longer blocked", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "openBlockedTarget", tabId: 7, url: "https://other.example/path" }, {});

  assert.equal(response.type, "opened");
  assert.deepEqual(api.updatedTabs, [{ tabId: 7, url: "https://other.example/path" }]);
});

test("startup sweep removes expired referrer records and preserves fresh records", async () => {
  const api = fakeApi({ now: referrerRecordRetentionMs + 1000 });
  const mixedKey = `${referrerRecordPrefix}https://example.com/page`;
  const expiredKey = `${referrerRecordPrefix}https://example.com/old`;
  const unrelatedKey = "unrelated";

  api.storageData[mixedKey] = {
    records: [
      { referrer: "https://expired.example/", recordedAt: 0 },
      { referrer: "https://fresh.example/", recordedAt: 1000 }
    ]
  };
  api.storageData[expiredKey] = {
    records: [{ referrer: "https://expired.example/", recordedAt: 0 }]
  };
  api.storageData[unrelatedKey] = { records: [{ referrer: "https://expired.example/", recordedAt: 0 }] };

  createBackgroundController(api);
  await flushPromises();

  assert.deepEqual(api.storageData[mixedKey], {
    records: [{ referrer: "https://fresh.example/", recordedAt: 1000 }]
  });
  assert.equal(api.storageData[expiredKey], undefined);
  assert.deepEqual(api.storageData[unrelatedKey], { records: [{ referrer: "https://expired.example/", recordedAt: 0 }] });
});

test("startup sweep does not rewrite unchanged referrer records", async () => {
  const api = fakeApi({ now: referrerRecordRetentionMs + 1000 });
  const freshKey = `${referrerRecordPrefix}https://example.com/fresh`;

  api.storageData[freshKey] = { records: [{ referrer: "https://fresh.example/", recordedAt: 1000 }] };

  createBackgroundController(api);
  await flushPromises();

  assert.deepEqual(api.storageSets.filter((value) => Object.hasOwn(value, freshKey)), []);
  assert.deepEqual(api.storageData[freshKey], { records: [{ referrer: "https://fresh.example/", recordedAt: 1000 }] });
});

test("committed Chromium typed navigation expands root URL blocks", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.redirectCommittedNavigation({
    frameId: 0,
    tabId: 7,
    transitionType: "typed",
    url: "https://example.com/path"
  });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://example.com/path", "scheduleRootDirectNavigation", "chrome-extension")
  }]);
});

test("committed Chromium reload navigation does not expand root URL blocks", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.redirectCommittedNavigation({
    frameId: 0,
    tabId: 7,
    transitionType: "reload",
    url: "https://example.com/path"
  });

  assert.equal(response.type, "allowed");
  assert.deepEqual(api.updatedTabs, []);
});

test("committed Chromium subframe navigation is ignored", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.redirectCommittedNavigation({
    frameId: 1,
    tabId: 7,
    transitionType: "typed",
    url: "https://example.com/path"
  });

  assert.equal(response.type, "ignored");
  assert.deepEqual(api.updatedTabs, []);
});

test("starting navigation to a page blocked for every arrival redirects before the request", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.redirectNavigationStart({ frameId: 0, tabId: 7, url: "https://example.com/" });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://example.com/", "scheduleDirectMatch", "chrome-extension")
  }]);
});

test("starting navigation leaves arrival-dependent root URL blocks to the commit", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.redirectNavigationStart({ frameId: 0, tabId: 7, url: "https://example.com/path" });

  assert.equal(response.type, "allowed");
  assert.deepEqual(api.updatedTabs, []);
});

test("starting subframe navigation is ignored", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.redirectNavigationStart({ frameId: 1, tabId: 7, url: "https://example.com/" });

  assert.equal(response.type, "ignored");
  assert.deepEqual(api.updatedTabs, []);
});

test("screenTimeElapsed logs time into the current hour bucket", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://reddit.com/popular" },
    { id: "22222222-2222-4222-8222-222222222222", kind: "domain", value: "example.com" },
    { id: "33333333-3333-4333-8333-333333333333", kind: "regex", value: "^https://ignored\\.example/" }
  ]);
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://old.reddit.com/r/safari",
    elapsedMs: 1500,
    source: defaultDocumentSource
  }, { tab: { id: 7 } }), { type: "logged", domain: "reddit.com", totalMs: 1500, limitMinutes: 30, isOverLimit: false });
  assert.deepEqual(await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://www.example.com/path",
    elapsedMs: 2500,
    source: defaultDocumentSource
  }, { tab: { id: 7 } }), { type: "logged", domain: "example.com", totalMs: 2500, limitMinutes: 30, isOverLimit: false });
  assert.deepEqual(await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://ignored.example/",
    elapsedMs: 1000,
    source: defaultDocumentSource
  }, { tab: { id: 7 } }), { type: "logged", domain: "ignored.example", totalMs: 1000, limitMinutes: 30, isOverLimit: false });

  assert.deepEqual(await controller.handleMessage({ type: "getScreenTimeLog" }, {}), {
    type: "screenTimeLog",
    entries: [
      { domain: "example.com", totalMs: 2500, limitMinutes: 30, isOverLimit: false },
      { domain: "reddit.com", totalMs: 1500, limitMinutes: 30, isOverLimit: false },
      { domain: "ignored.example", totalMs: 1000, limitMinutes: 30, isOverLimit: false }
    ]
  });
  assert.deepEqual(api.storageData.screenTimeUsage, {
    schemaVersion: 2,
    deviceId: "11111111-1111-4111-8111-000000000001",
    dirtySinceMs: 72000000,
    localBuckets: {
      "example.com": { 20: { totalMs: 2500, syncedMs: 0 } },
      "ignored.example": { 20: { totalMs: 1000, syncedMs: 0 } },
      "reddit.com": { 20: { totalMs: 1500, syncedMs: 0 } }
    },
    remoteBuckets: {}
  });
});

test("screenTimeElapsed resets unsupported old screen time usage schemas", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ]);
  api.storageData.screenTimeUsage = {
    schemaVersion: 1,
    totalsByDomain: {
      "example.com": { 20: 2500 }
    }
  };
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://www.example.com/path",
    elapsedMs: 2500,
    source: defaultDocumentSource
  }, { tab: { id: 7 } }), { type: "logged", domain: "example.com", totalMs: 2500, limitMinutes: 30, isOverLimit: false });
  assert.deepEqual(api.storageData.screenTimeUsage, {
    schemaVersion: 2,
    deviceId: "11111111-1111-4111-8111-000000000001",
    dirtySinceMs: 72000000,
    localBuckets: {
      "example.com": { 20: { totalMs: 2500, syncedMs: 0 } }
    },
    remoteBuckets: {}
  });
});

test("screenTimeElapsed stores usage through native storage on iOS", async () => {
  const api = fakeApi({ nativeStorage: true, now: 20 * 60 * 60 * 1000 });
  api.nativeData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ]);
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://www.example.com/path",
    elapsedMs: 2500,
    source: defaultDocumentSource
  }, { tab: { id: 7 } }), { type: "logged", domain: "example.com", totalMs: 2500, limitMinutes: 30, isOverLimit: false });
  assert.equal(api.storageData.screenTimeUsage, undefined);
  assert.deepEqual(api.nativeData.screenTimeUsage, {
    schemaVersion: 2,
    deviceId: "11111111-1111-4111-8111-000000000001",
    dirtySinceMs: 72000000,
    localBuckets: {
      "example.com": { 20: { totalMs: 2500, syncedMs: 0 } }
    },
    remoteBuckets: {}
  });
  assert.deepEqual(await controller.handleMessage({ type: "getScreenTimeLog" }, {}), {
    type: "screenTimeLog",
    entries: [
      { domain: "example.com", totalMs: 2500, limitMinutes: 30, isOverLimit: false }
    ]
  });
});

test("screenTimeElapsed validates elapsed time", async () => {
  const controller = createBackgroundController(fakeApi());

  await assert.rejects(() => controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://reddit.com",
    elapsedMs: 0,
    source: defaultDocumentSource
  }, { tab: { id: 7 } }), /positive integer/);
  await assert.rejects(() => controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://reddit.com",
    elapsedMs: 30001,
    source: defaultDocumentSource
  }, { tab: { id: 7 } }), /no more than 30 seconds/);
});

test("getScreenTimeLog sums the last 24 hour buckets without pruning storage", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ], core.DEFAULT_SCHEDULE, [
    { domain: "example.com", limitMinutes: 1 }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": {
      4: 1000,
      5: 2000,
      19: 3000,
      20: 4000,
      21: 5000
    }
  });
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({ type: "getScreenTimeLog" }, {}), {
    type: "screenTimeLog",
    entries: [
      { domain: "example.com", totalMs: 10000, limitMinutes: 1, isOverLimit: false }
    ]
  });
  assert.deepEqual(api.storageData.screenTimeUsage, screenTimeUsage({
    "example.com": {
      4: 1000,
      5: 2000,
      19: 3000,
      20: 4000,
      21: 5000
    }
  }));
});

test("getScreenTimeStats returns summary, hourly, device, and zero-domain rows", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" },
    { id: "22222222-2222-4222-8222-222222222222", kind: "domain", value: "unused.example" }
  ], core.DEFAULT_SCHEDULE, [
    { domain: "example.com", limitMinutes: 1 },
    { domain: "unused.example", limitMinutes: 5 }
  ], { type: "rollingWindow", windowHours: 2 });
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": {
      18: 1000,
      19: 2000
    }
  }, {
    "other-device": {
      "example.com": {
        20: 3000
      }
    }
  });
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({ type: "getScreenTimeStats" }, {}), {
    type: "screenTimeStats",
    stats: {
      generatedAtMs: 20 * 60 * 60 * 1000,
      schedule: core.DEFAULT_SCHEDULE,
      limitReset: { type: "rollingWindow", windowHours: 2 },
      window: { startHour: 19, endHour: 20 },
      totalMs: 5000,
      trackedDomainCount: 2,
      activeDomainCount: 1,
      overLimitCount: 0,
      entries: [
        {
          domain: "example.com",
          totalMs: 5000,
          localMs: 2000,
          remoteMs: 3000,
          limitMinutes: 1,
          remainingMs: 55000,
          usedPercent: 8,
          isOverLimit: false
        },
        {
          domain: "unused.example",
          totalMs: 0,
          localMs: 0,
          remoteMs: 0,
          limitMinutes: 5,
          remainingMs: 300000,
          usedPercent: 0,
          isOverLimit: false
        }
      ],
      hourlyTotals: [
        { hour: 19, startedAtMs: 19 * 60 * 60 * 1000, totalMs: 2000 },
        { hour: 20, startedAtMs: 20 * 60 * 60 * 1000, totalMs: 3000 }
      ],
      deviceTotals: [
        { label: "This Device", totalMs: 2000 },
        { label: "Other Device 1", totalMs: 3000 }
      ]
    }
  });
});

test("getLocalScreenTimeStats reads cached remote buckets without syncing", async () => {
  const fetch = globalThis.fetch;
  const remoteUrls = [];
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });

  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ], core.DEFAULT_SCHEDULE, [
    { domain: "example.com", limitMinutes: 1 }
  ], { type: "rollingWindow", windowHours: 2 });
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": { 19: 2000 }
  }, {
    "other-device": {
      "example.com": { 20: 3000 }
    }
  });
  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/screen_time_buckets")) {
      remoteUrls.push(String(url));
    }

    return fetch(url, options);
  };

  try {
    const response = await createBackgroundController(api).handleMessage({ type: "getLocalScreenTimeStats" }, {});

    assert.equal(response.type, "screenTimeStats");
    assert.equal(response.stats.totalMs, 5000);
    assert.deepEqual(response.stats.deviceTotals, [
      { label: "This Device", totalMs: 2000 },
      { label: "Other Device 1", totalMs: 3000 }
    ]);
    assert.equal(remoteUrls.length, 0);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("screenTimeElapsed keeps historical buckets when saving", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": {
      4: 1000,
      5: 2000,
      19: 3000,
      20: 4000,
      21: 5000
    }
  });
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://www.example.com/path",
    elapsedMs: 6000,
    source: defaultDocumentSource
  }, { tab: { id: 7 } }), { type: "logged", domain: "example.com", totalMs: 16000, limitMinutes: 30, isOverLimit: false });
  assert.deepEqual(api.storageData.screenTimeUsage, {
    schemaVersion: 2,
    deviceId: "11111111-1111-4111-8111-000000000001",
    dirtySinceMs: 72000000,
    localBuckets: {
      "example.com": {
        4: { totalMs: 1000, syncedMs: 1000 },
        5: { totalMs: 2000, syncedMs: 2000 },
        19: { totalMs: 3000, syncedMs: 3000 },
        20: { totalMs: 10000, syncedMs: 4000 },
        21: { totalMs: 5000, syncedMs: 5000 }
      }
    },
    remoteBuckets: {}
  });
});

test("urlChanged redirects matching URLs when rolling usage is over limit", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com/home" }
  ], inactiveSchedule(), [
    { domain: "x.com", limitMinutes: 1 }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "x.com": { 20: 60000 }
  });
  const controller = createBackgroundController(api);
  const blocked = await controller.handleMessage(urlChangedMessage("https://x.com/home"), { tab: { id: 7 } });
  const allowed = await controller.handleMessage(urlChangedMessage("https://x.com/messages"), { tab: { id: 8 } });

  assert.equal(blocked.type, "redirected");
  assert.equal(allowed.type, "allowed");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://x.com/home", "limitDirectMatch")
  }]);
});

test("urlChanged lets a remembered YouTube video continue after rolling usage exceeds the limit", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "youtube.com" }
  ], inactiveSchedule(), [
    { domain: "youtube.com", limitMinutes: 1 }
  ]);
  const controller = createBackgroundController(api);
  const remembered = await controller.handleMessage(urlChangedMessage("https://www.youtube.com/watch?v=abc", internalYoutubeSource), { tab: { id: 7 } });

  api.storageData.screenTimeUsage = screenTimeUsage({
    "youtube.com": { 20: 60000 }
  });
  const focused = await controller.handleMessage(urlChangedMessage("https://www.youtube.com/watch?v=abc&t=30", internalYoutubeSource), { tab: { id: 7 } });

  assert.deepEqual(remembered, { type: "allowed", youtubeFocus: false, shortVideo: { type: "feed", site: "youtube" } });
  assert.deepEqual(focused, { type: "allowed", youtubeFocus: true, shortVideo: { type: "feed", site: "youtube" } });
  assert.deepEqual(api.updatedTabs, []);
});

test("urlChanged blocks other YouTube videos after rolling usage exceeds the limit", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "youtube.com" }
  ], inactiveSchedule(), [
    { domain: "youtube.com", limitMinutes: 1 }
  ]);
  const controller = createBackgroundController(api);

  await controller.handleMessage(urlChangedMessage("https://www.youtube.com/watch?v=abc", internalYoutubeSource), { tab: { id: 7 } });
  api.storageData.screenTimeUsage = screenTimeUsage({
    "youtube.com": { 20: 60000 }
  });
  const response = await controller.handleMessage(urlChangedMessage("https://www.youtube.com/watch?v=def", internalYoutubeSource), { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://www.youtube.com/watch?v=def", "limitRootSameDomainNavigation")
  }]);
});

test("urlChanged blocks YouTube videos started from the homepage after block time starts", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "youtube.com" }
  ], inactiveSchedule());
  const controller = createBackgroundController(api);

  await controller.handleMessage(urlChangedMessage("https://www.youtube.com"), { tab: { id: 7 } });
  const blockedState = validState([
    { id, kind: "url", value: "youtube.com" }
  ], activeSchedule());

  api.storageData[core.STATE_KEY] = blockedState;
  api.storageData.settingsActivation = {
    schemaVersion: 1,
    activeState: blockedState,
    pending: { type: "none" }
  };
  const response = await controller.handleMessage(urlChangedMessage("https://www.youtube.com/watch?v=abc", {
    type: "document",
    referrer: knownReferrer("https://www.youtube.com"),
    navigationType: "navigate"
  }), { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://www.youtube.com/watch?v=abc", "scheduleRootSameDomainNavigation")
  }]);
});

test("screenTimeElapsed lets the current YouTube video continue after crossing the limit", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "youtube.com" }
  ], inactiveSchedule(), [
    { domain: "youtube.com", limitMinutes: 1 }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "youtube.com": { 20: 30000 }
  });
  const controller = createBackgroundController(api);

  await controller.handleMessage(urlChangedMessage("https://www.youtube.com/watch?v=abc", internalYoutubeSource), { tab: { id: 7 } });
  const response = await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://www.youtube.com/watch?v=abc",
    elapsedMs: 30000,
    source: internalYoutubeSource
  }, { tab: { id: 7 } });
  const focused = await controller.handleMessage(urlChangedMessage("https://www.youtube.com/watch?v=abc", internalYoutubeSource), { tab: { id: 7 } });

  assert.deepEqual(response, { type: "logged", domain: "youtube.com", totalMs: 60000, limitMinutes: 1, isOverLimit: true });
  assert.deepEqual(focused, { type: "allowed", youtubeFocus: true, shortVideo: { type: "feed", site: "youtube" } });
  assert.deepEqual(api.updatedTabs, []);
});

test("disabled YouTube focus redirects the current video after crossing the limit", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = {
    ...validState([
      { id, kind: "url", value: "youtube.com" }
    ], inactiveSchedule(), [
      { domain: "youtube.com", limitMinutes: 1 }
    ]),
    youtubeFocus: { finishCurrentVideo: false }
  };
  api.storageData.screenTimeUsage = screenTimeUsage({
    "youtube.com": { 20: 60000 }
  });
  const controller = createBackgroundController(api);

  const response = await controller.handleMessage(urlChangedMessage("https://www.youtube.com/watch?v=abc", internalYoutubeSource), { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://www.youtube.com/watch?v=abc", "limitRootSameDomainNavigation")
  }]);
});

test("hard schedule redirects remembered YouTube videos", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "youtube.com" }
  ], inactiveSchedule());
  const controller = createBackgroundController(api);

  await controller.handleMessage(urlChangedMessage("https://www.youtube.com/watch?v=abc"), { tab: { id: 7 } });
  const blockedState = validState([
    { id, kind: "url", value: "youtube.com" }
  ], inactiveSchedule(), undefined, core.DEFAULT_LIMIT_RESET, activeSchedule());

  api.storageData[core.STATE_KEY] = blockedState;
  api.storageData.settingsActivation = {
    schemaVersion: 1,
    activeState: blockedState,
    pending: { type: "none" }
  };
  const response = await controller.handleMessage(urlChangedMessage("https://www.youtube.com/watch?v=abc"), { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://www.youtube.com/watch?v=abc", "hardScheduleDomain")
  }]);
});

test("screenTimeElapsed redirects current root URL subpages after crossing the limit", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "x.com" }
  ], inactiveSchedule(), [
    { domain: "x.com", limitMinutes: 1 }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "x.com": { 20: 30000 }
  });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://x.com/messages",
    elapsedMs: 30000,
    source: { type: "document", referrer: knownReferrer("https://x.com/home"), navigationType: "navigate" }
  }, { tab: { id: 7 } });

  assert.deepEqual(response, { type: "logged", domain: "x.com", totalMs: 60000, limitMinutes: 1, isOverLimit: true });
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://x.com/messages", "limitRootSameDomainNavigation")
  }]);
});

test("screenTimeElapsed redirects matching URLs after crossing the limit", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com/home" }
  ], inactiveSchedule(), [
    { domain: "x.com", limitMinutes: 1 }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "x.com": { 20: 30000 }
  });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://x.com/home",
    elapsedMs: 30000,
    source: defaultDocumentSource
  }, { tab: { id: 7 } });

  assert.deepEqual(response, { type: "logged", domain: "x.com", totalMs: 60000, limitMinutes: 1, isOverLimit: true });
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://x.com/home", "limitDirectMatch")
  }]);
});

test("whole-domain usage counts on non-matching URLs without redirecting them", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://example.com/home" }
  ], inactiveSchedule(), [
    { domain: "example.com", limitMinutes: 1 }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": { 20: 30000 }
  });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://example.com/messages",
    elapsedMs: 30000,
    source: defaultDocumentSource
  }, { tab: { id: 7 } });

  assert.deepEqual(response, { type: "logged", domain: "example.com", totalMs: 60000, limitMinutes: 1, isOverLimit: true });
  assert.deepEqual(api.updatedTabs, []);
});

test("screen time limits include remote device buckets after sync", async () => {
  const fetch = globalThis.fetch;
  const calls = [];
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });

  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ], core.DEFAULT_SCHEDULE, [
    { domain: "example.com", limitMinutes: 1 }
  ]);
  api.storageData.supabaseSession = supabaseSession();
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": { 20: 30000 }
  });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });

    if (String(url).includes("/user_settings")) {
      return jsonResponse([]);
    }

    if (String(url).includes("/rpc/sync_screen_time_buckets")) {
      return jsonResponse([]);
    }

    if (String(url).includes("/screen_time_buckets")) {
      return jsonResponse([
        { device_id: "other-device", domain: "example.com", hour_number: 20, total_ms: 31000 }
      ]);
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);

    await controller.syncNow();

    assert.deepEqual(await controller.handleMessage({ type: "getScreenTimeLog" }, {}), {
      type: "screenTimeLog",
      entries: [
        { domain: "example.com", totalMs: 61000, limitMinutes: 1, isOverLimit: true }
      ]
    });
    assert.equal(calls.some((call) => call.url.includes("/screen_time_buckets")), true);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("signOut keeps screen time local-only by clearing cached remote buckets", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });

  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ], core.DEFAULT_SCHEDULE, [
    { domain: "example.com", limitMinutes: 1 }
  ]);
  api.storageData.supabaseSession = supabaseSession();
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": { 20: 30000 }
  }, {
    "other-device": {
      "example.com": { 20: 31000 }
    }
  });

  const controller = createBackgroundController(api);

  await controller.handleMessage({ type: "signOut" }, {});

  assert.equal(api.storageData.supabaseSession, undefined);
  assert.deepEqual(api.storageData.screenTimeUsage.remoteBuckets, {});
  assert.deepEqual(await controller.handleMessage({ type: "getScreenTimeLog" }, {}), {
    type: "screenTimeLog",
    entries: [
      { domain: "example.com", totalMs: 30000, limitMinutes: 1, isOverLimit: false }
    ]
  });
});

test("screen time sync waits until dirty data is old enough", async () => {
  const fetch = globalThis.fetch;
  const posts = [];
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });

  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ]);
  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/rpc/sync_screen_time_buckets")) {
      posts.push(JSON.parse(options.body));
      return jsonResponse([
        { device_id: "11111111-1111-4111-8111-000000000001", domain: "example.com", hour_number: 20, total_ms: 30000 }
      ]);
    }

    if (String(url).includes("/screen_time_buckets") || String(url).includes("/user_settings")) {
      return jsonResponse([]);
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);

    await controller.handleMessage({
      type: "screenTimeElapsed",
      url: "https://example.com",
      elapsedMs: 30000,
      source: defaultDocumentSource
    }, { tab: { id: 7 } });
    api.nowValue += 59000;
    await controller.handleMessage({ type: "getScreenTimeLog" }, {});
    assert.equal(posts.length, 0);

    api.nowValue += 1000;
    await controller.handleMessage({ type: "getScreenTimeLog" }, {});
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].p_buckets, [{
      device_id: "11111111-1111-4111-8111-000000000001",
      domain: "example.com",
      hour_number: 20,
      total_ms: 30000
    }]);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("continuous screen time updates do not postpone sync forever", async () => {
  const fetch = globalThis.fetch;
  const posts = [];
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });

  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ]);
  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/rpc/sync_screen_time_buckets")) {
      posts.push(JSON.parse(options.body));
      return jsonResponse([
        { device_id: "11111111-1111-4111-8111-000000000001", domain: "example.com", hour_number: 20, total_ms: 60000 }
      ]);
    }

    if (String(url).includes("/screen_time_buckets") || String(url).includes("/user_settings")) {
      return jsonResponse([]);
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);

    await controller.handleMessage({
      type: "screenTimeElapsed",
      url: "https://example.com",
      elapsedMs: 30000,
      source: defaultDocumentSource
    }, { tab: { id: 7 } });
    api.nowValue += 30000;
    await controller.handleMessage({
      type: "screenTimeElapsed",
      url: "https://example.com",
      elapsedMs: 30000,
      source: defaultDocumentSource
    }, { tab: { id: 7 } });
    api.nowValue += 30000;
    await controller.handleMessage({ type: "getScreenTimeLog" }, {});

    assert.equal(posts.length, 1);
    assert.equal(posts[0].p_buckets[0].total_ms, 60000);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("Supabase failures leave screen time local and dirty", async () => {
  const fetch = globalThis.fetch;
  const consoleError = console.error;
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });

  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ]);
  api.storageData.supabaseSession = supabaseSession();
  console.error = () => {};
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("supabase.co")) {
      throw new Error("Supabase is down.");
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);
    const response = await controller.handleMessage({
      type: "screenTimeElapsed",
      url: "https://example.com",
      elapsedMs: 30000,
      source: defaultDocumentSource
    }, { tab: { id: 7 } });

    assert.equal(response.type, "logged");
    assert.equal(api.storageData.screenTimeUsage.dirtySinceMs, 72000000);
    assert.equal(api.storageData.screenTimeUsage.localBuckets["example.com"][20].syncedMs, 0);
  } finally {
    globalThis.fetch = fetch;
    console.error = consoleError;
  }
});

test("Supabase HTTP failures include response details", async () => {
  const fetch = globalThis.fetch;
  const consoleError = console.error;
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });

  api.storageData.supabaseSession = supabaseSession();
  console.error = () => {};
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("supabase.co")) {
      return httpErrorResponse(400, {
        code: "PGRST205",
        message: "Could not find the table 'public.user_settings' in the schema cache"
      });
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);
    const response = await controller.syncNow();

    assert.equal(response.type, "synced");
    assert.match(response.status.error, /Could not find the table/);
    assert.match(response.status.error, /PGRST205/);
  } finally {
    globalThis.fetch = fetch;
    console.error = consoleError;
  }
});

test("settings sync metadata migrates missing last sync timestamp", () => {
  const metadata = sync.parseSettingsSync({
    schemaVersion: 1,
    deviceId: "device-id",
    updatedAtMs: 7000,
    revisionId: "revision-id",
    dirty: false
  }, () => "new-id", 8000);

  assert.deepEqual(metadata, {
    schemaVersion: 2,
    deviceId: "device-id",
    updatedAtMs: 7000,
    revisionId: "revision-id",
    dirty: false,
    lastSuccessfulSyncMs: null
  });
});

test("syncNow records the last successful sync time", async () => {
  const fetch = globalThis.fetch;
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });

  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/user_settings") || String(url).includes("/screen_time_buckets")) {
      return jsonResponse([]);
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);
    const syncResponse = await controller.syncNow();

    assert.equal(syncResponse.status.lastSuccessfulSyncAgeMs, 0);
    assert.equal(api.storageData.settingsSync.lastSuccessfulSyncMs, 72000000);

    api.nowValue += 2 * 60 * 1000;

    const statusResponse = await controller.handleMessage({ type: "getSyncStatus" }, {});

    assert.equal(statusResponse.lastSuccessfulSyncAgeMs, 2 * 60 * 1000);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("saveState returns after local write before Supabase follow-up", async () => {
  const fetch = globalThis.fetch;
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });
  const remoteState = validState([
    { id, kind: "domain", value: "reddit.com" }
  ]);

  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/rpc/save_user_settings")) {
      return jsonResponse({
        user_id: "22222222-2222-4222-8222-222222222222",
        state: remoteState,
        updated_at_ms: 72000001,
        revision_id: "remote-revision",
        device_id: "remote-device",
        updated_at: "2026-05-23T00:00:00.000Z"
      });
    }

    if (String(url).includes("/screen_time_buckets")) {
      return jsonResponse([]);
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);
    const localState = validState([
      { id, kind: "domain", value: "example.com" }
    ]);
    const response = await controller.saveState(localState);

    assert.equal(response.type, "saved");
    assert.deepEqual(response.state, localState);
    assert.deepEqual(api.storageData[core.STATE_KEY], localState);
    assert.equal(api.storageData.settingsSync.dirty, true);

    const finishResponse = await controller.finishSavedState();

    assert.equal(finishResponse.type, "finishedSavedState");
    assert.deepEqual(api.storageData[core.STATE_KEY], remoteState);
    assert.equal(api.storageData.settingsSync.dirty, false);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("getState applies newer remote settings with strict selected columns", async () => {
  const fetch = globalThis.fetch;
  const userSettingsUrls = [];
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });
  const remoteState = validState([
    { id, kind: "domain", value: "reddit.com" }
  ]);

  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/user_settings")) {
      userSettingsUrls.push(String(url));
      return jsonResponse([{
        user_id: "22222222-2222-4222-8222-222222222222",
        state: remoteState,
        updated_at_ms: 72000001,
        revision_id: "remote-revision",
        device_id: "remote-device",
        updated_at: "2026-05-23T00:00:00.000Z"
      }]);
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);
    const response = await controller.getState();
    const defaultState = core.emptyState(defaultBlockedPages);

    assert.equal(response.type, "state");
    assert.deepEqual(response.state, defaultState);
    assert.deepEqual(api.storageData[core.STATE_KEY], remoteState);
    assert.deepEqual(api.storageData.settingsActivation.activeState, defaultState);
    assert.deepEqual(api.storageData.settingsActivation.pending.state, remoteState);
    assert.deepEqual(api.storageData[core.BLOCKED_PAGE_HTML_KEY], { html: defaultState.blockedPageHtml });
    assert.equal(userSettingsUrls.length, 1);
    assert.match(userSettingsUrls[0], /select=user_id,state,updated_at_ms,revision_id,device_id,updated_at/);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("syncNow repairs remote settings missing added defaults", async () => {
  const fetch = globalThis.fetch;
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });
  const previousDefaults = defaultBlockedPages.filter((entry) => ![
    "youtube.com/feed/subscriptions",
    "youtube.com/shorts"
  ].includes(entry.value));
  const previousEntries = previousDefaults.map((entry) => ({ ...entry, enabled: entry.value === "youtube.com" }));
  const remoteState = {
    schemaVersion: core.SCHEMA_VERSION,
    entries: previousEntries,
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: core.DEFAULT_SCHEDULE,
    hardSchedule: core.DEFAULT_HARD_SCHEDULE,
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    youtubeFocus: core.DEFAULT_YOUTUBE_FOCUS,
    shortVideoHiding: core.DEFAULT_SHORT_VIDEO_HIDING,
    domainLimits: core.domainLimitsForEntries(previousEntries, [])
  };

  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/user_settings")) {
      return jsonResponse([{
        user_id: "22222222-2222-4222-8222-222222222222",
        state: remoteState,
        updated_at_ms: 72000001,
        revision_id: "remote-revision",
        device_id: "remote-device",
        updated_at: "2026-05-23T00:00:00.000Z"
      }]);
    }

    if (String(url).includes("/screen_time_buckets")) {
      return jsonResponse([]);
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);
    const response = await controller.syncNow();
    const repairedSubscriptions = api.storageData[core.STATE_KEY].entries.find((entry) => entry.value === "youtube.com/feed/subscriptions");
    const repairedShorts = api.storageData[core.STATE_KEY].entries.find((entry) => entry.value === "youtube.com/shorts");

    assert.equal(response.status.error, "");
    assert.equal(repairedSubscriptions.enabled, true);
    assert.equal(repairedShorts.enabled, true);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("getState resets unsupported remote blocklist versions", async () => {
  const fetch = globalThis.fetch;
  const defaultState = core.emptyState(defaultBlockedPages);
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });
  let savedBody;

  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/user_settings")) {
      return jsonResponse([{
        user_id: "22222222-2222-4222-8222-222222222222",
        state: {
          ...validState([]),
          schemaVersion: core.SCHEMA_VERSION + 1
        },
        updated_at_ms: 72000001,
        revision_id: "remote-revision",
        device_id: "remote-device",
        updated_at: "2026-05-23T00:00:00.000Z"
      }]);
    }

    if (String(url).includes("/rpc/save_user_settings")) {
      savedBody = JSON.parse(options.body);
      return jsonResponse({
        user_id: "22222222-2222-4222-8222-222222222222",
        state: savedBody.p_state,
        updated_at_ms: savedBody.p_updated_at_ms,
        revision_id: savedBody.p_revision_id,
        device_id: savedBody.p_device_id,
        updated_at: "2026-05-23T00:00:01.000Z"
      });
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);
    const response = await controller.getState();
    const status = await controller.handleMessage({ type: "getSyncStatus" }, {});

    assert.equal(response.type, "state");
    assert.deepEqual(response.state, defaultState);
    assert.deepEqual(api.storageData[core.STATE_KEY], defaultState);
    assert.deepEqual(api.storageData[core.BLOCKED_PAGE_HTML_KEY], { html: defaultState.blockedPageHtml });
    assert.deepEqual(savedBody.p_state, defaultState);
    assert.equal(savedBody.p_updated_at_ms, 72000002);
    assert.equal(api.storageData.settingsSync.dirty, false);
    assert.equal(status.error, "");
  } finally {
    globalThis.fetch = fetch;
  }
});

test("getLocalState reads storage without remote settings sync", async () => {
  const fetch = globalThis.fetch;
  const userSettingsUrls = [];
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });
  const localState = validState([
    { id, kind: "domain", value: "example.com" }
  ]);

  api.storageData[core.STATE_KEY] = localState;
  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/user_settings")) {
      userSettingsUrls.push(String(url));
      return jsonResponse([]);
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);
    const response = await controller.handleMessage({ type: "getLocalState" }, {});

    assert.equal(response.type, "state");
    assert.deepEqual(response.state, localState);
    assert.equal(userSettingsUrls.length, 0);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("signInWithProvider returns an OAuth URL when browser identity is unavailable", async () => {
  const api = fakeApi({ supabaseConfig: configuredSupabase() });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "signInWithProvider", provider: "google" }, {});

  assert.equal(response.type, "openOAuth");
  assert.match(response.url, /^https:\/\/project\.supabase\.co\/auth\/v1\/authorize/);
  assert.match(response.url, /provider=google/);
  assert.match(response.url, /redirect_to=safari-web-extension/);
});

test("signInWithProvider opens native mac sign-in when native messaging is available", async () => {
  const api = fakeApi({
    nativeSessionStorage: true,
    supabaseConfig: configuredSupabase()
  });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "signInWithProvider", provider: "google" }, {});

  assert.deepEqual(response, {
    type: "openOAuth",
    url: "urlblocker://sign-in/google"
  });
});

test("signInWithProvider keeps Chromium on the web OAuth flow", async () => {
  const api = fakeApi({
    nativeSessionStorage: true,
    runtimeScheme: "chrome-extension",
    supabaseConfig: configuredSupabase()
  });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "signInWithProvider", provider: "google" }, {});

  assert.equal(response.type, "openOAuth");
  assert.match(response.url, /^https:\/\/project\.supabase\.co\/auth\/v1\/authorize/);
  assert.match(response.url, /redirect_to=chrome-extension/);
});

test("getSyncStatus reads the native mac session", async () => {
  const api = fakeApi({
    nativeSessionStorage: true,
    supabaseConfig: configuredSupabase()
  });
  api.nativeData.supabaseSession = supabaseSession();
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "getSyncStatus" }, {});

  assert.equal(response.type, "syncStatus");
  assert.equal(response.status, "signedIn");
});

test("getSyncStatus reads the native session in the iOS containing app webview", async () => {
  const api = fakeApi({
    nativeStorage: true,
    runtimeScheme: "file",
    supabaseConfig: configuredSupabase()
  });
  api.nativeData.supabaseSession = supabaseSession();
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "getSyncStatus" }, {});

  assert.equal(response.type, "syncStatus");
  assert.equal(response.status, "signedIn");
});

test("getSyncStatus requires native sign-in on iOS when signed out", async () => {
  const api = fakeApi({
    nativeStorage: true,
    supabaseConfig: configuredSupabase()
  });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "getSyncStatus" }, {});

  assert.deepEqual(response, {
    type: "syncStatus",
    status: "nativeSignInRequired",
    error: ""
  });
});

test("saveState redirects open tabs that match the new state", async () => {
  const api = fakeApi({
    tabs: [
      { id: 7, url: "https://x.com/home" },
      { id: 8, url: "https://x.com/messages" }
    ]
  });
  const controller = createBackgroundController(api);
  const response = await controller.saveState(validState([
    { id, kind: "url", value: "https://x.com/home" }
  ], { type: "always" }));
  const finishResponse = await controller.finishSavedState();

  assert.equal(response.type, "saved");
  assert.equal(finishResponse.type, "finishedSavedState");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://x.com/home", "scheduleDirectMatch")
  }]);
});

function validState(entries, schedule = core.DEFAULT_SCHEDULE, domainLimits, limitReset = core.DEFAULT_LIMIT_RESET, hardSchedule = core.DEFAULT_HARD_SCHEDULE) {
  const stateEntries = stateEntriesWithDefaults(entries);

  return {
    schemaVersion: core.SCHEMA_VERSION,
    entries: stateEntries,
    blockedPageHtml: "<p>Blocked.</p>",
    schedule,
    hardSchedule,
    limitReset,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    youtubeFocus: core.DEFAULT_YOUTUBE_FOCUS,
    shortVideoHiding: core.DEFAULT_SHORT_VIDEO_HIDING,
    domainLimits: core.domainLimitsForEntries(stateEntries, domainLimits === undefined ? [] : domainLimits)
  };
}

function stateEntriesWithDefaults(entries) {
  const defaultIdsByMatcher = new Map(defaultBlockedPages.map((entry) => [matcherKey(entry), entry.id]));
  const enabledDefaultIds = new Set();
  const customEntries = [];

  entries.forEach((entry) => {
    const defaultId = defaultIdsByMatcher.get(matcherKey(entry));

    if (defaultId) {
      enabledDefaultIds.add(defaultId);
      return;
    }

    customEntries.push({ type: "custom", ...entry });
  });

  return [
    ...defaultBlockedPages.map((entry) => ({ ...entry, enabled: enabledDefaultIds.has(entry.id) })),
    ...customEntries
  ];
}

function matcherKey(entry) {
  switch (entry.kind) {
    case "domain":
      return `${entry.kind}:${core.normalizeDomainEntryValue(entry.value)}`;
    case "url":
    case "urlWithSubpaths":
      return `${entry.kind}:${core.normalizeUrlEntryValue(entry.value)}`;
    case "regex":
      return `${entry.kind}:${core.normalizeRegexEntryValue(entry.value)}`;
    default:
      throw new Error(`Unknown matcher kind: ${entry.kind}`);
  }
}

function activeSchedule() {
  const now = currentMinute();

  return {
    type: "dailyWindow",
    startMinute: (now + 1439) % 1440,
    endMinute: (now + 1) % 1440
  };
}

function inactiveSchedule() {
  const now = currentMinute();

  return {
    type: "dailyWindow",
    startMinute: (now + 1) % 1440,
    endMinute: (now + 2) % 1440
  };
}

function currentMinute() {
  const now = new Date();

  return now.getHours() * 60 + now.getMinutes();
}

function screenTimeUsage(totalsByDomain, remoteBuckets = {}) {
  const localBuckets = {};

  Object.entries(totalsByDomain).forEach(([domain, hours]) => {
    localBuckets[domain] = {};
    Object.entries(hours).forEach(([hour, totalMs]) => {
      localBuckets[domain][hour] = { totalMs, syncedMs: totalMs };
    });
  });

  return {
    schemaVersion: 2,
    deviceId: "11111111-1111-4111-8111-000000000001",
    dirtySinceMs: null,
    localBuckets,
    remoteBuckets
  };
}

function configuredSupabase() {
  return {
    schemaVersion: 1,
    supabaseUrl: "https://project.supabase.co",
    publishableKey: "publishable",
    redirectScheme: "urlblocker",
    screenTimeSyncAgeMs: 60000
  };
}

function supabaseSession() {
  return {
    schemaVersion: 1,
    accessToken: jwtForUser("22222222-2222-4222-8222-222222222222"),
    refreshToken: "refresh-token",
    expiresAtMs: Date.now() + 60 * 60 * 1000
  };
}

function jwtForUser(userId) {
  return [
    base64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    base64Url(JSON.stringify({ sub: userId })),
    "signature"
  ].join(".");
}

function base64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function jsonResponse(value) {
  return {
    ok: true,
    async json() {
      return value;
    }
  };
}

function httpErrorResponse(status, value) {
  return {
    ok: false,
    status,
    async text() {
      return JSON.stringify(value);
    }
  };
}

async function flushPromises() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

function fakeApi(overrides = {}) {
  const api = {
    storageData: {},
    storageSets: [],
    nativeData: {},
    grantedOrigins: overrides.grantedOrigins || ["*://*.example.com/*", ...manifest.host_permissions],
    tabsData: overrides.tabs || [],
    registeredScripts: [],
    scriptRegistrations: [],
    scriptUnregistrations: [],
    removedOrigins: [],
    updatedTabs: [],
    timers: [],
    uuidIndex: 1,
    nowValue: overrides.now,
    now: overrides.now === undefined ? undefined : () => api.nowValue,
    setTimeout(listener, delayMs) {
      api.timers.push({ listener, delayMs });

      return api.timers.length;
    },
    randomUUID() {
      const suffix = String(api.uuidIndex).padStart(12, "0");
      api.uuidIndex += 1;

      return `11111111-1111-4111-8111-${suffix}`;
    },
    runtime: {
      getURL(path) {
        if (path === "default-blocked-pages.json") {
          return `data:application/json,${encodeURIComponent(JSON.stringify(defaultBlockedPages))}`;
        }

        if (path === "supabase-config.json") {
          const config = overrides.supabaseConfig || {
            schemaVersion: 1,
            supabaseUrl: "",
            publishableKey: "",
            redirectScheme: "urlblocker",
            screenTimeSyncAgeMs: 60000
          };

          return `data:application/json,${encodeURIComponent(JSON.stringify(config))}`;
        }

        return `${overrides.runtimeScheme || "safari-web-extension"}://extension/${path}`;
      },
      getManifest() {
        return manifest;
      }
    },
    storage: {
      local: {
        async get(key) {
          if (key === null) {
            return { ...api.storageData };
          }

          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((storageKey) => [storageKey, api.storageData[storageKey]]));
          }

          return { [key]: api.storageData[key] };
        },
        async remove(key) {
          delete api.storageData[key];
        },
        async set(value) {
          api.storageSets.push(JSON.parse(JSON.stringify(value)));
          Object.assign(api.storageData, value);
        }
      }
    },
    permissions: {
      async contains({ origins }) {
        return origins.every((origin) => api.grantedOrigins.includes(origin));
      },
      async getAll() {
        return { origins: api.grantedOrigins };
      },
      async remove({ origins }) {
        api.removedOrigins.push(...origins);
        api.grantedOrigins = api.grantedOrigins.filter((origin) => !origins.includes(origin));
      }
    },
    scripting: {
      async getRegisteredContentScripts({ ids }) {
        return api.registeredScripts.filter((script) => ids.includes(script.id));
      },
      async unregisterContentScripts({ ids }) {
        api.scriptUnregistrations.push([...ids]);
        api.registeredScripts = api.registeredScripts.filter((script) => !ids.includes(script.id));
      },
      async registerContentScripts(scripts) {
        api.scriptRegistrations.push(...scripts);
        api.registeredScripts.push(...scripts);
      }
    },
    tabs: {
      async query() {
        return api.tabsData;
      },
      async create({ url }) {
        api.createdTab = url;
      },
      async update(tabId, { url }) {
        api.updatedTabs.push({ tabId, url });
      }
    }
  };

  if (overrides.nativeStorage || overrides.nativeSessionStorage) {
    api.runtime.getPlatformInfo = async () => ({ os: overrides.nativeStorage ? "ios" : "mac" });
    api.runtime.sendNativeMessage = async (_applicationId, message) => {
      switch (message.type) {
        case "loadState":
          return { type: "storedState", state: api.nativeData[core.STATE_KEY] };
        case "saveState":
          api.nativeData[core.STATE_KEY] = message.state;
          return { type: "savedState", state: message.state };
        case "loadBlockedPageHtml":
          return { type: "storedBlockedPageHtml", blockedPageHtml: api.nativeData[core.BLOCKED_PAGE_HTML_KEY] };
        case "saveBlockedPageHtml":
          api.nativeData[core.BLOCKED_PAGE_HTML_KEY] = message.blockedPageHtml;
          return { type: "savedBlockedPageHtml", blockedPageHtml: message.blockedPageHtml };
        case "loadScreenTimeUsage":
          return { type: "storedScreenTimeUsage", usage: api.nativeData.screenTimeUsage };
        case "saveScreenTimeUsage":
          api.nativeData.screenTimeUsage = message.usage;
          return { type: "savedScreenTimeUsage", usage: message.usage };
        case "loadSettingsSync":
          return { type: "storedSettingsSync", sync: api.nativeData.settingsSync };
        case "saveSettingsSync":
          api.nativeData.settingsSync = message.sync;
          return { type: "savedSettingsSync", sync: message.sync };
        case "loadSettingsActivation":
          return { type: "storedSettingsActivation", activation: api.nativeData.settingsActivation };
        case "saveSettingsActivation":
          api.nativeData.settingsActivation = message.activation;
          return { type: "savedSettingsActivation", activation: message.activation };
        case "loadSupabaseSession":
          return { type: "storedSupabaseSession", session: api.nativeData.supabaseSession };
        case "saveSupabaseSession":
          api.nativeData.supabaseSession = message.session;
          return { type: "savedSupabaseSession", session: message.session };
        case "clearSupabaseSession":
          delete api.nativeData.supabaseSession;
          return { type: "clearedSupabaseSession" };
        default:
          return { type: "error", error: `Unknown native message type: ${message.type}.`, errorCode: "NativeTestUnknownMessage" };
      }
    };
  }

  return api;
}
