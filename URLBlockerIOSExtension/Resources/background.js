(function loadBackground(root) {
  "use strict";

  if (!root.BlockerCore && typeof importScripts === "function") {
    importScripts("blocker.js");
  }

  const core = root.BlockerCore || require("./blocker.js");
  const CONTENT_SCRIPT_ID = "url-blocker-content";

  function createBackgroundController(api) {
    const stateStorage = createStateStorage(api);

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
      const result = core.validateState(rawState);

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
      await api.tabs.create({ url: api.runtime.getURL("options.html") });
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

    async function redirectBlockedUrl(tabId, rawUrl) {
      if (typeof tabId !== "number") {
        throw new Error("Blocked tab ID must be a number.");
      }

      if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
        throw new Error("Blocked URL must be a string.");
      }

      const match = core.findMatchingEntry(await loadState(), rawUrl);

      return redirectFromMatch(tabId, rawUrl, match);
    }

    async function redirectOpenBlockedTabs(state) {
      const tabs = await api.tabs.query({});

      await Promise.all(tabs.map((tab) => {
        if (typeof tab.id !== "number" || typeof tab.url !== "string") {
          return undefined;
        }

        const match = core.findMatchingEntry(state, tab.url);

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
      return `${api.runtime.getURL("blocked.html")}#${encodeURIComponent(rawUrl)}`;
    }

    async function loadState() {
      const stored = await stateStorage.loadState();

      if (stored === undefined) {
        return loadDefaultState();
      }

      return core.parseStoredState(stored);
    }

    async function loadDefaultState() {
      const response = await fetch(api.runtime.getURL("default-blocked-pages.json"));

      if (!response.ok) {
        throw new Error("Default blocked pages could not be loaded.");
      }

      return core.emptyState(await response.json());
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

    return {
      getState,
      handleMessage,
      loadState,
      openOptions,
      redirectBlockedUrl,
      resetState,
      saveState,
      syncContentScripts,
      syncWebsiteAccess
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
