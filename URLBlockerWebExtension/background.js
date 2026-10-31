(function loadBackground(root) {
  "use strict";

  if (!root.BlockerCore && typeof importScripts === "function") {
    importScripts("blocker.js");
  }

  if (!root.SupabaseSync && typeof importScripts === "function") {
    importScripts("supabase-sync.js");
  }

  const core = root.BlockerCore || require("./blocker.js");
  const sync = root.SupabaseSync || require("./supabase-sync.js");
  const CONTENT_SCRIPT_ID = "url-blocker-content";
  const CONTENT_SCRIPT_JS = ["content.js"];
  const CONTENT_SCRIPT_CSS = ["content.css"];
  const HOUR_MS = 60 * 60 * 1000;
  const MAX_SCREEN_TIME_ELAPSED_MS = 30 * 1000;
  const SCREEN_TIME_USAGE_KEY = "screenTimeUsage";
  const SETTINGS_SYNC_KEY = "settingsSync";
  const SETTINGS_ACTIVATION_KEY = "settingsActivation";
  const SUPABASE_SESSION_KEY = "supabaseSession";
  const REFERRER_RECORD_PREFIX = "referrerRecords:";
  const REFERRER_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const UNKNOWN_NAVIGATION_SOURCE = { type: "unknown" };

  function createBackgroundController(api) {
    const stateStorage = createStateStorage(api);
    const settingsActivationStorage = createSettingsActivationStorage(api);
    const blockedPageHtmlStorage = createBlockedPageHtmlStorage(api);
    const screenTimeStorage = createScreenTimeStorage(api);
    const settingsSyncStorage = createSettingsSyncStorage(api);
    const sessionStorage = createSupabaseSessionStorage(api);
    const youtubeVideosByTab = new Map();
    const committedNavigationsByTab = new Map();
    let defaultEntriesLoad;
    let configPromise;
    let lastSyncError = "";
    let activationTimer = 0;
    let activationTimerAtMs = 0;
    let usageSyncTimer = 0;

    async function handleMessage(message, sender) {
      if (!isPlainObject(message) || typeof message.type !== "string") {
        throw codedError("InvalidExtensionMessage", "Extension message must include a type.");
      }

      switch (message.type) {
        case "getLocalState":
          requireKeys(message, ["type"], "getLocalState message");
          return getLocalState();
        case "getBlockedPageHtml":
          requireKeys(message, ["type"], "getBlockedPageHtml message");
          return getBlockedPageHtml();
        case "getState":
          requireKeys(message, ["type"], "getState message");
          return getState();
        case "getDefaultState":
          requireKeys(message, ["type"], "getDefaultState message");
          return getDefaultState();
        case "saveState":
          requireKeys(message, ["type", "state"], "saveState message");
          return saveState(message.state);
        case "finishSavedState":
          requireKeys(message, ["type"], "finishSavedState message");
          return finishSavedState();
        case "syncWebsiteAccess":
          requireKeys(message, ["type"], "syncWebsiteAccess message");
          return syncWebsiteAccess();
        case "openOptions":
          requireKeys(message, ["type"], "openOptions message");
          return openOptions();
        case "urlChanged":
          requireKeys(message, ["type", "url", "source"], "urlChanged message");
          return urlChanged(message.url, message.source, sender);
        case "openBlockedTarget":
          requireKeys(message, ["type", "tabId", "url"], "openBlockedTarget message");
          return openBlockedTarget(message.tabId, message.url);
        case "screenTimeElapsed":
          requireKeys(message, ["type", "url", "elapsedMs", "source"], "screenTimeElapsed message");
          return logScreenTime(message.url, message.elapsedMs, message.source, sender);
        case "getScreenTimeLog":
          requireKeys(message, ["type"], "getScreenTimeLog message");
          return getScreenTimeLog();
        case "getLocalScreenTimeLog":
          requireKeys(message, ["type"], "getLocalScreenTimeLog message");
          return getLocalScreenTimeLog();
        case "getLocalScreenTimeStats":
          requireKeys(message, ["type"], "getLocalScreenTimeStats message");
          return getLocalScreenTimeStats();
        case "getScreenTimeStats":
          requireKeys(message, ["type"], "getScreenTimeStats message");
          return getScreenTimeStats();
        case "getSyncStatus":
          requireKeys(message, ["type"], "getSyncStatus message");
          return getSyncStatus();
        case "syncNow":
          requireKeys(message, ["type"], "syncNow message");
          return syncNow();
        case "signInWithProvider":
          requireKeys(message, ["type", "provider"], "signInWithProvider message");
          return signInWithProvider(message.provider);
        case "completeOAuthRedirect":
          requireKeys(message, ["type", "url"], "completeOAuthRedirect message");
          return completeOAuthRedirect(message.url);
        case "signOut":
          requireKeys(message, ["type"], "signOut message");
          return signOut();
        default:
          throw codedError("UnknownExtensionMessage", `Unknown message type: ${message.type}`);
      }
    }

    async function getState() {
      try {
        await syncRemoteStateIfPossible();

        return { type: "state", state: await loadState() };
      } catch (error) {
        return errorResponse("stateError", error);
      }
    }

    async function getLocalState() {
      try {
        const state = await loadSavedState();
        const activation = await loadSettledSettingsActivation();

        return { type: "state", state, activation: settingsActivationStatus(activation) };
      } catch (error) {
        return errorResponse("stateError", error);
      }
    }

    async function getBlockedPageHtml() {
      try {
        if (await settingsActivationStorage.loadActivation() !== undefined) {
          await loadSettledSettingsActivation();
        }

        const cachedHtml = await blockedPageHtmlStorage.loadHtml();

        if (cachedHtml !== undefined) {
          return { type: "blockedPageHtml", html: cachedHtml };
        }

        const state = await loadState();

        await blockedPageHtmlStorage.saveHtml(state.blockedPageHtml);
        return { type: "blockedPageHtml", html: state.blockedPageHtml };
      } catch (error) {
        return errorResponse("blockedPageHtmlError", error);
      }
    }

    async function getDefaultState() {
      try {
        return { type: "state", state: await loadDefaultState() };
      } catch (error) {
        return errorResponse("error", error);
      }
    }

    async function saveState(rawState) {
      const defaultEntries = await loadDefaultEntries();
      const result = core.validateState(rawState, defaultEntries);

      if (result.type === "invalid") {
        return { type: "validationError", errors: result.errors };
      }

      await requireWebsiteAccess(result.state);
      const currentActivation = await loadSettledSettingsActivation();
      const storageResponse = await stateStorage.saveState(result.state);

      if (storageResponse.type === "validationError") {
        return storageResponse;
      }

      if (storageResponse.type !== "saved") {
        throw errorFromResponse(storageResponse);
      }

      const activation = await saveSettingsActivation(storageResponse.state, currentActivation);

      const settingsSync = await loadSettingsSync();

      await settingsSyncStorage.saveSync(sync.dirtySettingsSync(settingsSync, currentTimeMs(), createId));
      return { type: "saved", state: storageResponse.state, activation: settingsActivationStatus(activation) };
    }

    async function finishSavedState() {
      const savedState = await syncSettingsIfPossible(await loadSavedState());
      const activation = await loadSettledSettingsActivation();
      const activeState = activation.activeState;

      await redirectOpenBlockedTabs(activeState);
      await removeUnusedWebsiteAccessForStates(activeAndPendingStates(activation));

      return { type: "finishedSavedState", state: savedState, activation: settingsActivationStatus(activation) };
    }

    async function openOptions() {
      await api.tabs.create({ url: runtimeUrl("options.html") });
      return { type: "opened" };
    }

    async function syncWebsiteAccess() {
      await syncContentScripts(await loadState());
      return { type: "synced" };
    }

    async function urlChanged(rawUrl, rawSource, sender) {
      if (!sender.tab || typeof sender.tab.id !== "number") {
        throw codedError("MissingSenderTab", "urlChanged message must come from a tab.");
      }

      return redirectBlockedUrl(sender.tab.id, rawUrl, contentNavigationSource(sender.tab.id, rawUrl, rawSource));
    }

    // The block page opens its target through here because Chromium sends no
    // referrer from extension pages: a plain link would arrive as a
    // referrer-less link, which root URL rules allow.
    async function openBlockedTarget(tabId, rawUrl) {
      const result = await redirectBlockedUrl(tabId, rawUrl, { type: "blockedPage" });

      switch (result.type) {
        case "allowed":
          await api.tabs.update(tabId, { url: rawUrl });
          return { type: "opened" };
        case "redirected":
          return result;
        default:
          throw new Error(`Unknown redirect result: ${result.type}`);
      }
    }

    // Chromium leaves document.referrer empty for typed URLs and bookmarks as
    // well as for some links, so the page's committed transition tells them apart.
    function contentNavigationSource(tabId, rawUrl, rawSource) {
      const source = documentNavigationSource(api, rawSource);
      const committed = committedNavigationsByTab.get(tabId);

      if (source.type === "document"
        && source.referrer.type === "known"
        && source.referrer.url === ""
        && committed !== undefined
        && core.pageChangeKey(committed.url) === core.pageChangeKey(rawUrl)) {
        return { type: "chromiumCommitted", transitionType: committed.transitionType };
      }

      return source;
    }

    async function logScreenTime(rawUrl, elapsedMs, rawSource, sender) {
      if (!sender.tab || typeof sender.tab.id !== "number") {
        throw codedError("MissingSenderTab", "screenTimeElapsed message must come from a tab.");
      }

      if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
        throw codedError("ScreenTimeUrlInvalid", "Screen time URL must be a string.");
      }

      if (!Number.isInteger(elapsedMs) || elapsedMs <= 0) {
        throw codedError("ScreenTimeElapsedInvalid", "Screen time elapsed time must be a positive integer.");
      }

      if (elapsedMs > MAX_SCREEN_TIME_ELAPSED_MS) {
        throw codedError("ScreenTimeElapsedInvalid", "Screen time elapsed time must be no more than 30 seconds.");
      }

      const source = contentNavigationSource(sender.tab.id, rawUrl, rawSource);
      const state = await loadState();
      const match = core.screenTimeDomainForUrl(state, rawUrl);

      switch (match.type) {
        case "none":
          return { type: "ignored" };
        case "match":
          return saveScreenTimeAndRedirect(state, match.domain, rawUrl, elapsedMs, source, sender.tab.id);
        default:
          throw new Error(`Unknown screen time match type: ${match.type}`);
      }
    }

    async function getScreenTimeLog() {
      const state = await loadState();
      const nowMs = currentTimeMs();
      await syncScreenTimeIfReady(state, { force: false });

      return {
        type: "screenTimeLog",
        entries: core.screenTimeEntries(state, await loadScreenTimeUsage(), nowMs)
      };
    }

    async function getLocalScreenTimeLog() {
      const state = await loadState();

      return {
        type: "screenTimeLog",
        entries: core.screenTimeEntries(state, await loadScreenTimeUsage(), currentTimeMs())
      };
    }

    async function getScreenTimeStats() {
      const state = await loadState();
      const nowMs = currentTimeMs();
      await syncScreenTimeIfReady(state, { force: false });

      return {
        type: "screenTimeStats",
        stats: screenTimeStats(state, await loadScreenTimeUsage(), nowMs)
      };
    }

    async function getLocalScreenTimeStats() {
      const state = await loadState();

      return {
        type: "screenTimeStats",
        stats: screenTimeStats(state, await loadScreenTimeUsage(), currentTimeMs())
      };
    }

    async function redirectBlockedUrl(tabId, rawUrl, navigationSource) {
      if (typeof tabId !== "number") {
        throw codedError("BlockedTabInvalid", "Blocked tab ID must be a number.");
      }

      if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
        throw codedError("BlockedUrlInvalid", "Blocked URL must be a string.");
      }

      const state = await loadState();
      const nowMs = currentTimeMs();
      const usage = await loadScreenTimeUsage();
      const match = core.findBlockedMatchingEntry(state, rawUrl, core.overLimitDomains(state, usage, nowMs), navigationSource);

      if (youtubeFocusAllows(state, tabId, rawUrl, match)) {
        return { type: "allowed", youtubeFocus: true, shortVideo: match.shortVideo };
      }

      if (match.type === "none") {
        rememberAllowedYoutubeVideo(tabId, rawUrl);
        return { type: "allowed", youtubeFocus: false, shortVideo: match.shortVideo };
      }

      return redirectFromMatch(tabId, rawUrl, match);
    }

    // Before the request goes out, the arrival is unknown, so only pages
    // blocked for every arrival redirect here, sparing the wait for the
    // site's response. Arrival-dependent blocks and single-video redirects
    // wait for the commit, which knows the transition.
    async function redirectNavigationStart(details) {
      requireTopFrameDetails(details);

      if (details.frameId !== 0) {
        return { type: "ignored" };
      }

      const state = await loadState();
      const usage = await loadScreenTimeUsage();
      const match = core.findBlockedMatchingEntry(state, details.url, core.overLimitDomains(state, usage, currentTimeMs()), UNKNOWN_NAVIGATION_SOURCE);

      if (match.type !== "match" || youtubeFocusAllows(state, details.tabId, details.url, match)) {
        return { type: "allowed" };
      }

      return redirectFromMatch(details.tabId, details.url, match);
    }

    async function redirectCommittedNavigation(details) {
      requireTopFrameDetails(details);

      if (typeof details.transitionType !== "string") {
        throw codedError("NavigationDetailsInvalid", "Committed navigation transition type must be a string.");
      }

      if (details.frameId !== 0) {
        return { type: "ignored" };
      }

      const previous = committedNavigationsByTab.get(details.tabId);

      // A reload keeps the page's original transition, the way content.js
      // keeps a reloaded page's remembered arrival.
      if (details.transitionType !== "reload"
        || previous === undefined
        || core.pageChangeKey(previous.url) !== core.pageChangeKey(details.url)) {
        committedNavigationsByTab.set(details.tabId, { url: details.url, transitionType: details.transitionType });
      }

      return redirectBlockedUrl(details.tabId, details.url, {
        type: "chromiumCommitted",
        transitionType: details.transitionType
      });
    }

    function requireTopFrameDetails(details) {
      if (!isPlainObject(details)) {
        throw codedError("NavigationDetailsInvalid", "Navigation details must be an object.");
      }

      if (typeof details.frameId !== "number") {
        throw codedError("NavigationDetailsInvalid", "Navigation frame ID must be a number.");
      }

      if (typeof details.tabId !== "number") {
        throw codedError("NavigationDetailsInvalid", "Navigation tab ID must be a number.");
      }

      if (typeof details.url !== "string" || details.url.trim() === "") {
        throw codedError("NavigationDetailsInvalid", "Navigation URL must be a string.");
      }
    }

    async function redirectOpenBlockedTabs(state) {
      const tabs = await api.tabs.query({});
      const nowMs = currentTimeMs();
      const usage = await loadScreenTimeUsage();
      const limitedDomains = core.overLimitDomains(state, usage, nowMs);

      await Promise.all(tabs.map((tab) => {
        if (typeof tab.id !== "number" || typeof tab.url !== "string") {
          return undefined;
        }

        const match = core.findBlockedMatchingEntry(state, tab.url, limitedDomains, UNKNOWN_NAVIGATION_SOURCE);

        return redirectFromMatch(tab.id, tab.url, match);
      }));
    }

    function youtubeFocusAllows(state, tabId, rawUrl, match) {
      if (!state.youtubeFocus.finishCurrentVideo || match.type !== "match" || match.reason === "hardScheduleDomain") {
        return false;
      }

      const video = core.youtubeWatchVideoForUrl(rawUrl);

      if (video.type === "none") {
        return false;
      }

      const allowedVideoId = youtubeVideosByTab.get(tabId);

      if (allowedVideoId !== video.videoId) {
        return false;
      }

      youtubeVideosByTab.set(tabId, video.videoId);
      return true;
    }

    function rememberAllowedYoutubeVideo(tabId, rawUrl) {
      const video = core.youtubeWatchVideoForUrl(rawUrl);

      switch (video.type) {
        case "match":
          youtubeVideosByTab.set(tabId, video.videoId);
          return;
        case "none":
          youtubeVideosByTab.delete(tabId);
          return;
        default:
          throw new Error(`Unknown YouTube video match type: ${video.type}`);
      }
    }

    async function redirectFromMatch(tabId, rawUrl, match) {
      switch (match.type) {
        case "none":
          return { type: "allowed" };
        case "match":
          await api.tabs.update(tabId, { url: blockedPageUrl(rawUrl, match.reason) });
          return { type: "redirected" };
        case "singleVideoRedirect":
          await api.tabs.update(tabId, { url: match.url });
          return { type: "redirected" };
        default:
          throw new Error(`Unknown match type: ${match.type}`);
      }
    }

    function blockedPageUrl(rawUrl, reason) {
      return `${runtimeUrl("blocked.html")}?reason=${encodeURIComponent(reason)}#${encodeURIComponent(rawUrl)}`;
    }

    async function loadState() {
      const activation = await loadSettledSettingsActivation();

      return activation.activeState;
    }

    async function loadSavedState() {
      const stored = await stateStorage.loadState();

      if (stored === undefined) {
        return loadDefaultState();
      }

      const defaultEntries = await loadDefaultEntries();
      const result = core.validateStoredState(stored, defaultEntries);

      if (result.type === "valid") {
        return result.state;
      }

      if (core.hasUnsupportedBlocklistVersion(result.errors)) {
        const repair = await resetBlocklist(defaultEntries, await loadSettingsSync(), currentTimeMs());

        return repair.state;
      }

      throw new Error(result.errors.map((error) => error.message).join("\n"));
    }

    async function loadSettledSettingsActivation() {
      const result = core.settleSettingsActivation(await loadSettingsActivation(), currentTimeMs());

      switch (result.type) {
        case "unchanged":
          scheduleSettingsActivation(result.activation);
          return result.activation;
        case "activated":
          return activateSettings(result.activation);
        default:
          throw new Error(`Unknown settings activation result: ${result.type}`);
      }
    }

    async function loadSettingsActivation() {
      const rawActivation = await settingsActivationStorage.loadActivation();
      const savedState = await loadSavedState();

      if (rawActivation === undefined) {
        const activation = core.activeSettingsActivation(savedState);

        await settingsActivationStorage.saveActivation(activation);
        await blockedPageHtmlStorage.saveHtml(savedState.blockedPageHtml);
        scheduleSettingsActivation(activation);
        return activation;
      }

      const result = core.validateSettingsActivation(rawActivation, await loadDefaultEntries());

      if (result.type === "invalid") {
        throw codedError("SettingsActivationInvalid", result.errors.map((error) => error.message).join("\n"));
      }

      scheduleSettingsActivation(result.activation);
      return result.activation;
    }

    async function saveSettingsActivation(state, currentActivation) {
      const activation = currentActivation || await loadSettledSettingsActivation();
      const nextActivation = core.pendingSettingsActivation(activation, state, currentTimeMs());

      await settingsActivationStorage.saveActivation(nextActivation);
      await blockedPageHtmlStorage.saveHtml(activation.activeState.blockedPageHtml);
      await syncContentScripts(activation.activeState);

      return loadSettledSettingsActivation();
    }

    async function activateSettings(activation) {
      const state = activation.activeState;

      await settingsActivationStorage.saveActivation(activation);
      await blockedPageHtmlStorage.saveHtml(state.blockedPageHtml);
      await syncContentScripts(state);
      await redirectOpenBlockedTabs(state);
      await removeUnusedWebsiteAccessForStates([state]);

      return activation;
    }

    function settingsActivationStatus(activation) {
      switch (activation.pending.type) {
        case "none":
          return { type: "active" };
        case "pending":
          return { type: "pending", effectiveAtMs: activation.pending.effectiveAtMs };
        default:
          throw new Error(`Unknown settings activation type: ${activation.pending.type}`);
      }
    }

    function activeAndPendingStates(activation) {
      switch (activation.pending.type) {
        case "none":
          return [activation.activeState];
        case "pending":
          return [activation.activeState, activation.pending.state];
        default:
          throw new Error(`Unknown settings activation type: ${activation.pending.type}`);
      }
    }

    function scheduleSettingsActivation(activation) {
      if (activation.pending.type === "none") {
        return;
      }

      if (activation.pending.type !== "pending") {
        throw new Error(`Unknown settings activation type: ${activation.pending.type}`);
      }

      const setTimer = api.setTimeout || root.setTimeout;

      if (typeof setTimer !== "function") {
        return;
      }

      if (activationTimer !== 0 && activationTimerAtMs <= activation.pending.effectiveAtMs) {
        return;
      }

      activationTimerAtMs = activation.pending.effectiveAtMs;
      activationTimer = setTimer(() => {
        activationTimer = 0;
        activationTimerAtMs = 0;
        loadSettledSettingsActivation()
          .catch((error) => rememberSyncError(error));
      }, Math.max(0, activation.pending.effectiveAtMs - currentTimeMs()));

      if (activationTimer && typeof activationTimer.unref === "function") {
        activationTimer.unref();
      }
    }

    async function saveScreenTimeAndRedirect(state, domain, rawUrl, elapsedMs, source, tabId) {
      const nowMs = currentTimeMs();
      const hour = currentHour(nowMs);
      const usage = await saveScreenTime(domain, elapsedMs, hour, nowMs);
      const isOverLimit = core.overLimitDomains(state, usage, nowMs).has(domain);

      await syncScreenTimeIfReady(state, { force: isOverLimit });

      if (isOverLimit) {
        const match = core.findBlockedMatchingEntry(state, rawUrl, new Set([domain]), source);

        if (!youtubeFocusAllows(state, tabId, rawUrl, match)) {
          await redirectFromMatch(tabId, rawUrl, match);
        }
      }

      return { type: "logged", domain, isOverLimit };
    }

    async function saveScreenTime(domain, elapsedMs, hour, nowMs) {
      const usage = await loadScreenTimeUsage();
      sync.addScreenTime(usage, domain, hour, elapsedMs, nowMs);

      await screenTimeStorage.saveUsage(usage);

      return usage;
    }

    async function loadScreenTimeUsage() {
      try {
        return sync.parseScreenTimeUsage(await screenTimeStorage.loadUsage(), createId, core);
      } catch (error) {
        if (!sync.isUnsupportedScreenTimeUsage(error)) {
          throw error;
        }

        const usage = sync.emptyScreenTimeUsage(createId());

        await screenTimeStorage.saveUsage(usage);
        return usage;
      }
    }

    async function loadDefaultState() {
      return core.emptyState(await loadDefaultEntries());
    }

    // Packaged files never change while the worker runs, and fetching one
    // costs ~300 ms in Vivaldi Android's unpacked installs, so the list loads
    // once per worker.
    function loadDefaultEntries() {
      defaultEntriesLoad ??= fetchDefaultEntries();
      return defaultEntriesLoad;
    }

    async function fetchDefaultEntries() {
      const url = runtimeUrl("default-blocked-pages.json");
      let response;

      try {
        response = await fetch(url);
      } catch (error) {
        throw codedError("DefaultBlockedPagesLoadFailed", `Default blocked pages request failed for ${url}: ${errorMessage(error)}`, error);
      }

      if (!response.ok) {
        throw codedError(`HTTP ${response.status}`, `Default blocked pages could not be loaded from ${url}.`);
      }

      try {
        return await response.json();
      } catch (error) {
        throw codedError("DefaultBlockedPagesParseFailed", `Default blocked pages JSON could not be parsed from ${url}: ${errorMessage(error)}`, error);
      }
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
        throw codedError("WebsiteAccessMissing", "Website access was not granted for the requested websites.");
      }
    }

    async function syncContentScripts(state) {
      const origins = core.contentScriptOriginsForState(state);
      const registered = await api.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });

      if (contentScriptAlreadyRegistered(registered, origins)) {
        return;
      }

      if (registered.length > 0) {
        await api.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
      }

      if (origins.length === 0) {
        return;
      }

      await api.scripting.registerContentScripts([{
        id: CONTENT_SCRIPT_ID,
        js: CONTENT_SCRIPT_JS,
        css: CONTENT_SCRIPT_CSS,
        matches: origins,
        runAt: "document_start"
      }]);
    }

    function contentScriptAlreadyRegistered(registered, origins) {
      if (registered.length !== 1) {
        return false;
      }

      const script = registered[0];

      return sameItems(script.js, CONTENT_SCRIPT_JS)
        && sameItems(script.css || [], CONTENT_SCRIPT_CSS)
        && sameItems(script.matches, origins)
        && script.runAt === "document_start";
    }

    function sameItems(left, right) {
      if (left.length !== right.length) {
        return false;
      }

      const rightItems = new Set(right);

      return left.every((item) => rightItems.has(item));
    }

    async function removeUnusedWebsiteAccessForStates(states) {
      const requiredOrigins = new Set(states.flatMap(core.permissionOriginsForState));
      const installTimeOrigins = new Set(api.runtime.getManifest().host_permissions);
      const granted = await api.permissions.getAll();
      const unusedOrigins = (granted.origins || []).filter((origin) => (
        !requiredOrigins.has(origin) && !installTimeOrigins.has(origin)
      ));

      if (unusedOrigins.length > 0) {
        await api.permissions.remove({ origins: unusedOrigins });
      }
    }

    async function getSyncStatus() {
      try {
        const config = await loadSupabaseConfig();

        if (!sync.configIsReady(config)) {
          return { type: "syncStatus", status: "unconfigured", error: lastSyncError };
        }

        const sessionResult = sync.parseSession(await sessionStorage.loadSession());

        if (sessionResult.type === "signedOut") {
          if (await usesNativeStorage(api)) {
            return { type: "syncStatus", status: "nativeSignInRequired", error: lastSyncError };
          }

          return { type: "syncStatus", status: "signedOut", error: lastSyncError };
        }

        const settingsSync = await loadSettingsSync();

        return {
          type: "syncStatus",
          status: "signedIn",
          userId: sync.sessionUserId(sessionResult.session),
          lastSuccessfulSyncAgeMs: lastSuccessfulSyncAgeMs(settingsSync),
          error: lastSyncError
        };
      } catch (error) {
        lastSyncError = errorMessage(error);
        return { type: "syncStatus", status: "error", error: lastSyncError };
      }
    }

    async function syncNow() {
      const savedState = await syncSettingsIfPossible(await loadSavedState());
      const activeState = await loadState();

      await syncScreenTimeIfReady(activeState, { force: true });

      return { type: "synced", status: await getSyncStatus() };
    }

    async function signInWithProvider(provider) {
      if (provider !== "google" && provider !== "apple") {
        throw codedError("UnknownSignInProvider", `Unknown sign-in provider: ${provider}`);
      }

      if (await usesNativeStorage(api)) {
        return { type: "nativeSignInRequired" };
      }

      const config = await loadSupabaseConfig();

      if (!sync.configIsReady(config)) {
        return { type: "syncUnavailable", reason: "unconfigured" };
      }

      if (!api.identity || typeof api.identity.launchWebAuthFlow !== "function") {
        return {
          type: "openOAuth",
          url: await fallbackSignInUrl(config, provider)
        };
      }

      const redirectTo = api.identity.getRedirectURL("supabase");
      const redirectUrl = await launchWebAuthFlow({
        interactive: true,
        url: sync.oauthUrl(config, provider, redirectTo)
      });

      await sessionStorage.saveSession(sync.sessionFromOAuthRedirect(redirectUrl, currentTimeMs()));
      await syncNow();

      return { type: "signedIn" };
    }

    async function completeOAuthRedirect(rawUrl) {
      if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
        throw codedError("OAuthRedirectInvalid", "OAuth redirect URL must be a string.");
      }

      await sessionStorage.saveSession(sync.sessionFromOAuthRedirect(rawUrl, currentTimeMs()));
      await syncNow();

      return { type: "signedIn" };
    }

    async function signOut() {
      await sessionStorage.clearSession();
      await clearRemoteScreenTimeBuckets();
      lastSyncError = "";

      return { type: "signedOut" };
    }

    async function clearRemoteScreenTimeBuckets() {
      const usage = await loadScreenTimeUsage();

      usage.remoteBuckets = {};
      await screenTimeStorage.saveUsage(usage);
    }

    async function launchWebAuthFlow(details) {
      if (api.identity.launchWebAuthFlow.length >= 2) {
        return new Promise((resolve, reject) => {
          api.identity.launchWebAuthFlow(details, (url) => {
            if (api.runtime.lastError) {
              reject(codedError("OAuthFailed", api.runtime.lastError.message));
              return;
            }

            resolve(url);
          });
        });
      }

      const result = api.identity.launchWebAuthFlow(details);

      if (!result || typeof result.then !== "function") {
        throw codedError("OAuthUnavailable", "Browser identity API did not return an auth flow promise.");
      }

      return result;
    }

    async function fallbackSignInUrl(config, provider) {
      if (await usesNativeSessionStorage(api)) {
        return `${config.redirectScheme}://sign-in/${provider}`;
      }

      return sync.oauthUrl(config, provider, runtimeUrl("options.html"));
    }

    async function syncRemoteStateIfPossible() {
      try {
        const active = await activeSupabaseSession();

        if (active.type !== "active") {
          return;
        }

        const rawSync = await settingsSyncStorage.loadSync();
        const settingsSync = sync.parseSettingsSync(rawSync, createId, currentTimeMs());

        if (settingsSync.dirty) {
          await syncSettingsIfPossible(await loadSavedState());
          return;
        }

        const remoteSettings = await sync.loadRemoteSettings(active.config, active.session, fetchJson);

        if (!remoteSettings) {
          await markSyncSuccessful(settingsSync);
          lastSyncError = "";
          return;
        }

        if (rawSync === undefined || sync.remoteSettingsAreNewer(settingsSync, remoteSettings)) {
          await applyRemoteSettings(active, remoteSettings, settingsSync);
          return;
        }

        await markSyncSuccessful(settingsSync);
        lastSyncError = "";
      } catch (error) {
        rememberSyncError(error);
      }
    }

    async function syncSettingsIfPossible(localState) {
      try {
        const active = await activeSupabaseSession();

        if (active.type !== "active") {
          return localState;
        }

        const settingsSync = await loadSettingsSync();
        const remoteSettings = settingsSync.dirty
          ? await sync.saveRemoteSettings(active.config, active.session, localState, settingsSync, fetchJson)
          : await sync.loadRemoteSettings(active.config, active.session, fetchJson);

        if (!remoteSettings) {
          await markSyncSuccessful(settingsSync);
          lastSyncError = "";
          return localState;
        }

        if (sync.remoteSettingsAreNewer(settingsSync, remoteSettings)) {
          return applyRemoteSettings(active, remoteSettings, settingsSync);
        }

        await settingsSyncStorage.saveSync(sync.cleanSettingsSync(settingsSync, remoteSettings, currentTimeMs()));
        lastSyncError = "";
        return localState;
      } catch (error) {
        rememberSyncError(error);
        return localState;
      }
    }

    async function applyRemoteSettings(active, remoteSettings, settingsSync) {
      const defaultEntries = await loadDefaultEntries();
      const result = core.validateStoredState(remoteSettings.state, defaultEntries);

      if (result.type === "invalid") {
        if (core.hasUnsupportedBlocklistVersion(result.errors)) {
          return resetRemoteBlocklist(active, remoteSettings, settingsSync, defaultEntries);
        }

        throw codedError("RemoteSettingsInvalid", result.errors.map((error) => error.message).join("\n"));
      }

      const currentActivation = await loadSettledSettingsActivation();

      await stateStorage.saveState(result.state);
      const activation = await saveSettingsActivation(result.state, currentActivation);
      await settingsSyncStorage.saveSync(sync.cleanSettingsSync(settingsSync, remoteSettings, currentTimeMs()));
      await syncWebsiteAccessForKnownPermissions(activation.activeState);
      lastSyncError = "";

      return result.state;
    }

    async function resetRemoteBlocklist(active, remoteSettings, settingsSync, defaultEntries) {
      const updatedAtMs = Math.max(currentTimeMs(), remoteSettings.updated_at_ms + 1);
      const repair = await resetBlocklist(defaultEntries, settingsSync, updatedAtMs);
      const savedRemoteSettings = await sync.saveRemoteSettings(active.config, active.session, repair.state, repair.dirtySync, fetchJson);

      await settingsSyncStorage.saveSync(sync.cleanSettingsSync(repair.dirtySync, savedRemoteSettings, currentTimeMs()));
      return repair.state;
    }

    async function resetBlocklist(defaultEntries, settingsSync, updatedAtMs) {
      const state = core.emptyState(defaultEntries);
      const dirtySync = sync.dirtySettingsSync(settingsSync, updatedAtMs, createId);

      await stateStorage.saveState(state);
      await settingsActivationStorage.saveActivation(core.activeSettingsActivation(state));
      await blockedPageHtmlStorage.saveHtml(state.blockedPageHtml);
      await settingsSyncStorage.saveSync(dirtySync);
      await syncWebsiteAccessForKnownPermissions(state);
      await redirectOpenBlockedTabs(state);
      await removeUnusedWebsiteAccessForStates([state]);
      lastSyncError = "";

      return { state, dirtySync };
    }

    async function syncWebsiteAccessForKnownPermissions(state) {
      const origins = core.permissionOriginsForState(state);

      if (origins.length > 0 && !(await api.permissions.contains({ origins }))) {
        return;
      }

      await syncContentScripts(state);
    }

    async function syncScreenTimeIfReady(state, options) {
      const usage = await loadScreenTimeUsage();
      const config = await loadSupabaseConfig().catch((error) => {
        rememberSyncError(error);
        return undefined;
      });

      if (!config) {
        return usage;
      }

      const syncAgeMs = config.screenTimeSyncAgeMs || sync.SCREEN_TIME_SYNC_AGE_MS;

      if (!options.force && !sync.shouldSyncScreenTime(usage, currentTimeMs(), syncAgeMs)) {
        scheduleScreenTimeSync(state, usage, syncAgeMs);
        return usage;
      }

      try {
        const active = await activeSupabaseSession(config);

        if (active.type !== "active") {
          return usage;
        }

        const dirtyBuckets = sync.dirtyScreenTimeBuckets(usage);

        if (dirtyBuckets.length > 0) {
          const savedBuckets = await sync.saveRemoteScreenTime(active.config, active.session, dirtyBuckets, fetchJson);
          const syncedBuckets = sync.normalizeSyncedScreenTimeRows(savedBuckets, core);

          sync.markScreenTimeSynced(usage, syncedBuckets);
        }

        const remoteRows = await sync.loadRemoteScreenTime(active.config, active.session, core.usageWindow(state.limitReset, currentTimeMs()), fetchJson);

        sync.mergeRemoteScreenTimeBuckets(usage, sync.normalizeRemoteScreenTimeRows(remoteRows, core));
        await screenTimeStorage.saveUsage(usage);
        await markSyncSuccessful(await loadSettingsSync());
        lastSyncError = "";
      } catch (error) {
        rememberSyncError(error);
      }

      return usage;
    }

    function scheduleScreenTimeSync(state, usage, syncAgeMs) {
      const setTimer = api.setTimeout || root.setTimeout;

      if (usageSyncTimer !== 0 || typeof setTimer !== "function") {
        return;
      }

      const delayMs = sync.screenTimeSyncDelayMs(usage, currentTimeMs(), syncAgeMs);

      if (delayMs === null) {
        return;
      }

      usageSyncTimer = setTimer(() => {
        usageSyncTimer = 0;
        syncScreenTimeIfReady(state, { force: false })
          .catch((error) => rememberSyncError(error));
      }, delayMs);
    }

    async function activeSupabaseSession(knownConfig) {
      const config = knownConfig || await loadSupabaseConfig();

      if (!sync.configIsReady(config)) {
        return { type: "inactive" };
      }

      const sessionResult = sync.parseSession(await sessionStorage.loadSession());

      if (sessionResult.type === "signedOut") {
        return { type: "inactive" };
      }

      if (!sync.sessionNeedsRefresh(sessionResult.session, currentTimeMs())) {
        return { type: "active", config, session: sessionResult.session };
      }

      const refreshedSession = await sync.refreshSession(config, sessionResult.session, fetchJson);

      await sessionStorage.saveSession(refreshedSession);

      return { type: "active", config, session: refreshedSession };
    }

    async function loadSettingsSync() {
      return sync.parseSettingsSync(await settingsSyncStorage.loadSync(), createId, currentTimeMs());
    }

    async function markSyncSuccessful(settingsSync) {
      await settingsSyncStorage.saveSync(sync.markSuccessfulSync(settingsSync, currentTimeMs()));
    }

    function lastSuccessfulSyncAgeMs(settingsSync) {
      if (settingsSync.lastSuccessfulSyncMs === null) {
        return null;
      }

      return Math.max(0, currentTimeMs() - settingsSync.lastSuccessfulSyncMs);
    }

    async function loadSupabaseConfig() {
      if (!configPromise) {
        configPromise = fetchJson(runtimeUrl(sync.CONFIG_PATH), { method: "GET", headers: {} })
          .then(sync.parseConfig);
      }

      return configPromise;
    }

    async function fetchJson(url, options) {
      const response = await fetch(url, options);

      if (!response.ok) {
        throw codedError(`HTTP ${response.status}`, sync.supabaseErrorMessage(response.status, await response.text()));
      }

      return response.json();
    }

    function rememberSyncError(error) {
      lastSyncError = errorMessage(error);
      console.error(`URL Blocker sync failed. ${errorLogText(error)}`);
    }

    function createId() {
      if (typeof api.randomUUID === "function") {
        return api.randomUUID();
      }

      if (root.crypto && typeof root.crypto.randomUUID === "function") {
        return root.crypto.randomUUID();
      }

      throw codedError("UUIDUnavailable", "A UUID generator is required.");
    }

    function currentTimeMs() {
      return typeof api.now === "function" ? api.now() : Date.now();
    }

    function currentHour(nowMs) {
      return Math.floor(nowMs / HOUR_MS);
    }

    async function sweepReferrerRecords() {
      const values = await api.storage.local.get(null);
      const expiresBefore = currentTimeMs() - REFERRER_RECORD_RETENTION_MS;

      for (const [key, value] of Object.entries(values)) {
        if (!key.startsWith(REFERRER_RECORD_PREFIX)) {
          continue;
        }

        const records = unexpiredReferrerRecords(value, expiresBefore);

        if (records.length === 0) {
          await api.storage.local.remove(key);
          continue;
        }

        // The sweep runs on every service worker wake; rewriting unchanged
        // keys would race concurrent content script writes for nothing.
        if (records.length === value.records.length) {
          continue;
        }

        await api.storage.local.set({ [key]: { records } });
      }
    }

    function unexpiredReferrerRecords(value, expiresBefore) {
      if (!isPlainObject(value) || !Array.isArray(value.records)) {
        return [];
      }

      return value.records.filter((record) => isPlainObject(record)
        && typeof record.referrer === "string"
        && typeof record.recordedAt === "number"
        && record.recordedAt >= expiresBefore);
    }

    function forgetTab(tabId) {
      youtubeVideosByTab.delete(tabId);
      committedNavigationsByTab.delete(tabId);
    }

    sweepReferrerRecords().catch((error) => {
      console.error(`URL Blocker could not sweep referrer records. ${errorLogText(error)}`);
    });

    return {
      forgetTab,
      getLocalScreenTimeLog,
      getBlockedPageHtml,
      getLocalState,
      getLocalScreenTimeStats,
      getScreenTimeLog,
      getScreenTimeStats,
      getState,
      getDefaultState,
      handleMessage,
      loadState,
      logScreenTime,
      openOptions,
      redirectBlockedUrl,
      redirectCommittedNavigation,
      redirectNavigationStart,
      finishSavedState,
      saveState,
      signInWithProvider,
      signOut,
      syncNow,
      syncContentScripts,
      syncWebsiteAccess
    };
  }

  function screenTimeStats(state, usage, nowMs) {
    const window = core.usageWindow(state.limitReset, nowMs);
    const entries = core.activeLimits(state)
      .map((limit) => screenTimeStatsEntry(usage, limit, window))
      .sort((left, right) => right.totalMs - left.totalMs || left.name.localeCompare(right.name));
    const domains = entries.flatMap((entry) => entry.domains);

    return {
      generatedAtMs: nowMs,
      schedule: state.schedule,
      limitReset: state.limitReset,
      window,
      totalMs: entries.reduce((total, entry) => total + entry.totalMs, 0),
      trackedDomainCount: entries.length,
      activeDomainCount: entries.filter((entry) => entry.totalMs > 0).length,
      overLimitCount: entries.filter((entry) => entry.isOverLimit).length,
      entries,
      hourlyTotals: screenTimeHourlyTotals(usage, domains, window),
      deviceTotals: screenTimeDeviceTotals(usage, domains, window)
    };
  }

  function screenTimeStatsEntry(usage, limit, window) {
    const limitMs = limit.limitMinutes * 60 * 1000;
    const localMs = limit.domains.reduce((total, domain) => total + core.screenTimeBucketTotalMs(usage.localBuckets[domain] || {}, window), 0);
    const remoteMs = limit.domains.reduce((total, domain) => total + remoteScreenTimeBucketTotal(usage.remoteBuckets, domain, window), 0);
    const totalMs = localMs + remoteMs;

    return {
      type: limit.type,
      name: limit.name,
      domains: limit.domains,
      totalMs,
      localMs,
      remoteMs,
      limitMinutes: limit.limitMinutes,
      remainingMs: Math.max(0, limitMs - totalMs),
      usedPercent: Math.min(100, Math.round((totalMs / limitMs) * 100)),
      isOverLimit: totalMs >= limitMs
    };
  }

  function screenTimeHourlyTotals(usage, domains, window) {
    const totals = [];

    for (let hour = window.startHour; hour <= window.endHour; hour += 1) {
      totals.push({
        hour,
        startedAtMs: hour * HOUR_MS,
        totalMs: domains.reduce((total, domain) => total + core.screenTimeTotalMs(usage, domain, { startHour: hour, endHour: hour }), 0)
      });
    }

    return totals;
  }

  function screenTimeDeviceTotals(usage, domains, window) {
    return [
      {
        label: "This Device",
        totalMs: domains.reduce((total, domain) => total + core.screenTimeBucketTotalMs(usage.localBuckets[domain] || {}, window), 0)
      },
      ...Object.values(usage.remoteBuckets).map((deviceBuckets, index) => ({
        label: `Other Device ${index + 1}`,
        totalMs: domains.reduce((total, domain) => total + core.screenTimeBucketTotalMs(deviceBuckets[domain] || {}, window), 0)
      }))
    ].filter((entry) => entry.totalMs > 0);
  }

  function remoteScreenTimeBucketTotal(remoteBuckets, domain, window) {
    return Object.values(remoteBuckets).reduce((total, deviceBuckets) => (
      total + core.screenTimeBucketTotalMs(deviceBuckets[domain] || {}, window)
    ), 0);
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
        const response = await sendNativeMessage(api, { type: "loadState" });

        switch (response.type) {
          case "storedState":
            return response.state;
          case "error":
            throw errorFromResponse(response);
          default:
            throw new Error(`Unknown native loadState response: ${response.type}`);
        }
      },
      async saveState(state) {
        const response = await sendNativeMessage(api, { type: "saveState", state });

        switch (response.type) {
          case "savedState":
            return { type: "saved", state: response.state };
          case "error":
            throw errorFromResponse(response);
          default:
            throw new Error(`Unknown native saveState response: ${response.type}`);
        }
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

  function createBlockedPageHtmlStorage(api) {
    const storage = createValueStorage(api, {
      key: core.BLOCKED_PAGE_HTML_KEY,
      valueKey: "blockedPageHtml",
      loadType: "loadBlockedPageHtml",
      loadedType: "storedBlockedPageHtml",
      saveType: "saveBlockedPageHtml",
      savedType: "savedBlockedPageHtml"
    }, usesNativeStorage);

    return {
      async loadHtml() {
        const stored = await storage.loadValue();

        if (stored === undefined) {
          return undefined;
        }

        return htmlFromBlockedPageHtmlCache(stored);
      },
      async saveHtml(html) {
        await storage.saveValue({ html: core.normalizeBlockedPageHtml(html) });
      }
    };
  }

  function htmlFromBlockedPageHtmlCache(stored) {
    if (!isPlainObject(stored)) {
      throw codedError("BlockedPageHtmlCacheInvalid", "Blocked page HTML cache must be an object.");
    }

    requireKeys(stored, ["html"], "Blocked page HTML cache");

    if (typeof stored.html !== "string") {
      throw codedError("BlockedPageHtmlCacheInvalid", "Blocked page HTML cache must include an html string.");
    }

    return core.normalizeBlockedPageHtml(stored.html);
  }

  function createScreenTimeStorage(api) {
    const storage = createValueStorage(api, {
      key: SCREEN_TIME_USAGE_KEY,
      valueKey: "usage",
      loadType: "loadScreenTimeUsage",
      loadedType: "storedScreenTimeUsage",
      saveType: "saveScreenTimeUsage",
      savedType: "savedScreenTimeUsage"
    }, usesNativeStorage);

    return {
      async loadUsage() {
        return storage.loadValue();
      },
      async saveUsage(usage) {
        return storage.saveValue(usage);
      }
    };
  }

  function createSettingsSyncStorage(api) {
    const storage = createValueStorage(api, {
      key: SETTINGS_SYNC_KEY,
      valueKey: "sync",
      loadType: "loadSettingsSync",
      loadedType: "storedSettingsSync",
      saveType: "saveSettingsSync",
      savedType: "savedSettingsSync"
    }, usesNativeStorage);

    return {
      async loadSync() {
        return storage.loadValue();
      },
      async saveSync(settingsSync) {
        return storage.saveValue(settingsSync);
      }
    };
  }

  function createSettingsActivationStorage(api) {
    const storage = createValueStorage(api, {
      key: SETTINGS_ACTIVATION_KEY,
      valueKey: "activation",
      loadType: "loadSettingsActivation",
      loadedType: "storedSettingsActivation",
      saveType: "saveSettingsActivation",
      savedType: "savedSettingsActivation"
    }, usesNativeStorage);

    return {
      async loadActivation() {
        return storage.loadValue();
      },
      async saveActivation(activation) {
        return storage.saveValue(activation);
      }
    };
  }

  function createSupabaseSessionStorage(api) {
    const storage = createValueStorage(api, {
      key: SUPABASE_SESSION_KEY,
      valueKey: "session",
      loadType: "loadSupabaseSession",
      loadedType: "storedSupabaseSession",
      saveType: "saveSupabaseSession",
      savedType: "savedSupabaseSession"
    }, usesNativeSessionStorage);

    return {
      async loadSession() {
        return storage.loadValue();
      },
      async saveSession(session) {
        return storage.saveValue(session);
      },
      async clearSession() {
        return clearStoredValue(api, {
          key: SUPABASE_SESSION_KEY,
          clearType: "clearSupabaseSession",
          clearedType: "clearedSupabaseSession"
        }, usesNativeSessionStorage);
      }
    };
  }

  function createValueStorage(api, types, usesNative) {
    const browserStorage = {
      async loadValue() {
        const stored = await api.storage.local.get(types.key);

        return stored[types.key];
      },
      async saveValue(value) {
        await api.storage.local.set({ [types.key]: value });

        return value;
      }
    };
    const nativeStorage = {
      async loadValue() {
        const response = await sendNativeMessage(api, { type: types.loadType });

        switch (response.type) {
          case types.loadedType:
            return response[types.valueKey];
          case "error":
            throw errorFromResponse(response);
          default:
            throw new Error(`Unknown native ${types.loadType} response: ${response.type}`);
        }
      },
      async saveValue(value) {
        const response = await sendNativeMessage(api, { type: types.saveType, [types.valueKey]: value });

        switch (response.type) {
          case types.savedType:
            return response[types.valueKey];
          case "error":
            throw errorFromResponse(response);
          default:
            throw new Error(`Unknown native ${types.saveType} response: ${response.type}`);
        }
      }
    };

    return {
      async loadValue() {
        return (await usesNative(api)) ? nativeStorage.loadValue() : browserStorage.loadValue();
      },
      async saveValue(value) {
        return (await usesNative(api)) ? nativeStorage.saveValue(value) : browserStorage.saveValue(value);
      }
    };
  }

  async function clearStoredValue(api, types, usesNative) {
    if (!(await usesNative(api))) {
      await api.storage.local.remove(types.key);
      return;
    }

    const response = await sendNativeMessage(api, { type: types.clearType });

    switch (response.type) {
      case types.clearedType:
        return;
      case "error":
        throw errorFromResponse(response);
      default:
        throw new Error(`Unknown native ${types.clearType} response: ${response.type}`);
    }
  }

  async function usesNativeStorage(api) {
    if (!canSendNativeMessage(api)) {
      return false;
    }

    if (typeof api.runtime.getPlatformInfo !== "function") {
      return true;
    }

    const platform = await api.runtime.getPlatformInfo();

    return platform.os === "ios";
  }

  async function usesNativeSessionStorage(api) {
    if (await usesNativeStorage(api)) {
      return true;
    }

    return canSendNativeMessage(api) && api.runtime.getURL("options.html").startsWith("safari-web-extension://");
  }

  function documentNavigationSource(api, source) {
    if (!isPlainObject(source) || source.type !== "document") {
      throw codedError("NavigationSourceInvalid", "Navigation source must be a document source.");
    }

    requireKeys(source, ["type", "referrer", "navigationType"], "Navigation source");

    if (typeof source.navigationType !== "string") {
      throw codedError("NavigationSourceInvalid", "Navigation source navigation type must be a string.");
    }

    return {
      type: isSafariRuntime(api) ? "safariDocument" : "document",
      referrer: documentNavigationReferrer(source.referrer),
      navigationType: source.navigationType
    };
  }

  function documentNavigationReferrer(referrer) {
    if (!isPlainObject(referrer) || typeof referrer.type !== "string") {
      throw codedError("NavigationSourceInvalid", "Navigation source referrer must be a referrer object.");
    }

    switch (referrer.type) {
      case "known":
        requireNavigationSourceKeys(referrer, ["type", "url"], "Navigation source referrer");

        if (typeof referrer.url !== "string") {
          throw codedError("NavigationSourceInvalid", "Navigation source referrer URL must be a string.");
        }

        return { type: "known", url: referrer.url };
      case "unknown":
        requireNavigationSourceKeys(referrer, ["type"], "Navigation source referrer");
        return { type: "unknown" };
      default:
        throw codedError("NavigationSourceInvalid", `Unknown navigation source referrer type: ${referrer.type}.`);
    }
  }

  function requireNavigationSourceKeys(object, allowedKeys, label) {
    const allowed = new Set(allowedKeys);
    const unknownKeys = Object.keys(object).filter((key) => !allowed.has(key));

    if (unknownKeys.length > 0) {
      throw codedError("NavigationSourceInvalid", `${label} has unknown key: ${unknownKeys[0]}.`);
    }
  }

  function isSafariRuntime(api) {
    return !!api.runtime
      && typeof api.runtime.getURL === "function"
      && api.runtime.getURL("options.html").startsWith("safari-web-extension://");
  }

  function canSendNativeMessage(api) {
    return !!api.runtime && typeof api.runtime.sendNativeMessage === "function";
  }

  async function sendNativeMessage(api, message) {
    const response = await api.runtime.sendNativeMessage("application.id", message);

    if (!isPlainObject(response) || typeof response.type !== "string") {
      throw codedError("NativeResponseInvalid", "Native response must include a type.");
    }

    return response;
  }

  function attachRuntimeListener(api) {
    const controller = createBackgroundController(api);
    const action = api.action || api.browserAction;

    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      controller.handleMessage(message, sender)
        .then(sendResponse)
        .catch((error) => sendResponse(errorResponse("error", error)));

      return true;
    });

    if (action && action.onClicked) {
      action.onClicked.addListener(() => {
        controller.openOptions().catch((error) => console.error(`URL Blocker could not open options. ${errorLogText(error)}`));
      });
    }

    if (api.tabs.onUpdated) {
      api.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (typeof changeInfo.url !== "string") {
          return;
        }

        controller.redirectBlockedUrl(tabId, changeInfo.url, UNKNOWN_NAVIGATION_SOURCE)
          .catch((error) => console.error(`URL Blocker could not redirect updated tab. ${errorLogText(error)}`));
      });
    }

    if (api.tabs.onRemoved) {
      api.tabs.onRemoved.addListener((tabId) => controller.forgetTab(tabId));
    }

    if (api.webNavigation) {
      api.webNavigation.onBeforeNavigate.addListener((details) => {
        controller.redirectNavigationStart(details)
          .catch((error) => console.error(`URL Blocker could not redirect starting navigation. ${errorLogText(error)}`));
      });
      api.webNavigation.onCommitted.addListener((details) => {
        controller.redirectCommittedNavigation(details)
          .catch((error) => console.error(`URL Blocker could not redirect committed navigation. ${errorLogText(error)}`));
      });
    }

    return controller;
  }

  function requireKeys(object, allowedKeys, label) {
    const allowed = new Set(allowedKeys);
    const unknownKeys = Object.keys(object).filter((key) => !allowed.has(key));

    if (unknownKeys.length > 0) {
      throw codedError("UnknownMessageKey", `${label} has unknown key: ${unknownKeys[0]}.`);
    }
  }

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function errorResponse(type, error) {
    return { type, error: errorMessage(error), errorCode: errorCode(error) };
  }

  // Browser extension error panes stringify console arguments, so log errors as
  // one formatted string instead of an object that renders as [object Object].
  function errorLogText(error) {
    return `${errorMessage(error)} (${errorCode(error)})`;
  }

  function errorFromResponse(response) {
    return codedError(response.errorCode || response.type, response.error || `Unexpected response: ${response.type}`);
  }

  function codedError(errorCode, message, cause) {
    const error = new Error(message);
    const causeCode = cause ? errorCodeValue(cause) : "";

    error.errorCode = causeCode === "" ? errorCode : `${errorCode}; ${causeCode}`;
    return error;
  }

  function errorMessage(error) {
    if (error instanceof Error && error.message !== "") {
      return error.message;
    }

    if (isPlainObject(error)) {
      return JSON.stringify(error);
    }

    return String(error);
  }

  function errorCode(error) {
    return errorCodeValue(error) || "UnknownError";
  }

  function errorCodeValue(error) {
    if (error instanceof Error && typeof error.errorCode === "string") {
      return error.errorCode;
    }

    if (error instanceof Error && error.code !== undefined) {
      return String(error.code);
    }

    if (error instanceof Error && error.name !== "") {
      return error.name;
    }

    if (isPlainObject(error) && typeof error.errorCode === "string") {
      return error.errorCode;
    }

    if (isPlainObject(error) && error.code !== undefined) {
      return String(error.code);
    }

    return "";
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
      .catch((error) => console.error(`URL Blocker could not sync website access. ${errorLogText(error)}`));
  }
})(globalThis);
