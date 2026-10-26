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
  let state = null;

  function call(fn) {
    try {
      return { type: "ok", value: fn() };
    } catch (error) {
      return { type: "error", message: `${error.message}\n${error.stack}` };
    }
  }

  // Invalid settings leave nothing blocked, matching what the status screen shows.
  function loadSettings(settingsText) {
    let rawState;
    state = null;

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

  // Credits elapsedMs to the app that was in front since the last step, then
  // decides whether the app in front now is blocked.
  function step(previousPackage, elapsedMs, foregroundPackage, nowMs) {
    if (state === null) {
      return { decision: { type: "noSettings" }, usage: null };
    }

    const screenTime = previousPackage === null ? { type: "none" } : core.screenTimeDomainForApp(state, previousPackage);
    const recorded = screenTime.type === "match" && elapsedMs > 0;

    if (recorded) {
      sync.addScreenTime(usage, screenTime.domain, Math.floor(nowMs / HOUR_MS), elapsedMs, nowMs);
    }

    return {
      decision: decision(foregroundPackage, nowMs),
      usage: recorded ? JSON.stringify(usage) : null
    };
  }

  function decision(packageName, nowMs) {
    const match = core.findBlockedApp(state, packageName, core.overLimitDomains(state, usage, nowMs), new Date(nowMs));

    switch (match.type) {
      case "none":
        return { type: "allowed", packageName };
      case "match":
        return { type: "blocked", packageName, reason: match.reason, blockedPageHtml: state.blockedPageHtml };
      default:
        throw new Error(`Unknown app match type: ${match.type}`);
    }
  }

  root.AndroidEngine = {
    start: (defaultsText, usageText) => call(() => {
      defaultEntries = JSON.parse(defaultsText);
      usage = sync.parseScreenTimeUsage(usageText === null ? undefined : JSON.parse(usageText), () => crypto.randomUUID(), core);
      return null;
    }),
    loadSettings: (settingsText) => call(() => loadSettings(settingsText)),
    step: (previousPackage, elapsedMs, foregroundPackage, nowMs) => call(() => step(previousPackage, elapsedMs, foregroundPackage, nowMs))
  };
})(globalThis);
