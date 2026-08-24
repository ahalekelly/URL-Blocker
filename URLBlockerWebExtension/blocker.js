(function loadBlockerCore(root) {
  "use strict";

  const STATE_KEY = "blockerState";
  const BLOCKED_PAGE_HTML_KEY = "blockedPageHtml";
  const SCHEMA_VERSION = 17;
  const LEGACY_SCHEMA_VERSION = 6;
  const SUBREDDIT_SCHEMA_VERSION = 7;
  const LIMIT_RESET_SCHEMA_VERSION = 8;
  const FACEBOOK_HOME_SCHEMA_VERSION = 9;
  const SOCIAL_DEFAULTS_SCHEMA_VERSION = 10;
  const SETTINGS_DELAY_SCHEMA_VERSION = 11;
  const SETTINGS_DELAY_MODE_SCHEMA_VERSION = 12;
  const YOUTUBE_SUBSCRIPTIONS_SCHEMA_VERSION = 13;
  const URL_SUBPATH_DEFAULTS_SCHEMA_VERSION = 14;
  const DOMAIN_NAVIGATION_SETTINGS_SCHEMA_VERSION = 15;
  const HARD_SCHEDULE_SCHEMA_VERSION = 16;
  const SUBREDDIT_FEEDS_VALUE = "reddit.com/r/*";
  const YOUTUBE_SUBSCRIPTIONS_VALUE = "youtube.com/feed/subscriptions";
  const YOUTUBE_SHORTS_VALUE = "youtube.com/shorts";
  const ADDED_DEFAULT_PARENT_VALUES = new Map([
    [SUBREDDIT_FEEDS_VALUE, "reddit.com"],
    [YOUTUBE_SUBSCRIPTIONS_VALUE, "youtube.com"],
    [YOUTUBE_SHORTS_VALUE, "youtube.com"]
  ]);
  const REMOVED_DEFAULT_IDS = new Set([
    "10000000-0000-4000-8000-000000000012",
    "10000000-0000-4000-8000-000000000016",
    "10000000-0000-4000-8000-000000000019"
  ]);
  const MAX_ENTRIES = 1000;
  const MAX_BLOCKED_PAGE_HTML_LENGTH = 4000;
  const DEFAULT_LIMIT_MINUTES = 30;
  const DEFAULT_BLOCK_DIRECT_VISITS = true;
  const DEFAULT_BLOCK_INTERNAL_LINKS = true;
  const MAX_LIMIT_MINUTES = 960;
  const MAX_ROLLING_WINDOW_HOURS = 168;
  const DEFAULT_SETTINGS_DELAY_MINUTES = 60;
  const MAX_SETTINGS_DELAY_MINUTES = 10080;
  const DEFAULT_BLOCKED_PAGE_HTML = "<h1>Blocked</h1><p>This page is on your blocklist.</p>";
  const DEFAULT_SCHEDULE = { type: "dailyWindow", startMinute: 1380, endMinute: 1140 };
  const DEFAULT_HARD_SCHEDULE = { type: "off" };
  const DEFAULT_LIMIT_RESET = { type: "rollingWindow", windowHours: 24 };
  const DEFAULT_SETTINGS_DELAY = { delayMinutes: DEFAULT_SETTINGS_DELAY_MINUTES };
  const UNSUPPORTED_BLOCKLIST_VERSION_MESSAGE = "Unsupported blocklist version. Reset the blocklist to repair it.";
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const URL_ALIASES = [
    { type: "exact", source: "x.com/home", target: "x.com" },
    { type: "exact", source: "twitter.com", target: "x.com" },
    { type: "exact", source: "twitter.com/home", target: "x.com" },
    { type: "exact", source: "tiktok.com/foryou", target: "tiktok.com" },
    { type: "exact", source: "ycombinator.com/news", target: "ycombinator.com" },
    { type: "exact", source: "linkedin.com/feed", target: "linkedin.com" },
    { type: "exact", source: "facebook.com/home.php", target: "facebook.com" },
    {
      type: "pathRegex",
      host: "reddit.com",
      pathPattern: /^\/r\/[a-z0-9_]+(?:\/(?:hot|new|top|rising|controversial))?$/i,
      target: SUBREDDIT_FEEDS_VALUE
    }
  ];
  const KIND_LABELS = {
    url: "URL",
    urlWithSubpaths: "URL and subpaths",
    domain: "Full domain",
    regex: "Custom regex"
  };
  const EDITABLE_KIND_LABELS = {
    url: "URL",
    urlWithSubpaths: "URL and subpaths",
    domain: "Full domain",
    regex: "Custom regex"
  };

  function emptyState(defaultEntries) {
    const entries = normalizeDefaultEntries(defaultEntries);
    const result = validateState({
      schemaVersion: SCHEMA_VERSION,
      entries,
      blockedPageHtml: DEFAULT_BLOCKED_PAGE_HTML,
      schedule: DEFAULT_SCHEDULE,
      hardSchedule: DEFAULT_HARD_SCHEDULE,
      limitReset: DEFAULT_LIMIT_RESET,
      settingsDelay: DEFAULT_SETTINGS_DELAY,
      domainLimits: domainLimitsForEntries(entries, [])
    }, entries);

    if (result.type === "invalid") {
      throw new Error(result.errors.map((error) => error.message).join("\n"));
    }

    return result.state;
  }

  function newEntry(kind) {
    if (!Object.hasOwn(KIND_LABELS, kind)) {
      throw new Error(`Unknown matcher kind: ${kind}`);
    }

    return { type: "custom", id: crypto.randomUUID(), kind, value: "" };
  }

  function validateState(rawState, defaultEntries) {
    const defaultCatalog = defaultEntryCatalog(defaultEntries);
    const errors = [];

    if (!isPlainObject(rawState)) {
      return invalid([{ index: null, message: "Blocklist data must be an object." }]);
    }

    if (rawState.schemaVersion !== SCHEMA_VERSION) {
      errors.push({ index: null, message: UNSUPPORTED_BLOCKLIST_VERSION_MESSAGE });
    }

    pushUnknownKeyErrors(errors, rawState, stateKeys(rawState.schemaVersion), "Blocklist");

    if (!Array.isArray(rawState.entries)) {
      errors.push({ index: null, message: "Blocklist entries must be an array." });
    }

    if (typeof rawState.blockedPageHtml !== "string") {
      errors.push({ index: null, message: "Blocked page HTML must be a string." });
    }

    if (!isPlainObject(rawState.schedule)) {
      errors.push({ index: null, message: "Schedule must be an object." });
    }

    if (!isPlainObject(rawState.hardSchedule)) {
      errors.push({ index: null, message: "Hard schedule must be an object." });
    }

    if (!isPlainObject(rawState.limitReset)) {
      errors.push({ index: null, message: "Limit reset must be an object." });
    }

    if (!isPlainObject(rawState.settingsDelay)) {
      errors.push({ index: null, message: "Settings delay must be an object." });
    }

    if (!Array.isArray(rawState.domainLimits)) {
      errors.push({ index: null, message: "Domain limits must be an array." });
    }

    if (errors.length > 0) {
      return invalid(errors);
    }

    let blockedPageHtml = "";
    let schedule = DEFAULT_SCHEDULE;
    let hardSchedule = DEFAULT_HARD_SCHEDULE;
    let limitReset = DEFAULT_LIMIT_RESET;
    let settingsDelay = DEFAULT_SETTINGS_DELAY;

    try {
      blockedPageHtml = normalizeBlockedPageHtml(rawState.blockedPageHtml);
    } catch (error) {
      errors.push({ index: null, message: error.message });
    }

    const scheduleResult = normalizeSchedule(rawState.schedule);

    if (scheduleResult.type === "invalid") {
      errors.push(...scheduleResult.errors);
    } else {
      schedule = scheduleResult.schedule;
    }

    const hardScheduleResult = normalizeHardSchedule(rawState.hardSchedule);

    if (hardScheduleResult.type === "invalid") {
      errors.push(...hardScheduleResult.errors);
    } else {
      hardSchedule = hardScheduleResult.schedule;
    }

    const limitResetResult = normalizeLimitReset(rawState.limitReset);

    if (limitResetResult.type === "invalid") {
      errors.push(...limitResetResult.errors);
    } else {
      limitReset = limitResetResult.limitReset;
    }

    const settingsDelayResult = normalizeSettingsDelay(rawState.settingsDelay);

    if (settingsDelayResult.type === "invalid") {
      errors.push(...settingsDelayResult.errors);
    } else {
      settingsDelay = settingsDelayResult.settingsDelay;
    }

    if (rawState.entries.length > MAX_ENTRIES) {
      errors.push({ index: null, message: `Blocklist is limited to ${MAX_ENTRIES} entries.` });
    }

    const entries = [];
    const seen = new Set();
    const seenDefaultIds = new Set();

    rawState.entries.forEach((entry, index) => {
      const result = normalizeEntry(entry, index, defaultCatalog);

      if (result.type === "invalid") {
        errors.push(...result.errors);
        return;
      }

      if (result.entry.type === "default") {
        if (seenDefaultIds.has(result.entry.id)) {
          errors.push({ index, message: "Duplicate default entry." });
          return;
        }

        seenDefaultIds.add(result.entry.id);
      }

      const duplicateKey = `${result.entry.kind}:${result.entry.value.toLowerCase()}`;

      if (seen.has(duplicateKey)) {
        if (rawState.schemaVersion < SCHEMA_VERSION && result.aliased) {
          return;
        }

        errors.push({ index, message: "Duplicate entry after normalization." });
        return;
      }

      seen.add(duplicateKey);
      entries.push(result.entry);
    });

    defaultCatalog.entries.forEach((entry) => {
      if (seenDefaultIds.has(entry.id)) {
        return;
      }

      errors.push({ index: null, message: `Missing default entry: ${entry.value}.` });
    });

    if (errors.length > 0) {
      return invalid(errors);
    }

    const limitsResult = normalizeDomainLimits(rawState.domainLimits, entries);

    if (limitsResult.type === "invalid") {
      errors.push(...limitsResult.errors);
    }

    if (errors.length > 0) {
      return invalid(errors);
    }

    return {
      type: "valid",
      state: {
        schemaVersion: SCHEMA_VERSION,
        entries,
        blockedPageHtml,
        schedule,
        hardSchedule,
        limitReset,
        settingsDelay,
        domainLimits: limitsResult.domainLimits
      }
    };
  }

  function validateStoredState(rawState, defaultEntries) {
    return validateState(migrateStoredState(rawState, defaultEntries), defaultEntries);
  }

  function hasUnsupportedBlocklistVersion(errors) {
    return errors.some((error) => error.message === UNSUPPORTED_BLOCKLIST_VERSION_MESSAGE);
  }

  function migrateStoredState(rawState, defaultEntries) {
    if (!isPlainObject(rawState) || ![
      LEGACY_SCHEMA_VERSION,
      SUBREDDIT_SCHEMA_VERSION,
      LIMIT_RESET_SCHEMA_VERSION,
      FACEBOOK_HOME_SCHEMA_VERSION,
      SOCIAL_DEFAULTS_SCHEMA_VERSION,
      SETTINGS_DELAY_SCHEMA_VERSION,
      SETTINGS_DELAY_MODE_SCHEMA_VERSION,
      SCHEMA_VERSION,
      HARD_SCHEDULE_SCHEMA_VERSION,
      DOMAIN_NAVIGATION_SETTINGS_SCHEMA_VERSION,
      URL_SUBPATH_DEFAULTS_SCHEMA_VERSION,
      YOUTUBE_SUBSCRIPTIONS_SCHEMA_VERSION
    ].includes(rawState.schemaVersion) || !Array.isArray(rawState.entries)) {
      return rawState;
    }

    const migratedState = storedStateWithCurrentShape(rawState);
    const defaultCatalog = defaultEntryCatalog(defaultEntries);
    const seenDefaultIds = new Set();
    const entries = rawState.entries.flatMap((entry) => {
      if (!isPlainObject(entry) || typeof entry.id !== "string") {
        return [entry];
      }

      if (REMOVED_DEFAULT_IDS.has(entry.id.toLowerCase())) {
        return [];
      }

      const defaultEntry = defaultCatalog.byId.get(entry.id.toLowerCase());

      if (!defaultEntry) {
        if (rawState.schemaVersion !== LEGACY_SCHEMA_VERSION) {
          return [entry];
        }

        return [{ type: "custom", id: entry.id, kind: entry.kind, value: entry.value }];
      }

      seenDefaultIds.add(defaultEntry.id);

      if (rawState.schemaVersion !== LEGACY_SCHEMA_VERSION) {
        return [{ ...defaultEntry, enabled: entry.enabled }];
      }

      return [{ ...defaultEntry, enabled: true }];
    });

    defaultCatalog.entries.forEach((entry) => {
      if (seenDefaultIds.has(entry.id)) {
        return;
      }

      entries.push({ ...entry, enabled: enabledForAddedDefault(entry, entries) });
    });

    return {
      ...migratedState,
      schemaVersion: SCHEMA_VERSION,
      entries,
      domainLimits: domainLimitsForEntries(entries, Array.isArray(rawState.domainLimits) ? rawState.domainLimits : [])
    };
  }

  function storedStateWithCurrentShape(rawState) {
    switch (rawState.schemaVersion) {
      case SCHEMA_VERSION:
        return rawState;
      case HARD_SCHEDULE_SCHEMA_VERSION:
      case DOMAIN_NAVIGATION_SETTINGS_SCHEMA_VERSION:
      case URL_SUBPATH_DEFAULTS_SCHEMA_VERSION:
      case YOUTUBE_SUBSCRIPTIONS_SCHEMA_VERSION:
        return { ...rawState, hardSchedule: DEFAULT_HARD_SCHEDULE };
      case SETTINGS_DELAY_MODE_SCHEMA_VERSION:
        return { ...rawState, hardSchedule: DEFAULT_HARD_SCHEDULE, settingsDelay: migrateSettingsDelay(rawState.settingsDelay) };
      case SETTINGS_DELAY_SCHEMA_VERSION:
        return { ...rawState, hardSchedule: DEFAULT_HARD_SCHEDULE, settingsDelay: DEFAULT_SETTINGS_DELAY };
      case LEGACY_SCHEMA_VERSION:
      case SUBREDDIT_SCHEMA_VERSION:
      case LIMIT_RESET_SCHEMA_VERSION:
      case FACEBOOK_HOME_SCHEMA_VERSION:
      case SOCIAL_DEFAULTS_SCHEMA_VERSION:
        return { ...rawState, hardSchedule: DEFAULT_HARD_SCHEDULE, limitReset: DEFAULT_LIMIT_RESET, settingsDelay: DEFAULT_SETTINGS_DELAY };
      default:
        throw new Error(`Unknown migratable schema version: ${rawState.schemaVersion}`);
    }
  }

  function migrateSettingsDelay(settingsDelay) {
    if (!isPlainObject(settingsDelay) || typeof settingsDelay.type !== "string") {
      return settingsDelay;
    }

    switch (settingsDelay.type) {
      case "immediate":
        return { delayMinutes: 0 };
      case "delayed":
        return { delayMinutes: settingsDelay.delayMinutes };
      default:
        return settingsDelay;
    }
  }

  function enabledForAddedDefault(entry, entries) {
    const parentValue = ADDED_DEFAULT_PARENT_VALUES.get(entry.value);

    if (!parentValue) {
      return false;
    }

    const parentEntry = entries.find((candidate) => candidate.type === "default" && candidate.value === parentValue);

    return parentEntry ? parentEntry.enabled : false;
  }

  function normalizeDefaultEntries(defaultEntries) {
    if (!Array.isArray(defaultEntries)) {
      throw new Error("Default entries must be an array.");
    }

    const seen = new Set();

    return defaultEntries.map((entry, index) => {
      if (!isPlainObject(entry)) {
        throw new Error("Default entry must be an object.");
      }

      const errors = [];

      pushUnknownKeyErrors(errors, entry, ["type", "id", "kind", "value", "enabled"], "Default entry", index);

      if (entry.type !== "default") {
        errors.push({ index, message: "Default entry type must be default." });
      }

      if (typeof entry.id !== "string" || !UUID_PATTERN.test(entry.id)) {
        errors.push({ index, message: "Default entry ID must be a valid UUID." });
      }

      if (entry.kind !== "url" && entry.kind !== "urlWithSubpaths") {
        errors.push({ index, message: "Default entries must be URL matchers." });
      }

      if (typeof entry.value !== "string" || entry.value.trim() === "") {
        errors.push({ index, message: "Default entry value must be a string." });
      }

      if (entry.enabled !== true) {
        errors.push({ index, message: "Default entries must start enabled." });
      }

      if (errors.length > 0) {
        throw new Error(errors[0].message);
      }

      const id = entry.id.toLowerCase();

      if (seen.has(id)) {
        throw new Error("Duplicate default entry ID.");
      }

      seen.add(id);

      const result = normalizeEntryValue(entry.kind, entry.value);

      return { type: "default", id, kind: entry.kind, value: result.value, enabled: true };
    });
  }

  function defaultEntryCatalog(defaultEntries) {
    const entries = normalizeDefaultEntries(defaultEntries);

    return {
      entries,
      byId: new Map(entries.map((entry) => [entry.id, entry]))
    };
  }

  function normalizeEntry(entry, index, defaultCatalog) {
    const errors = [];

    if (!isPlainObject(entry)) {
      return invalid([{ index, message: "Entry must be an object." }]);
    }

    if (typeof entry.type !== "string") {
      return invalid([{ index, message: "Entry type must be a string." }]);
    }

    switch (entry.type) {
      case "custom":
        return normalizeCustomEntry(entry, index);
      case "default":
        return normalizeDefaultEntry(entry, index, defaultCatalog);
      default:
        return invalid([{ index, message: `Unknown entry type: ${entry.type}` }]);
    }
  }

  function normalizeCustomEntry(entry, index) {
    const errors = [];

    pushUnknownKeyErrors(errors, entry, ["type", "id", "kind", "value"], "Entry", index);

    if (typeof entry.id !== "string" || !UUID_PATTERN.test(entry.id)) {
      errors.push({ index, message: "Entry ID must be a valid UUID." });
    }

    if (typeof entry.kind !== "string" || !Object.hasOwn(KIND_LABELS, entry.kind)) {
      errors.push({ index, message: "Choose a known matcher type." });
    }

    if (typeof entry.value !== "string" || entry.value.trim() === "") {
      errors.push({ index, message: "Enter a value." });
    }

    if (errors.length > 0) {
      return invalid(errors);
    }

    try {
      return validEntry(entry, normalizeEntryValue(entry.kind, entry.value));
    } catch (error) {
      return invalid([{ index, message: error.message }]);
    }
  }

  function normalizeDefaultEntry(entry, index, defaultCatalog) {
    const errors = [];

    pushUnknownKeyErrors(errors, entry, ["type", "id", "kind", "value", "enabled"], "Entry", index);

    if (typeof entry.id !== "string" || !UUID_PATTERN.test(entry.id)) {
      errors.push({ index, message: "Entry ID must be a valid UUID." });
    }

    if (entry.kind !== "url" && entry.kind !== "urlWithSubpaths") {
      errors.push({ index, message: "Default entries must be URL matchers." });
    }

    if (typeof entry.value !== "string" || entry.value.trim() === "") {
      errors.push({ index, message: "Enter a value." });
    }

    if (typeof entry.enabled !== "boolean") {
      errors.push({ index, message: "Default entry enabled value must be a boolean." });
    }

    if (errors.length > 0) {
      return invalid(errors);
    }

    const defaultEntry = defaultCatalog.byId.get(entry.id.toLowerCase());

    if (!defaultEntry) {
      return invalid([{ index, message: "Unknown default entry." }]);
    }

    try {
      const result = normalizeEntryValue(entry.kind, entry.value);

      if (defaultEntry.kind !== entry.kind || defaultEntry.value !== result.value) {
        return invalid([{ index, message: "Default entry does not match its default URL." }]);
      }

      return validEntry(entry, result);
    } catch (error) {
      return invalid([{ index, message: error.message }]);
    }
  }

  function normalizeEntryValue(kind, value) {
    switch (kind) {
      case "domain":
        return { value: normalizeDomainEntryValue(value), aliased: false };
      case "url":
      case "urlWithSubpaths":
        return normalizeUrlEntry(value);
      case "regex": {
        const normalizedValue = normalizeRegexEntryValue(value);

        domainForRegexEntryValue(normalizedValue);

        return { value: normalizedValue, aliased: false };
      }
      default:
        throw new Error(`Unknown matcher kind: ${kind}`);
    }
  }

  function normalizeDomainEntryValue(rawValue) {
    const value = rawValue.trim();

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      throw new Error("Enter a hostname, not a full URL.");
    }

    if (/[/?#@]/.test(value) || value.includes(":")) {
      throw new Error("Domain entries cannot include paths, ports, credentials, queries, or fragments.");
    }

    const url = new URL(`http://${value}`);

    if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "" || url.port !== "") {
      throw new Error("Domain entries must contain only a hostname.");
    }

    const host = normalizeHost(url.hostname);

    return host;
  }

  function normalizeUrlEntryValue(rawValue) {
    return normalizeUrlEntry(rawValue).value;
  }

  function normalizeUrlEntry(rawValue) {
    const url = parseUrlEntryValue(rawValue);
    const scheme = url.protocol.toLowerCase();

    if (scheme !== "http:" && scheme !== "https:") {
      throw new Error("URL entries must use http or https.");
    }

    if (url.username !== "" || url.password !== "") {
      throw new Error("URL entries cannot include usernames or passwords.");
    }

    if (url.port !== "") {
      throw new Error("URL entries cannot include non-default ports.");
    }

    const host = normalizeHost(url.hostname);
    const path = stripTrailingSlashes(url.pathname);
    const storedPath = path === "/" ? "" : path;
    const value = `${host}${storedPath}`;
    const alias = storedUrlAliasTarget(host, storedPath, value);

    if (alias) {
      return { value: alias, aliased: true };
    }

    return { value, aliased: false };
  }

  function normalizeHost(rawHost) {
    const host = stripLeadingWww(rawHost.toLowerCase());

    if (host === "" || host.startsWith(".") || host.endsWith(".")) {
      throw new Error("Enter a valid hostname.");
    }

    if (host.split(".").some((label) => label === "" || label.startsWith("-") || label.endsWith("-"))) {
      throw new Error("Enter a valid hostname.");
    }

    if (!/^[a-z0-9.-]+$/.test(host)) {
      throw new Error("Hostnames must normalize to lowercase ASCII or punycode.");
    }

    if (isIpAddress(host)) {
      throw new Error("IP address blocking is not supported in this version.");
    }

    return host;
  }

  function normalizeSchedule(schedule) {
    const errors = [];

    if (!isPlainObject(schedule)) {
      return invalid([{ index: null, message: "Schedule must be an object." }]);
    }

    if (typeof schedule.type !== "string") {
      return invalid([{ index: null, message: "Schedule type must be a string." }]);
    }

    switch (schedule.type) {
      case "always":
        pushUnknownKeyErrors(errors, schedule, ["type"], "Schedule");

        if (errors.length > 0) {
          return invalid(errors);
        }

        return { type: "valid", schedule: { type: "always" } };
      case "dailyWindow":
        return normalizedDailyWindow(schedule);
      default:
        return invalid([{ index: null, message: `Unknown schedule type: ${schedule.type}` }]);
    }
  }

  function normalizeHardSchedule(schedule) {
    const errors = [];

    if (!isPlainObject(schedule)) {
      return invalid([{ index: null, message: "Schedule must be an object." }]);
    }

    if (typeof schedule.type !== "string") {
      return invalid([{ index: null, message: "Schedule type must be a string." }]);
    }

    switch (schedule.type) {
      case "off":
        pushUnknownKeyErrors(errors, schedule, ["type"], "Schedule");

        if (errors.length > 0) {
          return invalid(errors);
        }

        return { type: "valid", schedule: { type: "off" } };
      case "dailyWindow":
        return normalizedDailyWindow(schedule);
      default:
        return invalid([{ index: null, message: `Unknown schedule type: ${schedule.type}` }]);
    }
  }

  function normalizedDailyWindow(schedule) {
    const errors = [];

    pushUnknownKeyErrors(errors, schedule, ["type", "startMinute", "endMinute"], "Schedule");

    if (!isMinute(schedule.startMinute)) {
      errors.push({ index: null, message: "Schedule start minute must be between 0 and 1439." });
    }

    if (!isMinute(schedule.endMinute)) {
      errors.push({ index: null, message: "Schedule end minute must be between 0 and 1439." });
    }

    if (errors.length > 0) {
      return invalid(errors);
    }

    if (schedule.startMinute === schedule.endMinute) {
      return invalid([{ index: null, message: "Daily schedule start and end times must be different." }]);
    }

    return {
      type: "valid",
      schedule: {
        type: "dailyWindow",
        startMinute: schedule.startMinute,
        endMinute: schedule.endMinute
      }
    };
  }

  function normalizeLimitReset(limitReset) {
    const errors = [];

    if (!isPlainObject(limitReset)) {
      return invalid([{ index: null, message: "Limit reset must be an object." }]);
    }

    if (typeof limitReset.type !== "string") {
      return invalid([{ index: null, message: "Limit reset type must be a string." }]);
    }

    switch (limitReset.type) {
      case "rollingWindow":
        pushUnknownKeyErrors(errors, limitReset, ["type", "windowHours"], "Limit reset");

        if (!Number.isInteger(limitReset.windowHours) || limitReset.windowHours < 1 || limitReset.windowHours > MAX_ROLLING_WINDOW_HOURS) {
          errors.push({ index: null, message: `Rolling reset window must be between 1 and ${MAX_ROLLING_WINDOW_HOURS} hours.` });
        }

        if (errors.length > 0) {
          return invalid(errors);
        }

        return {
          type: "valid",
          limitReset: { type: "rollingWindow", windowHours: limitReset.windowHours }
        };
      case "daily":
        pushUnknownKeyErrors(errors, limitReset, ["type", "resetHour"], "Limit reset");

        if (!Number.isInteger(limitReset.resetHour) || limitReset.resetHour < 0 || limitReset.resetHour > 23) {
          errors.push({ index: null, message: "Daily reset hour must be between 0 and 23." });
        }

        if (errors.length > 0) {
          return invalid(errors);
        }

        return {
          type: "valid",
          limitReset: { type: "daily", resetHour: limitReset.resetHour }
        };
      default:
        return invalid([{ index: null, message: `Unknown limit reset type: ${limitReset.type}` }]);
    }
  }

  function normalizeSettingsDelay(settingsDelay) {
    const errors = [];

    if (!isPlainObject(settingsDelay)) {
      return invalid([{ index: null, message: "Settings delay must be an object." }]);
    }

    pushUnknownKeyErrors(errors, settingsDelay, ["delayMinutes"], "Settings delay");

    if (!Number.isInteger(settingsDelay.delayMinutes) || settingsDelay.delayMinutes < 0 || settingsDelay.delayMinutes > MAX_SETTINGS_DELAY_MINUTES) {
      errors.push({ index: null, message: `Settings delay minutes must be between 0 and ${MAX_SETTINGS_DELAY_MINUTES}.` });
    }

    if (errors.length > 0) {
      return invalid(errors);
    }

    return {
      type: "valid",
      settingsDelay: { delayMinutes: settingsDelay.delayMinutes }
    };
  }

  function normalizeDomainLimits(rawDomainLimits, entries) {
    const errors = [];

    if (!Array.isArray(rawDomainLimits)) {
      return invalid([{ index: null, message: "Domain limits must be an array." }]);
    }

    const expectedDomains = entryDomains(entries);
    const seen = new Set();
    const domainLimits = [];

    rawDomainLimits.forEach((limit, index) => {
      if (!isPlainObject(limit)) {
        errors.push({ index: null, message: "Domain limit must be an object." });
        return;
      }

      pushUnknownKeyErrors(errors, limit, ["domain", "limitMinutes", "blockDirectVisits", "blockInternalLinks"], "Domain limit");

      if (typeof limit.domain !== "string") {
        errors.push({ index: null, message: "Domain limit domain must be a string." });
        return;
      }

      let domain = "";

      try {
        domain = normalizeDomainEntryValue(limit.domain);
      } catch (error) {
        errors.push({ index: null, message: error.message });
        return;
      }

      if (domain !== limit.domain) {
        errors.push({ index: null, message: "Domain limit domain must be normalized." });
        return;
      }

      if (seen.has(domain)) {
        errors.push({ index: null, message: `Duplicate domain limit: ${domain}.` });
        return;
      }

      if (!Number.isInteger(limit.limitMinutes) || limit.limitMinutes < 1 || limit.limitMinutes > MAX_LIMIT_MINUTES) {
        errors.push({ index: null, message: `Domain limit minutes must be between 1 and ${MAX_LIMIT_MINUTES}.` });
        return;
      }

      if (typeof limit.blockDirectVisits !== "boolean") {
        errors.push({ index: null, message: "Domain limit block direct visits setting must be a boolean." });
        return;
      }

      if (typeof limit.blockInternalLinks !== "boolean") {
        errors.push({ index: null, message: "Domain limit block internal links setting must be a boolean." });
        return;
      }

      seen.add(domain);
      domainLimits.push({
        domain,
        limitMinutes: limit.limitMinutes,
        blockDirectVisits: limit.blockDirectVisits,
        blockInternalLinks: limit.blockInternalLinks
      });
    });

    expectedDomains.forEach((domain) => {
      if (!seen.has(domain)) {
        errors.push({ index: null, message: `Missing domain limit: ${domain}.` });
      }
    });

    seen.forEach((domain) => {
      if (!expectedDomains.includes(domain)) {
        errors.push({ index: null, message: `Domain limit does not match a blocklist domain: ${domain}.` });
      }
    });

    if (errors.length > 0) {
      return invalid(errors);
    }

    return {
      type: "valid",
      domainLimits: domainLimits.sort((left, right) => left.domain.localeCompare(right.domain))
    };
  }

  function domainLimitsForEntries(entries, existingDomainLimits) {
    const existing = new Map(existingDomainLimits.map((limit) => [limit.domain, limit]));

    return rawEntryDomains(entries).map((domain) => ({
      domain,
      limitMinutes: existing.has(domain) ? existing.get(domain).limitMinutes : DEFAULT_LIMIT_MINUTES,
      blockDirectVisits: existing.has(domain) && typeof existing.get(domain).blockDirectVisits === "boolean"
        ? existing.get(domain).blockDirectVisits
        : DEFAULT_BLOCK_DIRECT_VISITS,
      blockInternalLinks: existing.has(domain) && typeof existing.get(domain).blockInternalLinks === "boolean"
        ? existing.get(domain).blockInternalLinks
        : DEFAULT_BLOCK_INTERNAL_LINKS
    }));
  }

  function normalizeBlockedPageHtml(rawValue) {
    const value = rawValue.trim();

    if (value.length > MAX_BLOCKED_PAGE_HTML_LENGTH) {
      throw new Error(`Blocked page HTML is limited to ${MAX_BLOCKED_PAGE_HTML_LENGTH} characters.`);
    }

    if (/<\/?(script|iframe|object|embed|form|input|button|textarea|select|option|link|meta|base|style)\b/i.test(value)) {
      throw new Error("Blocked page HTML cannot include active or form elements.");
    }

    if (/\son[a-z]+\s*=/i.test(value) || /javascript:/i.test(value)) {
      throw new Error("Blocked page HTML cannot include inline scripts.");
    }

    return value;
  }

  function normalizeRegexEntryValue(rawValue) {
    const value = rawValue.trim();

    if (value.includes("#")) {
      throw new Error("Regex entries cannot include fragments.");
    }

    if (/\(\?<[=!]/.test(value) || /\(\?<!/.test(value)) {
      throw new Error("Regex entries cannot use lookbehind.");
    }

    if (/\\[1-9]/.test(value)) {
      throw new Error("Regex entries cannot use backreferences.");
    }

    const catchAll = /^(?:\^)?\.\*(?:\$)?$/.test(value);

    if (catchAll) {
      throw new Error("Block-everything regexes are not supported in this version.");
    }

    try {
      new RegExp(value, "i");
    } catch (error) {
      throw new Error(`Regex is invalid: ${error.message}`);
    }

    return value;
  }

  function domainForRegexEntryValue(value) {
    const match = value.match(/^\^(?:https\?|https|http):\/\/([a-z0-9-]+(?:\\\.[a-z0-9-]+)+)(?=\/|\$)/i);

    if (!match) {
      throw new Error("Regex entries must start with one literal http or https host.");
    }

    return normalizeDomainEntryValue(match[1].replace(/\\\./g, "."));
  }

  function findMatchingEntry(state, rawUrl) {
    const result = normalizePageUrl(rawUrl);

    if (result.type === "invalid") {
      return { type: "none" };
    }

    for (const entry of state.entries) {
      if (!entryIsEnabled(entry)) {
        continue;
      }

      if (entryMatchesUrl(entry, result.url)) {
        return { type: "match", entry, reasonType: "directMatch" };
      }
    }

    return { type: "none" };
  }

  function findBlockedMatchingEntry(state, rawUrl, overLimitDomains, navigationSource, date = new Date()) {
    const hardScheduleMatch = findHardScheduleMatchingEntry(state, rawUrl, date);

    if (hardScheduleMatch.type === "match") {
      return hardScheduleMatch;
    }

    const match = findMatchingEntry(state, rawUrl);

    switch (match.type) {
      case "none":
        return activeBlockedMatch(state, findRootUrlMatchingEntry(state, rawUrl, navigationSource), overLimitDomains, date);
      case "match":
        return activeBlockedMatch(state, match, overLimitDomains, date);
      default:
        throw new Error(`Unknown match type: ${match.type}`);
    }
  }

  function findHardScheduleMatchingEntry(state, rawUrl, date) {
    if (!isScheduleActive(state.hardSchedule, date)) {
      return { type: "none" };
    }

    const result = normalizePageUrl(rawUrl);

    if (result.type === "invalid") {
      return { type: "none" };
    }

    for (const entry of state.entries) {
      if (entryIsEnabled(entry) && domainMatchesHost(associatedDomainForEntry(entry), result.url.limitHost)) {
        return { type: "match", entry, reason: "hardScheduleDomain" };
      }
    }

    return { type: "none" };
  }

  function activeBlockedMatch(state, match, overLimitDomains, date) {
    switch (match.type) {
      case "none":
        return { type: "none" };
      case "match":
        if (isScheduleActive(state.schedule, date)) {
          return blockedMatch(match, "schedule");
        }

        if (overLimitDomains.has(associatedDomainForEntry(match.entry))) {
          return blockedMatch(match, "limit");
        }

        return { type: "none" };
      default:
        throw new Error(`Unknown match type: ${match.type}`);
    }
  }

  function blockedMatch(match, activation) {
    switch (match.reasonType) {
      case "directMatch":
      case "currentPage":
        return { type: "match", entry: match.entry, reason: blockReason(activation, "scheduleDirectMatch", "limitDirectMatch") };
      case "rootDirectNavigation":
        return { type: "match", entry: match.entry, reason: blockReason(activation, "scheduleRootDirectNavigation", "limitRootDirectNavigation") };
      case "rootSameDomainNavigation":
        return { type: "match", entry: match.entry, reason: blockReason(activation, "scheduleRootSameDomainNavigation", "limitRootSameDomainNavigation") };
      default:
        throw new Error(`Unknown block reason type: ${match.reasonType}`);
    }
  }

  function blockReason(activation, scheduleReason, limitReason) {
    switch (activation) {
      case "schedule":
        return scheduleReason;
      case "limit":
        return limitReason;
      default:
        throw new Error(`Unknown block activation: ${activation}`);
    }
  }

  function findRootUrlMatchingEntry(state, rawUrl, navigationSource) {
    const result = normalizePageUrl(rawUrl);

    if (result.type === "invalid") {
      return { type: "none" };
    }

    if (sourceReferrerIsSamePage(navigationSource, rawUrl)) {
      return { type: "none" };
    }

    for (const entry of state.entries) {
      if (!entryIsEnabled(entry) || !rootUrlEntryMatchesHost(entry, result.url.limitHost)) {
        continue;
      }

      const reason = rootUrlNavigationReason(navigationSource, domainLimitForEntry(state, entry));

      switch (reason.type) {
        case "none":
          continue;
        case "match":
          return { type: "match", entry, reasonType: reason.reasonType };
        default:
          throw new Error(`Unknown root navigation reason: ${reason.type}`);
      }
    }

    return { type: "none" };
  }

  function rootUrlEntryMatchesHost(entry, host) {
    if (entry.kind !== "url") {
      return false;
    }

    const storedUrl = splitStoredUrl(entry.value);

    return storedUrl.path === "" && domainMatchesHost(storedUrl.host, host);
  }

  function domainLimitForEntry(state, entry) {
    const domain = associatedDomainForEntry(entry);
    const limit = state.domainLimits.find((candidate) => candidate.domain === domain);

    if (!limit) {
      throw new Error(`Missing domain limit: ${domain}.`);
    }

    return limit;
  }

  function rootUrlNavigationReason(source, limit) {
    switch (source.type) {
      case "unknown":
        return { type: "none" };
      case "sameDocument":
        return { type: "match", reasonType: "currentPage" };
      case "document":
        if (source.navigationType === "reload") {
          return { type: "none" };
        }

        return rootReferrerNavigationReason(source.referrer, limit);
      case "safariDocument":
        if (source.navigationType === "reload") {
          return { type: "none" };
        }

        if (source.referrer.type === "known" && source.referrer.url === "" && limit.blockDirectVisits) {
          return { type: "match", reasonType: "rootDirectNavigation" };
        }

        return rootReferrerNavigationReason(source.referrer, limit);
      case "chromiumCommitted":
        if (source.transitionType === "reload") {
          return { type: "none" };
        }

        if (limit.blockDirectVisits && ["typed", "generated", "auto_bookmark"].includes(source.transitionType)) {
          return { type: "match", reasonType: "rootDirectNavigation" };
        }

        return { type: "none" };
      default:
        throw new Error(`Unknown navigation source type: ${source.type}`);
    }
  }

  function rootReferrerNavigationReason(referrer, limit) {
    switch (referrer.type) {
      case "known":
        if (limit.blockInternalLinks && sourceReferrerMatchesDomain(referrer.url, limit.domain)) {
          return { type: "match", reasonType: "rootSameDomainNavigation" };
        }

        return { type: "none" };
      case "unknown":
        return unknownReferrerNavigationReason(limit);
      default:
        throw new Error(`Unknown referrer type: ${referrer.type}`);
    }
  }

  function unknownReferrerNavigationReason(limit) {
    if (limit.blockInternalLinks) {
      return { type: "match", reasonType: "rootSameDomainNavigation" };
    }

    if (limit.blockDirectVisits) {
      return { type: "match", reasonType: "rootDirectNavigation" };
    }

    return { type: "none" };
  }

  function sourceReferrerIsSamePage(source, rawUrl) {
    switch (source.type) {
      case "unknown":
      case "chromiumCommitted":
      case "sameDocument":
        return false;
      case "document":
      case "safariDocument":
        switch (source.referrer.type) {
          case "known":
            return pageChangeKey(source.referrer.url) === pageChangeKey(rawUrl);
          case "unknown":
            return false;
          default:
            throw new Error(`Unknown referrer type: ${source.referrer.type}`);
        }
      default:
        throw new Error(`Unknown navigation source type: ${source.type}`);
    }
  }

  // Everything up to the first & or # identifies the page: extra query params
  // and fragments change on SPAs without the user leaving the page.
  function pageChangeKey(rawUrl) {
    return rawUrl.split(/[&#]/, 1)[0];
  }

  function sourceReferrerMatchesDomain(rawReferrer, entryDomain) {
    const result = normalizePageUrl(rawReferrer);

    if (result.type === "invalid") {
      return false;
    }

    return domainMatchesHost(entryDomain, result.url.limitHost);
  }

  function screenTimeDomainForUrl(state, rawUrl) {
    const result = normalizePageUrl(rawUrl);

    if (result.type === "invalid") {
      return { type: "none" };
    }

    const limits = activeDomainLimits(state).sort((left, right) => right.domain.length - left.domain.length);

    for (const limit of limits) {
      if (domainMatchesHost(limit.domain, result.url.limitHost)) {
        return { type: "match", domain: limit.domain };
      }
    }

    return { type: "none" };
  }

  function entryDomains(entries) {
    return [...new Set(entries.map(associatedDomainForEntry))].sort();
  }

  function activeDomainLimits(state) {
    const activeDomains = new Set(entryDomains(state.entries.filter(entryIsEnabled)));

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

  function rawEntryDomains(entries) {
    const domains = [];

    entries.forEach((entry) => {
      try {
        domains.push(domainForEntry(entry));
      } catch {
        return;
      }
    });

    return [...new Set(domains)].sort();
  }

  function domainForEntry(entry) {
    if (!isPlainObject(entry) || typeof entry.kind !== "string" || typeof entry.value !== "string") {
      throw new Error("Entry must include a kind and value.");
    }

    const result = normalizeEntryValue(entry.kind, entry.value);

    return associatedDomainForEntry({ kind: entry.kind, value: result.value });
  }

  function associatedDomainForEntry(entry) {
    switch (entry.kind) {
      case "domain":
        return entry.value;
      case "url":
      case "urlWithSubpaths":
        return splitStoredUrl(entry.value).host;
      case "regex":
        return domainForRegexEntryValue(entry.value);
      default:
        throw new Error(`Unknown matcher kind: ${entry.kind}`);
    }
  }

  function isScheduleActive(schedule, date = new Date()) {
    switch (schedule.type) {
      case "off":
        return false;
      case "always":
        return true;
      case "dailyWindow":
        return isDailyWindowActive(schedule, date);
      default:
        throw new Error(`Unknown schedule type: ${schedule.type}`);
    }
  }

  function settingsDelayMinutes(settingsDelay) {
    return settingsDelay.delayMinutes;
  }

  function isDailyWindowActive(schedule, date) {
    const minute = date.getHours() * 60 + date.getMinutes();

    if (schedule.startMinute < schedule.endMinute) {
      return minute >= schedule.startMinute && minute < schedule.endMinute;
    }

    return minute >= schedule.startMinute || minute < schedule.endMinute;
  }

  function permissionOriginsForState(state) {
    return permissionOriginsForEntries(state.entries.filter(entryIsEnabled));
  }

  function permissionOriginsForEntries(entries) {
    const origins = [];

    for (const entry of entries) {
      switch (entry.kind) {
        case "domain":
          origins.push(`*://*.${entry.value}/*`);
          break;
        case "url":
        case "urlWithSubpaths":
          urlPermissionHosts(entry.value).forEach((host) => origins.push(`*://*.${host}/*`));
          break;
        case "regex":
          origins.push(`*://*.${domainForRegexEntryValue(entry.value)}/*`);
          break;
        default:
          throw new Error(`Unknown matcher kind: ${entry.kind}`);
      }
    }

    return [...new Set(origins)].sort();
  }

  function entryMatchesUrl(entry, pageUrl) {
    if (!entryIsEnabled(entry)) {
      return false;
    }

    switch (entry.kind) {
      case "domain":
        return domainMatchesUrl(entry.value, pageUrl);
      case "url":
        return makeContentRegex(entry).test(pageUrl.pathMatchUrl);
      case "urlWithSubpaths":
        return makeContentRegex(entry).test(pageUrl.pathMatchUrl);
      case "regex":
        return domainMatchesHost(domainForRegexEntryValue(entry.value), pageUrl.host)
          && new RegExp(entry.value, "i").test(pageUrl.regexMatchUrl);
      default:
        throw new Error(`Unknown matcher kind: ${entry.kind}`);
    }
  }

  function makeContentRegex(entry) {
    switch (entry.kind) {
      case "url":
        return new RegExp(makeUrlRegex(entry), "i");
      case "urlWithSubpaths":
        return new RegExp(makeUrlWithSubpathsRegex(entry), "i");
      case "domain":
      case "regex":
        throw new Error(`${entry.kind} entries do not use content URL regexes.`);
      default:
        throw new Error(`Unknown matcher kind: ${entry.kind}`);
    }
  }

  function makeUrlRegex(entry) {
    const { host, path } = splitStoredUrl(entry.value);

    return `^https?://(?:[^./?#]+\\.)*${escapeRegex(host)}${escapeRegex(path)}$`;
  }

  function makeUrlWithSubpathsRegex(entry) {
    const { host, path } = splitStoredUrl(entry.value);

    return `^https?://(?:[^./?#]+\\.)*${escapeRegex(host)}${escapeRegex(path)}(?:/[^?#]*)?$`;
  }

  function normalizePageUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const scheme = url.protocol.toLowerCase();

      if (scheme !== "http:" && scheme !== "https:") {
        return invalidUrl();
      }

      const host = url.hostname.toLowerCase();
      const base = `${scheme}//${host}${url.port === "" ? "" : `:${url.port}`}`;
      const path = stripTrailingSlashes(url.pathname);
      const normalizedPath = path === "/" ? "" : path;
      const aliasHost = stripLeadingWww(host);
      const aliasTarget = pageUrlAliasTarget(aliasHost, normalizedPath);
      const pathMatchUrl = aliasTarget ? storedUrlMatchUrl(scheme, aliasTarget) : `${base}${normalizedPath}`;
      const regexMatchUrl = `${base}${url.pathname}${url.search}`;

      return {
        type: "valid",
        url: {
          host,
          limitHost: hostAliasTarget(aliasHost) || host,
          pathMatchUrl,
          regexMatchUrl
        }
      };
    } catch {
      return invalidUrl();
    }
  }

  function storedUrlAliasTarget(host, path, storedValue) {
    for (const alias of URL_ALIASES) {
      switch (alias.type) {
        case "exact":
          if (alias.source === storedValue.toLowerCase()) {
            return alias.target;
          }

          break;
        case "pathRegex":
          if (domainMatchesHost(alias.host, host) && alias.pathPattern.test(path)) {
            return alias.target;
          }

          break;
        default:
          throw new Error(`Unknown URL alias type: ${alias.type}`);
      }
    }

    return null;
  }

  function pageUrlAliasTarget(host, path) {
    for (const alias of URL_ALIASES) {
      switch (alias.type) {
        case "exact": {
          const source = splitStoredUrl(alias.source);

          if (!domainMatchesHost(source.host, host)) {
            continue;
          }

          if (source.path.toLowerCase() !== path.toLowerCase()) {
            continue;
          }

          return alias.target;
        }
        case "pathRegex":
          if (domainMatchesHost(alias.host, host) && alias.pathPattern.test(path)) {
            return alias.target;
          }

          break;
        default:
          throw new Error(`Unknown URL alias type: ${alias.type}`);
      }
    }

    return null;
  }

  function hostAliasTarget(host) {
    for (const alias of URL_ALIASES) {
      switch (alias.type) {
        case "exact": {
          const source = splitStoredUrl(alias.source);

          if (domainMatchesHost(source.host, host)) {
            return splitStoredUrl(alias.target).host;
          }

          break;
        }
        case "pathRegex":
          if (domainMatchesHost(alias.host, host)) {
            return splitStoredUrl(alias.target).host;
          }

          break;
        default:
          throw new Error(`Unknown URL alias type: ${alias.type}`);
      }
    }

    return null;
  }

  function urlPermissionHosts(value) {
    const target = value.toLowerCase();
    const hosts = [splitStoredUrl(value).host];

    for (const alias of URL_ALIASES) {
      switch (alias.type) {
        case "exact":
          if (alias.target === target) {
            hosts.push(splitStoredUrl(alias.source).host);
          }

          break;
        case "pathRegex":
          if (alias.target === target) {
            hosts.push(alias.host);
          }

          break;
        default:
          throw new Error(`Unknown URL alias type: ${alias.type}`);
      }
    }

    return [...new Set(hosts)];
  }

  function storedUrlMatchUrl(scheme, value) {
    const { host, path } = splitStoredUrl(value);

    return `${scheme}//${host}${path}`;
  }

  function domainMatchesUrl(domain, pageUrl) {
    return domainMatchesHost(domain, pageUrl.host);
  }

  function domainMatchesHost(domain, host) {
    return host === domain || host.endsWith(`.${domain}`);
  }

  function splitStoredUrl(value) {
    const url = parseUrlEntryValue(value);
    const path = url.pathname === "/" ? "" : url.pathname;

    return { host: url.hostname, path };
  }

  function parseUrlEntryValue(rawValue) {
    const value = rawValue.trim();
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? new URL(value) : new URL(`https://${value}`);

    return url;
  }

  function stripLeadingWww(host) {
    return host.startsWith("www.") ? host.slice(4) : host;
  }

  function stripTrailingSlashes(path) {
    return path.replace(/\/+$/u, "") || "/";
  }

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isMinute(value) {
    return Number.isInteger(value) && value >= 0 && value <= 1439;
  }

  function isIpAddress(host) {
    if (host.includes(":") || host.includes("[") || host.includes("]")) {
      return true;
    }

    const parts = host.split(".");

    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  }

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function pushUnknownKeyErrors(errors, object, allowedKeys, label, index = null) {
    const allowed = new Set(allowedKeys);

    Object.keys(object).forEach((key) => {
      if (!allowed.has(key)) {
        errors.push({ index, message: `${label} has unknown key: ${key}.` });
      }
    });
  }

  function validEntry(entry, result) {
    switch (entry.type) {
      case "custom":
        return {
          type: "valid",
          entry: { type: "custom", id: entry.id.toLowerCase(), kind: entry.kind, value: result.value },
          aliased: result.aliased
        };
      case "default":
        return {
          type: "valid",
          entry: { type: "default", id: entry.id.toLowerCase(), kind: entry.kind, value: result.value, enabled: entry.enabled },
          aliased: result.aliased
        };
      default:
        throw new Error(`Unknown entry type: ${entry.type}`);
    }
  }

  function invalid(errors) {
    return { type: "invalid", errors };
  }

  function invalidUrl() {
    return { type: "invalid" };
  }

  function stateKeys(schemaVersion) {
    switch (schemaVersion) {
      case SCHEMA_VERSION:
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "hardSchedule", "limitReset", "settingsDelay", "domainLimits"];
      case HARD_SCHEDULE_SCHEMA_VERSION:
      case DOMAIN_NAVIGATION_SETTINGS_SCHEMA_VERSION:
      case URL_SUBPATH_DEFAULTS_SCHEMA_VERSION:
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "limitReset", "settingsDelay", "domainLimits"];
      case YOUTUBE_SUBSCRIPTIONS_SCHEMA_VERSION:
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "limitReset", "settingsDelay", "domainLimits"];
      case SETTINGS_DELAY_MODE_SCHEMA_VERSION:
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "limitReset", "settingsDelay", "domainLimits"];
      case SETTINGS_DELAY_SCHEMA_VERSION:
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "limitReset", "domainLimits"];
      default:
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "limitReset", "domainLimits"];
    }
  }

  const BlockerCore = {
    DEFAULT_SETTINGS_DELAY,
    DEFAULT_SETTINGS_DELAY_MINUTES,
    DEFAULT_LIMIT_MINUTES,
    DEFAULT_BLOCK_DIRECT_VISITS,
    DEFAULT_BLOCK_INTERNAL_LINKS,
    DEFAULT_BLOCKED_PAGE_HTML,
    DEFAULT_HARD_SCHEDULE,
    DEFAULT_LIMIT_RESET,
    DEFAULT_SCHEDULE,
    BLOCKED_PAGE_HTML_KEY,
    EDITABLE_KIND_LABELS,
    KIND_LABELS,
    MAX_LIMIT_MINUTES,
    MAX_ROLLING_WINDOW_HOURS,
    MAX_SETTINGS_DELAY_MINUTES,
    MAX_BLOCKED_PAGE_HTML_LENGTH,
    MAX_ENTRIES,
    SCHEMA_VERSION,
    STATE_KEY,
    associatedDomainForEntry,
    domainForEntry,
    domainForRegexEntryValue,
    domainLimitsForEntries,
    emptyState,
    entryMatchesUrl,
    findBlockedMatchingEntry,
    findMatchingEntry,
    isScheduleActive,
    newEntry,
    normalizeDomainEntryValue,
    normalizeBlockedPageHtml,
    normalizePageUrl,
    normalizeRegexEntryValue,
    permissionOriginsForState,
    settingsDelayMinutes,
    normalizeUrlEntryValue,
    hasUnsupportedBlocklistVersion,
    screenTimeDomainForUrl,
    validateStoredState,
    validateState
  };

  root.BlockerCore = BlockerCore;

  if (typeof module !== "undefined") {
    module.exports = BlockerCore;
  }
})(globalThis);
