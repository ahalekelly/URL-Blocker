(function loadBackground(root) {
  "use strict";

  if (!root.BlockerCore && typeof importScripts === "function") {
    importScripts("blocker.js");
  }

  const core = root.BlockerCore || require("./blocker.js");
  const CONTENT_SCRIPT_ID = "url-blocker-content";
  const HOUR_MS = 60 * 60 * 1000;
  const SCREEN_TIME_USAGE_KEY = "screenTimeUsage";
  const SCREEN_TIME_USAGE_SCHEMA_VERSION = 1;
  const SCREEN_TIME_WINDOW_HOURS = 16;

  function createBackgroundController(api) {
    const stateStorage = createStateStorage(api);
    const screenTimeStorage = createScreenTimeStorage(api);

    async function handleMessage(message, sender) {
      if (!isPlainObject(message) || typeof message.type !== "string") {
        throw new Error("Extension message must include a type.");
      }

      switch (message.type) {
        case "getState":
          requireKeys(message, ["type"], "getState message");
          return getState();
        case "saveState":
          requireKeys(message, ["type", "state"], "saveState message");
          return saveState(message.state);
        case "resetState":
          requireKeys(message, ["type"], "resetState message");
          return resetState();
        case "syncWebsiteAccess":
          requireKeys(message, ["type"], "syncWebsiteAccess message");
          return syncWebsiteAccess();
        case "openOptions":
          requireKeys(message, ["type"], "openOptions message");
          return openOptions();
        case "urlChanged":
          requireKeys(message, ["type", "url"], "urlChanged message");
          return urlChanged(message.url, sender);
        case "screenTimeElapsed":
          requireKeys(message, ["type", "url", "elapsedMs"], "screenTimeElapsed message");
          return logScreenTime(message.url, message.elapsedMs, sender);
        case "getScreenTimeLog":
          requireKeys(message, ["type"], "getScreenTimeLog message");
          return getScreenTimeLog();
        default:
          throw new Error(`Unknown message type: ${message.type}`);
      }
    }

    async function getState() {
      try {
        return { type: "state", state: await loadState() };
      } catch (error) {
        return { type: "stateError", error: error.message };
      }
    }

    async function saveState(rawState) {
      const defaultEntries = await loadDefaultEntries();
      const result = core.validateState(rawState, defaultEntries);

      if (result.type === "invalid") {
        return { type: "validationError", errors: result.errors };
      }

      await requireWebsiteAccess(result.state);
      await syncContentScripts(result.state);
      const storageResponse = await stateStorage.saveState(result.state);

      if (storageResponse.type === "validationError") {
        return storageResponse;
      }

      if (storageResponse.type !== "saved") {
        throw new Error(storageResponse.error);
      }

      await redirectOpenBlockedTabs(storageResponse.state);
      await removeUnusedWebsiteAccess(result.state);

      return { type: "saved", state: storageResponse.state };
    }

    async function resetState() {
      return saveState(await loadDefaultState());
    }

    async function openOptions() {
      await api.tabs.create({ url: runtimeUrl("options.html") });
      return { type: "opened" };
    }

    async function syncWebsiteAccess() {
      await syncContentScripts(await loadState());
      return { type: "synced" };
    }

    async function urlChanged(rawUrl, sender) {
      if (!sender.tab || typeof sender.tab.id !== "number") {
        throw new Error("urlChanged message must come from a tab.");
      }

      return redirectBlockedUrl(sender.tab.id, rawUrl);
    }

    async function logScreenTime(rawUrl, elapsedMs, sender = {}) {
      if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
        throw new Error("Screen time URL must be a string.");
      }

      if (!Number.isInteger(elapsedMs) || elapsedMs <= 0) {
        throw new Error("Screen time elapsed time must be a positive integer.");
      }

      const state = await loadState();
      const match = core.screenTimeDomainForUrl(state, rawUrl);

      switch (match.type) {
        case "none":
          return { type: "ignored" };
        case "match":
          return saveScreenTimeAndRedirect(state, match.domain, rawUrl, elapsedMs, sender);
        default:
          throw new Error(`Unknown screen time match type: ${match.type}`);
      }
    }

    async function getScreenTimeLog() {
      const state = await loadState();
      const hour = currentHour();

      return {
        type: "screenTimeLog",
        entries: screenTimeEntries(state, await loadScreenTimeUsage(hour), hour)
      };
    }

    async function redirectBlockedUrl(tabId, rawUrl) {
      if (typeof tabId !== "number") {
        throw new Error("Blocked tab ID must be a number.");
      }

      if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
        throw new Error("Blocked URL must be a string.");
      }

      const state = await loadState();
      const hour = currentHour();
      const usage = await loadScreenTimeUsage(hour);
      const match = core.findBlockedMatchingEntry(state, rawUrl, overLimitDomains(state, usage, hour));

      return redirectFromMatch(tabId, rawUrl, match);
    }

    async function redirectOpenBlockedTabs(state) {
      const tabs = await api.tabs.query({});
      const hour = currentHour();
      const usage = await loadScreenTimeUsage(hour);
      const limitedDomains = overLimitDomains(state, usage, hour);

      await Promise.all(tabs.map((tab) => {
        if (typeof tab.id !== "number" || typeof tab.url !== "string") {
          return undefined;
        }

        const match = core.findBlockedMatchingEntry(state, tab.url, limitedDomains);

        return redirectFromMatch(tab.id, tab.url, match);
      }));
    }

    async function redirectFromMatch(tabId, rawUrl, match) {
      switch (match.type) {
        case "none":
          return { type: "allowed" };
        case "match":
          await api.tabs.update(tabId, { url: blockedPageUrl(rawUrl) });
          return { type: "redirected" };
        default:
          throw new Error(`Unknown match type: ${match.type}`);
      }
    }

    function blockedPageUrl(rawUrl) {
      return `${runtimeUrl("blocked.html")}#${encodeURIComponent(rawUrl)}`;
    }

    async function loadState() {
      const stored = await stateStorage.loadState();

      if (stored === undefined) {
        return loadDefaultState();
      }

      return core.parseStoredState(stored, await loadDefaultEntries());
    }

    async function saveScreenTimeAndRedirect(state, domain, rawUrl, elapsedMs, sender) {
      const hour = currentHour();
      const usage = await saveScreenTime(domain, elapsedMs, hour);
      const totalMs = screenTimeTotalMs(usage, domain, hour);
      const limit = domainLimit(state, domain);
      const isOverLimit = totalMs >= limit.limitMinutes * 60 * 1000;

      if (isOverLimit && sender.tab && typeof sender.tab.id === "number") {
        const match = core.findBlockedMatchingEntry(state, rawUrl, new Set([domain]));

        await redirectFromMatch(sender.tab.id, rawUrl, match);
      }

      return { type: "logged", domain, totalMs, limitMinutes: limit.limitMinutes, isOverLimit };
    }

    async function saveScreenTime(domain, elapsedMs, hour) {
      const usage = await loadScreenTimeUsage(hour);
      const bucket = String(hour);

      usage.totalsByDomain[domain] = usage.totalsByDomain[domain] || {};
      usage.totalsByDomain[domain][bucket] = (usage.totalsByDomain[domain][bucket] || 0) + elapsedMs;
      const pruned = pruneScreenTimeUsage(usage, hour);

      await screenTimeStorage.saveUsage(pruned);

      return pruned;
    }

    async function loadScreenTimeUsage(hour) {
      const usage = parseScreenTimeUsage(await screenTimeStorage.loadUsage());
      const pruned = pruneScreenTimeUsage(usage, hour);

      await screenTimeStorage.saveUsage(pruned);

      return pruned;
    }

    async function loadDefaultState() {
      return core.emptyState(await loadDefaultEntries());
    }

    async function loadDefaultEntries() {
      const response = await fetch(runtimeUrl("default-blocked-pages.json"));

      if (!response.ok) {
        throw new Error("Default blocked pages could not be loaded.");
      }

      return response.json();
    }

    function runtimeUrl(path) {
      if (typeof api.runtime.getURL === "function") {
        return api.runtime.getURL(path);
      }

      return new URL(path, root.location.href).href;
    }

    async function requireWebsiteAccess(state) {
      const origins = core.permissionOriginsForState(state);

      if (origins.length === 0) {
        return;
      }

      const granted = await api.permissions.contains({ origins });

      if (!granted) {
        throw new Error("Website access was not granted for the requested websites.");
      }
    }

    async function syncContentScripts(state) {
      const origins = core.permissionOriginsForState(state);
      const registered = await api.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });

      if (registered.length > 0) {
        await api.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
      }

      if (origins.length === 0) {
        return;
      }

      await api.scripting.registerContentScripts([{
        id: CONTENT_SCRIPT_ID,
        js: ["content.js"],
        matches: origins,
        runAt: "document_start"
      }]);
    }

    async function removeUnusedWebsiteAccess(state) {
      const requiredOrigins = new Set(core.permissionOriginsForState(state));
      const installTimeOrigins = new Set(api.runtime.getManifest().host_permissions);
      const granted = await api.permissions.getAll();
      const unusedOrigins = (granted.origins || []).filter((origin) => (
        !requiredOrigins.has(origin) && !installTimeOrigins.has(origin)
      ));

      if (unusedOrigins.length > 0) {
        await api.permissions.remove({ origins: unusedOrigins });
      }
    }

    function currentHour() {
      const now = typeof api.now === "function" ? api.now() : Date.now();

      return Math.floor(now / HOUR_MS);
    }

    return {
      getScreenTimeLog,
      getState,
      handleMessage,
      loadState,
      logScreenTime,
      openOptions,
      redirectBlockedUrl,
      resetState,
      saveState,
      syncContentScripts,
      syncWebsiteAccess
    };
  }

  function parseScreenTimeUsage(rawUsage) {
    if (rawUsage === undefined) {
      return emptyScreenTimeUsage();
    }

    if (!isPlainObject(rawUsage)) {
      throw new Error("Screen time usage must be an object.");
    }

    requireKeys(rawUsage, ["schemaVersion", "totalsByDomain"], "Screen time usage");

    if (rawUsage.schemaVersion !== SCREEN_TIME_USAGE_SCHEMA_VERSION) {
      throw new Error("Unsupported screen time usage version.");
    }

    if (!isPlainObject(rawUsage.totalsByDomain)) {
      throw new Error("Screen time usage totals must be an object.");
    }

    const totalsByDomain = {};

    Object.entries(rawUsage.totalsByDomain).forEach(([domain, buckets]) => {
      if (core.normalizeDomainEntryValue(domain) !== domain) {
        throw new Error("Screen time domain must be normalized.");
      }

      if (!isPlainObject(buckets)) {
        throw new Error("Screen time buckets must be an object.");
      }

      totalsByDomain[domain] = {};

      Object.entries(buckets).forEach(([bucket, totalMs]) => {
        if (!/^\d+$/.test(bucket)) {
          throw new Error("Screen time bucket must be an hour number.");
        }

        if (!Number.isInteger(totalMs) || totalMs < 0) {
          throw new Error("Screen time total must be a non-negative integer.");
        }

        totalsByDomain[domain][bucket] = totalMs;
      });
    });

    return { schemaVersion: SCREEN_TIME_USAGE_SCHEMA_VERSION, totalsByDomain };
  }

  function pruneScreenTimeUsage(usage, hour) {
    const minHour = hour - SCREEN_TIME_WINDOW_HOURS + 1;
    const totalsByDomain = {};

    Object.entries(usage.totalsByDomain).forEach(([domain, buckets]) => {
      Object.entries(buckets).forEach(([bucket, totalMs]) => {
        const bucketHour = Number(bucket);

        if (bucketHour < minHour || bucketHour > hour) {
          return;
        }

        totalsByDomain[domain] = totalsByDomain[domain] || {};
        totalsByDomain[domain][bucket] = totalMs;
      });
    });

    return { schemaVersion: SCREEN_TIME_USAGE_SCHEMA_VERSION, totalsByDomain };
  }

  function screenTimeEntries(state, usage, hour) {
    return activeDomainLimits(state)
      .map((limit) => {
        const totalMs = screenTimeTotalMs(usage, limit.domain, hour);

        return {
          domain: limit.domain,
          totalMs,
          limitMinutes: limit.limitMinutes,
          isOverLimit: totalMs >= limit.limitMinutes * 60 * 1000
        };
      })
      .filter((entry) => entry.totalMs > 0)
      .sort((left, right) => right.totalMs - left.totalMs || left.domain.localeCompare(right.domain));
  }

  function activeDomainLimits(state) {
    const activeDomains = new Set(state.entries
      .filter(entryIsEnabled)
      .map(core.associatedDomainForEntry));

    return state.domainLimits.filter((limit) => activeDomains.has(limit.domain));
  }

  function entryIsEnabled(entry) {
    switch (entry.type) {
      case "custom":
        return true;
      case "default":
        return entry.enabled;
      default:
        throw new Error(`Unknown entry type: ${entry.type}`);
    }
  }

  function overLimitDomains(state, usage, hour) {
    return new Set(screenTimeEntries(state, usage, hour)
      .filter((entry) => entry.isOverLimit)
      .map((entry) => entry.domain));
  }

  function screenTimeTotalMs(usage, domain, hour) {
    const minHour = hour - SCREEN_TIME_WINDOW_HOURS + 1;
    const buckets = usage.totalsByDomain[domain] || {};

    return Object.entries(buckets).reduce((total, [bucket, totalMs]) => {
      const bucketHour = Number(bucket);

      if (bucketHour < minHour || bucketHour > hour) {
        return total;
      }

      return total + totalMs;
    }, 0);
  }

  function domainLimit(state, domain) {
    const limit = state.domainLimits.find((candidate) => candidate.domain === domain);

    if (!limit) {
      throw new Error(`Missing domain limit: ${domain}.`);
    }

    return limit;
  }

  function emptyScreenTimeUsage() {
    return {
      schemaVersion: SCREEN_TIME_USAGE_SCHEMA_VERSION,
      totalsByDomain: {}
    };
  }

  function createStateStorage(api) {
    const browserStorage = {
      async loadState() {
        const stored = await api.storage.local.get(core.STATE_KEY);

        return stored[core.STATE_KEY];
      },
      async saveState(state) {
        await api.storage.local.set({ [core.STATE_KEY]: state });

        return { type: "saved", state };
      }
    };
    const nativeStorage = {
      async loadState() {
        const response = await sendNativeMessage(api, { type: "getState" });

        switch (response.type) {
          case "state":
            return response.state;
          case "stateError":
          case "error":
            throw new Error(response.error);
          default:
            throw new Error(`Unknown native getState response: ${response.type}`);
        }
      },
      async saveState(state) {
        return sendNativeMessage(api, { type: "saveState", state });
      }
    };

    return {
      async loadState() {
        return (await usesNativeStorage(api)) ? nativeStorage.loadState() : browserStorage.loadState();
      },
      async saveState(state) {
        return (await usesNativeStorage(api)) ? nativeStorage.saveState(state) : browserStorage.saveState(state);
      }
    };
  }

  function createScreenTimeStorage(api) {
    const browserStorage = {
      async loadUsage() {
        const stored = await api.storage.local.get(SCREEN_TIME_USAGE_KEY);

        return stored[SCREEN_TIME_USAGE_KEY];
      },
      async saveUsage(usage) {
        await api.storage.local.set({ [SCREEN_TIME_USAGE_KEY]: usage });

        return usage;
      }
    };
    const nativeStorage = {
      async loadUsage() {
        const response = await sendNativeMessage(api, { type: "getScreenTimeUsage" });

        switch (response.type) {
          case "screenTimeUsage":
            return response.usage;
          case "error":
            throw new Error(response.error);
          default:
            throw new Error(`Unknown native getScreenTimeUsage response: ${response.type}`);
        }
      },
      async saveUsage(usage) {
        const response = await sendNativeMessage(api, { type: "saveScreenTimeUsage", usage });

        switch (response.type) {
          case "savedScreenTimeUsage":
            return response.usage;
          case "error":
            throw new Error(response.error);
          default:
            throw new Error(`Unknown native saveScreenTimeUsage response: ${response.type}`);
        }
      }
    };

    return {
      async loadUsage() {
        return (await usesNativeStorage(api)) ? nativeStorage.loadUsage() : browserStorage.loadUsage();
      },
      async saveUsage(usage) {
        return (await usesNativeStorage(api)) ? nativeStorage.saveUsage(usage) : browserStorage.saveUsage(usage);
      }
    };
  }

  async function usesNativeStorage(api) {
    if (!api.runtime || typeof api.runtime.sendNativeMessage !== "function") {
      return false;
    }

    if (typeof api.runtime.getPlatformInfo !== "function") {
      return true;
    }

    const platform = await api.runtime.getPlatformInfo();

    return platform.os === "ios";
  }

  async function sendNativeMessage(api, message) {
    const response = await api.runtime.sendNativeMessage("application.id", message);

    if (!isPlainObject(response) || typeof response.type !== "string") {
      throw new Error("Native response must include a type.");
    }

    return response;
  }

  function attachRuntimeListener(api) {
    const controller = createBackgroundController(api);
    const action = api.action || api.browserAction;

    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      controller.handleMessage(message, sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ type: "error", error: error.message }));

      return true;
    });

    if (action && action.onClicked) {
      action.onClicked.addListener(() => {
        controller.openOptions().catch(() => undefined);
      });
    }

    if (api.tabs.onUpdated) {
      api.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (typeof changeInfo.url !== "string") {
          return;
        }

        controller.redirectBlockedUrl(tabId, changeInfo.url)
          .catch((error) => console.error("URL Blocker could not redirect updated tab.", error));
      });
    }

    return controller;
  }

  function requireKeys(object, allowedKeys, label) {
    const allowed = new Set(allowedKeys);
    const unknownKeys = Object.keys(object).filter((key) => !allowed.has(key));

    if (unknownKeys.length > 0) {
      throw new Error(`${label} has unknown key: ${unknownKeys[0]}.`);
    }
  }

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  root.BackgroundController = { createBackgroundController };

  if (typeof module !== "undefined") {
    module.exports = { createBackgroundController };
  }

  const api = root.browser || root.chrome;

  if (api && api.runtime && api.runtime.onMessage) {
    const controller = attachRuntimeListener(api);

    controller.loadState()
      .then(controller.syncContentScripts)
      .catch((error) => console.error("URL Blocker could not sync website access.", error));
  }
})(globalThis);
