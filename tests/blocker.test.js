const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../URLBlockerWebExtension/blocker.js");
const defaultBlockedPages = require("../URLBlockerWebExtension/default-blocked-pages.json");
const manifest = require("../URLBlockerWebExtension/manifest.json");

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555"
];

test("labels matcher options in display order", () => {
  assert.deepEqual(Object.entries(core.EDITABLE_KIND_LABELS), [
    ["url", "URL"],
    ["urlWithSubpaths", "URL and subpaths"],
    ["domain", "Full domain"],
    ["regex", "Custom regex"]
  ]);

  assert.deepEqual(Object.entries(core.KIND_LABELS), [
    ["url", "URL"],
    ["urlWithSubpaths", "URL and subpaths"],
    ["domain", "Full domain"],
    ["regex", "Custom regex"]
  ]);
});

test("loads default blocked pages for new installs", () => {
  const state = core.emptyState(defaultBlockedPages);

  assert.deepEqual(state.entries.map(({ type, kind, value, enabled }) => ({ type, kind, value, enabled })), [
    { type: "default", kind: "url", value: "x.com", enabled: true },
    { type: "default", kind: "url", value: "instagram.com", enabled: true },
    { type: "default", kind: "url", value: "instagram.com/explore", enabled: true },
    { type: "default", kind: "url", value: "instagram.com/reels", enabled: true },
    { type: "default", kind: "url", value: "tiktok.com", enabled: true },
    { type: "default", kind: "url", value: "tiktok.com/following", enabled: true },
    { type: "default", kind: "url", value: "tiktok.com/discover", enabled: true },
    { type: "default", kind: "url", value: "facebook.com", enabled: true },
    { type: "default", kind: "url", value: "facebook.com/watch", enabled: true },
    { type: "default", kind: "url", value: "facebook.com/reel", enabled: true },
    { type: "default", kind: "url", value: "facebook.com/groups/feed", enabled: true },
    { type: "default", kind: "url", value: "threads.com", enabled: true },
    { type: "default", kind: "url", value: "threads.com/following", enabled: true },
    { type: "default", kind: "url", value: "bsky.app", enabled: true },
    { type: "default", kind: "url", value: "bsky.app/profile/bsky.app/feed/whats-hot", enabled: true },
    { type: "default", kind: "url", value: "pinterest.com", enabled: true },
    { type: "default", kind: "url", value: "pinterest.com/today", enabled: true },
    { type: "default", kind: "url", value: "pinterest.com/ideas", enabled: true },
    { type: "default", kind: "url", value: "linkedin.com", enabled: true },
    { type: "default", kind: "url", value: "youtube.com", enabled: true },
    { type: "default", kind: "url", value: "reddit.com", enabled: true },
    { type: "default", kind: "url", value: "reddit.com/r/*", enabled: true },
    { type: "default", kind: "url", value: "ycombinator.com", enabled: true }
  ]);
  assert.deepEqual(state.schedule, { type: "dailyWindow", startMinute: 1380, endMinute: 1140 });
  assert.deepEqual(state.limitReset, { type: "rollingWindow", windowHours: 24 });
  assert.deepEqual(state.settingsDelay, { delayMinutes: 60 });
  assert.deepEqual(state.domainLimits, [
    { domain: "bsky.app", limitMinutes: core.DEFAULT_LIMIT_MINUTES },
    { domain: "facebook.com", limitMinutes: core.DEFAULT_LIMIT_MINUTES },
    { domain: "instagram.com", limitMinutes: core.DEFAULT_LIMIT_MINUTES },
    { domain: "linkedin.com", limitMinutes: core.DEFAULT_LIMIT_MINUTES },
    { domain: "pinterest.com", limitMinutes: core.DEFAULT_LIMIT_MINUTES },
    { domain: "reddit.com", limitMinutes: core.DEFAULT_LIMIT_MINUTES },
    { domain: "threads.com", limitMinutes: core.DEFAULT_LIMIT_MINUTES },
    { domain: "tiktok.com", limitMinutes: core.DEFAULT_LIMIT_MINUTES },
    { domain: "x.com", limitMinutes: core.DEFAULT_LIMIT_MINUTES },
    { domain: "ycombinator.com", limitMinutes: core.DEFAULT_LIMIT_MINUTES },
    { domain: "youtube.com", limitMinutes: core.DEFAULT_LIMIT_MINUTES }
  ]);
});

test("keeps install-time permissions aligned with default blocked pages", () => {
  assert.deepEqual([
    "https://*.supabase.co/*",
    ...core.permissionOriginsForState(core.emptyState(defaultBlockedPages))
  ], manifest.host_permissions);
});

test("keeps default entries locked but configurable", () => {
  const defaultEntry = core.emptyState(defaultBlockedPages.slice(0, 1)).entries[0];
  const disabledState = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [{ ...defaultEntry, enabled: false }],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: core.DEFAULT_SCHEDULE,
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: [{ domain: "x.com", limitMinutes: 12 }]
  }, defaultBlockedPages.slice(0, 1));

  assert.equal(disabledState.type, "valid");
  assert.deepEqual(core.permissionOriginsForState(disabledState.state), []);
  assert.deepEqual(core.findMatchingEntry(disabledState.state, "https://x.com"), { type: "none" });
  assert.deepEqual(core.screenTimeDomainForUrl(disabledState.state, "https://x.com"), { type: "none" });
  assert.deepEqual(disabledState.state.domainLimits, [{ domain: "x.com", limitMinutes: 12 }]);

  const editedDefault = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [{ ...defaultEntry, value: "example.com" }],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: core.DEFAULT_SCHEDULE,
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: [{ domain: "example.com", limitMinutes: 30 }]
  }, defaultBlockedPages.slice(0, 1));

  assert.equal(editedDefault.type, "invalid");
  assert.match(editedDefault.errors[0].message, /default URL/);

  const missingDefault = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: core.DEFAULT_SCHEDULE,
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: []
  }, defaultBlockedPages.slice(0, 1));

  assert.equal(missingDefault.type, "invalid");
  assert.match(missingDefault.errors[0].message, /Missing default entry/);
});

test("normalizes old linkedin feed default entries", () => {
  const linkedinDefault = defaultBlockedPages.find((entry) => entry.value === "linkedin.com");
  const state = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [{ ...linkedinDefault, value: "linkedin.com/feed" }],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: core.DEFAULT_SCHEDULE,
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: [{ domain: "linkedin.com", limitMinutes: 30 }]
  }, [linkedinDefault]);

  assert.equal(state.type, "valid");
  assert.equal(state.state.entries[0].value, "linkedin.com");
});

test("migrates legacy default entries and deleted defaults", () => {
  const defaults = defaultBlockedPages.slice(0, 2);
  const state = validStoredState({
    schemaVersion: 6,
    entries: [
      { id: defaults[0].id, kind: defaults[0].kind, value: defaults[0].value },
      { id: ids[0], kind: "domain", value: "example.com" }
    ],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: core.DEFAULT_SCHEDULE,
    domainLimits: [
      { domain: defaults[0].value, limitMinutes: 9 },
      { domain: "example.com", limitMinutes: 20 }
    ]
  }, defaults);

  assert.deepEqual(state.entries, [
    { type: "default", id: defaults[0].id, kind: "url", value: defaults[0].value, enabled: true },
    { type: "custom", id: ids[0], kind: "domain", value: "example.com" },
    { type: "default", id: defaults[1].id, kind: "url", value: defaults[1].value, enabled: false }
  ]);
  assert.deepEqual(state.domainLimits, [
    { domain: "example.com", limitMinutes: 20 },
    { domain: "instagram.com", limitMinutes: core.DEFAULT_LIMIT_MINUTES },
    { domain: "x.com", limitMinutes: 9 }
  ]);
  assert.deepEqual(state.limitReset, core.DEFAULT_LIMIT_RESET);
});

test("migrates schema 7 states to split subreddit feeds from reddit", () => {
  const oldDefaultEntries = defaultBlockedPages
    .filter((entry) => entry.value !== "reddit.com/r/*")
    .map((entry) => ({ ...entry, enabled: entry.value !== "reddit.com" }));
  const state = validStoredState({
    schemaVersion: 7,
    entries: oldDefaultEntries,
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: core.DEFAULT_SCHEDULE,
    domainLimits: core.domainLimitsForEntries(oldDefaultEntries, [{ domain: "reddit.com", limitMinutes: 12 }])
  }, defaultBlockedPages);
  const redditEntry = state.entries.find((entry) => entry.value === "reddit.com");
  const subredditEntry = state.entries.find((entry) => entry.value === "reddit.com/r/*");

  assert.equal(redditEntry.enabled, false);
  assert.equal(subredditEntry.enabled, false);
  assert.deepEqual(state.domainLimits.find((limit) => limit.domain === "reddit.com"), {
    domain: "reddit.com",
    limitMinutes: 12
  });
  assert.deepEqual(state.limitReset, core.DEFAULT_LIMIT_RESET);
});

test("migrates schema 9 states to drop the removed facebook.com/home.php default", () => {
  const removedId = "10000000-0000-4000-8000-000000000016";
  const previousDefaults = [
    ...defaultBlockedPages.slice(0, defaultBlockedPages.findIndex((entry) => entry.value === "facebook.com") + 1),
    { type: "default", id: removedId, kind: "url", value: "facebook.com/home.php", enabled: true },
    ...defaultBlockedPages.slice(defaultBlockedPages.findIndex((entry) => entry.value === "facebook.com") + 1)
  ];
  const previousEntries = previousDefaults.map((entry) => ({ ...entry, enabled: true }));
  const state = validStoredState({
    schemaVersion: 9,
    entries: previousEntries,
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: core.DEFAULT_SCHEDULE,
    limitReset: core.DEFAULT_LIMIT_RESET,
    domainLimits: core.domainLimitsForEntries(previousEntries, [])
  }, defaultBlockedPages);

  assert.equal(state.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(state.entries.find((entry) => entry.id === removedId), undefined);
  assert.ok(state.entries.find((entry) => entry.value === "facebook.com"));
});

test("migrates schema 10 states to current social defaults", () => {
  const forYouId = "10000000-0000-4000-8000-000000000012";
  const reelsId = "10000000-0000-4000-8000-000000000019";
  const previousDefaults = defaultBlockedPages.flatMap((entry) => {
    if (entry.value === "tiktok.com") {
      return [entry, { type: "default", id: forYouId, kind: "url", value: "tiktok.com/foryou", enabled: true }];
    }

    if (entry.value === "tiktok.com/discover") {
      return [{ ...entry, value: "tiktok.com/explore" }];
    }

    if (entry.value === "facebook.com/reel") {
      return [entry, { type: "default", id: reelsId, kind: "url", value: "facebook.com/reels", enabled: true }];
    }

    return [entry];
  });
  const previousEntries = previousDefaults.map((entry) => ({ ...entry, enabled: true }));
  const state = validStoredState({
    schemaVersion: 10,
    entries: previousEntries,
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: core.DEFAULT_SCHEDULE,
    limitReset: core.DEFAULT_LIMIT_RESET,
    domainLimits: core.domainLimitsForEntries(previousEntries, [])
  }, defaultBlockedPages);

  assert.equal(state.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(state.entries.find((entry) => entry.id === forYouId), undefined);
  assert.equal(state.entries.find((entry) => entry.id === reelsId), undefined);
  assert.equal(state.entries.find((entry) => entry.value === "tiktok.com/explore"), undefined);
  assert.ok(state.entries.find((entry) => entry.value === "tiktok.com/discover"));
});

test("migrates schema 8 states to default rolling limit resets", () => {
  const oldState = validState([
    { id: ids[0], kind: "domain", value: "example.com" }
  ]);
  const state = validStoredState({
    schemaVersion: 8,
    entries: oldState.entries,
    blockedPageHtml: oldState.blockedPageHtml,
    schedule: oldState.schedule,
    domainLimits: oldState.domainLimits
  }, []);

  assert.deepEqual(state.limitReset, core.DEFAULT_LIMIT_RESET);
});

test("migrates schema 12 settings delay modes to minute values", () => {
  const oldState = validState([]);
  const immediate = validStoredState({
    ...oldState,
    schemaVersion: 12,
    settingsDelay: { type: "immediate" }
  }, []);
  const delayed = validStoredState({
    ...oldState,
    schemaVersion: 12,
    settingsDelay: { type: "delayed", delayMinutes: 17 }
  }, []);

  assert.deepEqual(immediate.settingsDelay, { delayMinutes: 0 });
  assert.deepEqual(delayed.settingsDelay, { delayMinutes: 17 });
});

test("maps URL alias source hosts to permissions", () => {
  const state = validState([
    { id: ids[0], kind: "url", value: "x.com" }
  ]);

  assert.deepEqual(core.permissionOriginsForState(state), ["*://*.twitter.com/*", "*://*.x.com/*"]);
});

test("normalizes URL entries for path-based matching", () => {
  assert.equal(
    core.normalizeUrlEntryValue(" HTTPS://www.Reddit.com:443/popular/?foo=bar#feed "),
    "reddit.com/popular"
  );
  assert.equal(core.normalizeUrlEntryValue("https://example.com/"), "example.com");
  assert.equal(core.normalizeUrlEntryValue("http://example.com:80/Docs/"), "example.com/Docs");
  assert.equal(core.normalizeUrlEntryValue("Example.com/Docs/?x=1#top"), "example.com/Docs");
  assert.equal(core.normalizeUrlEntryValue("https://x.com/home"), "x.com");
  assert.equal(core.normalizeUrlEntryValue("https://twitter.com"), "x.com");
  assert.equal(core.normalizeUrlEntryValue("https://twitter.com/home"), "x.com");
  assert.equal(core.normalizeUrlEntryValue("https://tiktok.com/foryou"), "tiktok.com");
  assert.equal(core.normalizeUrlEntryValue("https://ycombinator.com/news"), "ycombinator.com");
  assert.equal(core.normalizeUrlEntryValue("https://linkedin.com/feed?trk=nav"), "linkedin.com");
  assert.equal(core.normalizeUrlEntryValue("https://old.reddit.com/r/safari/top?t=month"), "reddit.com/r/*");
  assert.throws(() => core.normalizeUrlEntryValue("ftp://example.com"), /http or https/);
  assert.throws(() => core.normalizeUrlEntryValue("https://user@example.com"), /usernames/);
  assert.throws(() => core.normalizeUrlEntryValue("https://example.com:8443/path"), /non-default ports/);
  assert.throws(() => core.normalizeUrlEntryValue("exa_mple.com/path"), /lowercase ASCII/);
});

test("normalizes domain entries and rejects unsupported hosts", () => {
  assert.equal(core.normalizeDomainEntryValue(" WWW.Example.com "), "example.com");
  assert.equal(core.normalizeDomainEntryValue("Bücher.example"), "xn--bcher-kva.example");
  assert.throws(() => core.normalizeDomainEntryValue("https://example.com"), /hostname/);
  assert.throws(() => core.normalizeDomainEntryValue("example.com/path"), /paths/);
  assert.throws(() => core.normalizeDomainEntryValue("example..com"), /valid hostname/);
  assert.throws(() => core.normalizeDomainEntryValue("127.0.0.1"), /IP address/);
});

test("validates state strictly", () => {
  const valid = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: customEntries([{ id: ids[0], kind: "domain", value: "example.com" }]),
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: { type: "always" },
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: [{ domain: "example.com", limitMinutes: 30 }]
  }, []);

  assert.equal(valid.type, "valid");
  assert.deepEqual(valid.state.entries[0], { type: "custom", id: ids[0], kind: "domain", value: "example.com" });

  const unknownKey = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [{ type: "custom", id: ids[0], kind: "domain", value: "example.com", enabled: true }],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: { type: "always" },
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: [{ domain: "example.com", limitMinutes: 30 }]
  }, []);

  assert.equal(unknownKey.type, "invalid");
  assert.match(unknownKey.errors[0].message, /unknown key/);

  const unknownKind = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [{ type: "custom", id: ids[0], kind: "wildcard", value: "example.com" }],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: { type: "always" },
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: []
  }, []);

  assert.equal(unknownKind.type, "invalid");
  assert.match(unknownKind.errors[0].message, /known matcher/);

  const duplicate = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: customEntries([
      { id: ids[0], kind: "domain", value: "www.example.com" },
      { id: ids[1], kind: "domain", value: "example.com" }
    ]),
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: { type: "always" },
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: [{ domain: "example.com", limitMinutes: 30 }]
  }, []);

  assert.equal(duplicate.type, "invalid");
  assert.match(duplicate.errors[0].message, /Duplicate/);
});

test("validates blocked page HTML and rejects old state", () => {
  const oldState = core.validateState({
    schemaVersion: 1,
    entries: [{ id: ids[0], kind: "url", value: "https://example.com/path?x=1" }]
  }, []);

  assert.equal(oldState.type, "invalid");
  assert.match(oldState.errors[0].message, /Unsupported/);

  const custom = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [],
    blockedPageHtml: " <p><strong>Nope.</strong></p> ",
    schedule: { type: "always" },
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: []
  }, []);

  assert.equal(custom.type, "valid");
  assert.equal(custom.state.blockedPageHtml, "<p><strong>Nope.</strong></p>");

  const script = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [],
    blockedPageHtml: "<img src=x onerror=alert(1)>",
    schedule: { type: "always" },
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: []
  }, []);

  assert.equal(script.type, "invalid");
  assert.match(script.errors[0].message, /inline scripts/);
});

test("validates schedules and detects active windows", () => {
  assert.equal(core.isScheduleActive({ type: "always" }, new Date(2026, 0, 1, 12, 0)), true);
  assert.equal(core.isScheduleActive({ type: "dailyWindow", startMinute: 540, endMinute: 1020 }, new Date(2026, 0, 1, 9, 30)), true);
  assert.equal(core.isScheduleActive({ type: "dailyWindow", startMinute: 540, endMinute: 1020 }, new Date(2026, 0, 1, 17, 0)), false);
  assert.equal(core.isScheduleActive({ type: "dailyWindow", startMinute: 1320, endMinute: 420 }, new Date(2026, 0, 1, 23, 0)), true);
  assert.equal(core.isScheduleActive({ type: "dailyWindow", startMinute: 1320, endMinute: 420 }, new Date(2026, 0, 1, 6, 30)), true);
  assert.equal(core.isScheduleActive({ type: "dailyWindow", startMinute: 1320, endMinute: 420 }, new Date(2026, 0, 1, 12, 0)), false);

  const equalTimes = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: { type: "dailyWindow", startMinute: 540, endMinute: 540 },
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: []
  }, []);

  assert.equal(equalTimes.type, "invalid");
  assert.match(equalTimes.errors[0].message, /different/);
});

test("validates limit reset settings", () => {
  assert.deepEqual(validState([], core.DEFAULT_SCHEDULE, [], { type: "rollingWindow", windowHours: 4 }).limitReset, {
    type: "rollingWindow",
    windowHours: 4
  });
  assert.deepEqual(validState([], core.DEFAULT_SCHEDULE, [], { type: "daily", resetHour: 6 }).limitReset, {
    type: "daily",
    resetHour: 6
  });

  const invalidDailyReset = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: core.DEFAULT_SCHEDULE,
    limitReset: { type: "daily", resetHour: 6.5 },
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: []
  }, []);

  assert.equal(invalidDailyReset.type, "invalid");
  assert.match(invalidDailyReset.errors[0].message, /hour/);
});

test("validates settings delay settings", () => {
  const immediate = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: core.DEFAULT_SCHEDULE,
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: { delayMinutes: 0 },
    domainLimits: []
  }, []);
  const invalidDelay = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: core.DEFAULT_SCHEDULE,
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: { delayMinutes: -1 },
    domainLimits: []
  }, []);

  assert.equal(immediate.type, "valid");
  assert.equal(core.settingsDelayMinutes(immediate.state.settingsDelay), 0);
  assert.equal(invalidDelay.type, "invalid");
  assert.match(invalidDelay.errors[0].message, /between 0/);
});

test("matches only when the schedule is active", () => {
  const state = validState(
    [{ id: ids[0], kind: "url", value: "example.com" }],
    { type: "dailyWindow", startMinute: 540, endMinute: 1020 }
  );

  assert.equal(core.findBlockedMatchingEntry(state, "https://example.com", new Set(), new Date(2026, 0, 1, 9, 30)).type, "match");
  assert.equal(core.findBlockedMatchingEntry(state, "https://example.com", new Set(), new Date(2026, 0, 1, 17, 0)).type, "none");
});

test("matches when the schedule is active or the domain is over limit", () => {
  const state = validState(
    [{ id: ids[0], kind: "url", value: "example.com/focus" }],
    { type: "dailyWindow", startMinute: 540, endMinute: 1020 }
  );

  assert.equal(core.findBlockedMatchingEntry(state, "https://example.com/focus", new Set(), new Date(2026, 0, 1, 9, 30)).type, "match");
  assert.equal(core.findBlockedMatchingEntry(state, "https://example.com/focus", new Set(), new Date(2026, 0, 1, 17, 0)).type, "none");
  assert.equal(core.findBlockedMatchingEntry(state, "https://example.com/focus", new Set(["example.com"]), new Date(2026, 0, 1, 17, 0)).type, "match");
  assert.equal(core.findBlockedMatchingEntry(state, "https://example.com/other", new Set(["example.com"]), new Date(2026, 0, 1, 17, 0)).type, "none");
});

test("finds screen time domains by host only", () => {
  const state = validState([
    { id: ids[0], kind: "url", value: "https://example.com/focus" },
    { id: ids[1], kind: "urlWithSubpaths", value: "https://news.example.org/latest" },
    { id: ids[2], kind: "domain", value: "example.net" },
    { id: ids[3], kind: "regex", value: "^https://ignored\\.example/" }
  ]);

  assert.deepEqual(core.screenTimeDomainForUrl(state, "https://www.example.com/anything"), {
    type: "match",
    domain: "example.com"
  });
  assert.deepEqual(core.screenTimeDomainForUrl(state, "https://updates.news.example.org/archive"), {
    type: "match",
    domain: "news.example.org"
  });
  assert.deepEqual(core.screenTimeDomainForUrl(state, "https://deep.example.net/path"), {
    type: "match",
    domain: "example.net"
  });
  assert.deepEqual(core.screenTimeDomainForUrl(state, "https://ignored.example/other"), {
    type: "match",
    domain: "ignored.example"
  });
  assert.deepEqual(core.screenTimeDomainForUrl(state, "safari-web-extension://extension/options.html"), { type: "none" });
});

test("finds screen time domains through URL host aliases", () => {
  const state = validState([
    { id: ids[0], kind: "url", value: "x.com" }
  ]);

  assert.deepEqual(core.screenTimeDomainForUrl(state, "https://twitter.com/messages"), {
    type: "match",
    domain: "x.com"
  });
});

test("validates domain limits against associated domains", () => {
  const state = validState([
    { id: ids[0], kind: "url", value: "https://example.com/focus" },
    { id: ids[1], kind: "urlWithSubpaths", value: "https://example.com/other" },
    { id: ids[2], kind: "domain", value: "news.example.com" }
  ], core.DEFAULT_SCHEDULE, [
    { domain: "example.com", limitMinutes: 45 },
    { domain: "news.example.com", limitMinutes: 10 }
  ]);

  assert.deepEqual(state.domainLimits, [
    { domain: "example.com", limitMinutes: 45 },
    { domain: "news.example.com", limitMinutes: 10 }
  ]);

  const missing = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: customEntries([{ id: ids[0], kind: "domain", value: "example.com" }]),
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: { type: "always" },
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: []
  }, []);

  assert.equal(missing.type, "invalid");
  assert.match(missing.errors[0].message, /Missing domain limit/);

  const extra = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: [],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: { type: "always" },
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: [{ domain: "example.com", limitMinutes: 30 }]
  }, []);

  assert.equal(extra.type, "invalid");
  assert.match(extra.errors[0].message, /does not match/);
});

test("infers literal regex hosts for limits", () => {
  assert.equal(core.domainForRegexEntryValue("^https://x\\.com/(home|explore)/?$"), "x.com");
  assert.equal(core.domainForRegexEntryValue("^https?://www\\.example\\.com/.*$"), "example.com");
  assert.throws(() => core.domainForRegexEntryValue("^https://(?:www\\.)?example\\.com/"), /literal/);
  assert.throws(() => core.domainForRegexEntryValue("^https://(x|twitter)\\.com/"), /literal/);

  const valid = validState([
    { id: ids[0], kind: "regex", value: "^https://x\\.com/(home|explore)/?$" }
  ]);

  assert.deepEqual(valid.domainLimits, [{ domain: "x.com", limitMinutes: core.DEFAULT_LIMIT_MINUTES }]);
});

test("rejects duplicate entries after normalization", () => {
  const duplicate = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: customEntries([
      { id: ids[0], kind: "url", value: "x.com" },
      { id: ids[1], kind: "url", value: "x.com/home" }
    ]),
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: { type: "always" },
    limitReset: core.DEFAULT_LIMIT_RESET,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: [{ domain: "x.com", limitMinutes: 30 }]
  }, []);

  assert.equal(duplicate.type, "invalid");
  assert.match(duplicate.errors[0].message, /Duplicate/);
});

test("matches domains without matching text-similar hosts", () => {
  const state = validState([
    { id: ids[0], kind: "domain", value: "example.com" }
  ]);

  assert.equal(core.findMatchingEntry(state, "https://example.com").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://a.b.example.com/path").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://not-example.com").type, "none");
});

test("matches URL paths across schemes and subdomains", () => {
  const state = validState([
    { id: ids[0], kind: "url", value: "reddit.com/popular" }
  ]);

  [
    "https://reddit.com/popular",
    "http://reddit.com/popular/",
    "https://www.reddit.com/popular?foo=bar",
    "https://old.reddit.com/popular#feed",
    "https://reddit.com/popular/?foo=bar"
  ].forEach((url) => assert.equal(core.findMatchingEntry(state, url).type, "match", url));

  [
    "https://reddit.com/popular/foo",
    "https://reddit.com/popularity",
    "https://not-reddit.com/popular"
  ].forEach((url) => assert.equal(core.findMatchingEntry(state, url).type, "none", url));
});

test("matches URL subpaths without matching sibling prefixes", () => {
  const state = validState([
    { id: ids[0], kind: "urlWithSubpaths", value: "reddit.com/popular" }
  ]);

  [
    "https://reddit.com/popular",
    "https://reddit.com/popular/",
    "https://reddit.com/popular/foo",
    "https://old.reddit.com/popular/foo?bar=baz"
  ].forEach((url) => assert.equal(core.findMatchingEntry(state, url).type, "match", url));

  assert.equal(core.findMatchingEntry(state, "https://reddit.com/popularity").type, "none");
});

test("matches root reddit and subreddit feed entries separately", () => {
  const rootState = validState([
    { id: ids[0], kind: "url", value: "reddit.com" }
  ]);
  const subredditState = validState([
    { id: ids[1], kind: "url", value: "reddit.com/r/*" }
  ]);

  assert.equal(core.findMatchingEntry(rootState, "https://reddit.com").type, "match");
  assert.equal(core.findMatchingEntry(rootState, "https://reddit.com/").type, "match");
  assert.equal(core.findMatchingEntry(rootState, "https://reddit.com/r/safari").type, "none");
  assert.equal(core.findMatchingEntry(subredditState, "https://reddit.com").type, "none");
  assert.equal(core.findMatchingEntry(subredditState, "https://reddit.com/r/safari").type, "match");
  assert.equal(core.findMatchingEntry(subredditState, "https://old.reddit.com/r/safari/new?sort=hour").type, "match");
  assert.equal(core.findMatchingEntry(subredditState, "https://reddit.com/r/safari/comments/123/post").type, "none");
});

test("matches hardcoded URL aliases as their root URLs", () => {
  const state = validState([
    { id: ids[0], kind: "url", value: "x.com" },
    { id: ids[1], kind: "url", value: "ycombinator.com" },
    { id: ids[2], kind: "url", value: "linkedin.com" },
    { id: ids[3], kind: "url", value: "facebook.com" },
    { id: ids[4], kind: "url", value: "tiktok.com" }
  ]);

  assert.equal(core.findMatchingEntry(state, "https://x.com/home").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://twitter.com").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://www.twitter.com/home?src=nav").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://news.ycombinator.com/news").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://ycombinator.com/news").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://www.linkedin.com/feed?trk=nav").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://facebook.com/home.php").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://www.facebook.com/home.php?ref=nav").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://www.tiktok.com/foryou").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://x.com/messages").type, "none");
  assert.equal(core.findMatchingEntry(state, "https://twitter.com/messages").type, "none");
  assert.equal(core.findMatchingEntry(state, "https://linkedin.com/jobs").type, "none");
  assert.equal(core.findMatchingEntry(state, "https://facebook.com/messages").type, "none");
  assert.equal(core.findMatchingEntry(state, "https://tiktok.com/following").type, "none");
});

test("maps blocklist entries to host permissions", () => {
  const state = validState([
    { id: ids[0], kind: "url", value: "https://reddit.com/popular" },
    { id: ids[1], kind: "urlWithSubpaths", value: "https://old.reddit.com/user/safari" },
    { id: ids[2], kind: "domain", value: "example.com" }
  ]);

  assert.deepEqual(core.permissionOriginsForState(state), [
    "*://*.example.com/*",
    "*://*.old.reddit.com/*",
    "*://*.reddit.com/*"
  ]);
});

test("maps regex entries to their literal host permissions", () => {
  const state = validState([
    { id: ids[1], kind: "domain", value: "example.com" },
    { id: ids[0], kind: "regex", value: "^https://x\\.com/(home|explore)/?$" }
  ]);

  assert.deepEqual(core.permissionOriginsForState(state), ["*://*.example.com/*", "*://*.x.com/*"]);
});

test("matches regex entries case-insensitively without fragments", () => {
  const state = validState([
    { id: ids[0], kind: "regex", value: "^https://x\\.com/(home|explore)/?$" }
  ]);

  assert.equal(core.findMatchingEntry(state, "https://x.com/HOME/#feed").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://x.com/messages").type, "none");
  assert.equal(core.findMatchingEntry(state, "https://not-x.com/home").type, "none");
});

function validState(entries, schedule = core.DEFAULT_SCHEDULE, domainLimits, limitReset = core.DEFAULT_LIMIT_RESET) {
  const typedEntries = customEntries(entries);
  const result = core.validateState({
    schemaVersion: core.SCHEMA_VERSION,
    entries: typedEntries,
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule,
    limitReset,
    settingsDelay: core.DEFAULT_SETTINGS_DELAY,
    domainLimits: domainLimits === undefined ? core.domainLimitsForEntries(typedEntries, []) : domainLimits
  }, []);

  assert.equal(result.type, "valid");

  return result.state;
}

function validStoredState(rawState, defaultEntries) {
  const result = core.validateStoredState(rawState, defaultEntries);

  assert.equal(result.type, "valid");

  return result.state;
}

function customEntries(entries) {
  return entries.map((entry) => ({ type: "custom", ...entry }));
}
