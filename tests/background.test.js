const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../URLBlockerIOSExtension/Resources/blocker.js");
const defaultBlockedPages = require("../URLBlockerIOSExtension/Resources/default-blocked-pages.json");
const manifest = require("../URLBlockerIOSExtension/Resources/manifest.json");
const { createBackgroundController } = require("../URLBlockerIOSExtension/Resources/background.js");

const id = "11111111-1111-4111-8111-111111111111";

test("saveState validates, writes storage, and syncs content scripts", async () => {
  const api = fakeApi();
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({
    type: "saveState",
    state: validState([{ id, kind: "url", value: "https://x.com/home?foo=bar" }])
  }, {});

  assert.equal(response.type, "saved");
  assert.equal(response.state.entries[0].value, "x.com");
  assert.equal(response.state.blockedPageHtml, "<p>Blocked.</p>");
  assert.equal(api.storageData[core.STATE_KEY].entries[0].value, "x.com");
  assert.deepEqual(api.registeredScripts[0].js, ["content.js"]);
  assert.deepEqual(api.registeredScripts[0].matches, ["*://*.twitter.com/*", "*://*.x.com/*"]);
});

test("getState loads default blocked pages when storage is empty", async () => {
  const controller = createBackgroundController(fakeApi());
  const response = await controller.getState();

  assert.equal(response.type, "state");
  assert.deepEqual(response.state.entries, core.emptyState(defaultBlockedPages).entries);
  assert.deepEqual(response.state.schedule, { type: "dailyWindow", startMinute: 1380, endMinute: 1140 });
  assert.deepEqual(response.state.limitReset, { type: "rollingWindow", windowHours: 16 });
  assert.deepEqual(response.state.domainLimits, core.emptyState(defaultBlockedPages).domainLimits);
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

  assert.equal(response.type, "saved");
  assert.deepEqual(api.registeredScripts[0].matches, ["*://*.reddit.com/*", "*://*.twitter.com/*", "*://*.x.com/*"]);
  assert.deepEqual(api.removedOrigins, ["*://*.example.com/*"]);
});

test("saveState keeps install-time permissions when they are no longer blocked", async () => {
  const api = fakeApi({ grantedOrigins: ["*://*.example.com/*", "*://*.youtube.com/*"] });
  const controller = createBackgroundController(api);
  const response = await controller.saveState(validState([]));

  assert.equal(response.type, "saved");
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

  assert.equal(response.type, "saved");
  assert.deepEqual(api.registeredScripts[0].matches, ["*://*.x.com/*"]);
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
  assert.deepEqual(api.registeredScripts[0].matches, ["*://*.twitter.com/*", "*://*.x.com/*"]);
});

test("urlChanged redirects matching sender tab to the blocked page", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com" }
  ], { type: "always" });
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "urlChanged", url: "https://x.com/home" }, { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: "safari-web-extension://extension/blocked.html#https%3A%2F%2Fx.com%2Fhome"
  }]);
});

test("urlChanged allows URLs that no longer match saved state", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com" }
  ]);
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "urlChanged", url: "https://x.com/messages" }, { tab: { id: 7 } });

  assert.equal(response.type, "allowed");
  assert.deepEqual(api.updatedTabs, []);
});

test("urlChanged allows matching URLs outside the schedule", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com" }
  ], inactiveSchedule());
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "urlChanged", url: "https://x.com" }, { tab: { id: 7 } });

  assert.equal(response.type, "allowed");
  assert.deepEqual(api.updatedTabs, []);
});

test("urlChanged redirects matching URLs inside the schedule", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com" }
  ], activeSchedule());
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "urlChanged", url: "https://x.com" }, { tab: { id: 7 } });

  assert.equal(response.type, "redirected");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: "safari-web-extension://extension/blocked.html#https%3A%2F%2Fx.com"
  }]);
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
  }, {}), { type: "logged", domain: "reddit.com", totalMs: 1500, limitMinutes: 30, isOverLimit: false });
  assert.deepEqual(await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://www.example.com/path",
    elapsedMs: 2500
  }, {}), { type: "logged", domain: "example.com", totalMs: 2500, limitMinutes: 30, isOverLimit: false });
  assert.deepEqual(await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://ignored.example/",
    elapsedMs: 1000
  }, {}), { type: "logged", domain: "ignored.example", totalMs: 1000, limitMinutes: 30, isOverLimit: false });

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

test("screenTimeElapsed rejects old screen time usage schemas", async () => {
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

  await assert.rejects(() => controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://www.example.com/path",
    elapsedMs: 2500
  }, {}), /Screen time usage/);
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
  }, {}), { type: "logged", domain: "example.com", totalMs: 2500, limitMinutes: 30, isOverLimit: false });
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
    elapsedMs: 0
  }, {}), /positive integer/);
});

test("getScreenTimeLog sums the last 16 hour buckets without pruning storage", async () => {
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
      { domain: "example.com", totalMs: 9000, limitMinutes: 1, isOverLimit: false }
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

test("getScreenTimeLog uses the configured rolling reset window", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ], core.DEFAULT_SCHEDULE, [
    { domain: "example.com", limitMinutes: 1 }
  ], { type: "rollingWindow", windowHours: 2 });
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": {
      18: 1000,
      19: 2000,
      20: 3000
    }
  });
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({ type: "getScreenTimeLog" }, {}), {
    type: "screenTimeLog",
    entries: [
      { domain: "example.com", totalMs: 5000, limitMinutes: 1, isOverLimit: false }
    ]
  });
});

test("getScreenTimeLog uses the latest daily reset hour", async () => {
  const now = new Date(2026, 0, 2, 10, 30).getTime();
  const resetHour = hourNumber(new Date(2026, 0, 2, 6));
  const api = fakeApi({ now });

  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ], core.DEFAULT_SCHEDULE, [
    { domain: "example.com", limitMinutes: 1 }
  ], { type: "daily", resetHour: 6 });
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": {
      [resetHour - 1]: 1000,
      [resetHour]: 2000,
      [resetHour + 4]: 3000,
      [resetHour + 5]: 4000
    }
  });
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({ type: "getScreenTimeLog" }, {}), {
    type: "screenTimeLog",
    entries: [
      { domain: "example.com", totalMs: 5000, limitMinutes: 1, isOverLimit: false }
    ]
  });
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
  }, {}), { type: "logged", domain: "example.com", totalMs: 15000, limitMinutes: 30, isOverLimit: false });
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

test("getScreenTimeLog hides active domains with zero usage", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" },
    { id: "22222222-2222-4222-8222-222222222222", kind: "domain", value: "idle.example" }
  ]);
  api.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": { 20: 1000 }
  });
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({ type: "getScreenTimeLog" }, {}), {
    type: "screenTimeLog",
    entries: [
      { domain: "example.com", totalMs: 1000, limitMinutes: 30, isOverLimit: false }
    ]
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
  const blocked = await controller.handleMessage({ type: "urlChanged", url: "https://x.com/home" }, { tab: { id: 7 } });
  const allowed = await controller.handleMessage({ type: "urlChanged", url: "https://x.com/messages" }, { tab: { id: 8 } });

  assert.equal(blocked.type, "redirected");
  assert.equal(allowed.type, "allowed");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: "safari-web-extension://extension/blocked.html#https%3A%2F%2Fx.com%2Fhome"
  }]);
});

test("screenTimeElapsed redirects matching URLs after crossing the limit", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com/home" }
  ], inactiveSchedule(), [
    { domain: "x.com", limitMinutes: 1 }
  ]);
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://x.com/home",
    elapsedMs: 60000
  }, { tab: { id: 7 } });

  assert.deepEqual(response, { type: "logged", domain: "x.com", totalMs: 60000, limitMinutes: 1, isOverLimit: true });
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: "safari-web-extension://extension/blocked.html#https%3A%2F%2Fx.com%2Fhome"
  }]);
});

test("whole-domain usage counts on non-matching URLs without redirecting them", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "https://x.com/home" }
  ], inactiveSchedule(), [
    { domain: "x.com", limitMinutes: 1 }
  ]);
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://x.com/messages",
    elapsedMs: 60000
  }, { tab: { id: 7 } });

  assert.deepEqual(response, { type: "logged", domain: "x.com", totalMs: 60000, limitMinutes: 1, isOverLimit: true });
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
      elapsedMs: 30000
    }, {});
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
    }, {});
    api.nowValue += 30000;
    await controller.handleMessage({
      type: "screenTimeElapsed",
      url: "https://example.com",
      elapsedMs: 30000
    }, {});
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
    }, {});

    assert.equal(response.type, "logged");
    assert.equal(api.storageData.screenTimeUsage.dirtySinceMs, 72000000);
    assert.equal(api.storageData.screenTimeUsage.localBuckets["example.com"][20].syncedMs, 0);
  } finally {
    globalThis.fetch = fetch;
    console.error = consoleError;
  }
});

test("saveState applies newer remote settings when Supabase wins", async () => {
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
    const response = await controller.saveState(validState([
      { id, kind: "domain", value: "example.com" }
    ]));

    assert.equal(response.type, "saved");
    assert.deepEqual(response.state, remoteState);
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

    assert.equal(response.type, "state");
    assert.deepEqual(response.state, remoteState);
    assert.equal(userSettingsUrls.length, 1);
    assert.match(userSettingsUrls[0], /select=user_id,state,updated_at_ms,revision_id,device_id,updated_at/);
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

  assert.equal(response.type, "saved");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: "safari-web-extension://extension/blocked.html#https%3A%2F%2Fx.com%2Fhome"
  }]);
});

function validState(entries, schedule = core.DEFAULT_SCHEDULE, domainLimits, limitReset = core.DEFAULT_LIMIT_RESET) {
  const stateEntries = stateEntriesWithDefaults(entries);

  return {
    schemaVersion: core.SCHEMA_VERSION,
    entries: stateEntries,
    blockedPageHtml: "<p>Blocked.</p>",
    schedule,
    limitReset,
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

function hourNumber(date) {
  return Math.floor(date.getTime() / (60 * 60 * 1000));
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

function fakeApi(overrides = {}) {
  const api = {
    storageData: {},
    nativeData: {},
    grantedOrigins: overrides.grantedOrigins || ["*://*.example.com/*", ...manifest.host_permissions],
    tabsData: overrides.tabs || [],
    registeredScripts: [],
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

        return `safari-web-extension://extension/${path}`;
      },
      getManifest() {
        return manifest;
      }
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: api.storageData[key] };
        },
        async remove(key) {
          delete api.storageData[key];
        },
        async set(value) {
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
        api.registeredScripts = api.registeredScripts.filter((script) => !ids.includes(script.id));
      },
      async registerContentScripts(scripts) {
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

  if (overrides.nativeStorage) {
    api.runtime.getPlatformInfo = async () => ({ os: "ios" });
    api.runtime.sendNativeMessage = async (_applicationId, message) => {
      switch (message.type) {
        case "loadState":
          return { type: "storedState", state: api.nativeData[core.STATE_KEY] };
        case "saveState":
          api.nativeData[core.STATE_KEY] = message.state;
          return { type: "savedState", state: message.state };
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
        case "clearSettingsSync":
          delete api.nativeData.settingsSync;
          return { type: "clearedSettingsSync" };
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
