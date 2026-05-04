(function loadBackground(root) {
  "use strict";

  if (!root.BlockerCore && typeof importScripts === "function") {
    importScripts("blocker.js");
  }

  const core = root.BlockerCore || require("./blocker.js");
  const CONTENT_SCRIPT_ID = "url-blocker-content";

  function createBackgroundController(api) {
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
        case "openOptions":
          requireKeys(message, ["type"], "openOptions message");
          return openOptions();
        case "closeCurrentTab":
          requireKeys(message, ["type"], "closeCurrentTab message");
          return closeCurrentTab(sender);
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
      await api.storage.local.set({ [core.STATE_KEY]: result.state });
      await broadcastBlocklistChanged();
      await removeUnusedWebsiteAccess(result.state);

      return { type: "saved", state: result.state };
    }

    async function openOptions() {
      await api.tabs.create({ url: api.runtime.getURL("options.html") });
      return { type: "opened" };
    }

    async function closeCurrentTab(sender) {
      if (!sender.tab || typeof sender.tab.id !== "number") {
        return { type: "notClosed" };
      }

      await api.tabs.remove(sender.tab.id);

      return { type: "closed" };
    }

    async function loadState() {
      const stored = await api.storage.local.get(core.STATE_KEY);

      return core.parseStoredState(stored[core.STATE_KEY]);
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
        js: ["blocker.js", "content.js"],
        matches: origins,
        runAt: "document_start"
      }]);
    }

    async function removeUnusedWebsiteAccess(state) {
      const requiredOrigins = new Set(core.permissionOriginsForState(state));
      const granted = await api.permissions.getAll();
      const unusedOrigins = (granted.origins || []).filter((origin) => !requiredOrigins.has(origin));

      if (unusedOrigins.length > 0) {
        await api.permissions.remove({ origins: unusedOrigins });
      }
    }

    async function broadcastBlocklistChanged() {
      const tabs = await api.tabs.query({});

      await Promise.all(tabs.map((tab) => {
        if (typeof tab.id !== "number") {
          return Promise.resolve();
        }

        return api.tabs.sendMessage(tab.id, { type: "blocklistChanged" }).catch(() => undefined);
      }));
    }

    return {
      closeCurrentTab,
      getState,
      handleMessage,
      loadState,
      openOptions,
      saveState,
      syncContentScripts
    };
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
