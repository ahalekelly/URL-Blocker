const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../URLBlockerIOSExtension/Resources/blocker.js");
const defaultBlockedPages = require("../URLBlockerIOSExtension/Resources/default-blocked-pages.json");
const manifest = require("../URLBlockerIOSExtension/Resources/manifest.json");

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

  assert.deepEqual(state.entries.map(({ kind, value }) => ({ kind, value })), [
    { kind: "url", value: "x.com" },
    { kind: "url", value: "twitter.com" },
    { kind: "url", value: "youtube.com" },
    { kind: "url", value: "reddit.com" },
    { kind: "url", value: "ycombinator.com" }
  ]);
  assert.deepEqual(state.schedule, { type: "always" });
});

test("keeps install-time permissions aligned with default blocked pages", () => {
  assert.deepEqual(core.permissionOriginsForState(core.emptyState(defaultBlockedPages)), manifest.host_permissions);
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
  assert.equal(core.normalizeUrlEntryValue("https://twitter.com/home"), "twitter.com");
  assert.equal(core.normalizeUrlEntryValue("https://ycombinator.com/news"), "ycombinator.com");
  assert.throws(() => core.normalizeUrlEntryValue("ftp://example.com"), /http or https/);
  assert.throws(() => core.normalizeUrlEntryValue("https://user@example.com"), /usernames/);
  assert.throws(() => core.normalizeUrlEntryValue("https://example.com:8443/path"), /non-default ports/);
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
    schemaVersion: 1,
    entries: [{ id: ids[0], kind: "domain", value: "example.com" }]
  });

  assert.equal(valid.type, "valid");
  assert.deepEqual(valid.state.entries[0], { id: ids[0], kind: "domain", value: "example.com" });

  const unknownKey = core.validateState({
    schemaVersion: 1,
    entries: [{ id: ids[0], kind: "domain", value: "example.com", enabled: true }]
  });

  assert.equal(unknownKey.type, "invalid");
  assert.match(unknownKey.errors[0].message, /unknown key/);

  const unknownKind = core.validateState({
    schemaVersion: 1,
    entries: [{ id: ids[0], kind: "wildcard", value: "example.com" }]
  });

  assert.equal(unknownKind.type, "invalid");
  assert.match(unknownKind.errors[0].message, /known matcher/);

  const duplicate = core.validateState({
    schemaVersion: 1,
    entries: [
      { id: ids[0], kind: "domain", value: "www.example.com" },
      { id: ids[1], kind: "domain", value: "example.com" }
    ]
  });

  assert.equal(duplicate.type, "invalid");
  assert.match(duplicate.errors[0].message, /Duplicate/);
});

test("validates blocked page HTML and migrates old state", () => {
  const migrated = core.validateState({
    schemaVersion: 1,
    entries: [{ id: ids[0], kind: "url", value: "https://example.com/path?x=1" }]
  });

  assert.equal(migrated.type, "valid");
  assert.equal(migrated.state.schemaVersion, 5);
  assert.equal(migrated.state.entries[0].value, "example.com/path");
  assert.equal(migrated.state.blockedPageHtml, core.DEFAULT_BLOCKED_PAGE_HTML);
  assert.deepEqual(migrated.state.schedule, { type: "always" });

  const legacyApiSetting = core.validateState({
    schemaVersion: 3,
    entries: [{ id: ids[0], kind: "domain", value: "example.com" }],
    blockedPageHtml: "<p>Blocked.</p>",
    useSafariBlockingApi: true
  });

  assert.equal(legacyApiSetting.type, "valid");
  assert.equal(legacyApiSetting.state.schemaVersion, 5);
  assert.equal("useSafariBlockingApi" in legacyApiSetting.state, false);

  const custom = core.validateState({
    schemaVersion: 5,
    entries: [],
    blockedPageHtml: " <p><strong>Nope.</strong></p> ",
    schedule: { type: "always" }
  });

  assert.equal(custom.type, "valid");
  assert.equal(custom.state.blockedPageHtml, "<p><strong>Nope.</strong></p>");

  const script = core.validateState({
    schemaVersion: 5,
    entries: [],
    blockedPageHtml: "<img src=x onerror=alert(1)>",
    schedule: { type: "always" }
  });

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
    schemaVersion: 5,
    entries: [],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: { type: "dailyWindow", startMinute: 540, endMinute: 540 }
  });

  assert.equal(equalTimes.type, "invalid");
  assert.match(equalTimes.errors[0].message, /different/);
});

test("matches only when the schedule is active", () => {
  const state = validState(
    [{ id: ids[0], kind: "url", value: "example.com" }],
    { type: "dailyWindow", startMinute: 540, endMinute: 1020 }
  );

  assert.equal(core.findActiveMatchingEntry(state, "https://example.com", new Date(2026, 0, 1, 9, 30)).type, "match");
  assert.equal(core.findActiveMatchingEntry(state, "https://example.com", new Date(2026, 0, 1, 17, 0)).type, "none");
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
  assert.deepEqual(core.screenTimeDomainForUrl(state, "https://ignored.example/"), { type: "none" });
  assert.deepEqual(core.screenTimeDomainForUrl(state, "safari-web-extension://extension/options.html"), { type: "none" });
});

test("collapses alias-created duplicates during migration", () => {
  const migrated = core.validateState({
    schemaVersion: 4,
    entries: [
      { id: ids[0], kind: "url", value: "x.com" },
      { id: ids[1], kind: "url", value: "x.com/home" },
      { id: ids[2], kind: "url", value: "twitter.com/home" }
    ],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML
  });

  assert.equal(migrated.type, "valid");
  assert.deepEqual(migrated.state.entries.map(({ value }) => value), ["x.com", "twitter.com"]);

  const duplicate = core.validateState({
    schemaVersion: 5,
    entries: [
      { id: ids[0], kind: "url", value: "x.com" },
      { id: ids[1], kind: "url", value: "x.com/home" }
    ],
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule: { type: "always" }
  });

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

test("keeps root URL entries scoped to the root path", () => {
  const state = validState([
    { id: ids[0], kind: "url", value: "reddit.com" }
  ]);

  assert.equal(core.findMatchingEntry(state, "https://reddit.com").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://reddit.com/").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://reddit.com/r/safari").type, "none");
});

test("matches hardcoded URL aliases as their root URLs", () => {
  const state = validState([
    { id: ids[0], kind: "url", value: "x.com" },
    { id: ids[1], kind: "url", value: "twitter.com" },
    { id: ids[2], kind: "url", value: "ycombinator.com" }
  ]);

  assert.equal(core.findMatchingEntry(state, "https://x.com/home").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://www.twitter.com/home?src=nav").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://news.ycombinator.com/news").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://ycombinator.com/news").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://x.com/messages").type, "none");
});

test("maps blocklist entries to host permissions", () => {
  const state = validState([
    { id: ids[0], kind: "url", value: "https://reddit.com/popular" },
    { id: ids[1], kind: "urlWithSubpaths", value: "https://old.reddit.com/r/safari" },
    { id: ids[2], kind: "domain", value: "example.com" }
  ]);

  assert.deepEqual(core.permissionOriginsForState(state), [
    "*://*.example.com/*",
    "*://*.old.reddit.com/*",
    "*://*.reddit.com/*"
  ]);
});

test("maps regex entries to all-website permissions", () => {
  const state = validState([
    { id: ids[1], kind: "domain", value: "example.com" },
    { id: ids[0], kind: "regex", value: "^https://x\\.com/(home|explore)/?$" }
  ]);

  assert.deepEqual(core.permissionOriginsForState(state), ["*://*/*"]);
});

test("matches regex entries case-insensitively without fragments", () => {
  const state = validState([
    { id: ids[0], kind: "regex", value: "^https://x\\.com/(home|explore)/?$" }
  ]);

  assert.equal(core.findMatchingEntry(state, "https://x.com/HOME/#feed").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://x.com/messages").type, "none");
});

function validState(entries, schedule = core.DEFAULT_SCHEDULE) {
  const result = core.validateState({
    schemaVersion: 5,
    entries,
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    schedule
  });

  assert.equal(result.type, "valid");

  return result.state;
}
