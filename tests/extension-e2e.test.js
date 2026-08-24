const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const core = require("../URLBlockerWebExtension/blocker.js");
const defaultBlockedPages = require("../URLBlockerWebExtension/default-blocked-pages.json");
const manifest = require("../URLBlockerWebExtension/manifest.json");
const { createBackgroundController } = require("../URLBlockerWebExtension/background.js");

const resourcesPath = path.join(__dirname, "../URLBlockerWebExtension");
const optionsScript = fs.readFileSync(path.join(resourcesPath, "options.js"), "utf8");
const contentScript = fs.readFileSync(path.join(resourcesPath, "content.js"), "utf8");
const blockedScript = fs.readFileSync(path.join(resourcesPath, "blocked.js"), "utf8");
const statsScript = fs.readFileSync(path.join(resourcesPath, "stats.js"), "utf8");
const id = "11111111-1111-4111-8111-111111111111";

function blockedUrl(url, reason) {
  return `safari-web-extension://extension/blocked.html?reason=${reason}#${encodeURIComponent(url)}`;
}

test("options requests only missing website access for saved states", async () => {
  const app = createExtensionApp();

  app.backgroundApi.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ]);

  const page = await openOptionsPage(app);

  assert.deepEqual(messageTypes(app).slice(0, 4), ["syncNow", "getLocalState", "getLocalScreenTimeLog", "getSyncStatus"]);
  assert.equal(page.byId("permissionPanel").hidden, false);
  assert.equal(page.byId("editorPanel").hidden, true);
  assert.equal(page.byId("permissionMessage").textContent, "URL Blocker needs access to this website before blocking can run.");

  await page.byId("grantAccessButton").dispatch("click");

  assert.deepEqual(app.optionsApi.permissionRequests, [["*://*.example.com/*"]]);
  assert.equal(page.byId("permissionPanel").hidden, true);
  assert.equal(page.byId("editorPanel").hidden, false);
  assert.deepEqual(app.backgroundApi.registeredScripts[0].matches, ["*://*.example.com/*"]);
});

test("options renders local data before startup sync finishes", async () => {
  const app = createExtensionApp({ delaySyncNow: true });

  app.backgroundApi.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ]);
  app.backgroundApi.grantedOrigins.push("*://*.example.com/*");

  const page = await openOptionsPage(app);

  assert.deepEqual(messageTypes(app).slice(0, 4), ["syncNow", "getLocalState", "getLocalScreenTimeLog", "getSyncStatus"]);
  assert.equal(page.byId("editorPanel").hidden, false);
  assert.equal(page.customRows().at(-1).querySelector(".value-input").value, "example.com");

  await app.optionsApi.finishSyncNow();
});

test("options keeps the editor hidden until local data loads", async () => {
  const app = createExtensionApp({ delayGetLocalState: true });

  app.backgroundApi.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ]);
  app.backgroundApi.grantedOrigins.push("*://*.example.com/*");

  const page = await openOptionsPage(app);

  assert.deepEqual(messageTypes(app), ["syncNow", "getLocalState"]);
  assert.equal(page.byId("editorPanel").hidden, true);
  assert.equal(page.byId("rows").children.length, 0);

  await app.optionsApi.finishGetLocalState();

  assert.equal(page.byId("editorPanel").hidden, false);
  assert.equal(page.customRows().at(-1).querySelector(".value-input").value, "example.com");
});

test("options rounds displayed screen time to the nearest minute", async () => {
  const app = createExtensionApp();
  const hour = Math.floor(app.backgroundApi.nowValue / (60 * 60 * 1000));

  app.backgroundApi.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "x.com" }
  ]);
  app.backgroundApi.storageData.screenTimeUsage = screenTimeUsage({
    "x.com": { [hour]: 90000 }
  });

  const page = await openOptionsPage(app);
  const screenTimeTotal = page.byId("screenTimeRows").children[0].querySelector(".screen-time-total");

  assert.equal(page.byId("screenTimeTitle").textContent, "Last 24 Hours");
  assert.equal(screenTimeTotal.textContent, "2m / 30m");
});

test("options updates the stats summary from draft limit reset settings", async () => {
  const app = createExtensionApp();
  const page = await openOptionsPage(app);

  assert.equal(page.byId("screenTimeTitle").textContent, "Last 24 Hours");

  page.byId("rollingWindowHoursInput").value = "6";
  await page.byId("rollingWindowHoursInput").dispatch("input");

  assert.equal(page.byId("screenTimeTitle").textContent, "Last 6 Hours");

  await page.byId("dailyResetInput").dispatch("change");

  assert.equal(page.byId("screenTimeTitle").textContent, "Today");
});

test("options keeps stats and limit reset visible when block schedule is always", async () => {
  const app = createExtensionApp({ supabaseConfig: configuredSupabase() });
  const hour = Math.floor(app.backgroundApi.nowValue / (60 * 60 * 1000));

  app.backgroundApi.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ], { type: "always" });
  app.backgroundApi.storageData.screenTimeUsage = screenTimeUsage({
    "example.com": { [hour]: 90000 }
  });

  const page = await openOptionsPage(app);

  assert.equal(page.byId("screenTimePanel").hidden, false);
  assert.equal(page.byId("screenTimeRows").children[0].querySelector(".screen-time-total").textContent, "2m");
  assert.equal(page.byId("limitResetPanel").hidden, false);
  assert.equal(page.customRows().at(-1).querySelector(".row-limit").hidden, true);
  assert.equal(page.byId("syncStatusText").textContent, "Sign in to sync settings.");
  assert.equal(page.byId("googleSignInButton").hidden, false);
  assert.equal(page.byId("appleSignInButton").hidden, true);

  await page.byId("dailyScheduleInput").dispatch("change");

  assert.equal(page.byId("limitResetPanel").hidden, false);
  assert.equal(page.byId("screenTimeRows").children[0].querySelector(".screen-time-total").textContent, "2m / 30m");
  assert.equal(page.customRows().at(-1).querySelector(".row-limit").hidden, false);
  assert.equal(page.byId("syncStatusText").textContent, "Sign in to sync settings and screen time limits.");
});

test("options saves domain navigation settings across same-domain rows", async () => {
  const app = createExtensionApp();

  app.backgroundApi.storageData[core.STATE_KEY] = validState([
    { id, kind: "url", value: "example.com" },
    { id: "22222222-2222-4222-8222-222222222222", kind: "url", value: "example.com/focus" }
  ]);
  app.backgroundApi.grantedOrigins.push("*://*.example.com/*");

  const page = await openOptionsPage(app);
  let rows = page.customRows();

  assert.equal(rows[0].querySelector(".block-direct-visits-input").checked, true);
  assert.equal(rows[1].querySelector(".block-direct-visits-input").checked, true);

  rows[0].querySelector(".block-direct-visits-input").checked = false;
  await rows[0].querySelector(".block-direct-visits-input").dispatch("change");
  rows = page.customRows();

  assert.equal(rows[0].querySelector(".block-direct-visits-input").checked, false);
  assert.equal(rows[1].querySelector(".block-direct-visits-input").checked, false);

  rows[1].querySelector(".block-internal-links-input").checked = false;
  await rows[1].querySelector(".block-internal-links-input").dispatch("change");
  await page.byId("saveButton").dispatch("click");

  const domainLimit = app.backgroundApi.storageData[core.STATE_KEY].domainLimits.find((limit) => limit.domain === "example.com");

  assert.equal(domainLimit.blockDirectVisits, false);
  assert.equal(domainLimit.blockInternalLinks, false);
});

test("options hides provider sign-in buttons when sync is signed in", async () => {
  const app = createExtensionApp({
    delaySyncNow: true,
    supabaseConfig: configuredSupabase()
  });

  app.backgroundApi.storageData[core.STATE_KEY] = validState([]);
  app.backgroundApi.storageData.supabaseSession = supabaseSession();
  app.backgroundApi.storageData.settingsSync = settingsSync(app.backgroundApi.nowValue - 2 * 60 * 1000);

  const page = await openOptionsPage(app);

  assert.equal(page.byId("syncStatusText").textContent, "Last synced 2 minutes ago.");
  assert.equal(page.byId("googleSignInButton").hidden, true);
  assert.equal(page.byId("appleSignInButton").hidden, true);
  assert.equal(page.byId("syncNowButton").hidden, false);
  assert.equal(page.byId("signOutButton").hidden, false);
});

test("options hides provider sign-in buttons on iOS", async () => {
  const app = createExtensionApp({
    delaySyncNow: true,
    nativeStorage: true,
    supabaseConfig: configuredSupabase()
  });

  app.backgroundApi.nativeData[core.STATE_KEY] = validState([]);

  const page = await openOptionsPage(app);
  const signInLink = page.byId("syncStatusText").children[0];

  assert.equal(signInLink.tagName, "a");
  assert.equal(signInLink.href, "urlblocker://open");
  assert.equal(signInLink.textContent, "Sign in to sync screen time limits and settings");
  assert.equal(page.byId("googleSignInButton").hidden, true);
  assert.equal(page.byId("appleSignInButton").hidden, true);
  assert.equal(page.byId("syncNowButton").hidden, true);
  assert.equal(page.byId("signOutButton").hidden, true);
});

test("options refreshes iOS sync status after native sign-in", async () => {
  const app = createExtensionApp({
    delaySyncNow: true,
    nativeStorage: true,
    supabaseConfig: configuredSupabase()
  });

  app.backgroundApi.nativeData[core.STATE_KEY] = validState([]);
  const page = await openOptionsPage(app);

  app.backgroundApi.nativeData.supabaseSession = supabaseSession();
  app.backgroundApi.nativeData.settingsSync = settingsSync(app.backgroundApi.nowValue - 2 * 60 * 1000);
  await page.dispatchWindow("focus");

  assert.equal(page.byId("syncStatusText").textContent, "Last synced 2 minutes ago.");
});

test("options hides provider sign-in buttons when iOS sync is signed in", async () => {
  const app = createExtensionApp({
    delaySyncNow: true,
    nativeStorage: true,
    supabaseConfig: configuredSupabase()
  });

  app.backgroundApi.nativeData[core.STATE_KEY] = validState([]);
  app.backgroundApi.nativeData.supabaseSession = supabaseSession();
  app.backgroundApi.nativeData.settingsSync = settingsSync(app.backgroundApi.nowValue - 2 * 60 * 1000);

  const page = await openOptionsPage(app);

  assert.equal(page.byId("syncStatusText").textContent, "Last synced 2 minutes ago.");
  assert.equal(page.byId("googleSignInButton").hidden, true);
  assert.equal(page.byId("appleSignInButton").hidden, true);
  assert.equal(page.byId("syncNowButton").hidden, false);
  assert.equal(page.byId("signOutButton").hidden, false);
});

test("options shows immediate provider sign-in feedback", async () => {
  const app = createExtensionApp({
    delaySignInWithProvider: true,
    supabaseConfig: configuredSupabase()
  });

  app.backgroundApi.storageData[core.STATE_KEY] = validState([]);

  const page = await openOptionsPage(app);
  const click = page.byId("googleSignInButton").dispatch("click");

  await settle();

  assert.equal(page.byId("syncStatusText").textContent, "Opening Google sign-in.");
  assert.equal(page.byId("googleSignInButton").disabled, true);
  assert.equal(page.byId("appleSignInButton").hidden, true);
  assert.equal(page.byId("appleSignInButton").disabled, true);

  await app.optionsApi.finishSignInWithProvider();
  await click;
});

test("options shows the floating save button only for unsaved drafts", async () => {
  const app = createExtensionApp();
  const page = await openOptionsPage(app);
  const saveButton = page.byId("saveButton");
  const blockedPageHtmlInput = page.byId("blockedPageHtmlInput");
  const savedHtml = blockedPageHtmlInput.value;

  assert.equal(saveButton.hidden, true);

  blockedPageHtmlInput.value = `${savedHtml}<p>Extra nudge</p>`;
  await blockedPageHtmlInput.dispatch("input");

  assert.equal(saveButton.hidden, false);

  blockedPageHtmlInput.value = savedHtml;
  await blockedPageHtmlInput.dispatch("input");

  assert.equal(saveButton.hidden, true);
});

test("options clears validation messages while editing invalid rows", async () => {
  const app = createExtensionApp();
  const page = await openOptionsPage(app);

  await page.byId("addRowButton").dispatch("click");
  await page.byId("saveButton").dispatch("click");

  let row = page.customRows().at(-1);

  assert.equal(page.byId("errorSummary").hidden, false);
  assert.equal(row.querySelector(".row-error").textContent, "Enter a value.");

  row.querySelector(".value-input").value = "example.com";
  await row.querySelector(".value-input").dispatch("input");

  row = page.customRows().at(-1);

  assert.equal(page.byId("errorSummary").hidden, true);
  assert.equal(row.querySelector(".row-error").hidden, true);
});

test("options restores saved mode details after temporary mode changes", async () => {
  const app = createExtensionApp();
  const savedState = validState([], { type: "dailyWindow", startMinute: 60, endMinute: 120 });

  savedState.limitReset = { type: "rollingWindow", windowHours: 16 };
  app.backgroundApi.storageData[core.STATE_KEY] = savedState;

  const page = await openOptionsPage(app);

  await page.byId("alwaysScheduleInput").dispatch("change");
  await page.byId("dailyScheduleInput").dispatch("change");

  assert.equal(page.byId("scheduleStartInput").value, "01:00");
  assert.equal(page.byId("scheduleEndInput").value, "02:00");

  await page.byId("dailyResetInput").dispatch("change");
  await page.byId("rollingResetInput").dispatch("change");

  assert.equal(page.byId("rollingWindowHoursInput").value, "16");
});

test("options round-trips hard schedule settings and restores saved window details", async () => {
  const app = createExtensionApp();
  app.backgroundApi.storageData[core.STATE_KEY] = validState([]);

  let page = await openOptionsPage(app);

  assert.equal(page.byId("offHardScheduleInput").checked, true);
  assert.equal(page.byId("hardScheduleWindowFields").hidden, true);

  await page.byId("dailyHardScheduleInput").dispatch("change");
  page.byId("hardScheduleStartInput").value = "01:00";
  await page.byId("hardScheduleStartInput").dispatch("input");
  page.byId("hardScheduleEndInput").value = "02:00";
  await page.byId("hardScheduleEndInput").dispatch("input");
  await page.byId("saveButton").dispatch("click");

  assert.deepEqual(app.backgroundApi.storageData[core.STATE_KEY].hardSchedule, {
    type: "dailyWindow",
    startMinute: 60,
    endMinute: 120
  });

  page = await openOptionsPage(app);

  assert.equal(page.byId("dailyHardScheduleInput").checked, true);
  assert.equal(page.byId("hardScheduleWindowFields").hidden, false);
  assert.equal(page.byId("hardScheduleStartInput").value, "01:00");
  assert.equal(page.byId("hardScheduleEndInput").value, "02:00");

  await page.byId("offHardScheduleInput").dispatch("change");
  await page.byId("dailyHardScheduleInput").dispatch("change");

  assert.equal(page.byId("hardScheduleStartInput").value, "01:00");
  assert.equal(page.byId("hardScheduleEndInput").value, "02:00");
});

test("end-to-end options save blocks a page and renders the blocked view", async () => {
  const app = createExtensionApp({
    tabs: [{ id: 2, url: "https://example.com/focus" }]
  });
  const page = await openOptionsPage(app);

  assert.equal(page.byId("saveButton").hidden, true);

  await page.byId("addRowButton").dispatch("click");

  assert.equal(page.byId("saveButton").hidden, false);

  page.customRows().at(-1).querySelector(".value-input").value = "https://example.com/focus?ref=feed";
  await page.customRows().at(-1).querySelector(".value-input").dispatch("input");
  await page.byId("alwaysScheduleInput").dispatch("change");
  page.byId("blockedPageHtmlInput").value = "<h1>Stay focused</h1>";
  await page.byId("blockedPageHtmlInput").dispatch("input");
  await page.byId("saveButton").dispatch("click");

  const savedState = app.backgroundApi.storageData[core.STATE_KEY];

  assert.equal(page.byId("saveButton").hidden, true);
  assert.equal(savedState.entries.at(-1).value, "example.com/focus");
  assert.equal(page.byId("settingsActivationText").hidden, false);
  assert.deepEqual(app.optionsApi.permissionRequests, [["*://*.example.com/*"]]);
  assert.equal(app.backgroundApi.registeredScripts.at(-1).matches.includes("*://*.example.com/*"), false);
  assert.deepEqual(app.backgroundApi.updatedTabs, []);

  await runContentScript(app, "https://example.com/focus", 3);

  assert.deepEqual(app.backgroundApi.updatedTabs, []);

  app.backgroundApi.nowValue = app.backgroundApi.storageData.settingsActivation.pending.effectiveAtMs;
  await app.controller.loadState();

  assert.ok(app.backgroundApi.registeredScripts.at(-1).matches.includes("*://*.example.com/*"));
  assert.deepEqual(app.backgroundApi.updatedTabs, [{
    tabId: 2,
    url: blockedUrl("https://example.com/focus", "scheduleDirectMatch")
  }]);

  await runContentScript(app, "https://example.com/focus", 3);

  assert.deepEqual(app.backgroundApi.updatedTabs.at(-1), {
    tabId: 3,
    url: blockedUrl("https://example.com/focus", "scheduleDirectMatch")
  });

  const blocked = await openBlockedPage(app, app.backgroundApi.updatedTabs.at(-1).url);

  assert.equal(blocked.byId("blockedMessage").innerHTML, "<h1>Stay focused</h1>");
  assert.equal(blocked.byId("blockedReason").textContent, "This page is blocked during your schedule.");
  assert.equal(blocked.byId("blockedTarget").href, "https://example.com/focus");
  assert.equal(blocked.byId("blockedTarget").textContent, "https://example.com/focus");
  assert.equal(blocked.byId("blockedCard").dataset.loading, undefined);
});

test("blocked page renders each reason body without a built-in title", async () => {
  const app = createExtensionApp();
  app.backgroundApi.storageData[core.STATE_KEY] = validState([]);
  const reasons = [
    ["hardScheduleDomain", "All pages on this site are blocked during your hard block schedule."],
    ["scheduleDirectMatch", "This page is blocked during your schedule."],
    ["limitDirectMatch", "You've reached your time limit for this site."],
    ["scheduleRootDirectNavigation", "Direct visits to this blocked site are blocked during your schedule."],
    ["limitRootDirectNavigation", "Direct visits to this site are blocked because you've reached your time limit."],
    ["scheduleRootSameDomainNavigation", "Links within this blocked site are blocked during your schedule."],
    ["limitRootSameDomainNavigation", "Links within this site are blocked because you've reached your time limit."]
  ];

  for (const [reason, body] of reasons) {
    const blocked = await openBlockedPage(app, blockedUrl("https://example.com/focus", reason));

    assert.equal(blocked.byId("blockedMessage").innerHTML, "<h1>Stay focused</h1>");
    assert.equal(blocked.byId("blockedReason").textContent, body);
    assert.equal(blocked.byId("blockedTarget").href, "https://example.com/focus");
    assert.equal(blocked.byId("blockedTarget").textContent, "https://example.com/focus");
  }
});

test("blocked page rejects unknown reasons", async () => {
  await assert.rejects(
    () => openBlockedPage(createExtensionApp(), blockedUrl("https://example.com/focus", "mystery")),
    /Unknown blocked page reason/
  );
});

test("options hides the save button before saved-state follow-up finishes", async () => {
  const app = createExtensionApp({ delayFinishSavedState: true });
  const page = await openOptionsPage(app);
  const saveButton = page.byId("saveButton");

  await page.byId("addRowButton").dispatch("click");
  page.customRows().at(-1).querySelector(".value-input").value = "example.com";
  await page.customRows().at(-1).querySelector(".value-input").dispatch("input");
  await saveButton.dispatch("click");

  assert.equal(saveButton.hidden, true);
  assert.equal(saveButton.disabled, false);
  assert.ok(messageTypes(app).includes("finishSavedState"));

  await app.optionsApi.finishSavedState();
});

test("end-to-end stats page renders background screen time totals", async () => {
  const app = createExtensionApp();
  const hour = Math.floor(app.backgroundApi.nowValue / (60 * 60 * 1000));
  const usage = screenTimeUsage({
    "example.com": { [hour]: 90000 }
  });

  usage.remoteBuckets = {
    "remote-device": {
      "example.com": { [hour]: 30000 }
    }
  };
  app.backgroundApi.storageData[core.STATE_KEY] = validState([
    { id, kind: "domain", value: "example.com" }
  ]);
  app.backgroundApi.storageData.screenTimeUsage = usage;

  const page = await openStatsPage(app);

  assert.deepEqual(messageTypes(app), ["getScreenTimeStats", "getLocalScreenTimeStats"]);
  assert.equal(page.byId("totalTime").textContent, "2m");
  assert.equal(page.byId("activeDomains").textContent, "1");
  assert.equal(page.byId("trackedDomains").textContent, "1");
  assert.equal(page.byId("overLimitDomains").textContent, "0");
  assert.equal(page.byId("domainRows").children[0].children[0].children[1].children[0].textContent, "2m");
  assert.equal(page.byId("domainRows").children[0].children[0].children[1].children[2].textContent, "28m left");
  assert.equal(page.byId("domainRows").children[0].children[2].textContent, "This device 2m · Other devices 1m");
  assert.equal(page.byId("deviceRows").children[0].children[1].textContent, "2m");
  assert.equal(page.byId("deviceRows").children[1].children[1].textContent, "1m");
});

async function openOptionsPage(app) {
  const document = optionsDocument();
  const listeners = new Map();
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
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    scrollY: 0,
    scrollTo() {}
  };

  vm.runInNewContext(optionsScript, context, { filename: "options.js" });
  await settle();

  return page(document, listeners);
}

async function openStatsPage(app) {
  const document = statsDocument();
  const context = {
    browser: app.optionsApi,
    console,
    document,
    addEventListener() {}
  };

  vm.runInNewContext(statsScript, context, { filename: "stats.js" });
  await settle();

  return page(document);
}

async function openBlockedPage(app, url) {
  const pageUrl = new URL(url);
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
    location: { hash: pageUrl.hash, search: pageUrl.search },
    URLSearchParams
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
        id: "test-extension",
        sendMessage(message) {
          const result = app.controller.handleMessage(message, { tab: { id: tabId } });

          pendingMessages.push(result);
          return result;
        }
      },
      storage: {
        local: {
          async get(key) {
            if (key === null) {
              return { ...app.backgroundApi.storageData };
            }

            if (Array.isArray(key)) {
              return Object.fromEntries(key.map((storageKey) => [storageKey, app.backgroundApi.storageData[storageKey]]));
            }

            return { [key]: app.backgroundApi.storageData[key] };
          },
          async set(value) {
            Object.assign(app.backgroundApi.storageData, JSON.parse(JSON.stringify(value)));
          }
        }
      }
    },
    console,
    document: { hidden: false },
    location: { href: url },
    addEventListener() {},
    clearInterval() {},
    clearTimeout() {},
    setInterval() {
      return 1;
    },
    setTimeout(listener) {
      listener();
      return 1;
    },
    Date
  };

  vm.runInNewContext(contentScript, context, { filename: "content.js" });
  await settle();
  await Promise.all(pendingMessages);
  await settle();
}

function createExtensionApp(overrides = {}) {
  const backgroundApi = fakeBackgroundApi(overrides);
  const controller = createBackgroundController(backgroundApi);
  let finishDelayedLocalState;
  let finishDelayedSync;
  let finishDelayedSavedState;
  let finishDelayedSignInWithProvider;
  const optionsApi = {
    messages: [],
    permissionRequests: [],
    async finishGetLocalState() {
      if (!finishDelayedLocalState) {
        throw new Error("No delayed local-state load is pending.");
      }

      await finishDelayedLocalState();
      await settle();
    },
    async finishSyncNow() {
      if (!finishDelayedSync) {
        throw new Error("No delayed sync is pending.");
      }

      await finishDelayedSync();
      await settle();
    },
    async finishSavedState() {
      if (!finishDelayedSavedState) {
        throw new Error("No delayed saved-state follow-up is pending.");
      }

      await finishDelayedSavedState();
      await settle();
    },
    async finishSignInWithProvider() {
      if (!finishDelayedSignInWithProvider) {
        throw new Error("No delayed provider sign-in is pending.");
      }

      await finishDelayedSignInWithProvider();
      await settle();
    },
    runtime: {
      sendMessage(message) {
        optionsApi.messages.push(message);

        if (overrides.delayGetLocalState && message.type === "getLocalState") {
          return new Promise((resolve, reject) => {
            finishDelayedLocalState = () => controller.handleMessage(message, {}).then(resolve, reject);
          });
        }

        if (overrides.delaySyncNow && message.type === "syncNow") {
          return new Promise((resolve, reject) => {
            finishDelayedSync = () => controller.handleMessage(message, {}).then(resolve, reject);
          });
        }

        if (overrides.delayFinishSavedState && message.type === "finishSavedState") {
          return new Promise((resolve, reject) => {
            finishDelayedSavedState = () => controller.handleMessage(message, {}).then(resolve, reject);
          });
        }

        if (overrides.delaySignInWithProvider && message.type === "signInWithProvider") {
          return new Promise((resolve, reject) => {
            finishDelayedSignInWithProvider = () => controller.handleMessage(message, {}).then(resolve, reject);
          });
        }

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

function messageTypes(app) {
  return app.optionsApi.messages.map((message) => message.type);
}

function fakeBackgroundApi(overrides) {
  const api = {
    storageData: {},
    nativeData: {},
    grantedOrigins: [...manifest.host_permissions],
    tabsData: overrides.tabs || [],
    registeredScripts: [],
    removedOrigins: [],
    updatedTabs: [],
    timers: [],
    uuidIndex: 1,
    nowValue: new Date(2026, 0, 1, 12).getTime(),
    now() {
      return api.nowValue;
    },
    setTimeout(listener, delayMs) {
      api.timers.push({ listener, delayMs });

      return api.timers.length;
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
          return dataJsonUrl(overrides.supabaseConfig || {
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

function validState(entries, schedule = core.DEFAULT_SCHEDULE) {
  const stateEntries = stateEntriesWithDefaults(entries);

  return {
    schemaVersion: core.SCHEMA_VERSION,
    entries: stateEntries,
    blockedPageHtml: "<h1>Stay focused</h1>",
    schedule,
    hardSchedule: core.DEFAULT_HARD_SCHEDULE,
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
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

function screenTimeUsage(totalsByDomain) {
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
    remoteBuckets: {}
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

function settingsSync(lastSuccessfulSyncMs) {
  return {
    schemaVersion: 2,
    deviceId: "11111111-1111-4111-8111-000000000001",
    updatedAtMs: lastSuccessfulSyncMs,
    revisionId: "22222222-2222-4222-8222-000000000001",
    dirty: false,
    lastSuccessfulSyncMs
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
    "offHardScheduleInput",
    "dailyHardScheduleInput",
    "hardScheduleWindowFields",
    "hardScheduleStartInput",
    "hardScheduleEndInput",
    "screenTimePanel",
    "screenTimeTitle",
    "limitResetPanel",
    "rollingResetInput",
    "dailyResetInput",
    "rollingResetFields",
    "dailyResetFields",
    "rollingWindowHoursInput",
    "dailyResetHourSelect",
    "settingsDelayMinutesInput",
    "settingsActivationText",
    "errorSummary",
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
  document.elements.editorPanel.hidden = true;

  return document;
}

function blockedDocument() {
  const document = testDocument(["blockedCard", "blockedMessage", "blockedReason", "blockedTarget", "closeButton"]);

  document.elements.blockedCard.dataset.loading = "";
  return document;
}

function statsDocument() {
  const document = testDocument([
    "statsShell",
    "refreshButton",
    "errorSummary",
    "totalMetric",
    "totalTime",
    "activeDomains",
    "trackedDomains",
    "overLimitMetric",
    "overLimitDomains",
    "windowTitle",
    "updatedAt",
    "hourlyBars",
    "emptyHourlyTotals",
    "domainRows",
    "emptyDomains",
    "deviceRows",
    "emptyDevices"
  ]);

  document.elements.statsShell.hidden = true;
  return document;
}

function testDocument(ids) {
  const elements = Object.fromEntries(ids.map((id) => [id, new TestElement("div", id)]));

  return {
    elements,
    hidden: false,
    addEventListener() {},
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
  const deleteButton = new TestElement("button", "", "delete-button");
  const valueLabel = new TestElement("label");
  const valueInput = new TestElement("input", "", "value-input");
  const limitLabel = new TestElement("label", "", "row-limit");
  const limitInput = new TestElement("input", "", "limit-input");
  const domainSettings = new TestElement("div", "", "domain-settings");
  const blockDirectVisitsInput = new TestElement("input", "", "block-direct-visits-input");
  const blockInternalLinksInput = new TestElement("input", "", "block-internal-links-input");
  const rowError = new TestElement("p", "", "row-error");

  toolbar.append(segments, deleteButton);
  valueLabel.append(valueInput);
  limitLabel.append(limitInput);
  domainSettings.append(blockDirectVisitsInput, blockInternalLinksInput);
  row.append(toolbar, valueLabel, limitLabel, domainSettings, rowError);
  fragment.append(row);

  return fragment;
}

function page(document, listeners = new Map()) {
  return {
    document,
    byId(id) {
      return document.getElementById(id);
    },
    customRows() {
      return document.getElementById("rows").children.filter((row) => row.querySelector(".value-input"));
    },
    async dispatchWindow(type) {
      await Promise.all((listeners.get(type) || []).map((listener) => listener()));
      await settle();
    }
  };
}

class TestElement {
  constructor(tagName, id = "", className = "") {
    const style = {};

    style.setProperty = (name, value) => {
      style[name] = value;
    };

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
    this.title = "";
    this.style = style;
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
    this.children = children.flatMap((child) => child.tagName === "fragment" ? child.children : [child]);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  async dispatch(type, event = {}) {
    const listeners = this.listeners.get(type) || [];

    await Promise.all(listeners.map((listener) => listener({ target: this, preventDefault() {}, ...event })));
    await settle();
  }

  get valueAsNumber() {
    return this.value === "" ? NaN : Number(this.value);
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  removeAttribute(name) {
    if (name.startsWith("data-")) {
      delete this.dataset[name.slice(5)];
      return;
    }

    delete this[name];
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
