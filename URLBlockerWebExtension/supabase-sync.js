(function loadSupabaseSync(root) {
  "use strict";

  const CONFIG_PATH = "supabase-config.json";
  const SCREEN_TIME_SYNC_AGE_MS = 60 * 1000;
  const SCREEN_TIME_USAGE_SCHEMA_VERSION = 2;
  const SUPABASE_SESSION_SCHEMA_VERSION = 1;
  const SETTINGS_SYNC_SCHEMA_VERSION = 2;
  const CONFIG_SCHEMA_VERSION = 1;
  const CLOCK_SKEW_MS = 60 * 1000;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function emptyScreenTimeUsage(deviceId) {
    return {
      schemaVersion: SCREEN_TIME_USAGE_SCHEMA_VERSION,
      deviceId,
      dirtySinceMs: null,
      localBuckets: {},
      remoteBuckets: {}
    };
  }

  function parseScreenTimeUsage(rawUsage, createDeviceId, core) {
    if (rawUsage === undefined) {
      return emptyScreenTimeUsage(createDeviceId());
    }

    if (!isPlainObject(rawUsage)) {
      throw new Error("Screen time usage must be an object.");
    }

    if (rawUsage.schemaVersion !== SCREEN_TIME_USAGE_SCHEMA_VERSION) {
      throw new Error("Unsupported screen time usage version.");
    }

    requireKeys(rawUsage, ["schemaVersion", "deviceId", "dirtySinceMs", "localBuckets", "remoteBuckets"], "Screen time usage");

    if (typeof rawUsage.deviceId !== "string" || rawUsage.deviceId.trim() === "") {
      throw new Error("Screen time device ID must be a string.");
    }

    if (rawUsage.dirtySinceMs !== null && (!Number.isInteger(rawUsage.dirtySinceMs) || rawUsage.dirtySinceMs < 0)) {
      throw new Error("Screen time dirty timestamp must be null or a non-negative integer.");
    }

    return {
      schemaVersion: SCREEN_TIME_USAGE_SCHEMA_VERSION,
      deviceId: rawUsage.deviceId,
      dirtySinceMs: rawUsage.dirtySinceMs,
      localBuckets: parseLocalBuckets(rawUsage.localBuckets, core),
      remoteBuckets: parseRemoteBuckets(rawUsage.remoteBuckets, core)
    };
  }

  function isUnsupportedScreenTimeUsage(error) {
    return error instanceof Error && error.message === "Unsupported screen time usage version.";
  }

  function parseLocalBuckets(rawBuckets, core) {
    if (!isPlainObject(rawBuckets)) {
      throw new Error("Local screen time buckets must be an object.");
    }

    const buckets = {};

    Object.entries(rawBuckets).forEach(([domain, hours]) => {
      requireNormalizedDomain(domain, core);

      if (!isPlainObject(hours)) {
        throw new Error("Local screen time domain buckets must be an object.");
      }

      buckets[domain] = {};
      Object.entries(hours).forEach(([hour, bucket]) => {
        requireHour(hour);

        if (!isPlainObject(bucket)) {
          throw new Error("Local screen time bucket must be an object.");
        }

        requireKeys(bucket, ["totalMs", "syncedMs"], "Local screen time bucket");

        if (!Number.isInteger(bucket.totalMs) || bucket.totalMs < 0) {
          throw new Error("Local screen time total must be a non-negative integer.");
        }

        if (!Number.isInteger(bucket.syncedMs) || bucket.syncedMs < 0 || bucket.syncedMs > bucket.totalMs) {
          throw new Error("Local screen time synced total must be between 0 and the total.");
        }

        buckets[domain][hour] = {
          totalMs: bucket.totalMs,
          syncedMs: bucket.syncedMs
        };
      });
    });

    return buckets;
  }

  function parseRemoteBuckets(rawBuckets, core) {
    if (!isPlainObject(rawBuckets)) {
      throw new Error("Remote screen time buckets must be an object.");
    }

    const buckets = {};

    Object.entries(rawBuckets).forEach(([deviceId, domains]) => {
      if (typeof deviceId !== "string" || deviceId.trim() === "") {
        throw new Error("Remote screen time device ID must be a string.");
      }

      if (!isPlainObject(domains)) {
        throw new Error("Remote screen time device buckets must be an object.");
      }

      buckets[deviceId] = {};
      Object.entries(domains).forEach(([domain, hours]) => {
        requireNormalizedDomain(domain, core);

        if (!isPlainObject(hours)) {
          throw new Error("Remote screen time domain buckets must be an object.");
        }

        buckets[deviceId][domain] = {};
        Object.entries(hours).forEach(([hour, totalMs]) => {
          requireHour(hour);

          if (!Number.isInteger(totalMs) || totalMs < 0) {
            throw new Error("Remote screen time total must be a non-negative integer.");
          }

          buckets[deviceId][domain][hour] = totalMs;
        });
      });
    });

    return buckets;
  }

  function addScreenTime(usage, domain, hour, elapsedMs, nowMs) {
    const bucket = ensureLocalBucket(usage, domain, String(hour));

    bucket.totalMs += elapsedMs;

    if (usage.dirtySinceMs === null) {
      usage.dirtySinceMs = nowMs;
    }

    return usage;
  }

  function ensureLocalBucket(usage, domain, hour) {
    usage.localBuckets[domain] = usage.localBuckets[domain] || {};
    usage.localBuckets[domain][hour] = usage.localBuckets[domain][hour] || { totalMs: 0, syncedMs: 0 };

    return usage.localBuckets[domain][hour];
  }

  function screenTimeTotalMs(usage, domain, window) {
    return bucketTotal(usage.localBuckets[domain] || {}, window) + remoteBucketTotal(usage.remoteBuckets, domain, window);
  }

  function remoteBucketTotal(remoteBuckets, domain, window) {
    return Object.values(remoteBuckets).reduce((total, domains) => total + bucketTotal(domains[domain] || {}, window), 0);
  }

  function bucketTotal(buckets, window) {
    return Object.entries(buckets).reduce((total, [hour, bucket]) => {
      const bucketHour = Number(hour);

      if (bucketHour < window.startHour || bucketHour > window.endHour) {
        return total;
      }

      return total + (typeof bucket === "number" ? bucket : bucket.totalMs);
    }, 0);
  }

  function dirtyScreenTimeBuckets(usage) {
    const buckets = [];

    Object.entries(usage.localBuckets).forEach(([domain, hours]) => {
      Object.entries(hours).forEach(([hour, bucket]) => {
        if (bucket.totalMs === bucket.syncedMs) {
          return;
        }

        buckets.push({
          device_id: usage.deviceId,
          domain,
          hour_number: Number(hour),
          total_ms: bucket.totalMs
        });
      });
    });

    return buckets;
  }

  function shouldSyncScreenTime(usage, nowMs, syncAgeMs) {
    return usage.dirtySinceMs !== null && nowMs - usage.dirtySinceMs >= syncAgeMs;
  }

  function screenTimeSyncDelayMs(usage, nowMs, syncAgeMs) {
    if (usage.dirtySinceMs === null) {
      return null;
    }

    return Math.max(0, syncAgeMs - (nowMs - usage.dirtySinceMs));
  }

  function markScreenTimeSynced(usage, syncedBuckets) {
    syncedBuckets.forEach((synced) => {
      const bucket = usage.localBuckets[synced.domain] && usage.localBuckets[synced.domain][String(synced.hour_number)];

      if (!bucket) {
        return;
      }

      bucket.syncedMs = Math.max(bucket.syncedMs, Math.min(bucket.totalMs, synced.total_ms));
    });

    usage.dirtySinceMs = dirtyScreenTimeBuckets(usage).length === 0 ? null : usage.dirtySinceMs;
    return usage;
  }

  function mergeRemoteScreenTimeBuckets(usage, rows) {
    rows.forEach((row) => {
      if (row.device_id === usage.deviceId) {
        return;
      }

      usage.remoteBuckets[row.device_id] = usage.remoteBuckets[row.device_id] || {};
      usage.remoteBuckets[row.device_id][row.domain] = usage.remoteBuckets[row.device_id][row.domain] || {};
      usage.remoteBuckets[row.device_id][row.domain][String(row.hour_number)] = row.total_ms;
    });

    return usage;
  }

  function parseSettingsSync(rawSync, createDeviceId, nowMs) {
    if (rawSync === undefined) {
      return {
        schemaVersion: SETTINGS_SYNC_SCHEMA_VERSION,
        deviceId: createDeviceId(),
        updatedAtMs: nowMs,
        revisionId: createDeviceId(),
        dirty: false,
        lastSuccessfulSyncMs: null
      };
    }

    if (!isPlainObject(rawSync)) {
      throw new Error("Settings sync metadata must be an object.");
    }

    if (rawSync.schemaVersion !== 1 && rawSync.schemaVersion !== SETTINGS_SYNC_SCHEMA_VERSION) {
      throw new Error("Unsupported settings sync metadata version.");
    }

    const isVersion1 = rawSync.schemaVersion === 1;
    const allowedKeys = isVersion1
      ? ["schemaVersion", "deviceId", "updatedAtMs", "revisionId", "dirty"]
      : ["schemaVersion", "deviceId", "updatedAtMs", "revisionId", "dirty", "lastSuccessfulSyncMs"];

    requireKeys(rawSync, allowedKeys, "Settings sync metadata");

    if (typeof rawSync.deviceId !== "string" || rawSync.deviceId.trim() === "") {
      throw new Error("Settings sync device ID must be a string.");
    }

    if (!Number.isInteger(rawSync.updatedAtMs) || rawSync.updatedAtMs < 0) {
      throw new Error("Settings sync timestamp must be a non-negative integer.");
    }

    if (typeof rawSync.revisionId !== "string" || rawSync.revisionId.trim() === "") {
      throw new Error("Settings sync revision ID must be a string.");
    }

    if (typeof rawSync.dirty !== "boolean") {
      throw new Error("Settings sync dirty value must be a boolean.");
    }

    if (!isVersion1) {
      const lastSuccessfulSyncMs = rawSync.lastSuccessfulSyncMs;

      if (lastSuccessfulSyncMs !== null && (!Number.isInteger(lastSuccessfulSyncMs) || lastSuccessfulSyncMs < 0)) {
        throw new Error("Settings sync success timestamp must be null or a non-negative integer.");
      }
    }

    return {
      schemaVersion: SETTINGS_SYNC_SCHEMA_VERSION,
      deviceId: rawSync.deviceId,
      updatedAtMs: rawSync.updatedAtMs,
      revisionId: rawSync.revisionId,
      dirty: rawSync.dirty,
      lastSuccessfulSyncMs: isVersion1 ? null : rawSync.lastSuccessfulSyncMs
    };
  }

  function dirtySettingsSync(sync, nowMs, createRevisionId) {
    return {
      schemaVersion: SETTINGS_SYNC_SCHEMA_VERSION,
      deviceId: sync.deviceId,
      updatedAtMs: nowMs,
      revisionId: createRevisionId(),
      dirty: true,
      lastSuccessfulSyncMs: sync.lastSuccessfulSyncMs
    };
  }

  function cleanSettingsSync(sync, remoteRow, nowMs) {
    return {
      schemaVersion: SETTINGS_SYNC_SCHEMA_VERSION,
      deviceId: sync.deviceId,
      updatedAtMs: remoteRow.updated_at_ms,
      revisionId: remoteRow.revision_id,
      dirty: false,
      lastSuccessfulSyncMs: nowMs
    };
  }

  function markSuccessfulSync(sync, nowMs) {
    return {
      schemaVersion: SETTINGS_SYNC_SCHEMA_VERSION,
      deviceId: sync.deviceId,
      updatedAtMs: sync.updatedAtMs,
      revisionId: sync.revisionId,
      dirty: sync.dirty,
      lastSuccessfulSyncMs: nowMs
    };
  }

  function remoteSettingsAreNewer(sync, remoteRow) {
    if (remoteRow.updated_at_ms !== sync.updatedAtMs) {
      return remoteRow.updated_at_ms > sync.updatedAtMs;
    }

    return remoteRow.revision_id > sync.revisionId;
  }

  function parseConfig(rawConfig) {
    if (!isPlainObject(rawConfig)) {
      throw new Error("Supabase config must be an object.");
    }

    requireKeys(rawConfig, ["schemaVersion", "supabaseUrl", "publishableKey", "redirectScheme", "screenTimeSyncAgeMs"], "Supabase config");

    if (rawConfig.schemaVersion !== CONFIG_SCHEMA_VERSION) {
      throw new Error("Unsupported Supabase config version.");
    }

    if (!Number.isInteger(rawConfig.screenTimeSyncAgeMs) || rawConfig.screenTimeSyncAgeMs < 1000) {
      throw new Error("Supabase screen time sync age must be at least one second.");
    }

    return {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      supabaseUrl: stringValue(rawConfig.supabaseUrl),
      publishableKey: stringValue(rawConfig.publishableKey),
      redirectScheme: stringValue(rawConfig.redirectScheme),
      screenTimeSyncAgeMs: rawConfig.screenTimeSyncAgeMs
    };
  }

  function configIsReady(config) {
    return config.supabaseUrl !== "" && config.publishableKey !== "";
  }

  function parseSession(rawSession) {
    if (rawSession === undefined) {
      return { type: "signedOut" };
    }

    if (!isPlainObject(rawSession)) {
      throw new Error("Supabase session must be an object.");
    }

    requireKeys(rawSession, ["schemaVersion", "accessToken", "refreshToken", "expiresAtMs"], "Supabase session");

    if (rawSession.schemaVersion !== SUPABASE_SESSION_SCHEMA_VERSION) {
      throw new Error("Unsupported Supabase session version.");
    }

    if (typeof rawSession.accessToken !== "string" || rawSession.accessToken === "") {
      throw new Error("Supabase access token must be a string.");
    }

    if (typeof rawSession.refreshToken !== "string" || rawSession.refreshToken === "") {
      throw new Error("Supabase refresh token must be a string.");
    }

    if (!Number.isInteger(rawSession.expiresAtMs) || rawSession.expiresAtMs < 0) {
      throw new Error("Supabase session expiration must be a non-negative integer.");
    }

    return {
      type: "session",
      session: {
        schemaVersion: SUPABASE_SESSION_SCHEMA_VERSION,
        accessToken: rawSession.accessToken,
        refreshToken: rawSession.refreshToken,
        expiresAtMs: rawSession.expiresAtMs
      }
    };
  }

  function sessionUserId(session) {
    const payload = jwtPayload(session.accessToken);

    if (typeof payload.sub !== "string" || payload.sub === "") {
      throw new Error("Supabase access token is missing a user ID.");
    }

    return payload.sub;
  }

  function sessionNeedsRefresh(session, nowMs) {
    return session.expiresAtMs - nowMs <= CLOCK_SKEW_MS;
  }

  function sessionFromOAuthRedirect(rawUrl, nowMs) {
    const url = new URL(rawUrl);
    const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.search.slice(1));

    if (params.has("error")) {
      throw new Error(params.get("error_description") || params.get("error"));
    }

    const accessToken = params.get("access_token") || "";
    const refreshToken = params.get("refresh_token") || "";
    const expiresAt = params.get("expires_at");
    const expiresIn = params.get("expires_in");

    if (accessToken === "" || refreshToken === "") {
      throw new Error("Supabase sign-in did not return a session.");
    }

    return {
      schemaVersion: SUPABASE_SESSION_SCHEMA_VERSION,
      accessToken,
      refreshToken,
      expiresAtMs: expiresAt ? Number(expiresAt) * 1000 : nowMs + Number(expiresIn || 3600) * 1000
    };
  }

  async function refreshSession(config, session, fetchJson) {
    const response = await fetchJson(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: supabaseHeaders(config, session),
      body: JSON.stringify({ refresh_token: session.refreshToken })
    });

    // An unvalidated response would get persisted as the stored session and
    // break every later sync until the user signs in again, so fail loudly
    // here instead.
    if (typeof response.access_token !== "string" || response.access_token === "") {
      throw new Error("Supabase token refresh returned no access token.");
    }

    if (typeof response.refresh_token !== "string" || response.refresh_token === "") {
      throw new Error("Supabase token refresh returned no refresh token.");
    }

    if (!Number.isInteger(response.expires_in) || response.expires_in <= 0) {
      throw new Error("Supabase token refresh returned an invalid expiration.");
    }

    return {
      schemaVersion: SUPABASE_SESSION_SCHEMA_VERSION,
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAtMs: Date.now() + response.expires_in * 1000
    };
  }

  function oauthUrl(config, provider, redirectTo) {
    const url = new URL(`${config.supabaseUrl}/auth/v1/authorize`);

    url.searchParams.set("provider", provider);
    url.searchParams.set("redirect_to", redirectTo);

    return url.href;
  }

  async function saveRemoteSettings(config, session, state, sync, fetchJson) {
    const response = await fetchJson(`${config.supabaseUrl}/rest/v1/rpc/save_user_settings`, {
      method: "POST",
      headers: supabaseHeaders(config, session),
      body: JSON.stringify({
        p_state: state,
        p_updated_at_ms: sync.updatedAtMs,
        p_revision_id: sync.revisionId,
        p_device_id: sync.deviceId
      })
    });

    return normalizeSettingsRow(response);
  }

  async function loadRemoteSettings(config, session, fetchJson) {
    const rows = await fetchJson(`${config.supabaseUrl}/rest/v1/user_settings?select=user_id,state,updated_at_ms,revision_id,device_id,updated_at`, {
      method: "GET",
      headers: supabaseHeaders(config, session)
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      return undefined;
    }

    if (rows.length !== 1) {
      throw new Error("Supabase returned multiple settings rows.");
    }

    return normalizeSettingsRow(rows[0]);
  }

  async function saveRemoteScreenTime(config, session, buckets, fetchJson) {
    return fetchJson(`${config.supabaseUrl}/rest/v1/rpc/sync_screen_time_buckets`, {
      method: "POST",
      headers: supabaseHeaders(config, session),
      body: JSON.stringify({ p_buckets: buckets })
    });
  }

  async function loadRemoteScreenTime(config, session, window, fetchJson) {
    const url = new URL(`${config.supabaseUrl}/rest/v1/screen_time_buckets`);

    url.searchParams.set("select", "device_id,domain,hour_number,total_ms");
    url.searchParams.set("hour_number", `gte.${window.startHour}`);
    url.searchParams.append("hour_number", `lte.${window.endHour}`);

    return fetchJson(url.href, {
      method: "GET",
      headers: supabaseHeaders(config, session)
    });
  }

  function supabaseHeaders(config, session) {
    return {
      apikey: config.publishableKey,
      authorization: `Bearer ${session.accessToken}`,
      "content-type": "application/json"
    };
  }

  function normalizeRemoteScreenTimeRows(rows, core) {
    if (!Array.isArray(rows)) {
      throw new Error("Remote screen time rows must be an array.");
    }

    return rows.map((row) => {
      if (!isPlainObject(row)) {
        throw new Error("Remote screen time row must be an object.");
      }

      requireKeys(row, ["device_id", "domain", "hour_number", "total_ms"], "Remote screen time row");

      if (typeof row.device_id !== "string" || row.device_id.trim() === "") {
        throw new Error("Remote screen time row device ID must be a string.");
      }

      requireNormalizedDomain(row.domain, core);

      if (!Number.isInteger(row.hour_number) || row.hour_number < 0) {
        throw new Error("Remote screen time row hour must be a non-negative integer.");
      }

      if (!Number.isInteger(row.total_ms) || row.total_ms < 0) {
        throw new Error("Remote screen time row total must be a non-negative integer.");
      }

      return {
        device_id: row.device_id,
        domain: row.domain,
        hour_number: row.hour_number,
        total_ms: row.total_ms
      };
    });
  }

  function normalizeSettingsRow(row) {
    const value = Array.isArray(row) && row.length === 1 ? row[0] : row;

    if (!isPlainObject(value)) {
      throw new Error("Remote settings row must be an object.");
    }

    requireKeys(value, ["user_id", "state", "updated_at_ms", "revision_id", "device_id", "updated_at"], "Remote settings row");

    if (!isPlainObject(value.state)) {
      throw new Error("Remote settings state must be an object.");
    }

    if (!Number.isInteger(value.updated_at_ms) || value.updated_at_ms < 0) {
      throw new Error("Remote settings timestamp must be a non-negative integer.");
    }

    if (typeof value.revision_id !== "string" || value.revision_id === "") {
      throw new Error("Remote settings revision ID must be a string.");
    }

    if (typeof value.device_id !== "string" || value.device_id === "") {
      throw new Error("Remote settings device ID must be a string.");
    }

    return {
      state: value.state,
      updated_at_ms: value.updated_at_ms,
      revision_id: value.revision_id,
      device_id: value.device_id
    };
  }

  function normalizeSyncedScreenTimeRows(rows, core) {
    return normalizeRemoteScreenTimeRows(rows, core);
  }

  function requireNormalizedDomain(domain, core) {
    if (typeof domain !== "string" || core.normalizeDomainEntryValue(domain) !== domain) {
      throw new Error("Screen time domain must be normalized.");
    }
  }

  function requireHour(hour) {
    if (!/^\d+$/.test(hour)) {
      throw new Error("Screen time bucket must be an hour number.");
    }
  }

  function jwtPayload(token) {
    const parts = token.split(".");

    if (parts.length < 2) {
      throw new Error("Supabase access token must be a JWT.");
    }

    return JSON.parse(base64UrlDecode(parts[1]));
  }

  function base64UrlDecode(value) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");

    if (typeof root.atob === "function") {
      return root.atob(padded);
    }

    return Buffer.from(padded, "base64").toString("utf8");
  }

  function stringValue(value) {
    if (typeof value !== "string") {
      throw new Error("Supabase config values must be strings.");
    }

    return value.trim();
  }

  function requireKeys(object, allowedKeys, label) {
    const allowed = new Set(allowedKeys);
    const unknownKey = Object.keys(object).find((key) => !allowed.has(key));

    if (unknownKey) {
      throw new Error(`${label} has unknown key: ${unknownKey}.`);
    }
  }

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  root.SupabaseSync = {
    CONFIG_PATH,
    SCREEN_TIME_SYNC_AGE_MS,
    dirtyScreenTimeBuckets,
    dirtySettingsSync,
    cleanSettingsSync,
    configIsReady,
    emptyScreenTimeUsage,
    addScreenTime,
    loadRemoteScreenTime,
    loadRemoteSettings,
    markScreenTimeSynced,
    markSuccessfulSync,
    mergeRemoteScreenTimeBuckets,
    normalizeRemoteScreenTimeRows,
    normalizeSyncedScreenTimeRows,
    oauthUrl,
    parseConfig,
    parseScreenTimeUsage,
    parseSession,
    parseSettingsSync,
    refreshSession,
    remoteSettingsAreNewer,
    isUnsupportedScreenTimeUsage,
    saveRemoteScreenTime,
    saveRemoteSettings,
    screenTimeSyncDelayMs,
    screenTimeTotalMs,
    sessionFromOAuthRedirect,
    sessionNeedsRefresh,
    sessionUserId,
    shouldSyncScreenTime
  };

  if (typeof module !== "undefined") {
    module.exports = root.SupabaseSync;
  }
})(globalThis);
