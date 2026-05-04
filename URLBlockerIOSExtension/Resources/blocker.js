(function loadBlockerCore(root) {
  "use strict";

  const STATE_KEY = "blockerState";
  const SCHEMA_VERSION = 4;
  const MAX_ENTRIES = 1000;
  const MAX_BLOCKED_PAGE_HTML_LENGTH = 4000;
  const DEFAULT_BLOCKED_PAGE_HTML = "<h1>Blocked</h1><p>This page is on your blocklist.</p>";
  const ALL_WEBSITES_ORIGIN = "*://*/*";
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

  function emptyState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      entries: [],
      blockedPageHtml: DEFAULT_BLOCKED_PAGE_HTML
    };
  }

  function newEntry(kind) {
    if (!Object.hasOwn(KIND_LABELS, kind)) {
      throw new Error(`Unknown matcher kind: ${kind}`);
    }

    return { id: crypto.randomUUID(), kind, value: "" };
  }

  function validateState(rawState) {
    const errors = [];

    if (!isPlainObject(rawState)) {
      return invalid([{ index: null, message: "Blocklist data must be an object." }]);
    }

    if (rawState.schemaVersion !== 1 && rawState.schemaVersion !== 2 && rawState.schemaVersion !== 3 && rawState.schemaVersion !== SCHEMA_VERSION) {
      errors.push({ index: null, message: "Unsupported blocklist version. Reset the blocklist to repair it." });
    }

    pushUnknownKeyErrors(errors, rawState, stateKeys(rawState.schemaVersion), "Blocklist");

    if (!Array.isArray(rawState.entries)) {
      errors.push({ index: null, message: "Blocklist entries must be an array." });
    }

    if (rawState.schemaVersion >= 2 && typeof rawState.blockedPageHtml !== "string") {
      errors.push({ index: null, message: "Blocked page HTML must be a string." });
    }

    if (errors.length > 0) {
      return invalid(errors);
    }

    let blockedPageHtml = DEFAULT_BLOCKED_PAGE_HTML;

    try {
      if (rawState.schemaVersion >= 2) {
        blockedPageHtml = normalizeBlockedPageHtml(rawState.blockedPageHtml);
      }
    } catch (error) {
      errors.push({ index: null, message: error.message });
    }

    if (rawState.entries.length > MAX_ENTRIES) {
      errors.push({ index: null, message: `Blocklist is limited to ${MAX_ENTRIES} entries.` });
    }

    const entries = [];
    const seen = new Set();

    rawState.entries.forEach((entry, index) => {
      const result = normalizeEntry(entry, index);

      if (result.type === "invalid") {
        errors.push(...result.errors);
        return;
      }

      const duplicateKey = `${result.entry.kind}:${result.entry.value.toLowerCase()}`;

      if (seen.has(duplicateKey)) {
        errors.push({ index, message: "Duplicate entry after normalization." });
        return;
      }

      seen.add(duplicateKey);
      entries.push(result.entry);
    });

    if (errors.length > 0) {
      return invalid(errors);
    }

    return { type: "valid", state: { schemaVersion: SCHEMA_VERSION, entries, blockedPageHtml } };
  }

  function parseStoredState(rawState) {
    if (rawState === undefined) {
      return emptyState();
    }

    const result = validateState(rawState);

    if (result.type === "invalid") {
      throw new Error(result.errors.map((error) => error.message).join("\n"));
    }

    return result.state;
  }

  function normalizeEntry(entry, index) {
    const errors = [];

    if (!isPlainObject(entry)) {
      return invalid([{ index, message: "Entry must be an object." }]);
    }

    pushUnknownKeyErrors(errors, entry, ["id", "kind", "value"], "Entry", index);

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
      switch (entry.kind) {
        case "domain":
          return validEntry(entry, normalizeDomainEntryValue(entry.value));
        case "url":
          return validEntry(entry, normalizeUrlEntryValue(entry.value));
        case "urlWithSubpaths":
          return validEntry(entry, normalizeUrlEntryValue(entry.value));
        case "regex":
          return validEntry(entry, normalizeRegexEntryValue(entry.value));
        default:
          throw new Error(`Unknown matcher kind: ${entry.kind}`);
      }
    } catch (error) {
      return invalid([{ index, message: error.message }]);
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

    return `${host}${storedPath}`;
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

  function findMatchingEntry(state, rawUrl) {
    const result = normalizePageUrl(rawUrl);

    if (result.type === "invalid") {
      return { type: "none" };
    }

    for (const entry of state.entries) {
      if (entryMatchesUrl(entry, result.url)) {
        return { type: "match", entry };
      }
    }

    return { type: "none" };
  }

  function permissionOriginsForState(state) {
    const origins = [];
    let needsAllWebsites = false;

    for (const entry of state.entries) {
      switch (entry.kind) {
        case "domain":
          origins.push(`*://*.${entry.value}/*`);
          break;
        case "url":
        case "urlWithSubpaths":
          origins.push(`*://*.${splitStoredUrl(entry.value).host}/*`);
          break;
        case "regex":
          needsAllWebsites = true;
          break;
        default:
          throw new Error(`Unknown matcher kind: ${entry.kind}`);
      }
    }

    if (needsAllWebsites) {
      return [ALL_WEBSITES_ORIGIN];
    }

    return [...new Set(origins)].sort();
  }

  function entryMatchesUrl(entry, pageUrl) {
    switch (entry.kind) {
      case "domain":
        return domainMatchesUrl(entry.value, pageUrl);
      case "url":
        return makeContentRegex(entry).test(pageUrl.pathMatchUrl);
      case "urlWithSubpaths":
        return makeContentRegex(entry).test(pageUrl.pathMatchUrl);
      case "regex":
        return new RegExp(entry.value, "i").test(pageUrl.regexMatchUrl);
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
      const pathMatchUrl = `${base}${path === "/" ? "" : path}`;
      const regexMatchUrl = `${base}${url.pathname}${url.search}`;

      return {
        type: "valid",
        url: {
          host,
          pathMatchUrl,
          regexMatchUrl
        }
      };
    } catch {
      return invalidUrl();
    }
  }

  function domainMatchesUrl(domain, pageUrl) {
    return pageUrl.host === domain || pageUrl.host.endsWith(`.${domain}`);
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

  function validEntry(entry, value) {
    return { type: "valid", entry: { id: entry.id.toLowerCase(), kind: entry.kind, value } };
  }

  function invalid(errors) {
    return { type: "invalid", errors };
  }

  function invalidUrl() {
    return { type: "invalid" };
  }

  function stateKeys(schemaVersion) {
    switch (schemaVersion) {
      case 1:
        return ["schemaVersion", "entries"];
      case 2:
        return ["schemaVersion", "entries", "blockedPageHtml"];
      case 3:
        return ["schemaVersion", "entries", "blockedPageHtml", "useSafariBlockingApi"];
      case SCHEMA_VERSION:
        return ["schemaVersion", "entries", "blockedPageHtml"];
      default:
        return ["schemaVersion", "entries", "blockedPageHtml"];
    }
  }

  const BlockerCore = {
    DEFAULT_BLOCKED_PAGE_HTML,
    EDITABLE_KIND_LABELS,
    KIND_LABELS,
    MAX_BLOCKED_PAGE_HTML_LENGTH,
    MAX_ENTRIES,
    SCHEMA_VERSION,
    STATE_KEY,
    emptyState,
    entryMatchesUrl,
    findMatchingEntry,
    newEntry,
    normalizeDomainEntryValue,
    normalizeBlockedPageHtml,
    normalizePageUrl,
    normalizeRegexEntryValue,
    permissionOriginsForState,
    normalizeUrlEntryValue,
    parseStoredState,
    validateState
  };

  root.BlockerCore = BlockerCore;

  if (typeof module !== "undefined") {
    module.exports = BlockerCore;
  }
})(globalThis);
