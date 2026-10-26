// Bridge between BlockerService and BlockerCore. Each call returns
// { type: "ok", value } or { type: "error", message } so the service can fail
// loudly on exceptions, which evaluateJavascript would otherwise turn into null.
(function loadAndroidEngine(root) {
  "use strict";

  const core = root.BlockerCore;
  const sync = root.SupabaseSync;
  const HOUR_MS = 60 * 60 * 1000;
  let defaultEntries;
  let usage;
  let usageDirty = false;
  let state = null;

  function call(fn) {
    try {
      return { type: "ok", value: fn() };
    } catch (error) {
      return { type: "error", message: `${error.message}\n${error.stack}` };
    }
  }

  // Like the extension, unreadable or outdated usage starts over.
  function loadUsage(usageText) {
    if (usageText === null) {
      return sync.emptyScreenTimeUsage(crypto.randomUUID());
    }

    try {
      return sync.parseScreenTimeUsage(JSON.parse(usageText), () => crypto.randomUUID(), core);
    } catch (error) {
      if (!(error instanceof SyntaxError) && !sync.isUnsupportedScreenTimeUsage(error)) {
        throw error;
      }

      usageDirty = true;
      return sync.emptyScreenTimeUsage(crypto.randomUUID());
    }
  }

  // A missing or invalid settings file leaves nothing blocked, matching what
  // the status screen shows.
  function loadSettings(settingsText) {
    state = null;

    if (settingsText === null) {
      return { type: "missing" };
    }

    let rawState;

    try {
      rawState = JSON.parse(settingsText);
    } catch (error) {
      return { type: "invalid", message: `Settings are not valid JSON: ${error.message}` };
    }

    const result = core.validateStoredState(rawState, defaultEntries);

    switch (result.type) {
      case "valid":
        state = result.state;
        return { type: "valid" };
      case "invalid":
        return { type: "invalid", message: result.errors.map((error) => error.message).join("\n") };
      default:
        throw new Error(`Unknown settings validation result: ${result.type}`);
    }
  }

  // Credits elapsedMs to the sites of the apps that were visible since the
  // last step, then decides whether any app visible now is blocked.
  function step(countedPackages, elapsedMs, visiblePackages, nowMs) {
    if (state === null) {
      return { type: "noSettings" };
    }

    const domains = new Set(countedPackages
      .map((packageName) => core.screenTimeDomainForApp(state, packageName))
      .filter((match) => match.type === "match")
      .map((match) => match.domain));

    if (elapsedMs > 0) {
      domains.forEach((domain) => sync.addScreenTime(usage, domain, Math.floor(nowMs / HOUR_MS), elapsedMs, nowMs));
      usageDirty = usageDirty || domains.size > 0;
    }

    const overLimit = core.overLimitDomains(state, usage, nowMs);

    for (const packageName of visiblePackages) {
      const match = core.findBlockedApp(state, packageName, overLimit, new Date(nowMs));

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

  function takeDirtyUsage() {
    if (!usageDirty) {
      return null;
    }

    usageDirty = false;
    return JSON.stringify(usage);
  }

  root.AndroidEngine = {
    start: (defaultsText, usageText) => call(() => {
      defaultEntries = JSON.parse(defaultsText);
      usage = loadUsage(usageText);
      return null;
    }),
    loadSettings: (settingsText) => call(() => loadSettings(settingsText)),
    step: (countedPackages, elapsedMs, visiblePackages, nowMs) => call(() => step(countedPackages, elapsedMs, visiblePackages, nowMs)),
    takeDirtyUsage: () => call(takeDirtyUsage)
  };
})(globalThis);
