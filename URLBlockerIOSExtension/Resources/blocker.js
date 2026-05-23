(function loadBlockerCore(root) {
  "use strict";

  const STATE_KEY = "blockerState";
  const SCHEMA_VERSION = 8;
  const LEGACY_SCHEMA_VERSION = 6;
  const PREVIOUS_SCHEMA_VERSION = 7;
  const SUBREDDIT_FEEDS_VALUE = "reddit.com/r/*";
  const MAX_ENTRIES = 1000;
  const MAX_BLOCKED_PAGE_HTML_LENGTH = 4000;
  const DEFAULT_LIMIT_MINUTES = 30;
  const MAX_LIMIT_MINUTES = 960;
  const DEFAULT_BLOCKED_PAGE_HTML = "<h1>Blocked</h1><p>This page is on your blocklist.</p>";
  const DEFAULT_SCHEDULE = { type: "always" };
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const URL_ALIASES = [
    { type: "exact", source: "x.com/home", target: "x.com" },
    { type: "exact", source: "twitter.com", target: "x.com" },
    { type: "exact", source: "twitter.com/home", target: "x.com" },
    { type: "exact", source: "ycombinator.com/news", target: "ycombinator.com" },
    { type: "exact", source: "linkedin.com/feed", target: "linkedin.com" },
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
      errors.push({ index: null, message: "Unsupported blocklist version. Reset the blocklist to repair it." });
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

    if (!Array.isArray(rawState.domainLimits)) {
      errors.push({ index: null, message: "Domain limits must be an array." });
    }

    if (errors.length > 0) {
      return invalid(errors);
    }

    let blockedPageHtml = "";
    let schedule = DEFAULT_SCHEDULE;

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
        domainLimits: limitsResult.domainLimits
      }
    };
  }

  function parseStoredState(rawState, defaultEntries) {
    const result = validateState(migrateStoredState(rawState, defaultEntries), defaultEntries);

    if (result.type === "invalid") {
      throw new Error(result.errors.map((error) => error.message).join("\n"));
    }

    return result.state;
  }

  function migrateStoredState(rawState, defaultEntries) {
    if (!isPlainObject(rawState) || ![LEGACY_SCHEMA_VERSION, PREVIOUS_SCHEMA_VERSION].includes(rawState.schemaVersion) || !Array.isArray(rawState.entries)) {
      return rawState;
    }

    const defaultCatalog = defaultEntryCatalog(defaultEntries);
    const seenDefaultIds = new Set();
    const entries = rawState.entries.map((entry) => {
      if (!isPlainObject(entry) || typeof entry.id !== "string") {
        return entry;
      }

      const defaultEntry = defaultCatalog.byId.get(entry.id.toLowerCase());

      if (!defaultEntry) {
        if (rawState.schemaVersion === PREVIOUS_SCHEMA_VERSION) {
          return entry;
        }

        return { type: "custom", id: entry.id, kind: entry.kind, value: entry.value };
      }

      seenDefaultIds.add(defaultEntry.id);

      if (rawState.schemaVersion === PREVIOUS_SCHEMA_VERSION) {
        return { ...defaultEntry, enabled: entry.enabled };
      }

      return { ...defaultEntry, enabled: true };
    });

    defaultCatalog.entries.forEach((entry) => {
      if (seenDefaultIds.has(entry.id)) {
        return;
      }

      entries.push({ ...entry, enabled: enabledForAddedDefault(entry, entries) });
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      entries,
      blockedPageHtml: rawState.blockedPageHtml,
      schedule: rawState.schedule,
      domainLimits: domainLimitsForEntries(entries, Array.isArray(rawState.domainLimits) ? rawState.domainLimits : [])
    };
  }

  function enabledForAddedDefault(entry, entries) {
    if (entry.value !== SUBREDDIT_FEEDS_VALUE) {
      return false;
    }

    const redditEntry = entries.find((candidate) => candidate.type === "default" && candidate.value === "reddit.com");

    return redditEntry ? redditEntry.enabled : false;
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

      if (entry.kind !== "url") {
        errors.push({ index, message: "Default entries must be URL entries." });
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

      return { type: "default", id, kind: "url", value: normalizeUrlEntryValue(entry.value), enabled: true };
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

    if (entry.kind !== "url") {
      errors.push({ index, message: "Default entries must be URL entries." });
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

    const host = stripLeadingWww(url.hostname.toLowerCase());

    if (host === "" || host.startsWith(".") || host.endsWith(".")) {
      throw new Error("Enter a valid hostname.");
    }

    if (host.split(".").some((label) => label === "" || label.startsWith("-") || label.endsWith("-"))) {
      throw new Error("Enter a valid hostname.");
    }

    if (!/^[a-z0-9.-]+$/.test(host)) {
      throw new Error("Domain entries must normalize to lowercase ASCII or punycode.");
    }

    if (isIpAddress(host)) {
      throw new Error("IP address blocking is not supported in this version.");
    }

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

    const host = stripLeadingWww(url.hostname.toLowerCase());
    const path = stripTrailingSlashes(url.pathname);
    const storedPath = path === "/" ? "" : path;
    const value = `${host}${storedPath}`;
    const alias = storedUrlAliasTarget(host, storedPath, value);

    if (alias) {
      return { value: alias, aliased: true };
    }

    return { value, aliased: false };
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

        return { type: "valid", schedule: DEFAULT_SCHEDULE };
      case "dailyWindow":
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
      default:
        return invalid([{ index: null, message: `Unknown schedule type: ${schedule.type}` }]);
    }
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

      pushUnknownKeyErrors(errors, limit, ["domain", "limitMinutes"], "Domain limit");

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

      seen.add(domain);
      domainLimits.push({ domain, limitMinutes: limit.limitMinutes });
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
    const existing = new Map(existingDomainLimits.map((limit) => [limit.domain, limit.limitMinutes]));

    return rawEntryDomains(entries).map((domain) => ({
      domain,
      limitMinutes: existing.has(domain) ? existing.get(domain) : DEFAULT_LIMIT_MINUTES
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
        return { type: "match", entry };
      }
    }

    return { type: "none" };
  }

  function findActiveMatchingEntry(state, rawUrl, date = new Date()) {
    if (!isScheduleActive(state.schedule, date)) {
      return { type: "none" };
    }

    return findMatchingEntry(state, rawUrl);
  }

  function findBlockedMatchingEntry(state, rawUrl, overLimitDomains, date = new Date()) {
    const match = findMatchingEntry(state, rawUrl);

    switch (match.type) {
      case "none":
        return { type: "none" };
      case "match":
        if (isScheduleActive(state.schedule, date)) {
          return match;
        }

        if (overLimitDomains.has(associatedDomainForEntry(match.entry))) {
          return match;
        }

        return { type: "none" };
      default:
        throw new Error(`Unknown match type: ${match.type}`);
    }
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
      case "always":
        return true;
      case "dailyWindow":
        return isDailyWindowActive(schedule, date);
      default:
        throw new Error(`Unknown schedule type: ${schedule.type}`);
    }
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
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "domainLimits"];
      default:
        return ["schemaVersion", "entries", "blockedPageHtml", "schedule", "domainLimits"];
    }
  }

  const BlockerCore = {
    DEFAULT_LIMIT_MINUTES,
    DEFAULT_BLOCKED_PAGE_HTML,
    DEFAULT_SCHEDULE,
    EDITABLE_KIND_LABELS,
    KIND_LABELS,
    MAX_LIMIT_MINUTES,
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
    findActiveMatchingEntry,
    findBlockedMatchingEntry,
    findMatchingEntry,
    isScheduleActive,
    newEntry,
    normalizeDomainEntryValue,
    normalizeBlockedPageHtml,
    normalizePageUrl,
    normalizeRegexEntryValue,
    permissionOriginsForState,
    normalizeUrlEntryValue,
    parseStoredState,
    screenTimeDomainForUrl,
    validateState
  };

  root.BlockerCore = BlockerCore;

  if (typeof module !== "undefined") {
    module.exports = BlockerCore;
  }
})(globalThis);
