// Bridge between BlockerService and BlockerCore. Each call returns
// { type: "ok", value } or { type: "error", message } so the service can fail
// loudly on exceptions, which evaluateJavascript would otherwise turn into null.
// Sync runs in the background and reports through AndroidHost.syncStatus.
// AndroidHost reads and writes files in the app's private storage; a
// missing file reads as undefined, which is how the bridge passes Java null.
(function loadAndroidEngine(root) {
  "use strict";

  const core = root.BlockerCore;
  const sync = root.SupabaseSync;
  const host = root.AndroidHost;
  const HOUR_MS = 60 * 60 * 1000;
  const USAGE_FILE = "screen-time-usage.json";
  const ACTIVATION_FILE = "settings-activation.json";
  const SETTINGS_SYNC_FILE = "settings-sync.json";
  const SESSION_FILE = "supabase-session.json";
  let config;
  let defaultEntries;
  let usage;
  let usageDirty = false;
  let activation;
  let settingsSync;
  let account;
  let overLimit = new Set();
  let syncing = false;
  let lastSyncStartMs = 0;
  let syncError = "";

  function call(fn) {
    try {
      const value = fn();
      return { type: "ok", value: value === undefined ? null : value };
    } catch (error) {
      return { type: "error", message: `${error.message}\n${error.stack}` };
    }
  }

  function readJson(name) {
    const text = host.read(name);
    return text === undefined ? undefined : JSON.parse(text);
  }

  function writeJson(name, value) {
    host.write(name, JSON.stringify(value));
  }

  function start(configText, defaultsText) {
    config = sync.parseConfig(JSON.parse(configText));
    defaultEntries = JSON.parse(defaultsText);
    usage = loadUsage();
    activation = loadActivation();
    // A device that has never synced takes any remote settings as newer.
    settingsSync = sync.parseSettingsSync(readJson(SETTINGS_SYNC_FILE), () => crypto.randomUUID(), 0);
    const sessionResult = sync.parseSession(readJson(SESSION_FILE));
    account = sessionResult.type === "session" ? signedIn(sessionResult.session) : { type: "signedOut" };
    reportStatus();
  }

  // Like the extension, unreadable or outdated usage starts over.
  function loadUsage() {
    const text = host.read(USAGE_FILE);

    if (text === undefined) {
      return sync.emptyScreenTimeUsage(crypto.randomUUID());
    }

    try {
      return sync.parseScreenTimeUsage(JSON.parse(text), () => crypto.randomUUID(), core);
    } catch (error) {
      if (!(error instanceof SyntaxError) && !sync.isUnsupportedScreenTimeUsage(error)) {
        throw error;
      }

      usageDirty = true;
      return sync.emptyScreenTimeUsage(crypto.randomUUID());
    }
  }

  // Like the extension, a device with no settings yet uses the defaults.
  function loadActivation() {
    const raw = readJson(ACTIVATION_FILE);

    if (raw === undefined) {
      return core.activeSettingsActivation(core.emptyState(defaultEntries));
    }

    const result = core.validateSettingsActivation(raw, defaultEntries);

    if (result.type === "invalid") {
      throw new Error(`Stored settings are invalid: ${result.errors.map((error) => error.message).join("\n")}`);
    }

    return result.activation;
  }

  function signedIn(session) {
    return { type: "signedIn", session, email: sync.sessionEmail(session) };
  }

  function settleActivation(nowMs) {
    const result = core.settleSettingsActivation(activation, nowMs);

    switch (result.type) {
      case "unchanged":
        return;
      case "activated":
        activation = result.activation;
        writeJson(ACTIVATION_FILE, activation);
        reportStatus();
        return;
      default:
        throw new Error(`Unknown settings activation result: ${result.type}`);
    }
  }

  // Credits elapsedMs to the sites of the apps that were visible since the
  // last step, then decides whether any app visible now is blocked. A site
  // this device just put over its limit syncs at once so other devices see it
  // promptly.
  function step(countedPackages, elapsedMs, visiblePackages, nowMs) {
    settleActivation(nowMs);
    const state = activation.activeState;
    const domains = new Set(countedPackages
      .map((packageName) => core.screenTimeDomainForApp(state, packageName))
      .filter((match) => match.type === "match")
      .map((match) => match.domain));

    if (elapsedMs > 0) {
      domains.forEach((domain) => sync.addScreenTime(usage, domain, Math.floor(nowMs / HOUR_MS), elapsedMs, nowMs));
      usageDirty = usageDirty || domains.size > 0;
    }

    const nowOverLimit = core.overLimitDomains(state, usage, nowMs);

    if ([...domains].some((domain) => nowOverLimit.has(domain) && !overLimit.has(domain))) {
      startSync(true);
    }

    overLimit = nowOverLimit;

    for (const packageName of visiblePackages) {
      const match = core.findBlockedApp(state, packageName, nowOverLimit, new Date(nowMs));

      switch (match.type) {
        case "none":
          continue;
        case "match":
          return { type: "blocked", packageName, reason: match.reason, reasonText: core.blockedReasonText(match.reason), blockedPageHtml: state.blockedPageHtml };
        default:
          throw new Error(`Unknown app match type: ${match.type}`);
      }
    }

    return { type: "allowed", packages: visiblePackages };
  }

  function persist() {
    if (!usageDirty) {
      return;
    }

    usageDirty = false;
    writeJson(USAGE_FILE, usage);
  }

  // Syncs at most once per screenTimeSyncAgeMs unless forced.
  function startSync(force) {
    if (account.type === "signedOut" || syncing || (!force && Date.now() - lastSyncStartMs < config.screenTimeSyncAgeMs)) {
      return;
    }

    syncing = true;
    lastSyncStartMs = Date.now();
    syncAccount(account)
      .then(() => {
        syncError = "";
      })
      .catch((error) => {
        syncError = error.message;
        console.error(`URL Blocker sync failed. ${error.stack}`);
      })
      .finally(() => {
        syncing = false;
        reportStatus();
      });
  }

  // Pushes this device's screen time, pulls other devices' and pulls
  // settings. This device never edits settings, so it never pushes them.
  // Signing in or out mid-sync drops the rest of the sync.
  async function syncAccount(startAccount) {
    let session = startAccount.session;

    if (sync.sessionNeedsRefresh(session, Date.now())) {
      session = await sync.refreshSession(config, session, fetchJson);

      if (account !== startAccount) {
        return;
      }

      account = { ...account, session };
      startAccount = account;
      writeJson(SESSION_FILE, session);
    }

    const dirtyBuckets = sync.dirtyScreenTimeBuckets(usage);

    if (dirtyBuckets.length > 0) {
      const savedBuckets = await sync.saveRemoteScreenTime(config, session, dirtyBuckets, fetchJson);
      sync.markScreenTimeSynced(usage, sync.normalizeSyncedScreenTimeRows(savedBuckets, core));
      usageDirty = true;
    }

    const window = core.usageWindow(activation.activeState.limitReset, Date.now());
    const remoteRows = await sync.loadRemoteScreenTime(config, session, window, fetchJson);

    if (account !== startAccount) {
      return;
    }

    sync.mergeRemoteScreenTimeBuckets(usage, sync.normalizeRemoteScreenTimeRows(remoteRows, core));
    usageDirty = true;
    const remoteSettings = await sync.loadRemoteSettings(config, session, fetchJson);

    if (account !== startAccount) {
      return;
    }

    if (remoteSettings && sync.remoteSettingsAreNewer(settingsSync, remoteSettings)) {
      applyRemoteSettings(remoteSettings);
    }

    settingsSync = sync.markSuccessfulSync(settingsSync, Date.now());
    writeJson(SETTINGS_SYNC_FILE, settingsSync);
  }

  // Synced settings wait out the active settings delay, like in the extension.
  function applyRemoteSettings(remoteSettings) {
    const result = core.validateStoredState(remoteSettings.state, defaultEntries);

    if (result.type === "invalid") {
      throw new Error(`Synced settings are invalid: ${result.errors.map((error) => error.message).join("\n")}`);
    }

    const nowMs = Date.now();
    settleActivation(nowMs);
    activation = core.pendingSettingsActivation(activation, result.state, nowMs);
    writeJson(ACTIVATION_FILE, activation);
    settingsSync = sync.cleanSettingsSync(settingsSync, remoteSettings, nowMs);
    writeJson(SETTINGS_SYNC_FILE, settingsSync);
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(sync.supabaseErrorMessage(response.status, await response.text()));
    }

    return response.json();
  }

  function signInUrl() {
    return sync.oauthUrl(config, "google", `${config.redirectScheme}://supabase-auth`);
  }

  // The redirect URL comes from outside the app, so a bad one is shown as a
  // sync error rather than thrown. A sync already running for the previous
  // account stops, and the next tick syncs the new one.
  function completeSignIn(url) {
    try {
      account = signedIn(sync.sessionFromOAuthRedirect(url, Date.now()));
    } catch (error) {
      syncError = `Sign-in failed: ${error.message}`;
      reportStatus();
      return;
    }

    writeJson(SESSION_FILE, account.session);
    syncError = "";
    lastSyncStartMs = 0;
    startSync(true);
    reportStatus();
  }

  function signOut() {
    account = { type: "signedOut" };
    host.remove(SESSION_FILE);
    usage.remoteBuckets = {};
    usageDirty = true;
    syncError = "";
    reportStatus();
  }

  function reportStatus() {
    host.syncStatus(JSON.stringify({
      email: account.type === "signedIn" ? account.email : null,
      lastSyncMs: settingsSync.lastSuccessfulSyncMs,
      error: syncError,
      pendingSettingsAtMs: activation.pending.type === "pending" ? activation.pending.effectiveAtMs : null
    }));
  }

  root.AndroidEngine = {
    start: (configText, defaultsText) => call(() => start(configText, defaultsText)),
    step: (countedPackages, elapsedMs, visiblePackages, nowMs) => call(() => step(countedPackages, elapsedMs, visiblePackages, nowMs)),
    persist: () => call(persist),
    sync: (force) => call(() => startSync(force)),
    signInUrl: () => call(signInUrl),
    completeSignIn: (url) => call(() => completeSignIn(url)),
    signOut: () => call(signOut)
  };
})(globalThis);
