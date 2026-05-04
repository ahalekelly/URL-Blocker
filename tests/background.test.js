const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../URLBlockerIOSExtension/Resources/blocker.js");
const { createBackgroundController } = require("../URLBlockerIOSExtension/Resources/background.js");

const id = "11111111-1111-4111-8111-111111111111";

test("saveState validates, writes storage, and broadcasts", async () => {
  const api = fakeApi();
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({
    type: "saveState",
    state: validState([{ id, kind: "url", value: "https://x.com/home?foo=bar" }])
  }, {});

  assert.equal(response.type, "saved");
  assert.equal(response.state.entries[0].value, "x.com/home");
  assert.equal(response.state.blockedPageHtml, "<p>Blocked.</p>");
  assert.equal(api.storageData[core.STATE_KEY].entries[0].value, "x.com/home");
  assert.equal(api.messages.length, 2);
});

test("saveState migrates the old Safari API setting away", async () => {
  const api = fakeApi();
  const controller = createBackgroundController(api);
  const response = await controller.saveState({
    schemaVersion: 3,
    entries: [{ id, kind: "domain", value: "example.com" }],
    blockedPageHtml: "<p>Blocked.</p>",
    useSafariBlockingApi: true
  });

  assert.equal(response.type, "saved");
  assert.equal(response.state.schemaVersion, 4);
  assert.equal("useSafariBlockingApi" in response.state, false);
  assert.equal("useSafariBlockingApi" in api.storageData[core.STATE_KEY], false);
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

test("closeCurrentTab removes sender tab", async () => {
  const api = fakeApi();
  const controller = createBackgroundController(api);
  const response = await controller.handleMessage({ type: "closeCurrentTab" }, { tab: { id: 7 } });

  assert.equal(response.type, "closed");
  assert.deepEqual(api.removedTabs, [7]);
});

function validState(entries) {
  return {
    schemaVersion: 4,
    entries,
    blockedPageHtml: "<p>Blocked.</p>"
  };
}

function fakeApi() {
  const api = {
    storageData: {},
    messages: [],
    removedTabs: [],
    runtime: {
      getURL(path) {
        return `safari-web-extension://extension/${path}`;
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
    tabs: {
      async query() {
        return [{ id: 1 }, { id: 2 }];
      },
      async sendMessage(tabId, message) {
        api.messages.push({ tabId, message });
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
