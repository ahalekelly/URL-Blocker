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
  const HOUR_MS = 60 * 60 * 1000;
  const MAX_SCREEN_TIME_ELAPSED_MS = 30 * 1000;
  const SCREEN_TIME_USAGE_KEY = "screenTimeUsage";
  const SETTINGS_SYNC_KEY = "settingsSync";
  const SUPABASE_SESSION_KEY = "supabaseSession";

  function createBackgroundController(api) {
    const stateStorage = createStateStorage(api);
    const screenTimeStorage = createScreenTimeStorage(api);
    const settingsSyncStorage = createSettingsSyncStorage(api);
    const sessionStorage = createSupabaseSessionStorage(api);
    let configPromise;
    let lastSyncError = "";
    let usageSyncTimer = 0;

    async function handleMessage(message, sender) {
      if (!isPlainObject(message) || typeof message.type !== "string") {
        throw codedError("InvalidExtensionMessage", "Extension message must include a type.");
      }

      switch (message.type) {
        case "getLocalState":
          requireKeys(message, ["type"], "getLocalState message");
          return getLocalState();
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
          requireKeys(message, ["type", "url"], "urlChanged message");
          return urlChanged(message.url, sender);
        case "screenTimeElapsed":
          requireKeys(message, ["type", "url", "elapsedMs"], "screenTimeElapsed message");
          return logScreenTime(message.url, message.elapsedMs, sender);
        case "getScreenTimeLog":
          requireKeys(message, ["type"], "getScreenTimeLog message");
          return getScreenTimeLog();
        case "getLocalScreenTimeLog":
          requireKeys(message, ["type"], "getLocalScreenTimeLog message");
          return getLocalScreenTimeLog();
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
        return { type: "state", state: await loadState() };
      } catch (error) {
        return errorResponse("stateError", error);
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
      await syncContentScripts(result.state);
      const storageResponse = await stateStorage.saveState(result.state);

      if (storageResponse.type === "validationError") {
        return storageResponse;
      }

      if (storageResponse.type !== "saved") {
        throw errorFromResponse(storageResponse);
      }

      const settingsSync = await loadSettingsSync();

      await settingsSyncStorage.saveSync(sync.dirtySettingsSync(settingsSync, currentTimeMs(), createId));
      return { type: "saved", state: storageResponse.state };
    }

    async function finishSavedState() {
      const savedState = await syncSettingsIfPossible(await loadState());

      await redirectOpenBlockedTabs(savedState);
      await removeUnusedWebsiteAccess(savedState);

      return { type: "finishedSavedState", state: savedState };
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
        throw codedError("MissingSenderTab", "urlChanged message must come from a tab.");
      }

      return redirectBlockedUrl(sender.tab.id, rawUrl);
    }

    async function logScreenTime(rawUrl, elapsedMs, sender = {}) {
      if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
        throw codedError("ScreenTimeUrlInvalid", "Screen time URL must be a string.");
      }

      if (!Number.isInteger(elapsedMs) || elapsedMs <= 0) {
        throw codedError("ScreenTimeElapsedInvalid", "Screen time elapsed time must be a positive integer.");
      }

      if (elapsedMs > MAX_SCREEN_TIME_ELAPSED_MS) {
        throw codedError("ScreenTimeElapsedInvalid", "Screen time elapsed time must be no more than 30 seconds.");
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
      const nowMs = currentTimeMs();
      await syncScreenTimeIfReady(state, { force: false });

      return {
        type: "screenTimeLog",
        entries: screenTimeEntries(state, await loadScreenTimeUsage(), nowMs)
      };
    }

    async function getLocalScreenTimeLog() {
      const state = await loadState();

      return {
        type: "screenTimeLog",
        entries: screenTimeEntries(state, await loadScreenTimeUsage(), currentTimeMs())
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

    async function redirectBlockedUrl(tabId, rawUrl) {
      if (typeof tabId !== "number") {
        throw codedError("BlockedTabInvalid", "Blocked tab ID must be a number.");
      }

      if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
        throw codedError("BlockedUrlInvalid", "Blocked URL must be a string.");
      }

      const state = await loadState();
      const nowMs = currentTimeMs();
      const usage = await loadScreenTimeUsage();
      const match = core.findBlockedMatchingEntry(state, rawUrl, overLimitDomains(state, usage, nowMs));

      return redirectFromMatch(tabId, rawUrl, match);
    }

    async function redirectOpenBlockedTabs(state) {
      const tabs = await api.tabs.query({});
      const nowMs = currentTimeMs();
      const usage = await loadScreenTimeUsage();
      const limitedDomains = overLimitDomains(state, usage, nowMs);

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

    async function saveScreenTimeAndRedirect(state, domain, rawUrl, elapsedMs, sender) {
      const nowMs = currentTimeMs();
      const hour = currentHour(nowMs);
      const usage = await saveScreenTime(domain, elapsedMs, hour, nowMs);
      const totalMs = sync.screenTimeTotalMs(usage, domain, usageWindow(state.limitReset, nowMs));
      const limit = domainLimit(state, domain);
      const isOverLimit = totalMs >= limit.limitMinutes * 60 * 1000;

      await syncScreenTimeIfReady(state, { force: isOverLimit });

      if (isOverLimit && sender.tab && typeof sender.tab.id === "number") {
        const match = core.findBlockedMatchingEntry(state, rawUrl, new Set([domain]));

        await redirectFromMatch(sender.tab.id, rawUrl, match);
      }

      return { type: "logged", domain, totalMs, limitMinutes: limit.limitMinutes, isOverLimit };
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

    async function loadDefaultEntries() {
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
      const origins = core.permissionOriginsForState(state);
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
        js: ["content.js"],
        matches: origins,
        runAt: "document_start"
      }]);
    }

    function contentScriptAlreadyRegistered(registered, origins) {
      if (registered.length !== 1) {
        return false;
      }

      const script = registered[0];

      return sameItems(script.js, ["content.js"])
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
      const state = await loadState();
      const savedState = await syncSettingsIfPossible(state);

      await syncScreenTimeIfReady(savedState, { force: true });

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
          url: sync.oauthUrl(config, provider, runtimeUrl("options.html"))
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
    async function syncRemoteStateIfPossible() {
      try {
        const active = await activeSupabaseSession();

        if (active.type !== "active") {
          return;
        }

        const rawSync = await settingsSyncStorage.loadSync();
        const settingsSync = sync.parseSettingsSync(rawSync, createId, currentTimeMs());

        if (settingsSync.dirty) {
          await syncSettingsIfPossible(await loadState());
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
      const result = core.validateState(remoteSettings.state, defaultEntries);

      if (result.type === "invalid") {
        if (core.hasUnsupportedBlocklistVersion(result.errors)) {
          return resetRemoteBlocklist(active, remoteSettings, settingsSync, defaultEntries);
        }

        throw codedError("RemoteSettingsInvalid", result.errors.map((error) => error.message).join("\n"));
      }

      await stateStorage.saveState(result.state);
      await settingsSyncStorage.saveSync(sync.cleanSettingsSync(settingsSync, remoteSettings, currentTimeMs()));
      await syncWebsiteAccessForKnownPermissions(result.state);
      await redirectOpenBlockedTabs(result.state);
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
      await settingsSyncStorage.saveSync(dirtySync);
      await syncWebsiteAccessForKnownPermissions(state);
      await redirectOpenBlockedTabs(state);
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

        const remoteRows = await sync.loadRemoteScreenTime(active.config, active.session, usageWindow(state.limitReset, currentTimeMs()), fetchJson);

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
        throw codedError(`HTTP ${response.status}`, supabaseErrorMessage(response.status, await response.text()));
      }

      return response.json();
    }

    function supabaseErrorMessage(status, body) {
      if (body === "") {
        return `Supabase request failed: ${status}`;
      }

      try {
        const json = JSON.parse(body);
        const detail = [json.message, json.details, json.hint, json.code].filter((value) => typeof value === "string" && value !== "");

        if (detail.length > 0) {
          return `Supabase request failed: ${status}. ${detail.join(" ")}`;
        }
      } catch {
        return `Supabase request failed: ${status}. ${body}`;
      }

      return `Supabase request failed: ${status}. ${body}`;
    }

    function rememberSyncError(error) {
      lastSyncError = errorMessage(error);
      console.error("URL Blocker sync failed.", errorResponse("syncError", error));
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

    return {
      getLocalScreenTimeLog,
      getLocalState,
      getScreenTimeLog,
      getScreenTimeStats,
      getState,
      getDefaultState,
      handleMessage,
      loadState,
      logScreenTime,
      openOptions,
      redirectBlockedUrl,
      finishSavedState,
      saveState,
      signInWithProvider,
      signOut,
      syncNow,
      syncContentScripts,
      syncWebsiteAccess
    };
  }

  function screenTimeEntries(state, usage, nowMs) {
    const hours = usageWindow(state.limitReset, nowMs);

    return activeDomainLimits(state)
      .map((limit) => {
        const totalMs = sync.screenTimeTotalMs(usage, limit.domain, hours);

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

  function screenTimeStats(state, usage, nowMs) {
    const window = usageWindow(state.limitReset, nowMs);
    const entries = activeDomainLimits(state)
      .map((limit) => screenTimeStatsEntry(usage, limit, window))
      .sort((left, right) => right.totalMs - left.totalMs || left.domain.localeCompare(right.domain));
    const domains = entries.map((entry) => entry.domain);

    return {
      generatedAtMs: nowMs,
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
    const localMs = screenTimeBucketTotal(usage.localBuckets[limit.domain] || {}, window);
    const remoteMs = remoteScreenTimeBucketTotal(usage.remoteBuckets, limit.domain, window);
    const totalMs = localMs + remoteMs;

    return {
      domain: limit.domain,
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
        totalMs: domains.reduce((total, domain) => total + screenTimeHourTotal(usage, domain, hour), 0)
      });
    }

    return totals;
  }

  function screenTimeDeviceTotals(usage, domains, window) {
    return [
      {
        label: "This Device",
        totalMs: domains.reduce((total, domain) => total + screenTimeBucketTotal(usage.localBuckets[domain] || {}, window), 0)
      },
      ...Object.values(usage.remoteBuckets).map((deviceBuckets, index) => ({
        label: `Other Device ${index + 1}`,
        totalMs: domains.reduce((total, domain) => total + screenTimeBucketTotal(deviceBuckets[domain] || {}, window), 0)
      }))
    ].filter((entry) => entry.totalMs > 0);
  }

  function screenTimeHourTotal(usage, domain, hour) {
    return screenTimeBucketValue(usage.localBuckets[domain] && usage.localBuckets[domain][String(hour)])
      + Object.values(usage.remoteBuckets).reduce((total, deviceBuckets) => (
        total + screenTimeBucketValue(deviceBuckets[domain] && deviceBuckets[domain][String(hour)])
      ), 0);
  }

  function remoteScreenTimeBucketTotal(remoteBuckets, domain, window) {
    return Object.values(remoteBuckets).reduce((total, deviceBuckets) => (
      total + screenTimeBucketTotal(deviceBuckets[domain] || {}, window)
    ), 0);
  }

  function screenTimeBucketTotal(buckets, window) {
    return Object.entries(buckets).reduce((total, [hour, bucket]) => {
      const bucketHour = Number(hour);

      if (bucketHour < window.startHour || bucketHour > window.endHour) {
        return total;
      }

      return total + screenTimeBucketValue(bucket);
    }, 0);
  }

  function screenTimeBucketValue(bucket) {
    if (bucket === undefined) {
      return 0;
    }

    return typeof bucket === "number" ? bucket : bucket.totalMs;
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

  function overLimitDomains(state, usage, nowMs) {
    return new Set(screenTimeEntries(state, usage, nowMs)
      .filter((entry) => entry.isOverLimit)
      .map((entry) => entry.domain));
  }

  function usageWindow(limitReset, nowMs) {
    const hour = Math.floor(nowMs / HOUR_MS);

    switch (limitReset.type) {
      case "rollingWindow":
        return { startHour: hour - limitReset.windowHours + 1, endHour: hour };
      case "daily":
        return { startHour: dailyResetHour(limitReset.resetHour, nowMs), endHour: hour };
      default:
        throw new Error(`Unknown limit reset type: ${limitReset.type}`);
    }
  }

  function dailyResetHour(resetHour, nowMs) {
    const reset = new Date(nowMs);

    reset.setHours(resetHour, 0, 0, 0);

    if (reset.getTime() > nowMs) {
      reset.setDate(reset.getDate() - 1);
    }

    return Math.floor(reset.getTime() / HOUR_MS);
  }

  function domainLimit(state, domain) {
    const limit = state.domainLimits.find((candidate) => candidate.domain === domain);

    if (!limit) {
      throw new Error(`Missing domain limit: ${domain}.`);
    }

    return limit;
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

  function createScreenTimeStorage(api) {
    const storage = createValueStorage(api, {
      key: SCREEN_TIME_USAGE_KEY,
      valueKey: "usage",
      loadType: "loadScreenTimeUsage",
      loadedType: "storedScreenTimeUsage",
      saveType: "saveScreenTimeUsage",
      savedType: "savedScreenTimeUsage",
      clearType: "clearScreenTimeUsage",
      clearedType: "clearedScreenTimeUsage"
    });

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
      savedType: "savedSettingsSync",
      clearType: "clearSettingsSync",
      clearedType: "clearedSettingsSync"
    });

    return {
      async loadSync() {
        return storage.loadValue();
      },
      async saveSync(settingsSync) {
        return storage.saveValue(settingsSync);
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
      savedType: "savedSupabaseSession",
      clearType: "clearSupabaseSession",
      clearedType: "clearedSupabaseSession"
    });

    return {
      async loadSession() {
        return storage.loadValue();
      },
      async saveSession(session) {
        return storage.saveValue(session);
      },
      async clearSession() {
        return storage.clearValue();
      }
    };
  }

  function createValueStorage(api, types) {
    const browserStorage = {
      async loadValue() {
        const stored = await api.storage.local.get(types.key);

        return stored[types.key];
      },
      async saveValue(value) {
        await api.storage.local.set({ [types.key]: value });

        return value;
      },
      async clearValue() {
        if (api.storage.local.remove) {
          await api.storage.local.remove(types.key);
          return;
        }

        await api.storage.local.set({ [types.key]: undefined });
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
      },
      async clearValue() {
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
    };

    return {
      async loadValue() {
        return (await usesNativeStorage(api)) ? nativeStorage.loadValue() : browserStorage.loadValue();
      },
      async saveValue(value) {
        return (await usesNativeStorage(api)) ? nativeStorage.saveValue(value) : browserStorage.saveValue(value);
      },
      async clearValue() {
        return (await usesNativeStorage(api)) ? nativeStorage.clearValue() : browserStorage.clearValue();
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
        controller.openOptions().catch((error) => console.error("URL Blocker could not open options.", errorResponse("error", error)));
      });
    }

    if (api.tabs.onUpdated) {
      api.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (typeof changeInfo.url !== "string") {
          return;
        }

        controller.redirectBlockedUrl(tabId, changeInfo.url)
          .catch((error) => console.error("URL Blocker could not redirect updated tab.", errorResponse("error", error)));
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
      .catch((error) => console.error("URL Blocker could not sync website access.", errorResponse("error", error)));
  }
})(globalThis);
