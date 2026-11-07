const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../URLBlockerWebExtension/blocker.js");
const defaultBlockedPages = require("../URLBlockerWebExtension/default-blocked-pages.json");
const manifest = require("../URLBlockerWebExtension/manifest.json");
const sync = require("../URLBlockerWebExtension/supabase-sync.js");
const { createBackgroundController } = require("../URLBlockerWebExtension/background.js");

const id = "11111111-1111-4111-8111-111111111111";
function checkPageMessage(url, referrer = "https://other.example/from") {
  return { type: "checkPage", url, arrival: { type: "referrer", url: referrer } };
}

function restrictState(api, state) {
  api.storageData[core.STATE_KEY] = state;
  api.storageData.settingsActivation = { schemaVersion: 1, activeState: state, pending: { type: "none" } };
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

test("getLocalState loads default blocked pages when storage is empty", async () => {
  const controller = createBackgroundController(fakeApi());
  const response = await controller.getLocalState();

  assert.equal(response.type, "state");
  assert.deepEqual(response.state.entries, core.emptyState(defaultBlockedPages).entries);
  assert.deepEqual(response.state.schedule, { type: "dailyWindow", startMinute: 1380, endMinute: 1140 });
  assert.deepEqual(response.state.hardSchedule, { type: "off" });
  assert.deepEqual(response.state.limitReset, { type: "rollingWindow", windowHours: 24 });
  assert.deepEqual(response.state.domainLimits, core.emptyState(defaultBlockedPages).domainLimits);
});

test("getLocalState reports plain object errors with details", async () => {
  const api = fakeApi();

  api.storage.local.get = async () => {
    throw { message: "Storage request failed.", code: "StorageTestError" };
  };

  const response = await createBackgroundController(api).getLocalState();

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
    schemaVersion: 5
  };

  const response = await createBackgroundController(api).getLocalState();

  assert.equal(response.type, "state");
  assert.deepEqual(response.state, defaultState);
  assert.deepEqual(api.storageData[core.STATE_KEY], defaultState);
  assert.deepEqual(api.storageData[core.BLOCKED_PAGE_HTML_KEY], { html: defaultState.blockedPageHtml });
  assert.equal(api.storageData.settingsSync.dirty, false, "the account's settings replace the defaults");
  assert.equal(api.storageData.settingsSync.updatedAtMs, 0);
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

test("getLocalState loads default blocked pages without runtime getURL", async () => {
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
    const response = await createBackgroundController(api).getLocalState();

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

test("checkPage blocks feeds and lets outside links through while restricted", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "x.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage(checkPageMessage("https://x.com/home"), { tab: { id: 7 } }), { type: "redirected" });
  assert.deepEqual(await controller.handleMessage(checkPageMessage("https://x.com/status/1"), { tab: { id: 8 } }), { type: "allowed", shortVideo: { type: "none" } });
  assert.deepEqual(await controller.handleMessage(checkPageMessage("https://x.com/status/2", "https://x.com/status/1"), { tab: { id: 8 } }), { type: "redirected" });
  assert.deepEqual(api.updatedTabs, [
    { tabId: 7, url: blockedUrl("https://x.com/home", "schedule") },
    { tabId: 8, url: blockedUrl("https://x.com/status/2", "schedule") }
  ]);
});

test("checkPage keeps a tab on the page it holds a pass for", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ], inactiveSchedule());
  const controller = createBackgroundController(api);

  await controller.handleMessage(checkPageMessage("https://example.com/watch?v=1", "https://example.com/"), { tab: { id: 7 } });
  restrictState(api, validState([{ id, kind: "domain", value: "example.com" }], { type: "always" }));

  assert.equal((await controller.handleMessage(checkPageMessage("https://example.com/watch?v=1", "https://example.com/"), { tab: { id: 7 } })).type, "allowed");
  assert.equal((await controller.handleMessage(checkPageMessage("https://example.com/watch?v=1&t=30", "https://example.com/watch?v=1"), { tab: { id: 7 } })).type, "allowed");
  assert.equal((await controller.handleMessage(checkPageMessage("https://example.com/watch?v=2", "https://example.com/watch?v=1"), { tab: { id: 7 } })).type, "redirected");
  assert.equal((await controller.handleMessage(checkPageMessage("https://example.com/watch?v=1", "https://example.com/"), { tab: { id: 8 } })).type, "redirected");

  await controller.forgetTab(7);

  assert.equal((await controller.handleMessage(checkPageMessage("https://example.com/watch?v=1", "https://example.com/"), { tab: { id: 7 } })).type, "redirected");
});

test("checkPage counts empty Safari referrers as outside links", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);

  assert.equal((await controller.handleMessage(checkPageMessage("https://example.com/path", ""), { tab: { id: 7 } })).type, "allowed");
});

test("checkPage judges empty Chromium referrers by the committed transition", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const check = (tabId, url) => controller.handleMessage(checkPageMessage(url, ""), { tab: { id: tabId } });

  await controller.redirectCommittedNavigation({ frameId: 0, tabId: 7, transitionType: "link", transitionQualifiers: [], url: "https://example.com/linked" });
  await controller.redirectCommittedNavigation({ frameId: 0, tabId: 8, transitionType: "start_page", transitionQualifiers: [], url: "https://example.com/from-app" });

  assert.equal((await check(7, "https://example.com/linked")).type, "allowed");
  assert.equal((await check(8, "https://example.com/from-app")).type, "allowed");
  assert.equal((await check(9, "https://example.com/typed")).type, "allowed");
  assert.equal((await controller.redirectCommittedNavigation({ frameId: 0, tabId: 9, transitionType: "typed", transitionQualifiers: [], url: "https://example.com/typed" })).type, "redirected");
});

test("committed typed navigations count as inside arrivals and reloads keep the page's referrer", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const commit = (tabId, transitionType, url) => controller.redirectCommittedNavigation({ frameId: 0, tabId, transitionType, transitionQualifiers: [], url });

  assert.equal((await commit(7, "typed", "https://example.com/path")).type, "redirected");
  assert.equal((await commit(8, "auto_bookmark", "https://example.com/path")).type, "redirected");
  assert.equal((await commit(9, "link", "https://example.com/path")).type, "allowed");
  assert.equal((await controller.handleMessage(checkPageMessage("https://example.com/path"), { tab: { id: 10 } })).type, "allowed");
  assert.equal((await commit(10, "reload", "https://example.com/path")).type, "allowed");
  assert.equal((await commit(11, "reload", "https://example.com/path")).type, "allowed");
  assert.equal((await controller.handleMessage(checkPageMessage("https://example.com/path", "https://example.com/"), { tab: { id: 11 } })).type, "redirected");
  assert.equal((await commit(12, "reload", "https://example.com/path")).type, "allowed");
  assert.equal((await controller.handleMessage(checkPageMessage("https://example.com/path"), { tab: { id: 12 } })).type, "allowed");
  assert.deepEqual(api.updatedTabs.map((tab) => tab.tabId), [7, 8, 11]);
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
    transitionType: "typed", transitionQualifiers: [],
    url: "https://example.com/path"
  });

  assert.equal(response.type, "ignored");
  assert.deepEqual(api.updatedTabs, []);
});

test("starting navigation blocks feeds and leaves other pages to their arrival", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);

  assert.equal((await controller.redirectNavigationStart({ frameId: 0, tabId: 7, url: "https://example.com/" })).type, "redirected");
  assert.equal((await controller.redirectNavigationStart({ frameId: 0, tabId: 8, url: "https://example.com/path" })).type, "allowed");
  assert.equal((await controller.redirectNavigationStart({ frameId: 1, tabId: 9, url: "https://example.com/" })).type, "ignored");
  assert.deepEqual(api.updatedTabs, [{ tabId: 7, url: blockedUrl("https://example.com/", "schedule", "chrome-extension") }]);
});

test("Back and Forward return only to pages the tab was allowed onto", async () => {
  const api = fakeApi({ runtimeScheme: "chrome-extension" });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const history = (url) => controller.handleMessage({ type: "checkPage", url, arrival: { type: "history" } }, { tab: { id: 7 } });

  assert.equal((await controller.handleMessage(checkPageMessage("https://example.com/a"), { tab: { id: 7 } })).type, "allowed");
  assert.equal((await controller.handleMessage(checkPageMessage("https://example.com/b", "https://example.com/a"), { tab: { id: 7 } })).type, "redirected");
  assert.equal((await history("https://example.com/b")).type, "redirected");
  assert.equal((await history("https://example.com/a")).type, "allowed");
  assert.equal((await controller.redirectCommittedNavigation({ frameId: 0, tabId: 7, transitionType: "link", transitionQualifiers: ["forward_back"], url: "https://example.com/b" })).type, "redirected");
});

test("checkPage redirects every page on a domain during the hard schedule", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "x.com" }
  ], inactiveSchedule(), undefined, core.DEFAULT_LIMIT_RESET, activeSchedule());
  const controller = createBackgroundController(api);

  assert.equal((await controller.handleMessage(checkPageMessage("https://x.com/status/1"), { tab: { id: 7 } })).type, "redirected");
  assert.deepEqual(api.updatedTabs, [{ tabId: 7, url: blockedUrl("https://x.com/status/1", "hardSchedule") }]);
});

test("checkPage opens single short videos and keeps the redirected page open", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "youtube.com" },
    { id: "22222222-2222-4222-8222-222222222222", kind: "urlWithSubpaths", value: "youtube.com/shorts" }
  ], { type: "always" });
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage(checkPageMessage("https://www.youtube.com/shorts/abc"), { tab: { id: 7 } }), { type: "redirected" });
  assert.equal((await controller.handleMessage(checkPageMessage("https://www.youtube.com/watch?v=abc", ""), { tab: { id: 7 } })).type, "allowed");
  assert.deepEqual(await controller.handleMessage(checkPageMessage("https://www.youtube.com/shorts/def", "https://www.youtube.com/"), { tab: { id: 8 } }), { type: "redirected" });
  assert.deepEqual(api.updatedTabs, [
    { tabId: 7, url: "https://www.youtube.com/watch?v=abc" },
    { tabId: 8, url: blockedUrl("https://www.youtube.com/shorts/def", "schedule") }
  ]);
});

test("checkPage reports short video hiding for allowed pages", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com" }
  ], inactiveSchedule());
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage(checkPageMessage("https://www.facebook.com/reel/123"), { tab: { id: 7 } }), {
    type: "allowed",
    shortVideo: { type: "singleVideo", site: "facebook" }
  });
  assert.deepEqual(await controller.handleMessage(checkPageMessage("https://x.com/home"), { tab: { id: 7 } }), {
    type: "allowed",
    shortVideo: { type: "none" }
  });
});

test("checkPage keeps allowed pages open while their site is restricted", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = { ...validState([{ id, kind: "url", value: "x.com" }], { type: "always" }), allowedPages: ["x.com/messages"] };
  const controller = createBackgroundController(api);

  assert.equal((await controller.handleMessage(checkPageMessage("https://x.com/messages", "https://x.com/home"), { tab: { id: 7 } })).type, "allowed");
});

test("checkPage rejects malformed referrers", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([{ id, kind: "url", value: "x.com" }]);
  const controller = createBackgroundController(api);

  await assert.rejects(controller.handleMessage({ type: "checkPage", url: "https://x.com/", arrival: { type: "referrer", url: null } }, { tab: { id: 7 } }), /referrer must be a string/);
  await assert.rejects(controller.handleMessage({ type: "checkPage", url: "https://x.com/", arrival: { type: "typed" } }, { tab: { id: 7 } }), /Unknown page arrival type/);
});

test("openBlockedTarget keeps outside-link pages blocked", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({ type: "openBlockedTarget", tabId: 7, url: "https://example.com/path" }, {}), { type: "redirected" });
  assert.deepEqual(api.updatedTabs, [{ tabId: 7, url: blockedUrl("https://example.com/path", "schedule") }]);
});

test("openBlockedTarget opens targets that are no longer blocked and keeps them open", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" }
  ], inactiveSchedule());
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({ type: "openBlockedTarget", tabId: 7, url: "https://example.com/path" }, {}), { type: "opened" });
  restrictState(api, validState([{ id, kind: "url", value: "example.com" }], { type: "always" }));
  assert.equal((await controller.handleMessage(checkPageMessage("https://example.com/path", ""), { tab: { id: 7 } })).type, "allowed");
  assert.deepEqual(api.updatedTabs, [{ tabId: 7, url: "https://example.com/path" }]);
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
    elapsedMs: 1500
  }, { tab: { id: 7 } }), { type: "logged", domain: "reddit.com", isOverLimit: false });
  assert.deepEqual(await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://www.example.com/path",
    elapsedMs: 2500
  }, { tab: { id: 7 } }), { type: "logged", domain: "example.com", isOverLimit: false });
  assert.deepEqual(await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://ignored.example/",
    elapsedMs: 1000
  }, { tab: { id: 7 } }), { type: "logged", domain: "ignored.example", isOverLimit: false });

  assert.deepEqual(await controller.handleMessage({ type: "getScreenTimeLog" }, {}), {
    type: "screenTimeLog",
    entries: [
      { type: "site", name: "example.com", domains: ["example.com"], totalMs: 2500, limitMinutes: 30, isOverLimit: false },
      { type: "site", name: "reddit.com", domains: ["reddit.com"], totalMs: 1500, limitMinutes: 30, isOverLimit: false },
      { type: "site", name: "ignored.example", domains: ["ignored.example"], totalMs: 1000, limitMinutes: 30, isOverLimit: false }
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
    elapsedMs: 2500
  }, { tab: { id: 7 } }), { type: "logged", domain: "example.com", isOverLimit: false });
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
    elapsedMs: 2500
  }, { tab: { id: 7 } }), { type: "logged", domain: "example.com", isOverLimit: false });
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
      { type: "site", name: "example.com", domains: ["example.com"], totalMs: 2500, limitMinutes: 30, isOverLimit: false }
    ]
  });
});

test("screenTimeElapsed validates elapsed time", async () => {
  const controller = createBackgroundController(fakeApi());

  await assert.rejects(() => controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://reddit.com",
    elapsedMs: 0
  }, { tab: { id: 7 } }), /positive integer/);
  await assert.rejects(() => controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://reddit.com",
    elapsedMs: 30001
  }, { tab: { id: 7 } }), /no more than 30 seconds/);
});

test("getScreenTimeLog sums the last 24 hour buckets without pruning storage", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ], core.DEFAULT_SCHEDULE, [
    { domain: "example.com", limit: { type: "site", limitMinutes: 1 } }
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
      { type: "site", name: "example.com", domains: ["example.com"], totalMs: 10000, limitMinutes: 1, isOverLimit: false }
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
    { domain: "example.com", limit: { type: "site", limitMinutes: 1 } },
    { domain: "unused.example", limit: { type: "site", limitMinutes: 5 } }
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
          type: "site",
          name: "example.com",
          domains: ["example.com"],
          totalMs: 5000,
          localMs: 2000,
          remoteMs: 3000,
          limitMinutes: 1,
          remainingMs: 55000,
          usedPercent: 8,
          isOverLimit: false
        },
        {
          type: "site",
          name: "unused.example",
          domains: ["unused.example"],
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
    { domain: "example.com", limit: { type: "site", limitMinutes: 1 } }
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
    elapsedMs: 6000
  }, { tab: { id: 7 } }), { type: "logged", domain: "example.com", isOverLimit: false });
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

test("checkPage closes open feeds once the limit runs out", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "youtube.com" }
  ], inactiveSchedule(), [
    { domain: "youtube.com", limit: { type: "site", limitMinutes: 1 } }
  ]);
  const controller = createBackgroundController(api);

  await controller.handleMessage(checkPageMessage("https://www.youtube.com/watch?v=abc", "https://www.youtube.com/"), { tab: { id: 7 } });
  await controller.handleMessage(checkPageMessage("https://www.youtube.com/"), { tab: { id: 8 } });
  api.storageData.screenTimeUsage = screenTimeUsage({
    "youtube.com": { 20: 60000 }
  });

  assert.equal((await controller.handleMessage(checkPageMessage("https://www.youtube.com/watch?v=abc", "https://www.youtube.com/"), { tab: { id: 7 } })).type, "allowed");
  assert.equal((await controller.handleMessage(checkPageMessage("https://www.youtube.com/"), { tab: { id: 8 } })).type, "redirected");
  assert.deepEqual(api.updatedTabs, [{ tabId: 8, url: blockedUrl("https://www.youtube.com/", "limit") }]);
});

test("screenTimeElapsed leaves the open page open after crossing the limit", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com/home" }
  ], inactiveSchedule(), [
    { domain: "x.com", limit: { type: "site", limitMinutes: 1 } }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "x.com": { 20: 30000 }
  });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://x.com/home",
    elapsedMs: 30000
  }, { tab: { id: 7 } });

  assert.deepEqual(response, { type: "logged", domain: "x.com", isOverLimit: true });
  assert.deepEqual(api.updatedTabs, []);
});

test("whole-domain usage counts on non-matching URLs without redirecting them", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://example.com/home" }
  ], inactiveSchedule(), [
    { domain: "example.com", limit: { type: "site", limitMinutes: 1 } }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": { 20: 30000 }
  });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://example.com/messages",
    elapsedMs: 30000
  }, { tab: { id: 7 } });

  assert.deepEqual(response, { type: "logged", domain: "example.com", isOverLimit: true });
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
    { domain: "example.com", limit: { type: "site", limitMinutes: 1 } }
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
        { type: "site", name: "example.com", domains: ["example.com"], totalMs: 61000, limitMinutes: 1, isOverLimit: true }
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
    { domain: "example.com", limit: { type: "site", limitMinutes: 1 } }
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
      { type: "site", name: "example.com", domains: ["example.com"], totalMs: 30000, limitMinutes: 1, isOverLimit: false }
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
      elapsedMs: 30000
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
      elapsedMs: 30000
    }, { tab: { id: 7 } });
    api.nowValue += 30000;
    await controller.handleMessage({
      type: "screenTimeElapsed",
      url: "https://example.com",
      elapsedMs: 30000
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
      elapsedMs: 30000
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

test("syncNow applies newer remote settings with strict selected columns", async () => {
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
    await controller.syncNow();
    const defaultState = core.emptyState(defaultBlockedPages);

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
    shortVideoHiding: core.DEFAULT_SHORT_VIDEO_HIDING,
    allowedPages: [],
    limitGroups: core.DEFAULT_LIMIT_GROUPS,
    domainLimits: core.domainLimitsForEntries(previousEntries, [], core.DEFAULT_LIMIT_GROUPS)
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

test("syncNow leaves settings from a newer version in place", async () => {
  const fetch = globalThis.fetch;
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });
  const localState = validState([{ id, kind: "domain", value: "example.com" }]);
  const requests = [];

  restrictState(api, localState);
  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = remoteSettingsFetch(fetch, requests, () => remoteSettingsRow({ ...validState([]), schemaVersion: core.SCHEMA_VERSION + 1 }, 72000001));

  try {
    const response = await createBackgroundController(api).syncNow();

    assert.match(response.status.error, /newer version of URL Blocker/);
    assert.deepEqual(api.storageData[core.STATE_KEY], localState);
    assert.deepEqual(api.storageData.settingsActivation.activeState, localState);
    assert.equal(requests.some((request) => request.url.includes("/rpc/save_user_settings")), false);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("signing in on a new device takes the account's older settings", async () => {
  const fetch = globalThis.fetch;
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });
  const remoteState = validState([{ id, kind: "domain", value: "reddit.com" }]);

  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = remoteSettingsFetch(fetch, [], () => remoteSettingsRow(remoteState, 1000));

  try {
    await createBackgroundController(api).syncNow();

    assert.deepEqual(api.storageData[core.STATE_KEY], remoteState);
    assert.deepEqual(api.storageData.settingsActivation.pending.state, remoteState);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("signing out lets the next account's older settings apply", async () => {
  const fetch = globalThis.fetch;
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });
  const nextAccountState = validState([{ id, kind: "domain", value: "reddit.com" }]);

  api.storageData.settingsSync = { schemaVersion: 2, deviceId: "device", updatedAtMs: 71000000, revisionId: "first-account", dirty: false, lastSuccessfulSyncMs: 71000000 };
  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = remoteSettingsFetch(fetch, [], () => remoteSettingsRow(nextAccountState, 1000));

  try {
    const controller = createBackgroundController(api);

    await controller.signOut();
    api.storageData.supabaseSession = supabaseSession();
    await controller.syncNow();

    assert.deepEqual(api.storageData.settingsActivation.pending.state, nextAccountState);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("signing out keeps edits that never synced", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  const unsynced = { schemaVersion: 2, deviceId: "device", updatedAtMs: 72000000, revisionId: "local", dirty: true, lastSuccessfulSyncMs: null };

  api.storageData.settingsSync = unsynced;
  api.storageData.supabaseSession = supabaseSession();
  await createBackgroundController(api).signOut();

  assert.deepEqual(api.storageData.settingsSync, unsynced);
});

test("a screen time sync that ends after sign-out keeps other devices' time cleared", async () => {
  const fetch = globalThis.fetch;
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });
  let releaseDownload;
  let downloadStarted;
  const download = new Promise((resolve) => { releaseDownload = resolve; });
  const started = new Promise((resolve) => { downloadStarted = resolve; });

  api.storageData[core.STATE_KEY] = validState([{ id, kind: "domain", value: "example.com" }], inactiveSchedule());
  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/user_settings")) {
      return jsonResponse([]);
    }

    if (String(url).includes("/screen_time_buckets")) {
      downloadStarted();
      await download;
      return jsonResponse([{ device_id: "other-device", domain: "example.com", hour_number: 20, total_ms: 60000 }]);
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);
    const syncing = controller.syncNow();

    await started;
    await controller.signOut();
    releaseDownload();
    await syncing;

    assert.deepEqual(api.storageData.screenTimeUsage.remoteBuckets, {});
  } finally {
    globalThis.fetch = fetch;
  }
});

test("a settings sync that ends after a save keeps the save unsynced", async () => {
  const fetch = globalThis.fetch;
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });
  const remote = remoteSettingsRow(validState([]), 1000, "revision");
  let releaseLoad;
  const load = new Promise((resolve) => { releaseLoad = resolve; });

  restrictState(api, validState([]));
  api.storageData.settingsSync = { schemaVersion: 2, deviceId: "device", updatedAtMs: 1000, revisionId: "revision", dirty: false, lastSuccessfulSyncMs: 1000 };
  api.storageData.supabaseSession = supabaseSession();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/rpc/save_user_settings")) {
      return httpErrorResponse(503, { message: "Offline" });
    }

    if (String(url).includes("/rest/v1/user_settings")) {
      await load;
      return jsonResponse([remote]);
    }

    if (String(url).includes("/screen_time_buckets")) {
      return jsonResponse([]);
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);
    const opening = controller.syncNow();

    await new Promise((resolve) => setTimeout(resolve, 10));
    const saving = controller.saveState(validState([{ id, kind: "domain", value: "example.com" }]))
      .then(() => controller.finishSavedState());

    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseLoad();
    await Promise.all([opening, saving]);

    assert.equal(api.storageData.settingsSync.dirty, true);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("screen time logged during a sync is kept", async () => {
  const fetch = globalThis.fetch;
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });
  let releaseUpload;
  const upload = new Promise((resolve) => { releaseUpload = resolve; });

  api.storageData[core.STATE_KEY] = validState([{ id, kind: "domain", value: "example.com" }], inactiveSchedule());
  api.storageData.supabaseSession = supabaseSession();
  api.storageData.screenTimeUsage = { ...screenTimeUsage({ "example.com": { 20: 5000 } }), dirtySinceMs: 0 };
  api.storageData.screenTimeUsage.localBuckets["example.com"][20].syncedMs = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/rpc/sync_screen_time_buckets")) {
      await upload;
      return jsonResponse(JSON.parse(options.body).p_buckets);
    }

    if (String(url).includes("/screen_time_buckets")) {
      return jsonResponse([]);
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);
    const log = () => controller.handleMessage({ type: "screenTimeElapsed", url: "https://example.com/", elapsedMs: 5000 }, { tab: { id: 7 } });
    const logs = [log()];

    await new Promise((resolve) => setTimeout(resolve, 10));
    logs.push(log(), log());
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseUpload();
    await Promise.all(logs);

    assert.equal(api.storageData.screenTimeUsage.localBuckets["example.com"][20].totalMs, 20000);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("screen time syncs at once only when a site crosses its limit", async () => {
  const fetch = globalThis.fetch;
  const uploads = [];
  const api = fakeApi({
    now: 20 * 60 * 60 * 1000,
    supabaseConfig: configuredSupabase()
  });

  api.storageData[core.STATE_KEY] = validState([{ id, kind: "domain", value: "example.com" }], inactiveSchedule(), [
    { domain: "example.com", limit: { type: "site", limitMinutes: 1 } }
  ]);
  api.storageData.supabaseSession = supabaseSession();
  api.storageData.screenTimeUsage = screenTimeUsage({ "example.com": { 20: 55000 } });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/rpc/sync_screen_time_buckets")) {
      uploads.push(JSON.parse(options.body).p_buckets);
      return jsonResponse(JSON.parse(options.body).p_buckets);
    }

    if (String(url).includes("/screen_time_buckets")) {
      return jsonResponse([]);
    }

    return fetch(url, options);
  };

  try {
    const controller = createBackgroundController(api);
    const log = () => controller.handleMessage({ type: "screenTimeElapsed", url: "https://example.com/", elapsedMs: 5000 }, { tab: { id: 7 } });

    assert.equal((await log()).isOverLimit, true);
    assert.equal((await log()).isOverLimit, true);
    assert.equal(uploads.length, 1);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("overlapping settings activations register the content script once", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  const pendingState = validState([{ id, kind: "domain", value: "example.com" }], inactiveSchedule());

  api.storageData[core.STATE_KEY] = pendingState;
  api.storageData.settingsActivation = {
    schemaVersion: 1,
    activeState: validState([], inactiveSchedule()),
    pending: { type: "pending", state: pendingState, effectiveAtMs: 20 * 60 * 60 * 1000 }
  };
  api.registeredScripts = [{ id: "url-blocker-content", js: ["content.js"], css: ["content.css"], matches: ["*://*.old.example/*"], runAt: "document_start" }];
  api.scripting.unregisterContentScripts = async ({ ids }) => {
    await Promise.resolve();

    if (!api.registeredScripts.some((script) => ids.includes(script.id))) {
      throw new Error(`Nonexistent script ID '${ids[0]}'`);
    }

    api.registeredScripts = api.registeredScripts.filter((script) => !ids.includes(script.id));
  };
  api.scripting.registerContentScripts = async (scripts) => {
    await Promise.resolve();

    if (api.registeredScripts.some((script) => scripts.some((added) => added.id === script.id))) {
      throw new Error(`Duplicate script ID '${scripts[0].id}'`);
    }

    api.registeredScripts.push(...scripts);
  };

  const controller = createBackgroundController(api);
  const checks = await Promise.all([
    controller.handleMessage(checkPageMessage("https://example.com/a"), { tab: { id: 7 } }),
    controller.handleMessage(checkPageMessage("https://example.com/b"), { tab: { id: 8 } })
  ]);

  assert.deepEqual(checks.map((check) => check.type), ["allowed", "allowed"]);
  assert.equal(api.registeredScripts.length, 1);
  assert.deepEqual(api.registeredScripts[0].matches, core.contentScriptOriginsForState(pendingState));
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

test("saveState closes open feeds that match the new state", async () => {
  const api = fakeApi({
    tabs: [
      { id: 7, url: "https://x.com/home" },
      { id: 8, url: "https://x.com/messages" }
    ]
  });
  restrictState(api, { ...validState([], inactiveSchedule()), settingsDelay: { delayMinutes: 0 } });
  const controller = createBackgroundController(api);
  const response = await controller.saveState(validState([
    { id, kind: "url", value: "x.com" }
  ], { type: "always" }));
  const finishResponse = await controller.finishSavedState();

  assert.equal(response.type, "saved");
  assert.equal(finishResponse.type, "finishedSavedState");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: blockedUrl("https://x.com/home", "schedule")
  }]);
});

function remoteSettingsRow(state, updatedAtMs, revisionId = "remote-revision") {
  return {
    user_id: "22222222-2222-4222-8222-222222222222",
    state,
    updated_at_ms: updatedAtMs,
    revision_id: revisionId,
    device_id: "remote-device",
    updated_at: "2026-05-23T00:00:00.000Z"
  };
}

// Answers settings requests with settingsResponse(options); screen time requests get no rows.
function remoteSettingsFetch(fetch, requests, settingsResponse) {
  return async (url, options = {}) => {
    if (!String(url).startsWith("https://project.supabase.co")) {
      return fetch(url, options);
    }

    requests.push({ url: String(url), options });

    if (String(url).includes("user_settings")) {
      const row = await settingsResponse(options);

      return jsonResponse(options.method === "POST" || Array.isArray(row) ? row : [row]);
    }

    return jsonResponse([]);
  };
}

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
    shortVideoHiding: core.DEFAULT_SHORT_VIDEO_HIDING,
    allowedPages: [],
    limitGroups: core.DEFAULT_LIMIT_GROUPS,
    domainLimits: core.domainLimitsForEntries(stateEntries, domainLimits === undefined ? [] : domainLimits, core.DEFAULT_LIMIT_GROUPS)
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
    sessionData: {},
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
      },
      session: {
        async get(key) {
          return { [key]: api.sessionData[key] };
        },
        async remove(keys) {
          for (const key of [keys].flat()) {
            delete api.sessionData[key];
          }
        },
        async set(value) {
          Object.assign(api.sessionData, value);
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
        api.tabsData = api.tabsData.map((tab) => (tab.id === tabId ? { ...tab, url } : tab));
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
