const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../URLBlockerIOSExtension/Resources/blocker.js");
const { createBackgroundController } = require("../URLBlockerIOSExtension/Resources/background.js");

const id = "11111111-1111-4111-8111-111111111111";

test("saveState validates, checks regex support, updates DNR, writes storage, and broadcasts", async () => {
  const api = fakeApi();
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({
    type: "saveState",
    state: enabledState([{ id, kind: "url", value: "https://x.com/home?foo=bar" }])
  }, {});

  assert.equal(response.type, "saved");
  assert.equal(response.state.entries[0].value, "x.com/home");
  assert.equal(response.state.blockedPageHtml, "<p>Blocked.</p>");
  assert.equal(response.state.useSafariBlockingApi, true);
  assert.equal(api.storageData[core.STATE_KEY].entries[0].value, "x.com/home");
  assert.equal(api.dynamicRules.length, 1);
  assert.equal(api.messages.length, 2);
});

test("saveState removes DNR rules when Safari blocking API is off", async () => {
  const api = fakeApi();
  api.dynamicRules = [{ id: 1, condition: { regexFilter: "old" } }];
  const controller = createBackgroundController(api);
  const response = await controller.saveState({
    schemaVersion: 3,
    entries: [{ id, kind: "domain", value: "example.com" }],
    blockedPageHtml: "<p>Blocked.</p>",
    useSafariBlockingApi: false
  });

  assert.equal(response.type, "saved");
  assert.deepEqual(api.dynamicRules, []);
});

test("failed validation leaves DNR and storage untouched", async () => {
  const api = fakeApi();
  const controller = createBackgroundController(api);
  const response = await controller.saveState({
    schemaVersion: 1,
    entries: [{ id, kind: "domain", value: "https://example.com" }]
  });

  assert.equal(response.type, "validationError");
  assert.equal(api.dynamicRules.length, 0);
  assert.equal(api.storageData[core.STATE_KEY], undefined);
});

test("unsupported DNR regex leaves DNR and storage untouched", async () => {
  const api = fakeApi();
  api.unsupportedRegex = "^https://x\\.com/home/?$";
  const controller = createBackgroundController(api);

  await assert.rejects(
    () => controller.saveState({
      ...enabledState([{ id, kind: "regex", value: "^https://x\\.com/home/?$" }])
    }),
    /unsupported/
  );

  assert.equal(api.dynamicRules.length, 0);
  assert.equal(api.storageData[core.STATE_KEY], undefined);
});

test("failed dynamic rule update restores previous app-owned rules", async () => {
  const api = fakeApi();
  api.dynamicRules = [{ id: 1, condition: { regexFilter: "old" } }];
  api.failNextUpdate = true;
  const controller = createBackgroundController(api);

  await assert.rejects(
    () => controller.saveState({
      ...enabledState([{ id, kind: "domain", value: "example.com" }])
    }),
    /DNR failed/
  );

  assert.deepEqual(api.dynamicRules, [{ id: 1, condition: { regexFilter: "old" } }]);
  assert.equal(api.storageData[core.STATE_KEY], undefined);
});

test("urlMatched re-checks current storage before redirecting", async () => {
  const api = fakeApi();
  api.storageData[core.STATE_KEY] = {
    schemaVersion: 1,
    entries: [{ id, kind: "url", value: "https://x.com/home" }]
  };
  const controller = createBackgroundController(api);

  const blocked = await controller.handleMessage(
    { type: "urlMatched", url: "https://x.com/home#feed", entryId: id },
    { tab: { id: 7 } }
  );

  assert.equal(blocked.type, "blocked");
  assert.match(api.updatedTabs[0].url, /blocked\.html#https%3A%2F%2Fx\.com%2Fhome%23feed$/);

  api.storageData[core.STATE_KEY] = core.emptyState();
  const stale = await controller.handleMessage(
    { type: "urlMatched", url: "https://x.com/home#feed", entryId: id },
    { tab: { id: 7 } }
  );

  assert.equal(stale.type, "notBlocked");
  assert.equal(api.updatedTabs.length, 1);
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

test("closeCurrentTab removes sender tab", async () => {
  const api = fakeApi();
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "closeCurrentTab" }, { tab: { id: 7 } });

  assert.equal(response.type, "closed");
  assert.deepEqual(api.removedTabs, [7]);
});

test("syncBlockingRules removes stale DNR rules for migrated states", async () => {
  const api = fakeApi();
  api.dynamicRules = [{ id: 1, condition: { regexFilter: "old" } }];
  api.storageData[core.STATE_KEY] = {
    schemaVersion: 2,
    entries: [{ id, kind: "domain", value: "example.com" }],
    blockedPageHtml: "<p>Blocked.</p>"
  };
  const controller = createBackgroundController(api);

  await controller.syncBlockingRules();

  assert.deepEqual(api.dynamicRules, []);
});

function enabledState(entries) {
  return {
    schemaVersion: 3,
    entries,
    blockedPageHtml: "<p>Blocked.</p>",
    useSafariBlockingApi: true
  };
}

function fakeApi() {
  const api = {
    storageData: {},
    dynamicRules: [],
    messages: [],
    updatedTabs: [],
    removedTabs: [],
    unsupportedRegex: "",
    failNextUpdate: false,
    runtime: {
      getURL(path) {
        return `safari-web-extension://extension/${path}`;
      },
      async openOptionsPage() {
        api.openedOptions = true;
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
    declarativeNetRequest: {
      async getDynamicRules() {
        return api.dynamicRules.slice();
      },
      async isRegexSupported({ regex }) {
        if (regex === api.unsupportedRegex) {
          return { isSupported: false, reason: "unsupported regex" };
        }

        return { isSupported: true };
      },
      async updateDynamicRules({ addRules }) {
        if (api.failNextUpdate) {
          api.failNextUpdate = false;
          throw new Error("DNR failed");
        }

        api.dynamicRules = addRules.slice();
      }
    },
    tabs: {
      async query() {
        return [{ id: 1 }, { id: 2 }];
      },
      async sendMessage(tabId, message) {
        api.messages.push({ tabId, message });
      },
      async update(tabId, update) {
        api.updatedTabs.push({ tabId, url: update.url });
      },
      async create({ url }) {
        api.createdTab = url;
      },
      async remove(tabId) {
        api.removedTabs.push(tabId);
      }
    }
  };

  return api;
}
