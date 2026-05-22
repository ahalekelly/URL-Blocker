(function loadOptions(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const core = root.BlockerCore;
  const state = {
    draftEntries: [],
    draftBlockedPageHtml: core.DEFAULT_BLOCKED_PAGE_HTML,
    draftSchedule: core.DEFAULT_SCHEDULE,
    rowErrors: new Map(),
    pageError: "",
    successMessage: "",
    isSaving: false,
    isRequestingPermissions: false,
    missingOrigins: []
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
        state.draftEntries = editableEntries(response.state.entries);
        state.draftBlockedPageHtml = response.state.blockedPageHtml;
        state.draftSchedule = editableSchedule(response.state.schedule);
        await refreshWebsiteAccess(response.state);
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
    rowsElement.replaceChildren(...state.draftEntries.map(renderRow));
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
  }

  function renderRow(entry) {
    const fragment = rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".block-row");
    const segments = fragment.querySelector(".segments");
    const input = fragment.querySelector(".value-input");
    const deleteButton = fragment.querySelector(".delete-button");
    const rowError = fragment.querySelector(".row-error");
    const error = state.rowErrors.get(entry.id) || "";

    Object.entries(core.EDITABLE_KIND_LABELS).forEach(([kind, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-pressed", String(entry.kind === kind));
      button.addEventListener("click", () => updateKind(entry.id, kind));
      segments.append(button);
    });

    input.value = entry.value;
    input.placeholder = placeholderFor(entry.kind);
    input.addEventListener("input", () => updateValue(entry.id, input.value));
    input.addEventListener("blur", () => normalizeUrlInput(entry.id));
    deleteButton.disabled = state.draftEntries.length === 1;
    deleteButton.addEventListener("click", () => deleteRow(entry.id));
    rowError.hidden = error === "";
    rowError.textContent = error;
    row.dataset.entryId = entry.id;

    return fragment;
  }

  function addRow() {
    state.draftEntries.push(core.newEntry("url"));
    clearMessages();
    render();
  }

  function updateKind(id, kind) {
    state.draftEntries = state.draftEntries.map((entry) => (
      entry.id === id ? { id: entry.id, kind, value: entry.value } : entry
    ));
    state.rowErrors.delete(id);
    clearMessages();
    render();
  }

  function updateValue(id, value) {
    const entry = findDraftEntry(id);
    entry.value = value;
    state.rowErrors.delete(id);
    clearMessages();
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
    state.draftEntries = state.draftEntries.filter((entry) => entry.id !== id);
    state.draftEntries = ensureDraftEntry(state.draftEntries);
    state.rowErrors.delete(id);
    clearMessages();
    render();
  }

  function normalizeUrlInput(id) {
    const entry = findDraftEntry(id);

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
        state.draftEntries = editableEntries(response.state.entries);
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

  function permissionPanelMessage() {
    if (state.missingOrigins.length === 1) {
      return "URL Blocker needs access to this website before blocking can run.";
    }

    return `URL Blocker needs access to these ${state.missingOrigins.length} websites before blocking can run.`;
  }

  function normalizeAndValidateDraft() {
    try {
      state.draftEntries = state.draftEntries.map((entry) => {
        if (entry.kind !== "url" && entry.kind !== "urlWithSubpaths") {
          return entry;
        }

        return { id: entry.id, kind: entry.kind, value: core.normalizeUrlEntryValue(entry.value) };
      });
    } catch {
      return core.validateState({
        schemaVersion: core.SCHEMA_VERSION,
        entries: state.draftEntries,
        blockedPageHtml: state.draftBlockedPageHtml,
        schedule: state.draftSchedule
      });
    }

    const result = core.validateState({
      schemaVersion: core.SCHEMA_VERSION,
      entries: state.draftEntries,
      blockedPageHtml: state.draftBlockedPageHtml,
      schedule: state.draftSchedule
    });

    if (result.type === "valid") {
      state.draftBlockedPageHtml = result.state.blockedPageHtml;
      state.draftSchedule = editableSchedule(result.state.schedule);
    }

    return result;
  }

  async function resetBlocklist() {
    const response = await api.runtime.sendMessage({
      type: "resetState"
    });

    if (response.type !== "saved") {
      showFatalError(new Error("Reset failed."));
      return;
    }

    state.draftEntries = editableEntries(response.state.entries);
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

  function editableEntries(entries) {
    return ensureDraftEntry(entries.map((entry) => ({ id: entry.id, kind: entry.kind, value: entry.value })));
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

  function timeToMinute(value) {
    if (!/^\d{2}:\d{2}$/.test(value)) {
      return NaN;
    }

    const [hours, minutes] = value.split(":").map(Number);

    return hours * 60 + minutes;
  }

  function ensureDraftEntry(entries) {
    return entries.length === 0 ? [core.newEntry("url")] : entries;
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
})(globalThis);
