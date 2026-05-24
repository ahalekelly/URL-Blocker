const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const core = require("../URLBlockerIOSExtension/Resources/blocker.js");
const defaultBlockedPages = require("../URLBlockerIOSExtension/Resources/default-blocked-pages.json");
const manifest = require("../URLBlockerIOSExtension/Resources/manifest.json");
const { createBackgroundController } = require("../URLBlockerIOSExtension/Resources/background.js");

const resourcesPath = path.join(__dirname, "../URLBlockerIOSExtension/Resources");
const optionsScript = fs.readFileSync(path.join(resourcesPath, "options.js"), "utf8");
const contentScript = fs.readFileSync(path.join(resourcesPath, "content.js"), "utf8");
const blockedScript = fs.readFileSync(path.join(resourcesPath, "blocked.js"), "utf8");
const id = "11111111-1111-4111-8111-111111111111";

test("options requests only missing website access for saved states", async () => {
  const app = createExtensionApp();

  app.backgroundApi.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ]);

  const page = await openOptionsPage(app);

  assert.equal(page.byId("permissionPanel").hidden, false);
  assert.equal(page.byId("editorPanel").hidden, true);
  assert.equal(page.byId("permissionMessage").textContent, "URL Blocker needs access to this website before blocking can run.");

  await page.byId("grantAccessButton").dispatch("click");

  assert.deepEqual(app.optionsApi.permissionRequests, [["*://*.example.com/*"]]);
  assert.equal(page.byId("permissionPanel").hidden, true);
  assert.equal(page.byId("editorPanel").hidden, false);
  assert.deepEqual(app.backgroundApi.registeredScripts[0].matches, ["*://*.example.com/*"]);
});

test("end-to-end options save blocks a page and renders the blocked view", async () => {
  const app = createExtensionApp({
    tabs: [{ id: 2, url: "https://example.com/focus" }]
  });
  const page = await openOptionsPage(app);

  await page.byId("addRowButton").dispatch("click");
  page.customRows().at(-1).querySelector(".value-input").value = "https://example.com/focus?ref=feed";
  await page.customRows().at(-1).querySelector(".value-input").dispatch("input");
  await page.byId("alwaysScheduleInput").dispatch("change");
  page.byId("blockedPageHtmlInput").value = "<h1>Stay focused</h1>";
  await page.byId("blockedPageHtmlInput").dispatch("input");
  await page.byId("saveButton").dispatch("click");

  const savedState = app.backgroundApi.storageData[core.STATE_KEY];

  assert.equal(page.byId("successMessage").textContent, "Saved.");
  assert.equal(savedState.entries.at(-1).value, "example.com/focus");
  assert.deepEqual(app.optionsApi.permissionRequests, [["*://*.example.com/*"]]);
  assert.ok(app.backgroundApi.registeredScripts.at(-1).matches.includes("*://*.example.com/*"));
  assert.deepEqual(app.backgroundApi.updatedTabs, [{
    tabId: 2,
    url: "safari-web-extension://extension/blocked.html#https%3A%2F%2Fexample.com%2Ffocus"
  }]);

  await runContentScript(app, "https://example.com/focus", 3);

  assert.deepEqual(app.backgroundApi.updatedTabs.at(-1), {
    tabId: 3,
    url: "safari-web-extension://extension/blocked.html#https%3A%2F%2Fexample.com%2Ffocus"
  });

  const blocked = await openBlockedPage(app, app.backgroundApi.updatedTabs.at(-1).url);

  assert.equal(blocked.byId("blockedMessage").innerHTML, "<h1>Stay focused</h1>");
  assert.equal(blocked.byId("blockedTarget").textContent, "https://example.com/focus");
});

async function openOptionsPage(app) {
  const document = optionsDocument();
  const context = {
    BlockerCore: core,
    browser: app.optionsApi,
    console,
    document,
    location: {
      hash: "",
      href: "safari-web-extension://extension/options.html",
      pathname: "/options.html"
    },
    history: { replaceState() {} },
    addEventListener() {}
  };

  vm.runInNewContext(optionsScript, context, { filename: "options.js" });
  await settle();

  return page(document);
}

async function openBlockedPage(app, url) {
  const document = blockedDocument();
  const pendingMessages = [];
  const context = {
    browser: {
      runtime: {
        sendMessage(message) {
          const result = app.controller.handleMessage(message, {});

          pendingMessages.push(result);
          return result;
        }
      },
      tabs: {
        async getCurrent() {
          return { id: 4 };
        },
        async remove() {}
      }
    },
    console,
    document,
    location: { hash: new URL(url).hash }
  };

  vm.runInNewContext(blockedScript, context, { filename: "blocked.js" });
  await Promise.all(pendingMessages);
  await settle();

  return page(document);
}

async function runContentScript(app, url, tabId) {
  const pendingMessages = [];
  const context = {
    browser: {
      runtime: {
        sendMessage(message) {
          const result = app.controller.handleMessage(message, { tab: { id: tabId } });

          pendingMessages.push(result);
          return result;
        }
      }
    },
    console,
    document: { hidden: false },
    location: { href: url },
    addEventListener() {},
    clearTimeout() {},
    setInterval() {},
    setTimeout(listener) {
      listener();
      return 1;
    },
    Date
  };

  vm.runInNewContext(contentScript, context, { filename: "content.js" });
  await Promise.all(pendingMessages);
}

function createExtensionApp(overrides = {}) {
  const backgroundApi = fakeBackgroundApi(overrides);
  const controller = createBackgroundController(backgroundApi);
  const optionsApi = {
    permissionRequests: [],
    runtime: {
      sendMessage(message) {
        return controller.handleMessage(message, {});
      }
    },
    permissions: {
      contains: backgroundApi.permissions.contains,
      async request({ origins }) {
        optionsApi.permissionRequests.push([...origins]);
        backgroundApi.grantedOrigins = [...new Set([...backgroundApi.grantedOrigins, ...origins])];
        return true;
      }
    }
  };

  return { backgroundApi, controller, optionsApi };
}

function fakeBackgroundApi(overrides) {
  const api = {
    storageData: {},
    grantedOrigins: [...manifest.host_permissions],
    tabsData: overrides.tabs || [],
    registeredScripts: [],
    removedOrigins: [],
    updatedTabs: [],
    uuidIndex: 1,
    nowValue: new Date(2026, 0, 1, 12).getTime(),
    now() {
      return api.nowValue;
    },
    randomUUID() {
      const suffix = String(api.uuidIndex).padStart(12, "0");

      api.uuidIndex += 1;
      return `22222222-2222-4222-8222-${suffix}`;
    },
    runtime: {
      getURL(resourcePath) {
        if (resourcePath === "default-blocked-pages.json") {
          return dataJsonUrl(defaultBlockedPages);
        }

        if (resourcePath === "supabase-config.json") {
          return dataJsonUrl({
            schemaVersion: 1,
            supabaseUrl: "",
            publishableKey: "",
            redirectScheme: "urlblocker",
            screenTimeSyncAgeMs: 60000
          });
        }

        return `safari-web-extension://extension/${resourcePath}`;
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

  return api;
}

function validState(entries, schedule = core.DEFAULT_SCHEDULE) {
  const stateEntries = stateEntriesWithDefaults(entries);

  return {
    schemaVersion: core.SCHEMA_VERSION,
    entries: stateEntries,
    blockedPageHtml: "<h1>Stay focused</h1>",
    schedule,
    limitReset: core.DEFAULT_LIMIT_RESET,
    domainLimits: core.domainLimitsForEntries(stateEntries, [])
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

function optionsDocument() {
  const document = testDocument([
    "rows",
    "rowTemplate",
    "saveButton",
    "addRowButton",
    "blockedPageHtmlInput",
    "alwaysScheduleInput",
    "dailyScheduleInput",
    "scheduleWindowFields",
    "scheduleStartInput",
    "scheduleEndInput",
    "screenTimeTitle",
    "rollingResetInput",
    "dailyResetInput",
    "rollingResetFields",
    "dailyResetFields",
    "rollingWindowHoursInput",
    "dailyResetHourSelect",
    "errorSummary",
    "successMessage",
    "screenTimeRows",
    "emptyScreenTime",
    "syncStatusText",
    "googleSignInButton",
    "appleSignInButton",
    "syncNowButton",
    "signOutButton",
    "repairPanel",
    "repairMessage",
    "resetButton",
    "editorPanel",
    "permissionPanel",
    "permissionMessage",
    "permissionError",
    "grantAccessButton"
  ]);

  document.elements.rowTemplate.content = { cloneNode: rowTemplateContent };

  return document;
}

function blockedDocument() {
  return testDocument(["blockedMessage", "blockedTarget", "closeButton"]);
}

function testDocument(ids) {
  const elements = Object.fromEntries(ids.map((id) => [id, new TestElement("div", id)]));

  return {
    elements,
    createElement(tagName) {
      return new TestElement(tagName);
    },
    getElementById(id) {
      const element = elements[id];

      if (!element) {
        throw new Error(`Missing test element: ${id}`);
      }

      return element;
    }
  };
}

function rowTemplateContent() {
  const fragment = new TestElement("fragment");
  const row = new TestElement("article", "", "block-row");
  const toolbar = new TestElement("div", "", "row-toolbar");
  const segments = new TestElement("div", "", "segments");
  const enabledLabel = new TestElement("label", "", "enabled-label");
  const enabledInput = new TestElement("input", "", "enabled-input");
  const enabledText = new TestElement("span");
  const deleteButton = new TestElement("button", "", "delete-button");
  const valueLabel = new TestElement("label");
  const valueInput = new TestElement("input", "", "value-input");
  const limitLabel = new TestElement("label");
  const limitInput = new TestElement("input", "", "limit-input");
  const rowError = new TestElement("p", "", "row-error");

  enabledLabel.append(enabledInput, enabledText);
  toolbar.append(segments, enabledLabel, deleteButton);
  valueLabel.append(valueInput);
  limitLabel.append(limitInput);
  row.append(toolbar, valueLabel, limitLabel, rowError);
  fragment.append(row);

  return fragment;
}

function page(document) {
  return {
    document,
    byId(id) {
      return document.getElementById(id);
    },
    customRows() {
      return document.getElementById("rows").children.filter((row) => row.querySelector(".value-input"));
    }
  };
}

class TestElement {
  constructor(tagName, id = "", className = "") {
    this.tagName = tagName;
    this.id = id;
    this.className = className;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.checked = false;
    this.textContent = "";
    this.innerHTML = "";
    this.classList = {
      add: (...classNames) => {
        this.className = [...new Set([...this.className.split(" ").filter(Boolean), ...classNames])].join(" ");
      }
    };
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  async dispatch(type, event = {}) {
    const listeners = this.listeners.get(type) || [];

    await Promise.all(listeners.map((listener) => listener({ target: this, ...event })));
    await settle();
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  querySelector(selector) {
    if (!selector.startsWith(".")) {
      throw new Error(`Unsupported selector: ${selector}`);
    }

    return findByClass(this, selector.slice(1));
  }
}

function findByClass(element, className) {
  if (element.className.split(" ").includes(className)) {
    return element;
  }

  for (const child of element.children) {
    const match = findByClass(child, className);

    if (match) {
      return match;
    }
  }

  return null;
}

async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function dataJsonUrl(value) {
  return `data:application/json,${encodeURIComponent(JSON.stringify(value))}`;
}
