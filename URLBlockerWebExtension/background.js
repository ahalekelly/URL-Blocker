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
  // A stalled request would otherwise hold the settings queue, and every save
  // behind it, until the worker stops.
  const REQUEST_TIMEOUT_MS = 30 * 1000;
  const SCREEN_TIME_USAGE_KEY = "screenTimeUsage";
  const SETTINGS_SYNC_KEY = "settingsSync";
  const SETTINGS_ACTIVATION_KEY = "settingsActivation";
  const SUPABASE_SESSION_KEY = "supabaseSession";
  const COMMITTED_NAVIGATION_PREFIX = "committedNavigation:";
  const PAGE_PASS_PREFIX = "pagePasses:";
  const MAX_PAGE_PASSES = 100;
  // Chromium reports links opened from other apps as start_page.
  const OUTSIDE_TRANSITIONS = new Set(["link", "start_page", "form_submit"]);
  const ARRIVAL_PENDING = { type: "arrivalPending" };

  function createBackgroundController(api) {
    const stateStorage = createStateStorage(api);
    const settingsActivationStorage = createSettingsActivationStorage(api);
    const blockedPageHtmlStorage = createBlockedPageHtmlStorage(api);
    const screenTimeStorage = createScreenTimeStorage(api);
    const settingsSyncStorage = createSettingsSyncStorage(api);
    const sessionStorage = createSupabaseSessionStorage(api);
    // Per-tab memory lives in session storage because Safari and Chromium
    // stop the service worker when idle, such as while the phone is locked.
    const tabStorage = api.storage.session;
    // Settings saves and syncs read the sync metadata, wait on the network,
    // then write it back, so they run one at a time.
    const inSettingsQueue = createQueue();
    // Short read-modify-writes of screen time, page passes, and content
    // script registration. Tasks in it never wait on each other.
    const inLocalQueue = createQueue();
    let defaultEntriesLoad;
    let configPromise;
    // Settings and screen time sync separately, so one succeeding must not
    // hide the other's failure.
    const syncErrors = { settings: "", screenTime: "" };
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
        case "checkPage":
          requireKeys(message, ["type", "url", "arrival"], "checkPage message");
          return checkPage(message.url, message.arrival, sender);
        case "openBlockedTarget":
          requireKeys(message, ["type", "tabId", "url"], "openBlockedTarget message");
          return openBlockedTarget(message.tabId, message.url);
        case "screenTimeElapsed":
          requireKeys(message, ["type", "url", "elapsedMs"], "screenTimeElapsed message");
          return logScreenTime(message.url, message.elapsedMs, sender);
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

    function saveState(rawState) {
      return inSettingsQueue(async () => {
        const defaultEntries = await loadDefaultEntries();
        const result = core.validateState(rawState, defaultEntries);

        if (result.type === "invalid") {
          return { type: "validationError", errors: result.errors };
        }

        await requireWebsiteAccess(result.state);
        const currentActivation = await loadSettledSettingsActivation();
        const storageResponse = await stateStorage.saveState(result.state);
        const activation = await saveSettingsActivation(storageResponse.state, currentActivation);

        const settingsSync = await loadSettingsSync();

        await settingsSyncStorage.saveSync(sync.dirtySettingsSync(settingsSync, currentTimeMs(), createId));
        return { type: "saved", state: storageResponse.state, activation: settingsActivationStatus(activation) };
      });
    }

    async function finishSavedState() {
      const savedState = await syncSavedSettings();
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

    async function checkPage(rawUrl, arrival, sender) {
      if (!sender.tab || typeof sender.tab.id !== "number") {
        throw codedError("MissingSenderTab", "checkPage message must come from a tab.");
      }

      if (!isPlainObject(arrival)) {
        throw codedError("ArrivalInvalid", "Page arrival must be an object.");
      }

      switch (arrival.type) {
        case "history":
          requireKeys(arrival, ["type"], "Page arrival");
          return checkTabPage(sender.tab.id, rawUrl, { type: "arrival", from: { type: "inside" } });
        case "referrer":
          requireKeys(arrival, ["type", "url"], "Page arrival");

          if (typeof arrival.url !== "string") {
            throw codedError("ArrivalInvalid", "Page referrer must be a string.");
          }

          return checkTabPage(sender.tab.id, rawUrl, await contentArrival(sender.tab.id, rawUrl, arrival.url));
        default:
          throw codedError("ArrivalInvalid", `Unknown page arrival type: ${arrival.type}.`);
      }
    }

    // Chromium and iOS apps open some links without a referrer. Chromium's
    // committed transition tells those links apart from typed visits and
    // bookmarks; Safari has no transition, so an empty referrer counts as an
    // outside link there. The page can report before the commit is recorded,
    // in which case the commit decides.
    async function contentArrival(tabId, rawUrl, referrer) {
      if (referrer !== "") {
        return { type: "arrival", from: { type: "referrer", url: referrer } };
      }

      if (isSafariRuntime(api)) {
        return { type: "arrival", from: { type: "outside" } };
      }

      const committed = await loadTabValue(COMMITTED_NAVIGATION_PREFIX, tabId);

      if (committed === undefined || core.pageChangeKey(committed.url) !== core.pageChangeKey(rawUrl)) {
        return ARRIVAL_PENDING;
      }

      return { type: "arrival", from: { type: OUTSIDE_TRANSITIONS.has(committed.transitionType) ? "outside" : "inside" } };
    }

    // The block page opens its target through here so the target counts as
    // an arrival from inside the site, not as a referrer-less link.
    async function openBlockedTarget(tabId, rawUrl) {
      const result = await checkTabPage(tabId, rawUrl, { type: "arrival", from: { type: "inside" } });

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

    async function logScreenTime(rawUrl, elapsedMs, sender) {
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

      const state = await loadState();
      const match = core.screenTimeDomainForUrl(state, rawUrl);

      switch (match.type) {
        case "none":
          return { type: "ignored" };
        case "match":
          return saveScreenTimeAndSync(state, match.domain, elapsedMs);
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

    // A tab holding a pass for the page continues on it; anything else is a
    // new visit. Every allowed arrival gives the tab a pass for its page.
    async function checkTabPage(tabId, rawUrl, newVisit) {
      if (typeof tabId !== "number") {
        throw codedError("BlockedTabInvalid", "Blocked tab ID must be a number.");
      }

      if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
        throw codedError("BlockedUrlInvalid", "Blocked URL must be a string.");
      }

      const state = await loadState();
      const usage = await loadScreenTimeUsage();
      const passes = await loadTabValue(PAGE_PASS_PREFIX, tabId) || [];
      const visit = passes.includes(core.pageChangeKey(rawUrl)) ? { type: "continuing" } : newVisit;

      return applyDecision(tabId, rawUrl, visit, core.decidePage(state, rawUrl, visit, core.overLimitDomains(state, usage, currentTimeMs()), new Date()));
    }

    async function applyDecision(tabId, rawUrl, visit, decision) {
      switch (decision.type) {
        case "none":
          if (visit.type === "arrival") {
            await savePagePass(tabId, rawUrl);
          }

          return { type: "allowed", shortVideo: decision.shortVideo };
        case "match":
          await api.tabs.update(tabId, { url: blockedPageUrl(rawUrl, decision.reason) });
          return { type: "redirected" };
        case "singleVideoRedirect":
          await savePagePass(tabId, decision.url);
          await api.tabs.update(tabId, { url: decision.url });
          return { type: "redirected" };
        default:
          throw new Error(`Unknown page decision: ${decision.type}`);
      }
    }

    // A tab keeps a pass for every page it was allowed onto, so Back and
    // Forward return to them while other pages on the site stay blocked.
    function savePagePass(tabId, rawUrl) {
      return inLocalQueue(async () => {
        const passes = await loadTabValue(PAGE_PASS_PREFIX, tabId) || [];
        const page = core.pageChangeKey(rawUrl);

        if (!passes.includes(page)) {
          await tabStorage.set({ [`${PAGE_PASS_PREFIX}${tabId}`]: [...passes, page].slice(-MAX_PAGE_PASSES) });
        }
      });
    }

    // Before the request goes out, only feeds and the hard schedule can
    // block; outside-link pages wait for the commit or the page's referrer.
    async function redirectNavigationStart(details) {
      requireTopFrameDetails(details);

      if (details.frameId !== 0) {
        return { type: "ignored" };
      }

      return checkTabPage(details.tabId, details.url, ARRIVAL_PENDING);
    }

    async function redirectCommittedNavigation(details) {
      requireTopFrameDetails(details);

      if (typeof details.transitionType !== "string") {
        throw codedError("NavigationDetailsInvalid", "Committed navigation transition type must be a string.");
      }

      if (!Array.isArray(details.transitionQualifiers)) {
        throw codedError("NavigationDetailsInvalid", "Committed navigation transition qualifiers must be an array.");
      }

      if (details.frameId !== 0) {
        return { type: "ignored" };
      }

      await tabStorage.set({ [`${COMMITTED_NAVIGATION_PREFIX}${details.tabId}`]: { url: details.url, transitionType: details.transitionType } });

      // A reload keeps the page's original referrer, which the page reports,
      // so a restored tab is judged by how it was first opened.
      const pending = !details.transitionQualifiers.includes("forward_back")
        && (OUTSIDE_TRANSITIONS.has(details.transitionType) || details.transitionType === "reload");

      return checkTabPage(details.tabId, details.url, pending ? ARRIVAL_PENDING : { type: "arrival", from: { type: "inside" } });
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

      const continuing = { type: "continuing" };

      await Promise.all(tabs.map((tab) => {
        if (typeof tab.id !== "number" || typeof tab.url !== "string") {
          return undefined;
        }

        return applyDecision(tab.id, tab.url, continuing, core.decidePage(state, tab.url, continuing, limitedDomains, new Date()));
      }));
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
        return resetBlocklist(defaultEntries);
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
          .catch((error) => rememberSyncError("settings", error));
      }, Math.max(0, activation.pending.effectiveAtMs - currentTimeMs()));

      if (activationTimer && typeof activationTimer.unref === "function") {
        activationTimer.unref();
      }
    }

    // A site this device just put over its limit syncs at once so other
    // devices see it promptly.
    async function saveScreenTimeAndSync(state, domain, elapsedMs) {
      const nowMs = currentTimeMs();
      let wasOverLimit = false;
      const usage = await updateScreenTimeUsage((current) => {
        wasOverLimit = core.overLimitDomains(state, current, nowMs).has(domain);
        sync.addScreenTime(current, domain, currentHour(nowMs), elapsedMs, nowMs);
      });
      const isOverLimit = core.overLimitDomains(state, usage, nowMs).has(domain);

      await syncScreenTimeIfReady(state, { force: isOverLimit && !wasOverLimit });

      return { type: "logged", domain, isOverLimit };
    }

    function updateScreenTimeUsage(change) {
      return inLocalQueue(async () => {
        const usage = await loadScreenTimeUsage();

        await change(usage);
        await screenTimeStorage.saveUsage(usage);
        return usage;
      });
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

    // Overlapping calls would both unregister or both register the script,
    // and the browser rejects the second.
    function syncContentScripts(state) {
      return inLocalQueue(async () => {
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
      });
    }

    // Chromium orphans an updated or reloaded extension's content scripts, so
    // open pages, including long-lived single-page sites, would go unchecked
    // and untimed until they reload.
    async function injectContentScriptIntoOpenTabs() {
      const origins = core.contentScriptOriginsForState(await loadState());

      if (origins.length === 0) {
        return;
      }

      const tabs = await api.tabs.query({ url: origins, discarded: false });
      const results = await Promise.allSettled(tabs.map(async (tab) => {
        const target = { tabId: tab.id };

        await api.scripting.insertCSS({ target, files: CONTENT_SCRIPT_CSS });
        await api.scripting.executeScript({ target, files: CONTENT_SCRIPT_JS });
      }));
      const errors = results.filter((result) => result.status === "rejected").map((result) => errorMessage(result.reason));

      if (errors.length > 0) {
        throw codedError("ContentScriptInjectionFailed", `Could not inject into ${errors.length} open tabs: ${errors.join("; ")}`);
      }
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
          return { type: "syncStatus", status: "unconfigured", error: syncErrorText() };
        }

        const sessionResult = sync.parseSession(await sessionStorage.loadSession());

        if (sessionResult.type === "signedOut") {
          if (await usesNativeStorage(api)) {
            return { type: "syncStatus", status: "nativeSignInRequired", error: syncErrorText() };
          }

          return { type: "syncStatus", status: "signedOut", error: syncErrorText() };
        }

        const settingsSync = await loadSettingsSync();

        return {
          type: "syncStatus",
          status: "signedIn",
          userId: sync.sessionUserId(sessionResult.session),
          lastSuccessfulSyncAgeMs: lastSuccessfulSyncAgeMs(settingsSync),
          error: syncErrorText()
        };
      } catch (error) {
        return { type: "syncStatus", status: "error", error: errorMessage(error) };
      }
    }

    async function syncNow() {
      await syncSavedSettings();
      await syncScreenTimeIfReady(await loadState(), { force: true });

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

    // The next account's settings count as newer than the last account's,
    // unless this device has edits that never synced.
    async function signOut() {
      await inSettingsQueue(async () => {
        await sessionStorage.clearSession();

        if (!(await loadSettingsSync()).dirty) {
          await settingsSyncStorage.saveSync(sync.parseSettingsSync(undefined, createId));
        }
      });
      await updateScreenTimeUsage((usage) => {
        usage.remoteBuckets = {};
      });
      syncErrors.settings = "";
      syncErrors.screenTime = "";

      return { type: "signedOut" };
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

    function syncSavedSettings() {
      return inSettingsQueue(async () => syncSettingsIfPossible(await loadSavedState()));
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
          syncErrors.settings = "";
          return localState;
        }

        if (sync.remoteSettingsAreNewer(settingsSync, remoteSettings)) {
          // Awaited so the catch below records its errors.
          return await applyRemoteSettings(remoteSettings, settingsSync);
        }

        await settingsSyncStorage.saveSync(sync.cleanSettingsSync(settingsSync, remoteSettings, currentTimeMs()));
        syncErrors.settings = "";
        return localState;
      } catch (error) {
        rememberSyncError("settings", error);
        return localState;
      }
    }

    async function applyRemoteSettings(remoteSettings, settingsSync) {
      const defaultEntries = await loadDefaultEntries();
      const result = core.validateStoredState(remoteSettings.state, defaultEntries);

      if (result.type === "invalid") {
        throw codedError("RemoteSettingsInvalid", result.errors.map((error) => error.message).join("\n"));
      }

      const currentActivation = await loadSettledSettingsActivation();

      await stateStorage.saveState(result.state);
      const activation = await saveSettingsActivation(result.state, currentActivation);
      await settingsSyncStorage.saveSync(sync.cleanSettingsSync(settingsSync, remoteSettings, currentTimeMs()));
      await syncWebsiteAccessForKnownPermissions(activation.activeState);
      syncErrors.settings = "";

      return result.state;
    }

    // The defaults count as never synced, so the account's settings replace
    // them instead of the defaults replacing the account's.
    async function resetBlocklist(defaultEntries) {
      const state = core.emptyState(defaultEntries);

      await stateStorage.saveState(state);
      await settingsActivationStorage.saveActivation(core.activeSettingsActivation(state));
      await blockedPageHtmlStorage.saveHtml(state.blockedPageHtml);
      await settingsSyncStorage.saveSync(sync.parseSettingsSync(undefined, createId));
      await syncWebsiteAccessForKnownPermissions(state);
      await redirectOpenBlockedTabs(state);
      await removeUnusedWebsiteAccessForStates([state]);

      return state;
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
        rememberSyncError("screenTime", error);
        return undefined;
      });

      if (!config) {
        return;
      }

      const syncAgeMs = config.screenTimeSyncAgeMs || sync.SCREEN_TIME_SYNC_AGE_MS;

      if (!options.force && !sync.shouldSyncScreenTime(usage, currentTimeMs(), syncAgeMs)) {
        scheduleScreenTimeSync(state, usage, syncAgeMs);
        return;
      }

      try {
        const active = await activeSupabaseSession(config);

        if (active.type !== "active") {
          return;
        }

        const dirtyBuckets = sync.dirtyScreenTimeBuckets(usage);
        const syncedBuckets = dirtyBuckets.length === 0
          ? []
          : sync.normalizeSyncedScreenTimeRows(await sync.saveRemoteScreenTime(active.config, active.session, dirtyBuckets, fetchJson), core);
        const remoteRows = await sync.loadRemoteScreenTime(active.config, active.session, core.usageWindow(state.limitReset, currentTimeMs()), fetchJson);

        const userId = sync.sessionUserId(active.session);

        // Pages log time while the requests run, so the results apply to the
        // stored usage rather than to the copy read before them. A sign-out
        // meanwhile already cleared the account's buckets.
        await updateScreenTimeUsage(async (current) => {
          const session = sync.parseSession(await sessionStorage.loadSession());

          if (session.type === "signedOut" || sync.sessionUserId(session.session) !== userId) {
            return;
          }

          sync.markScreenTimeSynced(current, syncedBuckets);
          sync.mergeRemoteScreenTimeBuckets(current, sync.normalizeRemoteScreenTimeRows(remoteRows, core));
        });
        await inSettingsQueue(async () => markSyncSuccessful(await loadSettingsSync()));
        syncErrors.screenTime = "";
      } catch (error) {
        rememberSyncError("screenTime", error);
      }
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
          .catch((error) => rememberSyncError("screenTime", error));
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
      return sync.parseSettingsSync(await settingsSyncStorage.loadSync(), createId);
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
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

      if (!response.ok) {
        throw codedError(`HTTP ${response.status}`, sync.supabaseErrorMessage(response.status, await response.text()));
      }

      return response.json();
    }

    function syncErrorText() {
      return [syncErrors.settings, syncErrors.screenTime].filter((error) => error !== "").join("\n");
    }

    function rememberSyncError(kind, error) {
      syncErrors[kind] = errorMessage(error);
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

    async function loadTabValue(prefix, tabId) {
      const key = `${prefix}${tabId}`;
      const stored = await tabStorage.get(key);

      return stored[key];
    }

    async function forgetTab(tabId) {
      await tabStorage.remove([`${COMMITTED_NAVIGATION_PREFIX}${tabId}`, `${PAGE_PASS_PREFIX}${tabId}`]);
    }

    return {
      forgetTab,
      getLocalScreenTimeLog,
      getBlockedPageHtml,
      getLocalState,
      getLocalScreenTimeStats,
      getScreenTimeLog,
      getScreenTimeStats,
      getDefaultState,
      handleMessage,
      injectContentScriptIntoOpenTabs,
      loadState,
      logScreenTime,
      openOptions,
      checkTabPage,
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

  function createQueue() {
    let tail = Promise.resolve();

    return (task) => {
      const run = tail.then(task);

      tail = run.catch(() => {});
      return run;
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

    if (!isSafariRuntime(api)) {
      api.runtime.onInstalled.addListener(({ reason }) => {
        if (reason !== "install" && reason !== "update") {
          return;
        }

        controller.injectContentScriptIntoOpenTabs()
          .catch((error) => console.error(`URL Blocker could not check open tabs. ${errorLogText(error)}`));
      });
    }

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

        controller.checkTabPage(tabId, changeInfo.url, ARRIVAL_PENDING)
          .catch((error) => console.error(`URL Blocker could not redirect updated tab. ${errorLogText(error)}`));
      });
    }

    if (api.tabs.onRemoved) {
      api.tabs.onRemoved.addListener((tabId) => {
        controller.forgetTab(tabId)
          .catch((error) => console.error(`URL Blocker could not forget a closed tab. ${errorLogText(error)}`));
      });
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
