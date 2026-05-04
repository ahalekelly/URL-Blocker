(function loadBackground(root) {
  "use strict";

  if (!root.BlockerCore && typeof importScripts === "function") {
    importScripts("blocker.js");
  }

  const core = root.BlockerCore || require("./blocker.js");

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

      await api.storage.local.set({ [core.STATE_KEY]: result.state });
      await broadcastBlocklistChanged();

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
      saveState
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
    attachRuntimeListener(api);
  }
})(globalThis);
