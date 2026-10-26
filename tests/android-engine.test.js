const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../URLBlockerWebExtension/blocker.js");
const sync = require("../URLBlockerWebExtension/supabase-sync.js");
const defaultBlockedPages = require("../URLBlockerWebExtension/default-blocked-pages.json");

const ENGINE_PATH = require.resolve("../URLBlockerAndroid/app/src/main/assets/engine.js");
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const YOUTUBE = "com.google.android.youtube";
const config = {
  schemaVersion: 1,
  supabaseUrl: "https://project.supabase.co",
  publishableKey: "anon",
  redirectScheme: "urlblocker",
  screenTimeSyncAgeMs: MINUTE_MS
};

// Evening, outside the default schedule.
const startMs = new Date(2026, 0, 2, 20).getTime();

function startEngine(files = {}, routes = {}) {
  const engine = { files: { ...files }, statuses: [], requests: [], nowMs: startMs };

  global.AndroidHost = {
    read: (name) => engine.files[name],
    write: (name, text) => { engine.files[name] = text; },
    remove: (name) => { delete engine.files[name]; },
    syncStatus: (json) => engine.statuses.push(JSON.parse(json))
  };
  global.fetch = async (url, options) => {
    const route = Object.keys(routes).find((prefix) => url.startsWith(`${config.supabaseUrl}${prefix}`));

    if (!route) {
      throw new Error(`Unexpected request: ${url}`);
    }

    engine.requests.push({ url, body: options.body === undefined ? undefined : JSON.parse(options.body) });
    return { ok: true, json: async () => routes[route](options.body === undefined ? undefined : JSON.parse(options.body)) };
  };
  Date.now = () => engine.nowMs;
  delete require.cache[ENGINE_PATH];
  require(ENGINE_PATH);
  engine.call = (name, ...args) => {
    const result = global.AndroidEngine[name](...args);
    assert.equal(result.type, "ok", result.message);
    return result.value;
  };
  engine.call("start", JSON.stringify(config), JSON.stringify(defaultBlockedPages));
  engine.status = () => engine.statuses[engine.statuses.length - 1];
  engine.json = (name) => JSON.parse(engine.files[name]);
  return engine;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function session(nowMs) {
  const payload = Buffer.from(JSON.stringify({ sub: "22222222-2222-4222-8222-222222222222", email: "user@example.com" })).toString("base64url");

  return { schemaVersion: 1, accessToken: `e30.${payload}.signature`, refreshToken: "refresh", expiresAtMs: nowMs + HOUR_MS };
}

function settingsRow(state, updatedAtMs) {
  return [{ user_id: "22222222-2222-4222-8222-222222222222", state, updated_at_ms: updatedAtMs, revision_id: "revision", device_id: "mac", updated_at: "now" }];
}

test("starts with the default settings and does not sync while signed out", async () => {
  const engine = startEngine();

  assert.deepEqual(engine.status(), { email: null, lastSyncMs: null, error: "", pendingSettingsAtMs: null });
  assert.equal(engine.call("step", [], 0, [YOUTUBE], startMs).type, "allowed");
  engine.call("sync", true);
  await settle();
  assert.deepEqual(engine.requests, []);
});

test("synced settings wait out the active settings delay", async () => {
  const alwaysBlock = { ...core.emptyState(defaultBlockedPages), schedule: { type: "always" } };
  const engine = startEngine(
    { "supabase-session.json": JSON.stringify(session(startMs)) },
    {
      "/rest/v1/user_settings": () => settingsRow(alwaysBlock, startMs - HOUR_MS),
      "/rest/v1/screen_time_buckets": () => []
    }
  );

  engine.call("sync", true);
  await settle();

  const delayMs = core.emptyState(defaultBlockedPages).settingsDelay.delayMinutes * MINUTE_MS;
  assert.deepEqual(engine.status(), { email: "user@example.com", lastSyncMs: startMs, error: "", pendingSettingsAtMs: startMs + delayMs });
  assert.equal(engine.call("step", [], 0, [YOUTUBE], startMs + delayMs - 1).type, "allowed");
  assert.equal(engine.call("step", [], 0, [YOUTUBE], startMs + delayMs).type, "blocked");
  assert.equal(engine.json("settings-activation.json").pending.type, "none");
  assert.equal(engine.status().pendingSettingsAtMs, null);

  engine.nowMs = startMs + 2 * MINUTE_MS;
  engine.call("sync", false);
  await settle();
  assert.equal(engine.json("settings-activation.json").pending.type, "none", "the same remote revision does not apply again");
});

test("pushes this device's screen time and counts other devices' time", async () => {
  const engine = startEngine(
    { "supabase-session.json": JSON.stringify(session(startMs)) },
    {
      "/rest/v1/user_settings": () => [],
      "/rest/v1/rpc/sync_screen_time_buckets": (body) => body.p_buckets,
      "/rest/v1/screen_time_buckets": () => [{ device_id: "mac", domain: "youtube.com", hour_number: Math.floor(startMs / HOUR_MS), total_ms: 60 * MINUTE_MS }]
    }
  );

  engine.call("step", [], 0, [YOUTUBE], startMs);
  engine.call("step", [YOUTUBE], 5 * MINUTE_MS, [YOUTUBE], startMs);
  engine.call("sync", false);
  await settle();

  const pushed = engine.requests.find((request) => request.url.includes("sync_screen_time_buckets")).body.p_buckets;
  assert.deepEqual(pushed.map(({ domain, total_ms }) => ({ domain, total_ms })), [{ domain: "youtube.com", total_ms: 5 * MINUTE_MS }]);
  assert.equal(engine.call("step", [], 0, [YOUTUBE], startMs).type, "blocked", "the other device's hour puts YouTube over its limit");

  engine.call("persist");
  const usage = engine.json("screen-time-usage.json");
  assert.equal(usage.dirtySinceMs, null);
  assert.deepEqual(Object.keys(usage.remoteBuckets), ["mac"]);
});

test("signs in from the redirect and reports a failed redirect", async () => {
  const engine = startEngine({}, { "/rest/v1/user_settings": () => [], "/rest/v1/screen_time_buckets": () => [] });
  const signedIn = session(startMs);

  assert.equal(engine.call("signInUrl"), sync.oauthUrl(config, "google", "urlblocker://supabase-auth"));

  engine.call("completeSignIn", "urlblocker://supabase-auth#error=access_denied&error_description=Cancelled");
  assert.equal(engine.status().error, "Sign-in failed: Cancelled");
  assert.equal(engine.files["supabase-session.json"], undefined);

  engine.call("completeSignIn", `urlblocker://supabase-auth#access_token=${signedIn.accessToken}&refresh_token=refresh&expires_in=3600`);
  await settle();
  assert.deepEqual(engine.status(), { email: "user@example.com", lastSyncMs: startMs, error: "", pendingSettingsAtMs: null });

  engine.call("signOut");
  assert.equal(engine.files["supabase-session.json"], undefined);
  assert.equal(engine.status().email, null);
});

test("supabaseErrorMessage includes Supabase error details", () => {
  assert.equal(sync.supabaseErrorMessage(400, ""), "Supabase request failed: 400");
  assert.equal(sync.supabaseErrorMessage(400, JSON.stringify({ message: "bad", code: "42702" })), "Supabase request failed: 400. bad 42702");
  assert.equal(sync.supabaseErrorMessage(400, JSON.stringify({ code: 400, msg: "Refresh token is not valid" })), "Supabase request failed: 400. Refresh token is not valid");
  assert.equal(sync.supabaseErrorMessage(502, "Bad gateway"), "Supabase request failed: 502. Bad gateway");
});

test("sessionEmail reads the email claim", () => {
  assert.equal(sync.sessionEmail(session(0)), "user@example.com");
  assert.throws(() => sync.sessionEmail({ ...session(0), accessToken: "e30.e30.signature" }), /missing an email/);
});
