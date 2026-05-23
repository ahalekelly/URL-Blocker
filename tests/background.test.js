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
  assert.deepEqual(response.state.schedule, { type: "always" });
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

test("resetState restores default blocked pages", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = validState([]);
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "resetState" }, {});

  assert.equal(response.type, "saved");
  assert.deepEqual(response.state.entries, core.emptyState(defaultBlockedPages).entries);
  assert.deepEqual(api.storageData[core.STATE_KEY].entries, core.emptyState(defaultBlockedPages).entries);
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
  ]);
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
    schemaVersion: 1,
    totalsByDomain: {
      "example.com": { 20: 2500 },
      "ignored.example": { 20: 1000 },
      "reddit.com": { 20: 1500 }
    }
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
  }, {}), { type: "logged", domain: "example.com", totalMs: 2500, limitMinutes: 30, isOverLimit: false });
  assert.equal(api.storageData.screenTimeUsage, undefined);
  assert.deepEqual(api.nativeData.screenTimeUsage, {
    schemaVersion: 1,
    totalsByDomain: {
      "example.com": { 20: 2500 }
    }
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
  api.storageData.screenTimeUsage = {
    schemaVersion: 1,
    totalsByDomain: {
      "example.com": {
        4: 1000,
        5: 2000,
        19: 3000,
        20: 4000,
        21: 5000
      }
    }
  };
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({ type: "getScreenTimeLog" }, {}), {
    type: "screenTimeLog",
    entries: [
      { domain: "example.com", totalMs: 9000, limitMinutes: 1, isOverLimit: false }
    ]
  });
  assert.deepEqual(api.storageData.screenTimeUsage, {
    schemaVersion: 1,
    totalsByDomain: {
      "example.com": {
        4: 1000,
        5: 2000,
        19: 3000,
        20: 4000,
        21: 5000
      }
    }
  });
});

test("screenTimeElapsed keeps historical buckets when saving", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ]);
  api.storageData.screenTimeUsage = {
    schemaVersion: 1,
    totalsByDomain: {
      "example.com": {
        4: 1000,
        5: 2000,
        19: 3000,
        20: 4000,
        21: 5000
      }
    }
  };
  const controller = createBackgroundController(api);

  assert.deepEqual(await controller.handleMessage({
    type: "screenTimeElapsed",
    url: "https://www.example.com/path",
    elapsedMs: 6000
  }, {}), { type: "logged", domain: "example.com", totalMs: 15000, limitMinutes: 30, isOverLimit: false });
  assert.deepEqual(api.storageData.screenTimeUsage, {
    schemaVersion: 1,
    totalsByDomain: {
      "example.com": {
        4: 1000,
        5: 2000,
        19: 3000,
        20: 10000,
        21: 5000
      }
    }
  });
});

test("getScreenTimeLog hides active domains with zero usage", async () => {
  const api = fakeApi({ now: 20 * 60 * 60 * 1000 });
  api.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" },
    { id: "22222222-2222-4222-8222-222222222222", kind: "domain", value: "idle.example" }
  ]);
  api.storageData.screenTimeUsage = {
    schemaVersion: 1,
    totalsByDomain: {
      "example.com": { 20: 1000 }
    }
  };
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
  api.storageData.screenTimeUsage = {
    schemaVersion: 1,
    totalsByDomain: {
      "x.com": { 20: 60000 }
    }
  };
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
  ]));

  assert.equal(response.type, "saved");
  assert.deepEqual(api.updatedTabs, [{
    tabId: 7,
    url: "safari-web-extension://extension/blocked.html#https%3A%2F%2Fx.com%2Fhome"
  }]);
});

function validState(entries, schedule = core.DEFAULT_SCHEDULE, domainLimits) {
  const stateEntries = stateEntriesWithDefaults(entries);

  return {
    schemaVersion: core.SCHEMA_VERSION,
    entries: stateEntries,
    blockedPageHtml: "<p>Blocked.</p>",
    schedule,
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

function fakeApi(overrides = {}) {
  const api = {
    storageData: {},
    nativeData: {},
    grantedOrigins: overrides.grantedOrigins || ["*://*.example.com/*", ...manifest.host_permissions],
    tabsData: overrides.tabs || [],
    registeredScripts: [],
    removedOrigins: [],
    updatedTabs: [],
    now: overrides.now === undefined ? undefined : () => overrides.now,
    runtime: {
      getURL(path) {
        if (path === "default-blocked-pages.json") {
          return `data:application/json,${encodeURIComponent(JSON.stringify(defaultBlockedPages))}`;
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
        case "getState":
          return { type: "state", state: api.nativeData[core.STATE_KEY] || core.emptyState(defaultBlockedPages) };
        case "saveState":
          api.nativeData[core.STATE_KEY] = message.state;
          return { type: "saved", state: message.state };
        case "getScreenTimeUsage":
          return { type: "screenTimeUsage", usage: api.nativeData.screenTimeUsage };
        case "saveScreenTimeUsage":
          api.nativeData.screenTimeUsage = message.usage;
          return { type: "savedScreenTimeUsage", usage: message.usage };
        default:
          return { type: "error", error: `Unknown native message type: ${message.type}.` };
      }
    };
  }

  return api;
}
