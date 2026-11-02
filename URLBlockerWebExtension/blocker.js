(function loadBlockerCore(root) {
  "use strict";

  const STATE_KEY = "blockerState";
  const BLOCKED_PAGE_HTML_KEY = "blockedPageHtml";
  const SCHEMA_VERSION = 22;
  const OPEN_PAGES_SCHEMA_VERSION = 21;
  const SHARED_LIMIT_GROUPS_SCHEMA_VERSION = 20;
  const LIMIT_GROUPS_SCHEMA_VERSION = 19;
  const SHORT_VIDEO_HIDING_SCHEMA_VERSION = 18;
  const YOUTUBE_FOCUS_SCHEMA_VERSION = 17;
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
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const SETTINGS_ACTIVATION_SCHEMA_VERSION = 1;
  const MAX_BLOCKED_PAGE_HTML_LENGTH = 4000;
  const DEFAULT_LIMIT_MINUTES = 30;
  const MAX_LIMIT_MINUTES = 960;
  const MAX_ROLLING_WINDOW_HOURS = 168;
  const DEFAULT_SETTINGS_DELAY_MINUTES = 60;
  const MAX_SETTINGS_DELAY_MINUTES = 10080;
  const DEFAULT_BLOCKED_PAGE_HTML = "<h1>Blocked</h1><p>This page is on your blocklist.</p>";
  const DEFAULT_SCHEDULE = { type: "dailyWindow", startMinute: 1380, endMinute: 1140 };
  const DEFAULT_HARD_SCHEDULE = { type: "off" };
  const DEFAULT_LIMIT_RESET = { type: "rollingWindow", windowHours: 24 };
  const DEFAULT_SETTINGS_DELAY = { delayMinutes: DEFAULT_SETTINGS_DELAY_MINUTES };
  const STREAMING_LIMIT_GROUP_ID = "20000000-0000-4000-8000-000000000001";
  const DEFAULT_LIMIT_GROUPS = [{ id: STREAMING_LIMIT_GROUP_ID, name: "Streaming", limitMinutes: 60 }];
  // New domains listed here join their default group while it exists.
  const DEFAULT_DOMAIN_LIMIT_GROUP_IDS = {
    "hbomax.com": STREAMING_LIMIT_GROUP_ID,
    "netflix.com": STREAMING_LIMIT_GROUP_ID
  };
  const MAX_LIMIT_GROUP_NAME_LENGTH = 40;
  const SHORT_VIDEO_SITE_DOMAINS = {
    youtube: "youtube.com",
    instagram: "instagram.com",
    facebook: "facebook.com",
    linkedin: "linkedin.com"
  };
  const DEFAULT_SHORT_VIDEO_HIDING = { youtube: true, instagram: true, facebook: true, linkedin: true };
  // Single short video URLs per site. A redirect target shows the video
  // without a swipe feed; "inPlace" pages keep their URL and content.js locks
  // navigation to the next video.
  const SINGLE_SHORT_VIDEO_PAGES = {
    youtube: [{ type: "redirect", pathPattern: /^\/shorts\/([A-Za-z0-9_-]+)\/?$/, target: (id) => `/watch?v=${id}` }],
    instagram: [
      { type: "redirect", pathPattern: /^\/(?:[A-Za-z0-9._]+\/)?reel\/([A-Za-z0-9_-]+)\/?$/, target: (id) => `/p/${id}/` },
      { type: "redirect", pathPattern: /^\/reels\/([A-Za-z0-9_-]+)\/?$/, target: (id) => `/p/${id}/` }
    ],
    facebook: [{ type: "inPlace", pathPattern: /^\/reel\/[0-9]+\/?$/ }],
    linkedin: []
  };
  // Android apps that open a blocklist site's home feed.
  const APP_SITE_DOMAINS = {
    "com.twitter.android": "x.com",
    "com.instagram.android": "instagram.com",
    "com.zhiliaoapp.musically": "tiktok.com",
    "com.ss.android.ugc.trill": "tiktok.com",
    "com.facebook.katana": "facebook.com",
    "com.facebook.lite": "facebook.com",
    "com.instagram.barcelona": "threads.com",
    "xyz.blueskyweb.app": "bsky.app",
    "com.pinterest": "pinterest.com",
    "com.linkedin.android": "linkedin.com",
    "com.google.android.youtube": "youtube.com",
    "com.reddit.frontpage": "reddit.com",
    "com.netflix.mediaclient": "netflix.com",
    "com.wbd.stream": "hbomax.com"
  };
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
      shortVideoHiding: DEFAULT_SHORT_VIDEO_HIDING,
      allowedPages: [],
      limitGroups: DEFAULT_LIMIT_GROUPS,
      domainLimits: domainLimitsForEntries(entries, [], DEFAULT_LIMIT_GROUPS)
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

    if (!isPlainObject(rawState.shortVideoHiding)) {
      errors.push({ index: null, message: "Short video hiding settings must be an object." });
    }

    if (!Array.isArray(rawState.allowedPages)) {
      errors.push({ index: null, message: "Allowed pages must be an array." });
    }

    if (!Array.isArray(rawState.limitGroups)) {
      errors.push({ index: null, message: "Limit groups must be an array." });
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
    let shortVideoHiding = DEFAULT_SHORT_VIDEO_HIDING;

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

    const shortVideoHidingResult = normalizeShortVideoHiding(rawState.shortVideoHiding);

    if (shortVideoHidingResult.type === "invalid") {
      errors.push(...shortVideoHidingResult.errors);
    } else {
      shortVideoHiding = shortVideoHidingResult.shortVideoHiding;
    }

    const allowedPages = [];

    rawState.allowedPages.forEach((value) => {
      if (typeof value !== "string" || value.trim() === "") {
        errors.push({ index: null, message: "Allowed pages must be non-empty strings." });
        return;
      }

      try {
        const normalized = normalizeUrlValue(value);

        if (allowedPages.includes(normalized)) {
          errors.push({ index: null, message: `Duplicate allowed page: ${normalized}.` });
          return;
        }

        allowedPages.push(normalized);
      } catch (error) {
        errors.push({ index: null, message: `Allowed page ${value}: ${error.message}` });
      }
    });

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

    const groupsResult = normalizeLimitGroups(rawState.limitGroups);

    if (groupsResult.type === "invalid") {
      return invalid(groupsResult.errors);
    }

    const limitsResult = normalizeDomainLimits(rawState.domainLimits, entries, groupsResult.limitGroups);

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
        shortVideoHiding,
        allowedPages,
        limitGroups: groupsResult.limitGroups,
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
      OPEN_PAGES_SCHEMA_VERSION,
      SHARED_LIMIT_GROUPS_SCHEMA_VERSION,
      LIMIT_GROUPS_SCHEMA_VERSION,
      SHORT_VIDEO_HIDING_SCHEMA_VERSION,
      YOUTUBE_FOCUS_SCHEMA_VERSION,
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
      domainLimits: domainLimitsForEntries(
        entries,
        Array.isArray(migratedState.domainLimits) ? migratedState.domainLimits : [],
        Array.isArray(migratedState.limitGroups) ? migratedState.limitGroups : []
      )
    };
  }

  function storedStateWithCurrentShape(rawState) {
    if (rawState.schemaVersion === SCHEMA_VERSION) {
      return rawState;
    }

    return { ...storedStateWithOpenPagesVersionShape(rawState), allowedPages: [] };
  }

  function storedStateWithOpenPagesVersionShape(rawState) {
    if (rawState.schemaVersion === OPEN_PAGES_SCHEMA_VERSION) {
      return rawState;
    }

    const { youtubeFocus, ...state } = storedStateWithSharedLimitGroupsVersionShape(rawState);

    return state;
  }

  function storedStateWithSharedLimitGroupsVersionShape(rawState) {
    if (rawState.schemaVersion === SHARED_LIMIT_GROUPS_SCHEMA_VERSION) {
      return rawState;
    }

    const state = storedStateWithLimitGroupsVersionShape(rawState);

    return {
      ...state,
      limitGroups: DEFAULT_LIMIT_GROUPS,
      domainLimits: Array.isArray(state.domainLimits) ? state.domainLimits.map(siteDomainLimit) : state.domainLimits
    };
  }

  function siteDomainLimit(domainLimit) {
    if (!isPlainObject(domainLimit)) {
      return domainLimit;
    }

    const { limitMinutes, ...rest } = domainLimit;

    return { ...rest, limit: { type: "site", limitMinutes } };
  }

  function storedStateWithLimitGroupsVersionShape(rawState) {
    switch (rawState.schemaVersion) {
      case LIMIT_GROUPS_SCHEMA_VERSION:
        return rawState;
      case SHORT_VIDEO_HIDING_SCHEMA_VERSION:
        return { ...rawState, shortVideoHiding: DEFAULT_SHORT_VIDEO_HIDING };
      case YOUTUBE_FOCUS_SCHEMA_VERSION:
        return { ...rawState, shortVideoHiding: DEFAULT_SHORT_VIDEO_HIDING };
      case HARD_SCHEDULE_SCHEMA_VERSION:
      case DOMAIN_NAVIGATION_SETTINGS_SCHEMA_VERSION:
      case URL_SUBPATH_DEFAULTS_SCHEMA_VERSION:
      case YOUTUBE_SUBSCRIPTIONS_SCHEMA_VERSION:
        return { ...rawState, hardSchedule: DEFAULT_HARD_SCHEDULE, shortVideoHiding: DEFAULT_SHORT_VIDEO_HIDING };
      case SETTINGS_DELAY_MODE_SCHEMA_VERSION:
        return { ...rawState, hardSchedule: DEFAULT_HARD_SCHEDULE, settingsDelay: migrateSettingsDelay(rawState.settingsDelay), shortVideoHiding: DEFAULT_SHORT_VIDEO_HIDING };
      case SETTINGS_DELAY_SCHEMA_VERSION:
        return { ...rawState, hardSchedule: DEFAULT_HARD_SCHEDULE, settingsDelay: DEFAULT_SETTINGS_DELAY, shortVideoHiding: DEFAULT_SHORT_VIDEO_HIDING };
      case LEGACY_SCHEMA_VERSION:
      case SUBREDDIT_SCHEMA_VERSION:
      case LIMIT_RESET_SCHEMA_VERSION:
      case FACEBOOK_HOME_SCHEMA_VERSION:
      case SOCIAL_DEFAULTS_SCHEMA_VERSION:
        return { ...rawState, hardSchedule: DEFAULT_HARD_SCHEDULE, limitReset: DEFAULT_LIMIT_RESET, settingsDelay: DEFAULT_SETTINGS_DELAY, shortVideoHiding: DEFAULT_SHORT_VIDEO_HIDING };
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
    const value = normalizeUrlValue(rawValue);
    const slash = value.indexOf("/");
    const host = slash === -1 ? value : value.slice(0, slash);
    const alias = storedUrlAliasTarget(host, value.slice(host.length), value);

    if (alias) {
      return { value: alias, aliased: true };
    }

    return { value, aliased: false };
  }

  // Allowed pages skip URL aliases: allowing x.com/home must not allow all of x.com.
  function normalizeUrlValue(rawValue) {
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
    return `${host}${storedPath}`;
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

  function normalizeShortVideoHiding(shortVideoHiding) {
    const errors = [];
    const sites = Object.keys(SHORT_VIDEO_SITE_DOMAINS);

    if (!isPlainObject(shortVideoHiding)) {
      return invalid([{ index: null, message: "Short video hiding settings must be an object." }]);
    }

    pushUnknownKeyErrors(errors, shortVideoHiding, sites, "Short video hiding settings");

    sites.forEach((site) => {
      if (typeof shortVideoHiding[site] !== "boolean") {
        errors.push({ index: null, message: `Short video hiding setting for ${site} must be a boolean.` });
      }
    });

    if (errors.length > 0) {
      return invalid(errors);
    }

    return {
      type: "valid",
      shortVideoHiding: Object.fromEntries(sites.map((site) => [site, shortVideoHiding[site]]))
    };
  }

  function normalizeLimitGroups(rawLimitGroups) {
    const errors = [];
    const seenIds = new Set();
    const seenNames = new Set();
    const limitGroups = [];

    rawLimitGroups.forEach((group) => {
      if (!isPlainObject(group)) {
        errors.push({ index: null, message: "Limit group must be an object." });
        return;
      }

      pushUnknownKeyErrors(errors, group, ["id", "name", "limitMinutes"], "Limit group");

      if (typeof group.id !== "string" || !UUID_PATTERN.test(group.id) || group.id !== group.id.toLowerCase()) {
        errors.push({ index: null, message: "Limit group ID must be a lowercase UUID." });
        return;
      }

      if (seenIds.has(group.id)) {
        errors.push({ index: null, message: "Duplicate limit group ID." });
        return;
      }

      if (typeof group.name !== "string" || group.name.trim() === "" || group.name.trim().length > MAX_LIMIT_GROUP_NAME_LENGTH) {
        errors.push({ index: null, message: `Limit group names must be 1 to ${MAX_LIMIT_GROUP_NAME_LENGTH} characters.` });
        return;
      }

      const name = group.name.trim();

      if (seenNames.has(name.toLowerCase())) {
        errors.push({ index: null, message: `Duplicate limit group name: ${name}.` });
        return;
      }

      if (!isLimitMinutes(group.limitMinutes)) {
        errors.push({ index: null, message: `Limit group minutes must be between 1 and ${MAX_LIMIT_MINUTES}.` });
        return;
      }

      seenIds.add(group.id);
      seenNames.add(name.toLowerCase());
      limitGroups.push({ id: group.id, name, limitMinutes: group.limitMinutes });
    });

    if (errors.length > 0) {
      return invalid(errors);
    }

    return { type: "valid", limitGroups: limitGroups.sort((left, right) => left.name.localeCompare(right.name)) };
  }

  function normalizeDomainLimits(rawDomainLimits, entries, limitGroups) {
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

      pushUnknownKeyErrors(errors, limit, ["domain", "limit"], "Domain limit");

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

      const limitResult = normalizeDomainLimitValue(limit.limit, limitGroups);

      if (limitResult.type === "invalid") {
        errors.push(...limitResult.errors);
        return;
      }

      seen.add(domain);
      domainLimits.push({ domain, limit: limitResult.limit });
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

  function normalizeDomainLimitValue(limit, limitGroups) {
    if (!isPlainObject(limit)) {
      return invalid([{ index: null, message: "Domain limit must include a limit object." }]);
    }

    switch (limit.type) {
      case "site": {
        const errors = [];

        pushUnknownKeyErrors(errors, limit, ["type", "limitMinutes"], "Site limit");

        if (!isLimitMinutes(limit.limitMinutes)) {
          errors.push({ index: null, message: `Domain limit minutes must be between 1 and ${MAX_LIMIT_MINUTES}.` });
        }

        return errors.length > 0 ? invalid(errors) : { type: "valid", limit: { type: "site", limitMinutes: limit.limitMinutes } };
      }
      case "group": {
        const errors = [];

        pushUnknownKeyErrors(errors, limit, ["type", "groupId"], "Group limit");

        if (!limitGroups.some((group) => group.id === limit.groupId)) {
          errors.push({ index: null, message: "Domain limit group does not exist." });
        }

        return errors.length > 0 ? invalid(errors) : { type: "valid", limit: { type: "group", groupId: limit.groupId } };
      }
      default:
        return invalid([{ index: null, message: "Domain limit type must be site or group." }]);
    }
  }

  function isLimitMinutes(value) {
    return Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT_MINUTES;
  }

  function domainLimitsForEntries(entries, existingDomainLimits, limitGroups) {
    const existing = new Map(existingDomainLimits.map((limit) => [limit.domain, limit]));

    return rawEntryDomains(entries).map((domain) => ({
      domain,
      limit: existing.has(domain) ? existing.get(domain).limit : defaultDomainLimit(domain, limitGroups)
    }));
  }

  function defaultDomainLimit(domain, limitGroups) {
    const groupId = DEFAULT_DOMAIN_LIMIT_GROUP_IDS[domain];

    if (limitGroups.some((group) => group.id === groupId)) {
      return { type: "group", groupId };
    }

    return { type: "site", limitMinutes: DEFAULT_LIMIT_MINUTES };
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
    return findEntryMatch(state.entries, rawUrl);
  }

  function findEntryMatch(entries, rawUrl) {
    const result = normalizePageUrl(rawUrl);

    if (result.type === "invalid") {
      return { type: "none" };
    }

    for (const entry of entries) {
      if (!entryIsEnabled(entry)) {
        continue;
      }

      if (entryMatchesUrl(entry, result.url)) {
        return { type: "match", entry, reasonType: "directMatch" };
      }
    }

    return { type: "none" };
  }

  // Precedence: the hard schedule, then single short video redirects, which
  // are judged by their destination, then the allow list and the page policy.
  //
  // A visit is "continuing" when the tab already holds a pass for the page,
  // "arrivalPending" when it is new but how it arrived is not known yet, or an
  // "arrival" from outside the site, from inside it, or from a referrer.
  //
  // Every result carries the page's short video handling for content.js.
  function decidePage(state, rawUrl, visit, overLimitDomains, date) {
    const shortVideo = shortVideoPage(state, rawUrl);

    return { ...pageDecision(state, rawUrl, shortVideo, visit, overLimitDomains, date), shortVideo };
  }

  function pageDecision(state, rawUrl, shortVideo, visit, overLimitDomains, date) {
    const hardScheduleMatch = findHardScheduleMatchingEntry(state, rawUrl, date);

    if (hardScheduleMatch.type === "match") {
      return hardScheduleMatch;
    }

    if (shortVideo.type === "singleVideoRedirect") {
      const target = pageDecision(state, shortVideo.url, shortVideoPage(state, shortVideo.url), visit, overLimitDomains, date);

      return target.type === "match" || visit.type === "arrivalPending" ? target : { type: "singleVideoRedirect", url: shortVideo.url };
    }

    if (isAllowedPage(state, rawUrl)) {
      return { type: "none" };
    }

    const policy = pagePolicy(state, rawUrl, shortVideo);

    if (policy.type === "unrestricted") {
      return { type: "none" };
    }

    const domain = associatedDomainForEntry(policy.entry);
    const reason = isScheduleActive(state.schedule, date) ? "schedule" : overLimitDomains.has(domain) ? "limit" : "none";

    if (reason === "none") {
      return { type: "none" };
    }

    switch (policy.type) {
      case "feed":
        return { type: "match", entry: policy.entry, reason };
      case "outsideLinksOnly":
        return visitAllowsPage(visit, domain) ? { type: "none" } : { type: "match", entry: policy.entry, reason };
      default:
        throw new Error(`Unknown page policy: ${policy.type}`);
    }
  }

  // Exact URL entries name feed pages. Every other entry match, and the rest
  // of a bare-domain URL entry's site, opens only from outside links. A single
  // short video is never a feed.
  function pagePolicy(state, rawUrl, shortVideo) {
    if (shortVideo.type !== "singleVideo") {
      const feed = findEntryMatch(state.entries.filter((entry) => entry.kind === "url"), rawUrl);

      if (feed.type === "match") {
        return { type: "feed", entry: feed.entry };
      }
    }

    const match = findEntryMatch(state.entries, rawUrl);

    if (match.type === "match") {
      return { type: "outsideLinksOnly", entry: match.entry };
    }

    const result = normalizePageUrl(rawUrl);
    const rootEntry = result.type === "valid"
      ? state.entries.find((entry) => entryIsEnabled(entry) && rootUrlEntryMatchesHost(entry, result.url.limitHost))
      : undefined;

    return rootEntry ? { type: "outsideLinksOnly", entry: rootEntry } : { type: "unrestricted" };
  }

  function visitAllowsPage(visit, domain) {
    switch (visit.type) {
      case "continuing":
      case "arrivalPending":
        return true;
      case "arrival":
        return isOutsideArrival(visit.from, domain);
      default:
        throw new Error(`Unknown visit type: ${visit.type}`);
    }
  }

  function isOutsideArrival(from, domain) {
    switch (from.type) {
      case "outside":
        return true;
      case "inside":
        return false;
      case "referrer": {
        // Android apps open links with an android-app:// referrer. Other
        // non-web referrers, like the block page, count as inside.
        if (from.url.startsWith("android-app://")) {
          return true;
        }

        const result = normalizePageUrl(from.url);

        return result.type === "valid" && !domainMatchesHost(domain, result.url.limitHost);
      }
      default:
        throw new Error(`Unknown arrival type: ${from.type}`);
    }
  }

  function isAllowedPage(state, rawUrl) {
    const result = normalizePageUrl(rawUrl);

    return result.type === "valid"
      && state.allowedPages.some((value) => makeContentRegex({ kind: "urlWithSubpaths", value }).test(result.url.pathUrl));
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
        return { type: "match", entry, reason: "hardSchedule" };
      }
    }

    return { type: "none" };
  }

  // An app is its site's home page opened directly, checked for as long as it
  // is on screen.
  function findBlockedApp(state, packageName, overLimitDomains, date) {
    if (!Object.hasOwn(APP_SITE_DOMAINS, packageName)) {
      return { type: "none" };
    }

    return decidePage(state, `https://${APP_SITE_DOMAINS[packageName]}/`, { type: "arrival", from: { type: "inside" } }, overLimitDomains, date);
  }

  function screenTimeDomainForApp(state, packageName) {
    if (!Object.hasOwn(APP_SITE_DOMAINS, packageName)) {
      return { type: "none" };
    }

    return screenTimeDomainForUrl(state, `https://${APP_SITE_DOMAINS[packageName]}/`);
  }

  function blockedReasonText(reason) {
    switch (reason) {
      case "hardSchedule":
        return "All pages on this site are blocked during your hard block schedule.";
      case "schedule":
        return "This page is blocked during your schedule.";
      case "limit":
        return "You've reached your time limit for this site.";
      default:
        throw new Error(`Unknown blocked page reason: ${reason}`);
    }
  }

  function rootUrlEntryMatchesHost(entry, host) {
    if (entry.kind !== "url") {
      return false;
    }

    const storedUrl = splitStoredUrl(entry.value);

    return storedUrl.path === "" && domainMatchesHost(storedUrl.host, host);
  }

  // Everything up to the first & or # identifies the page: extra query params
  // and fragments change on SPAs without the user leaving the page.
  function pageChangeKey(rawUrl) {
    return rawUrl.split(/[&#]/, 1)[0];
  }

  // Short video hiding is always on for enabled sites, independent of the
  // blocklist, schedules, and limits.
  function shortVideoPage(state, rawUrl) {
    const result = normalizePageUrl(rawUrl);

    if (result.type === "invalid") {
      return { type: "none" };
    }

    const site = Object.keys(SHORT_VIDEO_SITE_DOMAINS)
      .find((candidate) => domainMatchesHost(SHORT_VIDEO_SITE_DOMAINS[candidate], result.url.host));

    if (site === undefined || !state.shortVideoHiding[site]) {
      return { type: "none" };
    }

    const url = new URL(rawUrl);

    for (const page of SINGLE_SHORT_VIDEO_PAGES[site]) {
      const match = url.pathname.match(page.pathPattern);

      if (!match) {
        continue;
      }

      switch (page.type) {
        case "redirect":
          return { type: "singleVideoRedirect", site, url: `${url.origin}${page.target(match[1])}` };
        case "inPlace":
          return { type: "singleVideo", site };
        default:
          throw new Error(`Unknown single short video page type: ${page.type}`);
      }
    }

    return { type: "feed", site };
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

  function screenTimeEntries(state, usage, nowMs) {
    const window = usageWindow(state.limitReset, nowMs);

    return activeLimits(state)
      .map((limit) => {
        const totalMs = limit.domains.reduce((total, domain) => total + screenTimeTotalMs(usage, domain, window), 0);

        return {
          type: limit.type,
          name: limit.name,
          domains: limit.domains,
          totalMs,
          limitMinutes: limit.limitMinutes,
          isOverLimit: totalMs >= limit.limitMinutes * MINUTE_MS
        };
      })
      .filter((entry) => entry.totalMs > 0)
      .sort((left, right) => right.totalMs - left.totalMs || left.name.localeCompare(right.name));
  }

  function overLimitDomains(state, usage, nowMs) {
    return new Set(screenTimeEntries(state, usage, nowMs)
      .filter((entry) => entry.isOverLimit)
      .flatMap((entry) => entry.domains));
  }

  // One limit per site with its own limit, and one per group with an active site.
  function activeLimits(state) {
    const siteLimits = [];
    const groupDomains = new Map();

    activeDomainLimits(state).forEach((domainLimit) => {
      switch (domainLimit.limit.type) {
        case "site":
          siteLimits.push({ type: "site", name: domainLimit.domain, domains: [domainLimit.domain], limitMinutes: domainLimit.limit.limitMinutes });
          return;
        case "group":
          groupDomains.set(domainLimit.limit.groupId, [...(groupDomains.get(domainLimit.limit.groupId) || []), domainLimit.domain]);
          return;
        default:
          throw new Error(`Unknown domain limit type: ${domainLimit.limit.type}`);
      }
    });

    const groupLimits = state.limitGroups
      .filter((group) => groupDomains.has(group.id))
      .map((group) => ({ type: "group", name: group.name, domains: groupDomains.get(group.id), limitMinutes: group.limitMinutes }));

    return [...siteLimits, ...groupLimits];
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

  function screenTimeTotalMs(usage, domain, window) {
    return screenTimeBucketTotalMs(usage.localBuckets[domain] || {}, window)
      + Object.values(usage.remoteBuckets).reduce((total, domains) => total + screenTimeBucketTotalMs(domains[domain] || {}, window), 0);
  }

  // Local buckets store { totalMs, syncedMs }; remote buckets store totals.
  function screenTimeBucketTotalMs(buckets, window) {
    return Object.entries(buckets).reduce((total, [hour, bucket]) => {
      const bucketHour = Number(hour);

      if (bucketHour < window.startHour || bucketHour > window.endHour) {
        return total;
      }

      return total + (typeof bucket === "number" ? bucket : bucket.totalMs);
    }, 0);
  }

  function activeSettingsActivation(state) {
    return {
      schemaVersion: SETTINGS_ACTIVATION_SCHEMA_VERSION,
      activeState: state,
      pending: { type: "none" }
    };
  }

  // Saved settings wait for the delay set by the currently active settings, so
  // a shorter delay cannot take effect sooner than the old one allows.
  function pendingSettingsActivation(activation, state, nowMs) {
    return {
      schemaVersion: SETTINGS_ACTIVATION_SCHEMA_VERSION,
      activeState: activation.activeState,
      pending: {
        type: "pending",
        state,
        effectiveAtMs: nowMs + settingsDelayMinutes(activation.activeState.settingsDelay) * MINUTE_MS
      }
    };
  }

  function settleSettingsActivation(activation, nowMs) {
    switch (activation.pending.type) {
      case "none":
        return { type: "unchanged", activation };
      case "pending":
        if (activation.pending.effectiveAtMs > nowMs) {
          return { type: "unchanged", activation };
        }

        return { type: "activated", activation: activeSettingsActivation(activation.pending.state) };
      default:
        throw new Error(`Unknown settings activation type: ${activation.pending.type}`);
    }
  }

  function validateSettingsActivation(rawActivation, defaultEntries) {
    if (!isPlainObject(rawActivation)) {
      return invalid([{ index: null, message: "Settings activation must be an object." }]);
    }

    const keyErrors = [];

    pushUnknownKeyErrors(keyErrors, rawActivation, ["schemaVersion", "activeState", "pending"], "Settings activation");

    if (keyErrors.length > 0) {
      return invalid(keyErrors);
    }

    if (rawActivation.schemaVersion !== SETTINGS_ACTIVATION_SCHEMA_VERSION) {
      return invalid([{ index: null, message: "Unsupported settings activation version." }]);
    }

    if (!isPlainObject(rawActivation.pending) || typeof rawActivation.pending.type !== "string") {
      return invalid([{ index: null, message: "Settings activation pending value must include a type." }]);
    }

    const activeResult = validateStoredState(rawActivation.activeState, defaultEntries);

    if (activeResult.type === "invalid") {
      return invalid([{ index: null, message: `Active settings are invalid: ${errorMessages(activeResult.errors)}` }]);
    }

    switch (rawActivation.pending.type) {
      case "none":
        pushUnknownKeyErrors(keyErrors, rawActivation.pending, ["type"], "Settings activation pending value");

        if (keyErrors.length > 0) {
          return invalid(keyErrors);
        }

        return { type: "valid", activation: activeSettingsActivation(activeResult.state) };
      case "pending": {
        pushUnknownKeyErrors(keyErrors, rawActivation.pending, ["type", "state", "effectiveAtMs"], "Settings activation pending value");

        if (keyErrors.length > 0) {
          return invalid(keyErrors);
        }

        if (!Number.isInteger(rawActivation.pending.effectiveAtMs) || rawActivation.pending.effectiveAtMs < 0) {
          return invalid([{ index: null, message: "Settings activation time must be a non-negative integer." }]);
        }

        const pendingResult = validateStoredState(rawActivation.pending.state, defaultEntries);

        if (pendingResult.type === "invalid") {
          return invalid([{ index: null, message: `Pending settings are invalid: ${errorMessages(pendingResult.errors)}` }]);
        }

        return {
          type: "valid",
          activation: {
            schemaVersion: SETTINGS_ACTIVATION_SCHEMA_VERSION,
            activeState: activeResult.state,
            pending: { type: "pending", state: pendingResult.state, effectiveAtMs: rawActivation.pending.effectiveAtMs }
          }
        };
      }
      default:
        return invalid([{ index: null, message: `Unknown settings activation type: ${rawActivation.pending.type}.` }]);
    }
  }

  function errorMessages(errors) {
    return errors.map((error) => error.message).join("\n");
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

  // Short video sites are install-time host permissions, so hiding needs no
  // extra website access.
  function contentScriptOriginsForState(state) {
    const shortVideoOrigins = Object.keys(SHORT_VIDEO_SITE_DOMAINS)
      .filter((site) => state.shortVideoHiding[site])
      .map((site) => `*://*.${SHORT_VIDEO_SITE_DOMAINS[site]}/*`);

    return [...new Set([...permissionOriginsForState(state), ...shortVideoOrigins])].sort();
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
      const pathUrl = `${base}${normalizedPath}`;
      const pathMatchUrl = aliasTarget ? storedUrlMatchUrl(scheme, aliasTarget) : pathUrl;
      const regexMatchUrl = `${base}${url.pathname}${url.search}`;

      return {
        type: "valid",
        url: {
          host,
          limitHost: hostAliasTarget(aliasHost) || host,
          pathUrl,
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
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "hardSchedule", "limitReset", "settingsDelay", "shortVideoHiding", "allowedPages", "limitGroups", "domainLimits"];
      case OPEN_PAGES_SCHEMA_VERSION:
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "hardSchedule", "limitReset", "settingsDelay", "shortVideoHiding", "limitGroups", "domainLimits"];
      case SHARED_LIMIT_GROUPS_SCHEMA_VERSION:
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "hardSchedule", "limitReset", "settingsDelay", "youtubeFocus", "shortVideoHiding", "limitGroups", "domainLimits"];
      case LIMIT_GROUPS_SCHEMA_VERSION:
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "hardSchedule", "limitReset", "settingsDelay", "youtubeFocus", "shortVideoHiding", "domainLimits"];
      case SHORT_VIDEO_HIDING_SCHEMA_VERSION:
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "hardSchedule", "limitReset", "settingsDelay", "youtubeFocus", "domainLimits"];
      case YOUTUBE_FOCUS_SCHEMA_VERSION:
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
    DEFAULT_LIMIT_GROUPS,
    DEFAULT_LIMIT_MINUTES,
    MAX_LIMIT_GROUP_NAME_LENGTH,
    DEFAULT_BLOCKED_PAGE_HTML,
    DEFAULT_HARD_SCHEDULE,
    DEFAULT_LIMIT_RESET,
    DEFAULT_SCHEDULE,
    DEFAULT_SHORT_VIDEO_HIDING,
    BLOCKED_PAGE_HTML_KEY,
    EDITABLE_KIND_LABELS,
    KIND_LABELS,
    APP_SITE_DOMAINS,
    MAX_LIMIT_MINUTES,
    MAX_ROLLING_WINDOW_HOURS,
    MAX_SETTINGS_DELAY_MINUTES,
    MAX_BLOCKED_PAGE_HTML_LENGTH,
    MAX_ENTRIES,
    SCHEMA_VERSION,
    STATE_KEY,
    activeLimits,
    activeSettingsActivation,
    associatedDomainForEntry,
    blockedReasonText,
    contentScriptOriginsForState,
    decidePage,
    domainForEntry,
    domainForRegexEntryValue,
    domainLimitsForEntries,
    emptyState,
    entryMatchesUrl,
    findBlockedApp,
    findMatchingEntry,
    isScheduleActive,
    newEntry,
    overLimitDomains,
    pendingSettingsActivation,
    normalizeDomainEntryValue,
    normalizeBlockedPageHtml,
    normalizePageUrl,
    pageChangeKey,
    normalizeRegexEntryValue,
    permissionOriginsForState,
    settingsDelayMinutes,
    normalizeUrlEntryValue,
    hasUnsupportedBlocklistVersion,
    screenTimeBucketTotalMs,
    screenTimeDomainForApp,
    screenTimeDomainForUrl,
    screenTimeEntries,
    screenTimeTotalMs,
    settleSettingsActivation,
    shortVideoPage,
    usageWindow,
    validateSettingsActivation,
    validateStoredState,
    validateState
  };

  root.BlockerCore = BlockerCore;

  if (typeof module !== "undefined") {
    module.exports = BlockerCore;
  }
})(globalThis);
