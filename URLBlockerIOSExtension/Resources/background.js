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
        case "urlMatched":
          requireKeys(message, ["type", "url", "entryId"], "urlMatched message");
          return blockMatchedUrl(message, sender);
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

      const replacement = await replaceBlockingRules(result.state);

      try {
        await api.storage.local.set({ [core.STATE_KEY]: result.state });
      } catch (error) {
        await replaceAppOwnedRules(replacement.previousRules, replacement.nextRules);
        throw error;
      }

      await broadcastBlocklistChanged();

      return { type: "saved", state: result.state };
    }

    async function blockMatchedUrl(message, sender) {
      if (typeof message.url !== "string") {
        throw new Error("urlMatched message URL must be a string.");
      }

      if (typeof message.entryId !== "string") {
        throw new Error("urlMatched message entry ID must be a string.");
      }

      const state = await loadState();
      const match = core.findMatchingEntry(state, message.url);

      if (match.type === "none" || match.entry.id !== message.entryId) {
        return { type: "notBlocked" };
      }

      if (!sender.tab || typeof sender.tab.id !== "number") {
        return { type: "notBlocked" };
      }

      await api.tabs.update(sender.tab.id, { url: blockedUrl(message.url) });

      return { type: "blocked" };
    }

    async function openOptions() {
      await api.tabs.create({ url: api.runtime.getURL("options.html") });
      return { type: "opened" };
    }

    async function syncBlockingRules() {
      await replaceBlockingRules(await loadState());
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

    async function getAppOwnedRules() {
      const rules = await api.declarativeNetRequest.getDynamicRules();
      const appRuleIds = new Set(core.APP_RULE_IDS);

      return rules.filter((rule) => appRuleIds.has(rule.id));
    }

    async function ensureRegexRulesAreSupported(rules) {
      for (const rule of rules) {
        const result = await api.declarativeNetRequest.isRegexSupported({
          regex: rule.condition.regexFilter,
          isCaseSensitive: false
        });

        if (!result.isSupported) {
          throw new Error(result.reason || `Rule ${rule.id} is not supported by Safari.`);
        }
      }
    }

    async function replaceBlockingRules(state) {
      const nextRules = core.buildDnrRules(state);
      const previousRules = await getAppOwnedRules();

      await ensureRegexRulesAreSupported(nextRules);
      await replaceAppOwnedRules(nextRules, previousRules);

      return { previousRules, nextRules };
    }

    async function replaceAppOwnedRules(nextRules, restoreRules) {
      try {
        await api.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: core.APP_RULE_IDS,
          addRules: nextRules
        });
      } catch (error) {
        await api.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: core.APP_RULE_IDS,
          addRules: restoreRules
        });
        throw error;
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

    function blockedUrl(url) {
      return `${api.runtime.getURL("blocked.html")}#${encodeURIComponent(url)}`;
    }

    return {
      blockMatchedUrl,
      blockedUrl,
      closeCurrentTab,
      getState,
      handleMessage,
      loadState,
      openOptions,
      saveState,
      syncBlockingRules
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

    controller.syncBlockingRules().catch(() => undefined);
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
