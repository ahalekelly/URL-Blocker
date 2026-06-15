(function loadOptions(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const core = root.BlockerCore;
  const DEFAULT_GROUP_TITLES = {
    "bsky.app": "Bluesky",
    "facebook.com": "Facebook",
    "instagram.com": "Instagram",
    "linkedin.com": "LinkedIn",
    "pinterest.com": "Pinterest",
    "reddit.com": "Reddit",
    "threads.com": "Threads",
    "tiktok.com": "TikTok",
    "x.com": "X",
    "ycombinator.com": "Hacker News",
    "youtube.com": "YouTube"
  };
  const NATIVE_APP_SIGN_IN_URL_BASE = "urlblocker://";
  const NATIVE_APP_SIGN_IN_URL = `${NATIVE_APP_SIGN_IN_URL_BASE}open`;
  const NATIVE_APP_SIGN_IN_TEXT = "Sign in to sync screen time limits and settings";
  const state = {
    defaultEntries: [],
    draftEntries: [],
    draftBlockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    draftSchedule: core.DEFAULT_SCHEDULE,
    draftLimitReset: core.DEFAULT_LIMIT_RESET,
    draftSettingsDelay: core.DEFAULT_SETTINGS_DELAY,
    savedDraft: {
      entries: [],
      blockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
      schedule: core.DEFAULT_SCHEDULE,
      limitReset: core.DEFAULT_LIMIT_RESET,
      settingsDelay: core.DEFAULT_SETTINGS_DELAY
    },
    settingsActivation: { type: "active" },
    rowErrors: new Map(),
    pageError: "",
    isSaving: false,
    isRequestingPermissions: false,
    missingOrigins: [],
    screenTimeEntries: [],
    syncStatus: { status: "checking", error: "", lastSuccessfulSyncAgeMs: null }
  };

  const rowsElement = document.getElementById("rows");
  const rowTemplate = document.getElementById("rowTemplate");
  const saveButton = document.getElementById("saveButton");
  const addRowButton = document.getElementById("addRowButton");
  const blockedPageHtmlInput = document.getElementById("blockedPageHtmlInput");
  const alwaysScheduleInput = document.getElementById("alwaysScheduleInput");
  const dailyScheduleInput = document.getElementById("dailyScheduleInput");
  const scheduleWindowFields = document.getElementById("scheduleWindowFields");
  const scheduleStartInput = document.getElementById("scheduleStartInput");
  const scheduleEndInput = document.getElementById("scheduleEndInput");
  const screenTimeTitle = document.getElementById("screenTimeTitle");
  const rollingResetInput = document.getElementById("rollingResetInput");
  const dailyResetInput = document.getElementById("dailyResetInput");
  const rollingResetFields = document.getElementById("rollingResetFields");
  const dailyResetFields = document.getElementById("dailyResetFields");
  const rollingWindowHoursInput = document.getElementById("rollingWindowHoursInput");
  const dailyResetHourSelect = document.getElementById("dailyResetHourSelect");
  const immediateSettingsDelayInput = document.getElementById("immediateSettingsDelayInput");
  const delayedSettingsDelayInput = document.getElementById("delayedSettingsDelayInput");
  const settingsDelayFields = document.getElementById("settingsDelayFields");
  const settingsDelayMinutesInput = document.getElementById("settingsDelayMinutesInput");
  const settingsActivationText = document.getElementById("settingsActivationText");
  const errorSummary = document.getElementById("errorSummary");
  const screenTimeRows = document.getElementById("screenTimeRows");
  const emptyScreenTime = document.getElementById("emptyScreenTime");
  const syncStatusText = document.getElementById("syncStatusText");
  const googleSignInButton = document.getElementById("googleSignInButton");
  const appleSignInButton = document.getElementById("appleSignInButton");
  const syncNowButton = document.getElementById("syncNowButton");
  const signOutButton = document.getElementById("signOutButton");
  const repairPanel = document.getElementById("repairPanel");
  const repairMessage = document.getElementById("repairMessage");
  const resetButton = document.getElementById("resetButton");
  const editorPanel = document.getElementById("editorPanel");
  const permissionPanel = document.getElementById("permissionPanel");
  const permissionMessage = document.getElementById("permissionMessage");
  const permissionError = document.getElementById("permissionError");
  const grantAccessButton = document.getElementById("grantAccessButton");

  renderDailyResetHourOptions();
  addRowButton.addEventListener("click", addRow);
  saveButton.addEventListener("click", saveDraft);
  blockedPageHtmlInput.addEventListener("input", updateBlockedPageHtml);
  alwaysScheduleInput.addEventListener("change", () => updateScheduleType("always"));
  dailyScheduleInput.addEventListener("change", () => updateScheduleType("dailyWindow"));
  scheduleStartInput.addEventListener("input", updateScheduleWindow);
  scheduleEndInput.addEventListener("input", updateScheduleWindow);
  rollingResetInput.addEventListener("change", () => updateLimitResetType("rollingWindow"));
  dailyResetInput.addEventListener("change", () => updateLimitResetType("daily"));
  rollingWindowHoursInput.addEventListener("input", updateRollingWindow);
  dailyResetHourSelect.addEventListener("change", updateDailyResetHour);
  immediateSettingsDelayInput.addEventListener("change", () => updateSettingsDelayType("immediate"));
  delayedSettingsDelayInput.addEventListener("change", () => updateSettingsDelayType("delayed"));
  settingsDelayMinutesInput.addEventListener("input", updateSettingsDelayMinutes);
  resetButton.addEventListener("click", resetBlocklist);
  grantAccessButton.addEventListener("click", requestMissingWebsiteAccess);
  googleSignInButton.addEventListener("click", () => signInWithProvider("google"));
  appleSignInButton.addEventListener("click", () => signInWithProvider("apple"));
  syncNowButton.addEventListener("click", syncNow);
  signOutButton.addEventListener("click", signOut);
  root.addEventListener("error", (event) => showFatalError(event.error || codedError("WindowError", event.message)));
  root.addEventListener("unhandledrejection", (event) => showFatalError(errorFromReason(event.reason)));
  root.addEventListener("focus", refreshNativeSignInStatus);
  document.addEventListener("visibilitychange", refreshVisibleNativeSignInStatus);

  root.addEventListener("hashchange", start);
  start();

  function start() {
    completeOAuthRedirect()
      .then(loadLocalStateThenSync)
      .catch(showFatalError);
  }

  async function loadLocalStateThenSync() {
    const syncResult = syncOnOpenResult();

    await loadLocalState();
    await applySyncOnOpenResult(await syncResult);
  }

  async function syncOnOpenResult() {
    try {
      return await loadSyncOnOpenResult();
    } catch (error) {
      return { type: "syncError", error };
    }
  }

  async function loadSyncOnOpenResult() {
    const response = await api.runtime.sendMessage({ type: "syncNow" });

    switch (response.type) {
      case "synced":
        return { type: "synced", status: normalizeSyncStatus(response.status) };
      case "error":
        return { type: "syncError", error: errorFromResponse(response) };
      default:
        throw codedError("UnexpectedSyncOnOpenResponse", `Unknown syncNow response: ${response.type}`);
    }
  }

  async function applySyncOnOpenResult(result) {
    switch (result.type) {
      case "synced":
        state.syncStatus = result.status;
        await loadLocalState();
        return;
      case "syncError":
        state.syncStatus = syncStatusFromError(result.error);
        render();
        return;
      default:
        throw codedError("UnexpectedSyncOnOpenResult", `Unknown sync-on-open result: ${result.type}`);
    }
  }

  async function loadLocalState() {
    const response = await api.runtime.sendMessage({ type: "getLocalState" });

    switch (response.type) {
      case "state":
        setDraftState(response.state, response.activation);
        await refreshWebsiteAccess(response.state);
        await loadScreenTimeLog("getLocalScreenTimeLog");
        await loadSyncStatus();
        render();
        return;
      case "stateError":
        await loadDefaultStateForReset();
        showRepair(errorFromResponse(response));
        return;
      case "error":
        showFatalError(errorFromResponse(response));
        return;
      default:
        throw codedError("UnexpectedGetLocalStateResponse", `Unknown getLocalState response: ${response.type}`);
    }
  }

  function render() {
    const needsWebsiteAccess = state.missingOrigins.length > 0;
    const scrollY = root.scrollY;

    repairPanel.hidden = true;
    permissionPanel.hidden = !needsWebsiteAccess;
    editorPanel.hidden = needsWebsiteAccess;
    rowsElement.replaceChildren(...renderBlockItems());
    blockedPageHtmlInput.value = state.draftBlockedPageHtml;
    renderScreenTimeTitle();
    alwaysScheduleInput.checked = state.draftSchedule.type === "always";
    dailyScheduleInput.checked = state.draftSchedule.type === "dailyWindow";
    scheduleWindowFields.hidden = state.draftSchedule.type !== "dailyWindow";
    scheduleStartInput.value = minuteToTime(state.draftSchedule.startMinute);
    scheduleEndInput.value = minuteToTime(state.draftSchedule.endMinute);
    rollingResetInput.checked = state.draftLimitReset.type === "rollingWindow";
    dailyResetInput.checked = state.draftLimitReset.type === "daily";
    rollingResetFields.hidden = state.draftLimitReset.type !== "rollingWindow";
    dailyResetFields.hidden = state.draftLimitReset.type !== "daily";
    rollingWindowHoursInput.value = String(rollingWindowHours());
    dailyResetHourSelect.value = String(dailyResetHour());
    immediateSettingsDelayInput.checked = state.draftSettingsDelay.type === "immediate";
    delayedSettingsDelayInput.checked = state.draftSettingsDelay.type === "delayed";
    settingsDelayFields.hidden = state.draftSettingsDelay.type !== "delayed";
    settingsDelayMinutesInput.value = String(settingsDelayMinutes());
    renderSettingsActivation();
    renderSaveButton();
    grantAccessButton.disabled = state.isRequestingPermissions;
    permissionMessage.textContent = needsWebsiteAccess ? permissionPanelMessage() : "";
    permissionError.hidden = state.pageError === "";
    permissionError.textContent = state.pageError;
    errorSummary.hidden = state.pageError === "";
    errorSummary.textContent = state.pageError;
    renderScreenTimeLog();
    renderSyncStatus();
    root.scrollTo(0, scrollY);
  }

  function renderBlockItems() {
    const groupedDefaults = groupedDefaultEntries();
    const renderedDomains = new Set();

    return state.draftEntries.flatMap((entry) => {
      switch (entry.type) {
        case "custom":
          return [renderCustomRow(entry)];
        case "default": {
          const domain = core.associatedDomainForEntry(entry);

          if (renderedDomains.has(domain)) {
            return [];
          }

          const group = groupedDefaults.get(domain);

          if (!group) {
            throw new Error(`Missing default group: ${domain}.`);
          }

          renderedDomains.add(domain);

          return [renderDefaultGroup(domain, group)];
        }
        default:
          throw new Error(`Unknown entry type: ${entry.type}`);
      }
    });
  }

  function groupedDefaultEntries() {
    const groups = new Map();

    state.draftEntries.forEach((entry) => {
      if (entry.type !== "default") {
        return;
      }

      const domain = core.associatedDomainForEntry(entry);

      groups.set(domain, [...(groups.get(domain) || []), entry]);
    });

    return groups;
  }

  function defaultGroupTitle(domain) {
    if (!Object.hasOwn(DEFAULT_GROUP_TITLES, domain)) {
      throw new Error(`Missing default group title: ${domain}.`);
    }

    return DEFAULT_GROUP_TITLES[domain];
  }

  function renderDefaultGroup(domain, entries) {
    const group = document.createElement("article");
    const toolbar = document.createElement("div");
    const title = document.createElement("div");
    const limitLabel = document.createElement("label");
    const limitPrefix = document.createElement("span");
    const limitInput = document.createElement("input");
    const limitSuffix = document.createElement("span");
    const entryList = document.createElement("div");
    const titleText = defaultGroupTitle(domain);

    group.className = "block-row default-group";
    group.dataset.domain = domain;
    toolbar.className = "default-group-toolbar";
    title.className = "default-group-title";
    title.textContent = titleText;
    limitLabel.className = "default-group-limit";
    limitLabel.hidden = timeLimitsAreHidden();
    limitPrefix.className = "limit-prefix";
    limitPrefix.textContent = "Limit:";
    limitInput.className = "limit-input";
    limitInput.type = "number";
    limitInput.min = "1";
    limitInput.max = "960";
    limitInput.step = "1";
    limitInput.inputMode = "numeric";
    limitInput.setAttribute("aria-label", `Limit minutes for ${titleText}`);
    limitInput.value = String(entries[0].limitMinutes);
    limitInput.addEventListener("input", () => updateLimit(entries[0].id, limitInput.value));
    limitSuffix.className = "limit-suffix";
    limitSuffix.textContent = "min";
    limitLabel.append(limitPrefix, limitInput, limitSuffix);
    toolbar.append(title, limitLabel);
    entryList.className = "default-group-entries";
    entryList.replaceChildren(...entries.map(renderDefaultGroupEntry));
    group.append(toolbar, entryList);

    return group;
  }

  function renderSaveButton() {
    saveButton.hidden = !draftHasUnsavedChanges();
    saveButton.disabled = state.isSaving;
  }

  function draftHasUnsavedChanges() {
    return JSON.stringify(draftSnapshot()) !== JSON.stringify(state.savedDraft);
  }

  function draftSnapshot() {
    return {
      entries: state.draftEntries.map(draftEntrySnapshot),
      blockedPageHtml: state.draftBlockedPageHtml,
      schedule: editableSchedule(state.draftSchedule),
      limitReset: editableLimitReset(state.draftLimitReset),
      settingsDelay: editableSettingsDelay(state.draftSettingsDelay)
    };
  }

  function draftEntrySnapshot(entry) {
    switch (entry.type) {
      case "custom":
        return { type: "custom", id: entry.id, kind: entry.kind, value: entry.value, limitMinutes: entry.limitMinutes };
      case "default":
        return { type: "default", id: entry.id, kind: entry.kind, value: entry.value, enabled: entry.enabled, limitMinutes: entry.limitMinutes };
      default:
        throw new Error(`Unknown entry type: ${entry.type}`);
    }
  }

  function renderDefaultGroupEntry(entry) {
    const row = document.createElement("div");
    const enabledLabel = renderDefaultEnabledLabel(entry);
    const value = document.createElement("span");
    const rowError = document.createElement("p");
    const error = state.rowErrors.get(entry.id) || "";

    row.className = "default-group-entry";
    row.dataset.entryId = entry.id;
    value.className = "default-group-entry-value";
    value.textContent = entry.value;
    rowError.className = "row-error";
    rowError.hidden = error === "";
    rowError.textContent = error;
    row.append(value, enabledLabel, rowError);

    return row;
  }

  function renderDefaultEnabledLabel(entry) {
    const enabledLabel = document.createElement("label");
    const enabledInput = document.createElement("input");

    enabledLabel.className = "enabled-label";
    enabledInput.className = "enabled-input";
    enabledInput.type = "checkbox";
    enabledInput.checked = entry.enabled;
    enabledInput.setAttribute("aria-label", `Enable ${entry.value}`);
    enabledInput.addEventListener("change", () => updateEnabled(entry.id, enabledInput.checked));
    enabledLabel.append(enabledInput);

    return enabledLabel;
  }

  function renderCustomRow(entry) {
    const fragment = rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".block-row");
    const segments = fragment.querySelector(".segments");
    const input = fragment.querySelector(".value-input");
    const limitLabel = fragment.querySelector(".row-limit");
    const limitInput = fragment.querySelector(".limit-input");
    const deleteButton = fragment.querySelector(".delete-button");
    const rowError = fragment.querySelector(".row-error");
    const error = state.rowErrors.get(entry.id) || "";

    renderKindButtons(entry, segments);
    input.value = entry.value;
    input.placeholder = placeholderFor(entry.kind);
    input.addEventListener("input", () => updateValue(entry.id, input.value));
    input.addEventListener("blur", () => normalizeUrlInput(entry.id));
    limitInput.value = String(entry.limitMinutes);
    limitInput.addEventListener("input", () => updateLimit(entry.id, limitInput.value));
    limitLabel.hidden = timeLimitsAreHidden();
    deleteButton.disabled = state.defaultEntries.length === 0 && customEntryCount() === 1;
    deleteButton.addEventListener("click", () => deleteRow(entry.id));
    rowError.hidden = error === "";
    rowError.textContent = error;
    row.dataset.entryId = entry.id;

    return fragment;
  }

  function renderKindButtons(entry, segments) {
    Object.entries(core.EDITABLE_KIND_LABELS).forEach(([kind, label]) => {
      const button = document.createElement("button");

      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-pressed", String(entry.kind === kind));
      button.addEventListener("click", () => updateKind(entry.id, kind));
      segments.append(button);
    });
  }

  function renderScreenTimeLog() {
    screenTimeRows.replaceChildren(...state.screenTimeEntries.map(renderScreenTimeRow));
    emptyScreenTime.hidden = state.screenTimeEntries.length !== 0;
  }

  function renderScreenTimeTitle() {
    screenTimeTitle.textContent = screenTimeTitleText(state.draftLimitReset);
  }

  function renderSyncStatus() {
    googleSignInButton.disabled = false;
    appleSignInButton.disabled = false;

    switch (state.syncStatus.status) {
      case "checking":
        syncStatusText.textContent = "Checking sync.";
        googleSignInButton.hidden = true;
        appleSignInButton.hidden = true;
        syncNowButton.hidden = true;
        signOutButton.hidden = true;
        return;
      case "unconfigured":
        syncStatusText.textContent = "Sync is not configured on this build.";
        googleSignInButton.hidden = true;
        appleSignInButton.hidden = true;
        syncNowButton.hidden = true;
        signOutButton.hidden = true;
        return;
      case "signedOut":
        syncStatusText.textContent = syncStatusErrorText(signedOutSyncStatusText());
        googleSignInButton.hidden = false;
        appleSignInButton.hidden = true;
        syncNowButton.hidden = true;
        signOutButton.hidden = true;
        return;
      case "signedIn":
        syncStatusText.textContent = syncStatusErrorText(signedInSyncStatusText());
        googleSignInButton.hidden = true;
        appleSignInButton.hidden = true;
        syncNowButton.hidden = false;
        signOutButton.hidden = false;
        return;
      case "nativeSignInRequired":
        renderNativeSignInLink();
        googleSignInButton.hidden = true;
        appleSignInButton.hidden = true;
        syncNowButton.hidden = true;
        signOutButton.hidden = true;
        return;
      case "error":
        syncStatusText.textContent = state.syncStatus.error;
        googleSignInButton.hidden = false;
        appleSignInButton.hidden = true;
        syncNowButton.hidden = true;
        signOutButton.hidden = true;
        return;
      default:
        throw new Error(`Unknown sync status: ${state.syncStatus.status}`);
    }
  }

  function renderSettingsActivation() {
    switch (state.settingsActivation.type) {
      case "active":
        settingsActivationText.hidden = true;
        settingsActivationText.textContent = "";
        return;
      case "pending":
        settingsActivationText.hidden = false;
        settingsActivationText.textContent = `Pending changes take effect in ${formatPendingDelay(state.settingsActivation.effectiveAtMs)}.`;
        return;
      default:
        throw new Error(`Unknown settings activation status: ${state.settingsActivation.type}`);
    }
  }

  function formatPendingDelay(effectiveAtMs) {
    const minutes = Math.ceil(Math.max(0, effectiveAtMs - Date.now()) / (60 * 1000));

    if (minutes <= 0) {
      return "less than 1 minute";
    }

    return pluralize(minutes, "minute");
  }

  function syncStatusErrorText(text) {
    if (!state.syncStatus.error) {
      return text;
    }

    return `${text} Last sync error: ${state.syncStatus.error}`;
  }

  function renderNativeSignInLink() {
    const link = document.createElement("a");

    link.href = NATIVE_APP_SIGN_IN_URL;
    link.textContent = NATIVE_APP_SIGN_IN_TEXT;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      root.location.href = NATIVE_APP_SIGN_IN_URL;
    });
    syncStatusText.replaceChildren(link);
  }

  function refreshVisibleNativeSignInStatus() {
    if (document.hidden) { return; }

    refreshNativeSignInStatus();
  }

  function refreshNativeSignInStatus() {
    if (state.syncStatus.status !== "nativeSignInRequired" && state.syncStatus.status !== "signedOut") { return; }

    loadSyncStatus()
      .then(render)
      .catch(showFatalError);
  }

  function signedOutSyncStatusText() {
    if (timeLimitsAreHidden()) {
      return "Sign in to sync settings.";
    }

    return "Sign in to sync settings and screen time limits.";
  }

  function signedInSyncStatusText() {
    if (state.syncStatus.lastSuccessfulSyncAgeMs === null) {
      return "No successful sync yet.";
    }

    if (state.syncStatus.lastSuccessfulSyncAgeMs < 60 * 1000) {
      return "Last synced just now.";
    }

    return `Last synced ${formatSyncAge(state.syncStatus.lastSuccessfulSyncAgeMs)} ago.`;
  }

  function formatSyncAge(ageMs) {
    const minutes = Math.floor(ageMs / (60 * 1000));

    if (minutes < 60) {
      return pluralize(minutes, "minute");
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
      return pluralize(hours, "hour");
    }

    return pluralize(Math.floor(hours / 24), "day");
  }

  function pluralize(value, unit) {
    return value === 1 ? `1 ${unit}` : `${value} ${unit}s`;
  }

  function renderScreenTimeRow(entry) {
    const row = document.createElement("div");
    const domain = document.createElement("strong");
    const total = document.createElement("span");

    row.className = entry.isOverLimit ? "screen-time-row is-over-limit" : "screen-time-row";
    domain.className = "screen-time-domain";
    total.className = "screen-time-total";
    domain.textContent = entry.domain;
    total.textContent = timeLimitsAreHidden()
      ? formatDuration(entry.totalMs)
      : `${formatDuration(entry.totalMs)} / ${entry.limitMinutes}m`;
    row.append(domain, total);

    return row;
  }

  function renderDailyResetHourOptions() {
    for (let hour = 0; hour < 24; hour += 1) {
      const option = document.createElement("option");

      option.value = String(hour);
      option.textContent = minuteToTime(hour * 60);
      dailyResetHourSelect.append(option);
    }
  }

  function screenTimeTitleText(limitReset) {
    switch (limitReset.type) {
      case "rollingWindow": {
        const hours = limitReset.windowHours;

        if (!Number.isInteger(hours)) {
          return "Screen Time";
        }

        return `Last ${hours} ${hours === 1 ? "Hour" : "Hours"}`;
      }
      case "daily":
        return "Today";
      default:
        throw new Error(`Unknown limit reset type: ${limitReset.type}`);
    }
  }

  function timeLimitsAreHidden() {
    return state.draftSchedule.type === "always";
  }

  function addRow() {
    state.draftEntries.push(core.newEntry("url"));
    state.draftEntries[state.draftEntries.length - 1].limitMinutes = core.DEFAULT_LIMIT_MINUTES;
    clearMessages();
    render();
  }

  function updateKind(id, kind) {
    const entry = findDraftEntry(id);

    if (entry.type !== "custom") {
      throw new Error("Default entries cannot change matcher type.");
    }

    state.draftEntries = state.draftEntries.map((entry) => (
      entry.id === id ? { type: "custom", id: entry.id, kind, value: entry.value, limitMinutes: entry.limitMinutes } : entry
    ));
    syncLimitForEntry(findDraftEntry(id));
    state.rowErrors.delete(id);
    clearMessages();
    render();
  }

  function updateEnabled(id, enabled) {
    const entry = findDraftEntry(id);

    if (entry.type !== "default") {
      throw new Error("Only default entries can be enabled or disabled.");
    }

    entry.enabled = enabled;
    clearMessages();
    render();
  }

  function updateValue(id, value) {
    const entry = findDraftEntry(id);

    if (entry.type !== "custom") {
      throw new Error("Default entries cannot change URL.");
    }

    entry.value = value;
    syncLimitForEntry(entry);
    clearRowError(id);
    clearMessages();
    renderSaveButton();
  }

  function syncLimitForEntry(entry) {
    let domain = "";

    try {
      domain = core.domainForEntry(entry);
    } catch {
      return;
    }

    const matchingEntry = state.draftEntries.find((candidate) => {
      if (candidate.id === entry.id) {
        return false;
      }

      try {
        return core.domainForEntry(candidate) === domain;
      } catch {
        return false;
      }
    });

    if (matchingEntry) {
      entry.limitMinutes = matchingEntry.limitMinutes;
    }
  }

  function updateLimit(id, rawValue) {
    const entry = findDraftEntry(id);
    const limitMinutes = Number(rawValue);
    let domain = "";

    entry.limitMinutes = limitMinutes;

    try {
      domain = core.domainForEntry(entry);
    } catch {
      clearRowError(id);
      clearMessages();
      renderSaveButton();
      return;
    }

    state.draftEntries.forEach((candidate) => {
      try {
        if (core.domainForEntry(candidate) === domain) {
          candidate.limitMinutes = limitMinutes;
        }
      } catch {
        return;
      }
    });

    clearRowError(id);
    clearMessages();
    renderSaveButton();
  }

  function updateBlockedPageHtml() {
    state.draftBlockedPageHtml = blockedPageHtmlInput.value;
    clearMessages();
    renderSaveButton();
  }

  function updateScheduleType(type) {
    switch (type) {
      case "always":
        state.draftSchedule = { type: "always" };
        break;
      case "dailyWindow":
        state.draftSchedule = existingDailyWindow();
        break;
      default:
        throw new Error(`Unknown schedule type: ${type}`);
    }

    clearMessages();
    render();
  }

  function updateScheduleWindow() {
    state.draftSchedule = {
      type: "dailyWindow",
      startMinute: timeToMinute(scheduleStartInput.value),
      endMinute: timeToMinute(scheduleEndInput.value)
    };
    clearMessages();
    renderSaveButton();
  }

  function updateLimitResetType(type) {
    switch (type) {
      case "rollingWindow":
        state.draftLimitReset = existingRollingWindow();
        break;
      case "daily":
        state.draftLimitReset = existingDailyReset();
        break;
      default:
        throw new Error(`Unknown limit reset type: ${type}`);
    }

    clearMessages();
    render();
  }

  function updateRollingWindow() {
    state.draftLimitReset = {
      type: "rollingWindow",
      windowHours: Number(rollingWindowHoursInput.value)
    };
    clearMessages();
    renderScreenTimeTitle();
    renderSaveButton();
  }

  function updateDailyResetHour() {
    state.draftLimitReset = {
      type: "daily",
      resetHour: Number(dailyResetHourSelect.value)
    };
    clearMessages();
    renderScreenTimeTitle();
    renderSaveButton();
  }

  function updateSettingsDelayType(type) {
    switch (type) {
      case "immediate":
        state.draftSettingsDelay = { type: "immediate" };
        break;
      case "delayed":
        state.draftSettingsDelay = existingDelayedSettingsDelay();
        break;
      default:
        throw new Error(`Unknown settings delay type: ${type}`);
    }

    clearMessages();
    render();
  }

  function updateSettingsDelayMinutes() {
    state.draftSettingsDelay = {
      type: "delayed",
      delayMinutes: Number(settingsDelayMinutesInput.value)
    };
    clearMessages();
    renderSaveButton();
  }

  function deleteRow(id) {
    const entry = findDraftEntry(id);

    if (entry.type !== "custom") {
      throw new Error("Default entries cannot be deleted.");
    }

    state.draftEntries = state.draftEntries.filter((entry) => entry.id !== id);
    state.draftEntries = ensureDraftEntry(state.draftEntries);
    state.rowErrors.delete(id);
    clearMessages();
    render();
  }

  function normalizeUrlInput(id) {
    const entry = findDraftEntry(id);

    if (entry.type !== "custom") {
      return;
    }

    if (entry.kind !== "url" && entry.kind !== "urlWithSubpaths") {
      return;
    }

    if (entry.value.trim() === "") {
      return;
    }

    try {
      entry.value = core.normalizeUrlEntryValue(entry.value);
      state.rowErrors.delete(id);
    } catch (error) {
      state.rowErrors.set(id, error.message);
    }

    render();
  }

  async function saveDraft() {
    state.isSaving = true;
    clearMessages();
    render();

    const localResult = normalizeAndValidateDraft();

    if (localResult.type === "invalid") {
      state.isSaving = false;
      showValidationErrors(localResult.errors);
      return;
    }

    try {
      await requestWebsiteAccess(localResult.state);
    } catch (error) {
      state.isSaving = false;
      state.pageError = errorMessage(error);
      render();
      return;
    }

    const response = await api.runtime.sendMessage({
      type: "saveState",
      state: localResult.state
    });

    state.isSaving = false;

    switch (response.type) {
      case "saved":
        finishSavedState();
        await applySavedState(response.state, response.activation);
        return;
      case "validationError":
        showValidationErrors(response.errors);
        return;
      case "error":
        state.pageError = errorMessage(errorFromResponse(response));
        render();
        return;
      default:
        throw codedError("UnexpectedSaveStateResponse", `Unknown saveState response: ${response.type}`);
    }
  }

  async function requestWebsiteAccess(blockerState) {
    const origins = await missingWebsiteOrigins(core.permissionOriginsForState(blockerState));

    if (origins.length === 0) {
      return;
    }

    const granted = await api.permissions.request({ origins });

    if (!granted) {
      throw codedError("WebsiteAccessDenied", "Allow the requested website access before saving.");
    }
  }

  async function requestMissingWebsiteAccess() {
    state.isRequestingPermissions = true;
    clearMessages();
    render();

    try {
      const granted = await api.permissions.request({ origins: state.missingOrigins });

      if (!granted) {
        state.isRequestingPermissions = false;
        state.pageError = errorMessage(codedError("WebsiteAccessDenied", "Allow website access before editing the blocklist."));
        render();
        return;
      }

      const response = await api.runtime.sendMessage({ type: "syncWebsiteAccess" });

      if (response.type !== "synced") {
        throw errorFromResponse(response);
      }

      state.isRequestingPermissions = false;
      state.missingOrigins = [];
      render();
    } catch (error) {
      state.isRequestingPermissions = false;
      state.pageError = errorMessage(error);
      render();
    }
  }

  async function refreshWebsiteAccess(blockerState) {
    state.missingOrigins = await missingWebsiteOrigins(core.permissionOriginsForState(blockerState));
  }

  async function missingWebsiteOrigins(origins) {
    const missingOrigins = [];

    for (const origin of origins) {
      if (!await api.permissions.contains({ origins: [origin] })) {
        missingOrigins.push(origin);
      }
    }

    return missingOrigins;
  }

  async function loadScreenTimeLog(messageType) {
    const response = await api.runtime.sendMessage({ type: messageType });

    switch (response.type) {
      case "screenTimeLog":
        state.screenTimeEntries = normalizeScreenTimeEntries(response.entries);
        return;
      case "error":
        throw errorFromResponse(response);
      default:
        throw codedError("UnexpectedScreenTimeResponse", `Unknown ${messageType} response: ${response.type}`);
    }
  }

  async function loadSyncStatus() {
    const response = await api.runtime.sendMessage({ type: "getSyncStatus" });

    switch (response.type) {
      case "syncStatus":
        state.syncStatus = normalizeSyncStatus(response);
        return;
      case "error":
        state.syncStatus = syncStatusFromError(errorFromResponse(response));
        return;
      default:
        throw codedError("UnexpectedSyncStatusResponse", `Unknown getSyncStatus response: ${response.type}`);
    }
  }

  async function signInWithProvider(provider) {
    clearMessages();
    syncStatusText.textContent = `Opening ${providerTitle(provider)} sign-in.`;
    googleSignInButton.disabled = true;
    appleSignInButton.disabled = true;

    const response = await api.runtime.sendMessage({ type: "signInWithProvider", provider });

    switch (response.type) {
      case "signedIn":
        await loadSyncStatus();
        await loadScreenTimeLog("getScreenTimeLog");
        render();
        return;
      case "nativeSignInRequired":
        state.syncStatus = { status: "nativeSignInRequired", error: "", lastSuccessfulSyncAgeMs: null };
        render();
        return;
      case "openOAuth":
        await openOAuth(response.url);
        return;
      case "syncUnavailable":
        state.syncStatus = { status: "unconfigured", error: "", lastSuccessfulSyncAgeMs: null };
        render();
        return;
      case "error":
        state.syncStatus = syncStatusFromError(errorFromResponse(response));
        render();
        return;
      default:
        throw codedError("UnexpectedSignInResponse", `Unknown signInWithProvider response: ${response.type}`);
    }
  }

  function providerTitle(provider) {
    switch (provider) {
      case "google":
        return "Google";
      case "apple":
        return "Apple";
      default:
        throw new Error(`Unknown sign-in provider: ${provider}`);
    }
  }

  async function syncNow() {
    clearMessages();

    const response = await api.runtime.sendMessage({ type: "syncNow" });

    switch (response.type) {
      case "synced":
        state.syncStatus = normalizeSyncStatus(response.status);
        await loadLocalState();
        render();
        return;
      case "error":
        state.syncStatus = syncStatusFromError(errorFromResponse(response));
        render();
        return;
      default:
        throw codedError("UnexpectedSyncNowResponse", `Unknown syncNow response: ${response.type}`);
    }
  }

  async function signOut() {
    clearMessages();

    const response = await api.runtime.sendMessage({ type: "signOut" });

    switch (response.type) {
      case "signedOut":
        await loadSyncStatus();
        render();
        return;
      case "error":
        state.syncStatus = syncStatusFromError(errorFromResponse(response));
        render();
        return;
      default:
        throw codedError("UnexpectedSignOutResponse", `Unknown signOut response: ${response.type}`);
    }
  }

  async function completeOAuthRedirect() {
    if (!root.location.hash.includes("access_token=")) {
      return;
    }

    const response = await api.runtime.sendMessage({
      type: "completeOAuthRedirect",
      url: root.location.href
    });

    switch (response.type) {
      case "signedIn":
        root.history.replaceState(null, "", root.location.pathname);
        return;
      case "error":
        throw errorFromResponse(response);
      default:
        throw codedError("UnexpectedOAuthRedirectResponse", `Unknown completeOAuthRedirect response: ${response.type}`);
    }
  }

  async function openOAuth(url) {
    if (api.tabs && typeof api.tabs.create === "function") {
      await api.tabs.create({ url });
      return;
    }

    root.location.href = url;
  }

  async function loadDefaultStateForReset() {
    const response = await api.runtime.sendMessage({ type: "getDefaultState" });

    switch (response.type) {
      case "state":
        setDraftState(response.state, { type: "active" });
        return;
      case "error":
        throw errorFromResponse(response);
      default:
        throw codedError("UnexpectedGetDefaultStateResponse", `Unknown getDefaultState response: ${response.type}`);
    }
  }

  function permissionPanelMessage() {
    if (state.missingOrigins.length === 1) {
      return "URL Blocker needs access to this website before blocking can run.";
    }

    return `URL Blocker needs access to these ${state.missingOrigins.length} websites before blocking can run.`;
  }

  function syncStatusFromError(error) {
    const status = state.syncStatus.status === "signedIn" ? "signedIn" : "error";

    return {
      status,
      error: errorMessage(error),
      lastSuccessfulSyncAgeMs: status === "signedIn" ? state.syncStatus.lastSuccessfulSyncAgeMs : null
    };
  }

  function normalizeAndValidateDraft() {
    try {
      state.draftEntries = state.draftEntries.map(normalizeDraftEntry);
    } catch {
      return core.validateState({
        schemaVersion: core.SCHEMA_VERSION,
        entries: storedEntries(state.draftEntries),
        blockedPageHtml: state.draftBlockedPageHtml,
        schedule: state.draftSchedule,
        limitReset: state.draftLimitReset,
        settingsDelay: state.draftSettingsDelay,
        domainLimits: domainLimitsForDraft()
      }, state.defaultEntries);
    }

    const result = core.validateState({
      schemaVersion: core.SCHEMA_VERSION,
      entries: storedEntries(state.draftEntries),
      blockedPageHtml: state.draftBlockedPageHtml,
      schedule: state.draftSchedule,
      limitReset: state.draftLimitReset,
      settingsDelay: state.draftSettingsDelay,
      domainLimits: domainLimitsForDraft()
    }, state.defaultEntries);

    if (result.type === "valid") {
      state.draftEntries = editableEntries(result.state.entries, result.state.domainLimits);
      state.draftBlockedPageHtml = result.state.blockedPageHtml;
      state.draftSchedule = editableSchedule(result.state.schedule);
      state.draftLimitReset = editableLimitReset(result.state.limitReset);
      state.draftSettingsDelay = editableSettingsDelay(result.state.settingsDelay);
    }

    return result;
  }

  function normalizeDraftEntry(entry) {
    if (entry.kind !== "url" && entry.kind !== "urlWithSubpaths") {
      return entry;
    }

    switch (entry.type) {
      case "custom":
        return { ...entry, value: core.normalizeUrlEntryValue(entry.value) };
      case "default":
        return entry;
      default:
        throw new Error(`Unknown entry type: ${entry.type}`);
    }
  }

  function storedEntries(entries) {
    return entries.map((entry) => {
      switch (entry.type) {
        case "custom":
          return { type: "custom", id: entry.id, kind: entry.kind, value: entry.value };
        case "default":
          return { type: "default", id: entry.id, kind: entry.kind, value: entry.value, enabled: entry.enabled };
        default:
          throw new Error(`Unknown entry type: ${entry.type}`);
      }
    });
  }

  function domainLimitsForDraft() {
    const hints = [];

    state.draftEntries.forEach((entry) => {
      try {
        hints.push({ domain: core.domainForEntry(entry), limitMinutes: entry.limitMinutes });
      } catch {
        return;
      }
    });

    return core.domainLimitsForEntries(storedEntries(state.draftEntries), hints);
  }

  async function resetBlocklist() {
    resetButton.disabled = true;
    clearMessages();

    const localResult = normalizeAndValidateDraft();

    if (localResult.type === "invalid") {
      showRepair(codedError("ValidationError", localResult.errors.map((error) => error.message).join("\n")));
      return;
    }

    try {
      await requestWebsiteAccess(localResult.state);
    } catch (error) {
      showRepair(error);
      return;
    }

    const response = await api.runtime.sendMessage({
      type: "saveState",
      state: localResult.state
    });

    switch (response.type) {
      case "saved":
        resetButton.disabled = false;
        finishSavedState();
        await applySavedState(response.state, response.activation);
        return;
      case "validationError":
        showRepair(codedError("ValidationError", response.errors.map((error) => error.message).join("\n")));
        return;
      case "error":
        showRepair(errorFromResponse(response));
        return;
      default:
        throw codedError("UnexpectedSaveStateResponse", `Unknown saveState response: ${response.type}`);
    }
  }

  async function applySavedState(savedState, activation) {
    setDraftState(savedState, activation);
    render();

    await loadScreenTimeLog("getScreenTimeLog");
    await loadSyncStatus();
    render();
  }

  function finishSavedState() {
    api.runtime.sendMessage({ type: "finishSavedState" })
      .then(handleFinishedSavedState)
      .catch((error) => {
        state.pageError = errorMessage(error);
        render();
      });
  }

  async function handleFinishedSavedState(response) {
    switch (response.type) {
      case "finishedSavedState":
        if (!draftHasUnsavedChanges()) {
          setDraftState(response.state, response.activation);
        }

        await loadSyncStatus();
        render();
        return;
      case "error":
        state.pageError = errorMessage(errorFromResponse(response));
        render();
        return;
      default:
        throw codedError("UnexpectedFinishSavedStateResponse", `Unknown finishSavedState response: ${response.type}`);
    }
  }

  function setDraftState(blockerState, activation) {
    state.defaultEntries = defaultEntriesFromState(blockerState.entries);
    state.draftEntries = editableEntries(blockerState.entries, blockerState.domainLimits);
    state.draftBlockedPageHtml = blockerState.blockedPageHtml;
    state.draftSchedule = editableSchedule(blockerState.schedule);
    state.draftLimitReset = editableLimitReset(blockerState.limitReset);
    state.draftSettingsDelay = editableSettingsDelay(blockerState.settingsDelay);
    state.settingsActivation = activation || { type: "active" };
    state.savedDraft = draftSnapshot();
  }

  function showValidationErrors(errors) {
    state.rowErrors = new Map();
    state.pageError = errorMessage(codedError("ValidationError", "Fix the highlighted rows before saving."));

    errors.forEach((error) => {
      if (error.index === null) {
        state.pageError = errorMessage(codedError("ValidationError", error.message));
        return;
      }

      const entry = state.draftEntries[error.index];

      if (entry) {
        state.rowErrors.set(entry.id, error.message);
      }
    });

    render();
  }

  function showRepair(error) {
    resetButton.disabled = false;
    repairMessage.textContent = errorMessage(error);
    repairPanel.hidden = false;
    editorPanel.hidden = true;
  }

  function showFatalError(error) {
    state.pageError = errorMessage(error);
    render();
  }

  function errorFromResponse(response) {
    return codedError(response.errorCode || response.type, response.error || `Unexpected response: ${response.type}`);
  }

  function errorFromReason(reason) {
    if (reason instanceof Error) {
      return reason;
    }

    return codedError("UnhandledPromiseRejection", String(reason));
  }

  function codedError(errorCode, message) {
    const error = new Error(message);
    error.errorCode = errorCode;
    return error;
  }

  function errorMessage(error) {
    const code = errorCode(error);
    const message = error instanceof Error ? error.message : String(error);

    return `${message}\n\nCode: ${code}`;
  }

  function errorCode(error) {
    if (error instanceof Error && typeof error.errorCode === "string") {
      return error.errorCode;
    }

    if (error instanceof Error && error.code !== undefined) {
      return String(error.code);
    }

    if (error instanceof Error && error.name !== "") {
      return error.name;
    }

    return "UnknownError";
  }

  function clearMessages() {
    state.pageError = "";
    errorSummary.hidden = true;
    errorSummary.textContent = "";
    permissionError.hidden = true;
    permissionError.textContent = "";
  }

  function clearRowError(id) {
    state.rowErrors.delete(id);

    const row = Array.from(rowsElement.children).find((child) => child.dataset.entryId === id);

    if (!row) { return; }

    const rowError = row.querySelector(".row-error");

    rowError.hidden = true;
    rowError.textContent = "";
  }

  function findDraftEntry(id) {
    const entry = state.draftEntries.find((candidate) => candidate.id === id);

    if (!entry) {
      throw new Error(`Missing draft entry: ${id}`);
    }

    return entry;
  }

  function editableEntries(entries, domainLimits) {
    const limits = new Map(domainLimits.map((limit) => [limit.domain, limit.limitMinutes]));

    return ensureDraftEntry(entries.map((entry) => {
      const limitMinutes = limits.get(core.associatedDomainForEntry(entry));

      switch (entry.type) {
        case "custom":
          return { type: "custom", id: entry.id, kind: entry.kind, value: entry.value, limitMinutes };
        case "default":
          return { type: "default", id: entry.id, kind: entry.kind, value: entry.value, enabled: entry.enabled, limitMinutes };
        default:
          throw new Error(`Unknown entry type: ${entry.type}`);
      }
    }));
  }

  function defaultEntriesFromState(entries) {
    const defaultEntries = [];

    entries.forEach((entry) => {
      switch (entry.type) {
        case "custom":
          return;
        case "default":
          defaultEntries.push({ type: "default", id: entry.id, kind: entry.kind, value: entry.value, enabled: true });
          return;
        default:
          throw new Error(`Unknown entry type: ${entry.type}`);
      }
    });

    return defaultEntries;
  }

  function editableSchedule(schedule) {
    switch (schedule.type) {
      case "always":
        return { type: "always" };
      case "dailyWindow":
        return {
          type: "dailyWindow",
          startMinute: schedule.startMinute,
          endMinute: schedule.endMinute
        };
      default:
        throw new Error(`Unknown schedule type: ${schedule.type}`);
    }
  }

  function editableLimitReset(limitReset) {
    switch (limitReset.type) {
      case "rollingWindow":
        return { type: "rollingWindow", windowHours: limitReset.windowHours };
      case "daily":
        return { type: "daily", resetHour: limitReset.resetHour };
      default:
        throw new Error(`Unknown limit reset type: ${limitReset.type}`);
    }
  }

  function editableSettingsDelay(settingsDelay) {
    switch (settingsDelay.type) {
      case "immediate":
        return { type: "immediate" };
      case "delayed":
        return { type: "delayed", delayMinutes: settingsDelay.delayMinutes };
      default:
        throw new Error(`Unknown settings delay type: ${settingsDelay.type}`);
    }
  }

  function existingDailyWindow() {
    if (state.draftSchedule.type === "dailyWindow") {
      return state.draftSchedule;
    }

    if (state.savedDraft.schedule.type === "dailyWindow") {
      return state.savedDraft.schedule;
    }

    return core.DEFAULT_SCHEDULE;
  }

  function existingRollingWindow() {
    if (state.draftLimitReset.type === "rollingWindow") {
      return state.draftLimitReset;
    }

    if (state.savedDraft.limitReset.type === "rollingWindow") {
      return state.savedDraft.limitReset;
    }

    return core.DEFAULT_LIMIT_RESET;
  }

  function existingDailyReset() {
    if (state.draftLimitReset.type === "daily") {
      return state.draftLimitReset;
    }

    if (state.savedDraft.limitReset.type === "daily") {
      return state.savedDraft.limitReset;
    }

    return { type: "daily", resetHour: 0 };
  }

  function existingDelayedSettingsDelay() {
    if (state.draftSettingsDelay.type === "delayed") {
      return state.draftSettingsDelay;
    }

    if (state.savedDraft.settingsDelay.type === "delayed") {
      return state.savedDraft.settingsDelay;
    }

    return core.DEFAULT_SETTINGS_DELAY;
  }

  function rollingWindowHours() {
    if (state.draftLimitReset.type === "rollingWindow") {
      return state.draftLimitReset.windowHours;
    }

    return core.DEFAULT_LIMIT_RESET.windowHours;
  }

  function dailyResetHour() {
    if (state.draftLimitReset.type === "daily") {
      return state.draftLimitReset.resetHour;
    }

    return 0;
  }

  function settingsDelayMinutes() {
    if (state.draftSettingsDelay.type === "delayed") {
      return state.draftSettingsDelay.delayMinutes;
    }

    return core.DEFAULT_SETTINGS_DELAY.delayMinutes;
  }

  function minuteToTime(minute) {
    if (!Number.isInteger(minute)) {
      return "";
    }

    const hours = String(Math.floor(minute / 60)).padStart(2, "0");
    const minutes = String(minute % 60).padStart(2, "0");

    return `${hours}:${minutes}`;
  }

  function formatDuration(totalMs) {
    const totalMinutes = Math.round(totalMs / (60 * 1000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours > 0) {
      return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    }

    return `${minutes}m`;
  }

  function timeToMinute(value) {
    if (!/^\d{2}:\d{2}$/.test(value)) {
      return NaN;
    }

    const [hours, minutes] = value.split(":").map(Number);

    return hours * 60 + minutes;
  }

  function ensureDraftEntry(entries) {
    if (entries.length > 0) {
      return entries;
    }

    const entry = core.newEntry("url");

    entry.limitMinutes = core.DEFAULT_LIMIT_MINUTES;

    return [entry];
  }

  function customEntryCount() {
    return state.draftEntries.filter((entry) => entry.type === "custom").length;
  }

  function placeholderFor(kind) {
    switch (kind) {
      case "domain":
        return "example.com";
      case "url":
        return "example.com/path";
      case "urlWithSubpaths":
        return "example.com/path";
      case "regex":
        return "^https://x\\.com/(home|explore)/?$";
      default:
        throw new Error(`Unknown matcher kind: ${kind}`);
    }
  }

  function normalizeScreenTimeEntries(entries) {
    if (!Array.isArray(entries)) {
      throw new Error("Screen time entries must be an array.");
    }

    return entries.map((entry) => {
      if (!isPlainObject(entry)) {
        throw new Error("Screen time entry must be an object.");
      }

      requireKeys(entry, ["domain", "totalMs", "limitMinutes", "isOverLimit"], "Screen time entry");

      if (typeof entry.domain !== "string" || entry.domain.trim() === "") {
        throw new Error("Screen time entry domain must be a string.");
      }

      if (!Number.isInteger(entry.totalMs) || entry.totalMs < 0) {
        throw new Error("Screen time entry total must be a non-negative integer.");
      }

      if (!Number.isInteger(entry.limitMinutes) || entry.limitMinutes < 1 || entry.limitMinutes > core.MAX_LIMIT_MINUTES) {
        throw new Error("Screen time entry limit must be a valid integer.");
      }

      if (typeof entry.isOverLimit !== "boolean") {
        throw new Error("Screen time entry over-limit value must be a boolean.");
      }

      return {
        domain: entry.domain,
        totalMs: entry.totalMs,
        limitMinutes: entry.limitMinutes,
        isOverLimit: entry.isOverLimit
      };
    });
  }

  function normalizeSyncStatus(response) {
    requireKeys(response, ["type", "status", "userId", "lastSuccessfulSyncAgeMs", "error"], "Sync status");

    switch (response.status) {
      case "unconfigured":
      case "signedOut":
      case "signedIn":
      case "nativeSignInRequired":
      case "error":
        if (response.status === "signedIn") {
          const ageMs = response.lastSuccessfulSyncAgeMs;

          if (ageMs !== null && (!Number.isInteger(ageMs) || ageMs < 0)) {
            throw new Error("Sync status last successful sync age must be null or a non-negative integer.");
          }
        }

        return {
          status: response.status,
          error: typeof response.error === "string" ? response.error : "",
          lastSuccessfulSyncAgeMs: response.status === "signedIn" ? response.lastSuccessfulSyncAgeMs : null
        };
      default:
        throw new Error(`Unknown sync status: ${response.status}`);
    }
  }

  function requireKeys(object, allowedKeys, label) {
    const allowed = new Set(allowedKeys);
    const unknownKeys = Object.keys(object).filter((key) => !allowed.has(key));

    if (unknownKeys.length > 0) {
      throw new Error(`${label} has unknown key: ${unknownKeys[0]}.`);
    }
  }

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
})(globalThis);
