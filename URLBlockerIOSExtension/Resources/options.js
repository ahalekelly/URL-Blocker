(function loadOptions(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const core = root.BlockerCore;
  const state = {
    defaultEntries: [],
    draftEntries: [],
    draftBlockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    draftSchedule: core.DEFAULT_SCHEDULE,
    rowErrors: new Map(),
    pageError: "",
    successMessage: "",
    isSaving: false,
    isRequestingPermissions: false,
    missingOrigins: [],
    screenTimeEntries: []
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
  const errorSummary = document.getElementById("errorSummary");
  const successMessage = document.getElementById("successMessage");
  const screenTimeRows = document.getElementById("screenTimeRows");
  const emptyScreenTime = document.getElementById("emptyScreenTime");
  const repairPanel = document.getElementById("repairPanel");
  const repairMessage = document.getElementById("repairMessage");
  const resetButton = document.getElementById("resetButton");
  const editorPanel = document.getElementById("editorPanel");
  const permissionPanel = document.getElementById("permissionPanel");
  const permissionMessage = document.getElementById("permissionMessage");
  const permissionError = document.getElementById("permissionError");
  const grantAccessButton = document.getElementById("grantAccessButton");

  addRowButton.addEventListener("click", addRow);
  saveButton.addEventListener("click", saveDraft);
  blockedPageHtmlInput.addEventListener("input", updateBlockedPageHtml);
  alwaysScheduleInput.addEventListener("change", () => updateScheduleType("always"));
  dailyScheduleInput.addEventListener("change", () => updateScheduleType("dailyWindow"));
  scheduleStartInput.addEventListener("input", updateScheduleWindow);
  scheduleEndInput.addEventListener("input", updateScheduleWindow);
  resetButton.addEventListener("click", resetBlocklist);
  grantAccessButton.addEventListener("click", requestMissingWebsiteAccess);

  loadState().catch(showFatalError);

  async function loadState() {
    const response = await api.runtime.sendMessage({ type: "getState" });

    switch (response.type) {
      case "state":
        state.defaultEntries = defaultEntriesFromState(response.state.entries);
        state.draftEntries = editableEntries(response.state.entries, response.state.domainLimits);
        state.draftBlockedPageHtml = response.state.blockedPageHtml;
        state.draftSchedule = editableSchedule(response.state.schedule);
        await refreshWebsiteAccess(response.state);
        await loadScreenTimeLog();
        render();
        return;
      case "stateError":
        showRepair(response.error);
        return;
      case "error":
        showFatalError(new Error(response.error));
        return;
      default:
        throw new Error(`Unknown getState response: ${response.type}`);
    }
  }

  function render() {
    const needsWebsiteAccess = state.missingOrigins.length > 0;

    repairPanel.hidden = true;
    permissionPanel.hidden = !needsWebsiteAccess;
    editorPanel.hidden = needsWebsiteAccess;
    rowsElement.replaceChildren(...renderBlockItems());
    blockedPageHtmlInput.value = state.draftBlockedPageHtml;
    alwaysScheduleInput.checked = state.draftSchedule.type === "always";
    dailyScheduleInput.checked = state.draftSchedule.type === "dailyWindow";
    scheduleWindowFields.hidden = state.draftSchedule.type !== "dailyWindow";
    scheduleStartInput.value = minuteToTime(state.draftSchedule.startMinute);
    scheduleEndInput.value = minuteToTime(state.draftSchedule.endMinute);
    saveButton.disabled = state.isSaving;
    grantAccessButton.disabled = state.isRequestingPermissions;
    permissionMessage.textContent = needsWebsiteAccess ? permissionPanelMessage() : "";
    permissionError.hidden = state.pageError === "";
    permissionError.textContent = state.pageError;
    errorSummary.hidden = state.pageError === "";
    errorSummary.textContent = state.pageError;
    successMessage.hidden = state.successMessage === "";
    successMessage.textContent = state.successMessage;
    renderScreenTimeLog();
  }

  function renderBlockItems() {
    const groupedDefaults = groupedDefaultEntries();
    const renderedDomains = new Set();

    return state.draftEntries.flatMap((entry) => {
      if (entry.type !== "default") {
        return [renderRow(entry)];
      }

      const domain = core.associatedDomainForEntry(entry);
      const group = groupedDefaults.get(domain);

      if (!group) {
        return [renderRow(entry)];
      }

      if (renderedDomains.has(domain)) {
        return [];
      }

      renderedDomains.add(domain);

      return [renderDefaultGroup(domain, group)];
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

  function renderDefaultGroup(domain, entries) {
    const group = document.createElement("article");
    const toolbar = document.createElement("div");
    const title = document.createElement("div");
    const limitLabel = document.createElement("label");
    const limitInput = document.createElement("input");
    const entryList = document.createElement("div");

    group.className = "block-row default-group";
    group.dataset.domain = domain;
    toolbar.className = "row-toolbar default-group-toolbar";
    title.className = "default-group-title";
    title.textContent = domain;
    limitLabel.className = "default-group-limit";
    limitLabel.textContent = "Limit minutes";
    limitInput.className = "limit-input";
    limitInput.type = "number";
    limitInput.min = "1";
    limitInput.max = "960";
    limitInput.step = "1";
    limitInput.inputMode = "numeric";
    limitInput.setAttribute("aria-label", `Limit minutes for ${domain}`);
    limitInput.value = String(entries[0].limitMinutes);
    limitInput.addEventListener("input", () => updateLimit(entries[0].id, limitInput.value));
    entryList.className = "default-group-entries";
    entryList.replaceChildren(...entries.map(renderDefaultGroupEntry));
    limitLabel.append(limitInput);
    toolbar.append(title, limitLabel);
    group.append(toolbar, entryList);

    return group;
  }

  function renderDefaultGroupEntry(entry) {
    const row = document.createElement("div");
    const enabledLabel = document.createElement("label");
    const enabledInput = document.createElement("input");
    const enabledText = document.createElement("span");
    const value = document.createElement("span");
    const rowError = document.createElement("p");
    const error = state.rowErrors.get(entry.id) || "";

    row.className = "default-group-entry";
    row.dataset.entryId = entry.id;
    enabledLabel.className = "enabled-label";
    enabledInput.className = "enabled-input";
    enabledInput.type = "checkbox";
    enabledInput.checked = entry.enabled;
    enabledInput.setAttribute("aria-label", `Enable ${entry.value}`);
    enabledInput.addEventListener("change", () => updateEnabled(entry.id, enabledInput.checked));
    enabledText.textContent = "Enabled";
    value.className = "default-group-entry-value";
    value.textContent = entry.value;
    rowError.className = "row-error";
    rowError.hidden = error === "";
    rowError.textContent = error;
    enabledLabel.append(enabledInput, enabledText);
    row.append(value, enabledLabel, rowError);

    return row;
  }

  function renderRow(entry) {
    const fragment = rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".block-row");
    const segments = fragment.querySelector(".segments");
    const enabledInput = fragment.querySelector(".enabled-input");
    const enabledLabel = fragment.querySelector(".enabled-label");
    const input = fragment.querySelector(".value-input");
    const limitInput = fragment.querySelector(".limit-input");
    const deleteButton = fragment.querySelector(".delete-button");
    const rowError = fragment.querySelector(".row-error");
    const error = state.rowErrors.get(entry.id) || "";

    renderEntryControls(entry, segments, enabledInput, enabledLabel, deleteButton);

    input.value = entry.value;
    input.placeholder = placeholderFor(entry.kind);
    input.readOnly = entry.type === "default";

    if (entry.type === "custom") {
      input.addEventListener("input", () => updateValue(entry.id, input.value));
      input.addEventListener("blur", () => normalizeUrlInput(entry.id));
    }

    limitInput.value = String(entry.limitMinutes);
    limitInput.addEventListener("input", () => updateLimit(entry.id, limitInput.value));
    rowError.hidden = error === "";
    rowError.textContent = error;
    row.dataset.entryId = entry.id;

    return fragment;
  }

  function renderEntryControls(entry, segments, enabledInput, enabledLabel, deleteButton) {
    switch (entry.type) {
      case "custom":
        enabledLabel.hidden = true;
        deleteButton.disabled = state.defaultEntries.length === 0 && customEntryCount() === 1;
        deleteButton.addEventListener("click", () => deleteRow(entry.id));
        renderKindButtons(entry, segments);
        return;
      case "default":
        segments.classList.add("default-kind");
        segments.textContent = "Default URL";
        enabledInput.checked = entry.enabled;
        enabledInput.addEventListener("change", () => updateEnabled(entry.id, enabledInput.checked));
        deleteButton.hidden = true;
        return;
      default:
        throw new Error(`Unknown entry type: ${entry.type}`);
    }
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

  function renderScreenTimeRow(entry) {
    const row = document.createElement("div");
    const domain = document.createElement("strong");
    const total = document.createElement("span");

    row.className = entry.isOverLimit ? "screen-time-row is-over-limit" : "screen-time-row";
    domain.className = "screen-time-domain";
    total.className = "screen-time-total";
    domain.textContent = entry.domain;
    total.textContent = `${formatDuration(entry.totalMs)} / ${entry.limitMinutes}m`;
    row.append(domain, total);

    return row;
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
    state.rowErrors.delete(id);
    clearMessages();
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
      state.rowErrors.delete(id);
      clearMessages();
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

    state.rowErrors.delete(id);
    clearMessages();
    render();
  }

  function updateBlockedPageHtml() {
    state.draftBlockedPageHtml = blockedPageHtmlInput.value;
    clearMessages();
  }

  function updateScheduleType(type) {
    switch (type) {
      case "always":
        state.draftSchedule = core.DEFAULT_SCHEDULE;
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
      state.pageError = error.message;
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
        state.defaultEntries = defaultEntriesFromState(response.state.entries);
        state.draftEntries = editableEntries(response.state.entries, response.state.domainLimits);
        state.draftBlockedPageHtml = response.state.blockedPageHtml;
        state.draftSchedule = editableSchedule(response.state.schedule);
        state.successMessage = "Saved.";
        render();
        return;
      case "validationError":
        showValidationErrors(response.errors);
        return;
      case "error":
        state.pageError = response.error;
        render();
        return;
      default:
        throw new Error(`Unknown saveState response: ${response.type}`);
    }
  }

  async function requestWebsiteAccess(blockerState) {
    const origins = core.permissionOriginsForState(blockerState);

    if (origins.length === 0) {
      return;
    }

    const granted = await api.permissions.request({ origins });

    if (!granted) {
      throw new Error("Allow the requested website access before saving.");
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
        state.pageError = "Allow website access before editing the blocklist.";
        render();
        return;
      }

      const response = await api.runtime.sendMessage({ type: "syncWebsiteAccess" });

      if (response.type !== "synced") {
        throw new Error("Website access was granted, but blocking could not be refreshed.");
      }

      state.isRequestingPermissions = false;
      state.missingOrigins = [];
      state.successMessage = "Website access granted.";
      render();
    } catch (error) {
      state.isRequestingPermissions = false;
      state.pageError = error.message;
      render();
    }
  }

  async function refreshWebsiteAccess(blockerState) {
    const origins = core.permissionOriginsForState(blockerState);

    if (origins.length === 0 || await api.permissions.contains({ origins })) {
      state.missingOrigins = [];
      return;
    }

    state.missingOrigins = origins;
  }

  async function loadScreenTimeLog() {
    const response = await api.runtime.sendMessage({ type: "getScreenTimeLog" });

    switch (response.type) {
      case "screenTimeLog":
        state.screenTimeEntries = normalizeScreenTimeEntries(response.entries);
        return;
      case "error":
        throw new Error(response.error);
      default:
        throw new Error(`Unknown getScreenTimeLog response: ${response.type}`);
    }
  }

  function permissionPanelMessage() {
    if (state.missingOrigins.length === 1) {
      return "URL Blocker needs access to this website before blocking can run.";
    }

    return `URL Blocker needs access to these ${state.missingOrigins.length} websites before blocking can run.`;
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
        domainLimits: domainLimitsForDraft()
      }, state.defaultEntries);
    }

    const result = core.validateState({
      schemaVersion: core.SCHEMA_VERSION,
      entries: storedEntries(state.draftEntries),
      blockedPageHtml: state.draftBlockedPageHtml,
      schedule: state.draftSchedule,
      domainLimits: domainLimitsForDraft()
    }, state.defaultEntries);

    if (result.type === "valid") {
      state.draftEntries = editableEntries(result.state.entries, result.state.domainLimits);
      state.draftBlockedPageHtml = result.state.blockedPageHtml;
      state.draftSchedule = editableSchedule(result.state.schedule);
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
    const response = await api.runtime.sendMessage({
      type: "resetState"
    });

    if (response.type !== "saved") {
      showFatalError(new Error("Reset failed."));
      return;
    }

    state.defaultEntries = defaultEntriesFromState(response.state.entries);
    state.draftEntries = editableEntries(response.state.entries, response.state.domainLimits);
    state.draftBlockedPageHtml = response.state.blockedPageHtml;
    state.draftSchedule = editableSchedule(response.state.schedule);
    state.successMessage = "Reset.";
    render();
  }

  function showValidationErrors(errors) {
    state.rowErrors = new Map();
    state.pageError = "Fix the highlighted rows before saving.";

    errors.forEach((error) => {
      if (error.index === null) {
        state.pageError = error.message;
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
    repairMessage.textContent = error;
    repairPanel.hidden = false;
    editorPanel.hidden = true;
  }

  function showFatalError(error) {
    state.pageError = error.message;
    render();
  }

  function clearMessages() {
    state.pageError = "";
    state.successMessage = "";
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
        return core.DEFAULT_SCHEDULE;
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

  function existingDailyWindow() {
    if (state.draftSchedule.type === "dailyWindow") {
      return state.draftSchedule;
    }

    return { type: "dailyWindow", startMinute: 540, endMinute: 1020 };
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
    const totalSeconds = Math.round(totalMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    }

    if (minutes > 0) {
      return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }

    return `${seconds}s`;
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
