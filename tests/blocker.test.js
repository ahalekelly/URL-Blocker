const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../URLBlockerIOSExtension/Resources/blocker.js");

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444"
];

test("labels matcher options in display order", () => {
  assert.deepEqual(Object.entries(core.KIND_LABELS), [
    ["url", "URL"],
    ["urlWithSubpaths", "URL and subpaths"],
    ["domain", "Full domain"],
    ["regex", "Custom regex"]
  ]);
});

test("normalizes URL entries for path-based matching", () => {
  assert.equal(
    core.normalizeUrlEntryValue(" HTTPS://www.Reddit.com:443/popular/?foo=bar#feed "),
    "reddit.com/popular"
  );
  assert.equal(core.normalizeUrlEntryValue("https://example.com/"), "example.com");
  assert.equal(core.normalizeUrlEntryValue("http://example.com:80/Docs/"), "example.com/Docs");
  assert.equal(core.normalizeUrlEntryValue("Example.com/Docs/?x=1#top"), "example.com/Docs");
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
  assert.equal(migrated.state.schemaVersion, 3);
  assert.equal(migrated.state.entries[0].value, "example.com/path");
  assert.equal(migrated.state.blockedPageHtml, core.DEFAULT_BLOCKED_PAGE_HTML);
  assert.equal(migrated.state.useSafariBlockingApi, false);

  const custom = core.validateState({
    schemaVersion: 3,
    entries: [],
    blockedPageHtml: " <p><strong>Nope.</strong></p> ",
    useSafariBlockingApi: true
  });

  assert.equal(custom.type, "valid");
  assert.equal(custom.state.blockedPageHtml, "<p><strong>Nope.</strong></p>");
  assert.equal(custom.state.useSafariBlockingApi, true);

  const script = core.validateState({
    schemaVersion: 3,
    entries: [],
    blockedPageHtml: "<img src=x onerror=alert(1)>",
    useSafariBlockingApi: false
  });

  assert.equal(script.type, "invalid");
  assert.match(script.errors[0].message, /inline scripts/);
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

test("matches regex entries case-insensitively without fragments", () => {
  const state = validState([
    { id: ids[0], kind: "regex", value: "^https://x\\.com/(home|explore)/?$" }
  ]);

  assert.equal(core.findMatchingEntry(state, "https://x.com/HOME/#feed").type, "match");
  assert.equal(core.findMatchingEntry(state, "https://x.com/messages").type, "none");
});

test("skips DNR rules unless Safari blocking API is enabled", () => {
  const state = validState([
    { id: ids[0], kind: "domain", value: "example.com" }
  ]);

  assert.deepEqual(core.buildDnrRules(state), []);
});

test("generates DNR rules with app-owned IDs and explicit case handling", () => {
  const state = validState([
    { id: ids[0], kind: "domain", value: "example.com" },
    { id: ids[1], kind: "url", value: "reddit.com/popular" },
    { id: ids[2], kind: "urlWithSubpaths", value: "reddit.com/popular" },
    { id: ids[3], kind: "regex", value: "^https://x\\.com/home/?$" }
  ], true);

  const rules = core.buildDnrRules(state);

  assert.deepEqual(rules.map((rule) => rule.id), [1, 2, 3, 4]);
  assert.deepEqual(rules[0].action, { type: "block" });
  assert.deepEqual(rules[0].condition.resourceTypes, ["main_frame"]);
  assert.equal(rules[0].condition.isUrlFilterCaseSensitive, false);
  assert.equal(rules[1].condition.regexFilter, "^https?://(?:[^./?#]+\\.)*reddit\\.com/popular/*(?:\\?[^#]*)?$");
  assert.equal(rules[2].condition.regexFilter, "^https?://(?:[^./?#]+\\.)*reddit\\.com/popular(?:/[^?#]*)?(?:\\?[^#]*)?$");
});

function validState(entries, useSafariBlockingApi = false) {
  const result = core.validateState({
    schemaVersion: 3,
    entries,
    blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    useSafariBlockingApi
  });

  assert.equal(result.type, "valid");

  return result.state;
}
