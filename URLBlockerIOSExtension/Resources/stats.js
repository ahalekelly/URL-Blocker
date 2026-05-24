(function loadStatsPage(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const elements = {
    refreshButton: document.getElementById("refreshButton"),
    errorSummary: document.getElementById("errorSummary"),
    totalTime: document.getElementById("totalTime"),
    activeDomains: document.getElementById("activeDomains"),
    trackedDomains: document.getElementById("trackedDomains"),
    overLimitDomains: document.getElementById("overLimitDomains"),
    windowTitle: document.getElementById("windowTitle"),
    updatedAt: document.getElementById("updatedAt"),
    hourlyBars: document.getElementById("hourlyBars"),
    emptyHourlyTotals: document.getElementById("emptyHourlyTotals"),
    domainRows: document.getElementById("domainRows"),
    emptyDomains: document.getElementById("emptyDomains"),
    deviceRows: document.getElementById("deviceRows"),
    emptyDevices: document.getElementById("emptyDevices")
  };

  elements.refreshButton.addEventListener("click", loadStats);
  root.addEventListener("error", (event) => showFatalError(event.error || new Error(event.message)));
  root.addEventListener("unhandledrejection", (event) => showFatalError(errorFromReason(event.reason)));

  loadStats().catch(showFatalError);

  async function loadStats() {
    elements.errorSummary.hidden = true;
    elements.refreshButton.disabled = true;

    const response = await api.runtime.sendMessage({ type: "getScreenTimeStats" });

    elements.refreshButton.disabled = false;

    switch (response.type) {
      case "screenTimeStats":
        renderStats(normalizeStats(response.stats));
        return;
      default:
        throw new Error(`Unknown screen time stats response: ${response.type}`);
    }
  }

  function renderStats(stats) {
    elements.totalTime.textContent = formatDuration(stats.totalMs);
    elements.activeDomains.textContent = String(stats.activeDomainCount);
    elements.trackedDomains.textContent = String(stats.trackedDomainCount);
    elements.overLimitDomains.textContent = String(stats.overLimitCount);
    elements.windowTitle.textContent = windowTitle(stats.limitReset);
    elements.updatedAt.textContent = `Updated ${new Date(stats.generatedAtMs).toLocaleString()}`;

    renderHourlyTotals(stats.hourlyTotals);
    renderDomains(stats.entries);
    renderDevices(stats.deviceTotals);
  }

  function renderHourlyTotals(hourlyTotals) {
    const maxMs = Math.max(0, ...hourlyTotals.map((entry) => entry.totalMs));

    elements.hourlyBars.replaceChildren(...hourlyTotals.map((entry) => renderHourlyBar(entry, maxMs)));
    elements.emptyHourlyTotals.hidden = maxMs > 0;
  }

  function renderHourlyBar(entry, maxMs) {
    const bar = document.createElement("div");
    const height = maxMs === 0 ? 2 : Math.max(2, Math.round((entry.totalMs / maxMs) * 148));

    bar.className = entry.totalMs === 0 ? "hourly-bar is-empty" : "hourly-bar";
    bar.style.height = `${height}px`;
    bar.title = `${hourLabel(entry.startedAtMs)}: ${formatDuration(entry.totalMs)}`;

    return bar;
  }

  function renderDomains(entries) {
    elements.domainRows.replaceChildren(...entries.map(renderDomainRow));
    elements.emptyDomains.hidden = entries.length !== 0;
  }

  function renderDomainRow(entry) {
    const row = document.createElement("article");
    const main = document.createElement("div");
    const name = document.createElement("strong");
    const values = document.createElement("div");
    const used = document.createElement("strong");
    const limit = document.createElement("span");
    const remaining = document.createElement("span");
    const progress = document.createElement("div");
    const fill = document.createElement("div");
    const detail = document.createElement("p");

    row.className = entry.isOverLimit ? "stats-domain-row is-over-limit" : "stats-domain-row";
    main.className = "stats-row-main";
    name.className = "stats-domain-name";
    values.className = "stats-row-values";
    used.className = "stats-domain-used";
    limit.className = "stats-domain-limit";
    remaining.className = "stats-domain-limit";
    progress.className = "stats-progress";
    fill.className = "stats-progress-fill";
    detail.className = "stats-domain-detail";

    name.textContent = entry.domain;
    used.textContent = formatDuration(entry.totalMs);
    limit.textContent = `Limit ${entry.limitMinutes}m`;
    remaining.textContent = entry.isOverLimit ? "Over limit" : `${formatDuration(entry.remainingMs)} left`;
    fill.style.setProperty("--progress", `${entry.usedPercent}%`);
    detail.textContent = `This device ${formatDuration(entry.localMs)} · Other devices ${formatDuration(entry.remoteMs)}`;

    values.append(used, limit, remaining);
    main.append(name, values);
    progress.append(fill);
    row.append(main, progress, detail);

    return row;
  }

  function renderDevices(deviceTotals) {
    elements.deviceRows.replaceChildren(...deviceTotals.map(renderDeviceRow));
    elements.emptyDevices.hidden = deviceTotals.length !== 0;
  }

  function renderDeviceRow(entry) {
    const row = document.createElement("div");
    const label = document.createElement("strong");
    const total = document.createElement("span");

    row.className = "stats-device-row";
    label.textContent = entry.label;
    total.textContent = formatDuration(entry.totalMs);
    row.append(label, total);

    return row;
  }

  function normalizeStats(stats) {
    requireKeys(stats, [
      "generatedAtMs",
      "limitReset",
      "totalMs",
      "trackedDomainCount",
      "activeDomainCount",
      "overLimitCount",
      "entries",
      "hourlyTotals",
      "deviceTotals"
    ], "screen time stats");

    if (!Array.isArray(stats.entries) || !Array.isArray(stats.hourlyTotals) || !Array.isArray(stats.deviceTotals)) {
      throw new Error("Screen time stats lists must be arrays.");
    }

    return stats;
  }

  function requireKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object.`);
    }

    keys.forEach((key) => {
      if (!Object.hasOwn(value, key)) {
        throw new Error(`${label} is missing ${key}.`);
      }
    });
  }

  function windowTitle(limitReset) {
    switch (limitReset.type) {
      case "rollingWindow":
        return `Last ${limitReset.windowHours} ${limitReset.windowHours === 1 ? "Hour" : "Hours"}`;
      case "daily":
        return `Since ${minuteToTime(limitReset.resetHour * 60)}`;
      default:
        throw new Error(`Unknown limit reset type: ${limitReset.type}`);
    }
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

  function minuteToTime(minute) {
    const hours = String(Math.floor(minute / 60)).padStart(2, "0");
    const minutes = String(minute % 60).padStart(2, "0");

    return `${hours}:${minutes}`;
  }

  function hourLabel(startedAtMs) {
    return new Date(startedAtMs).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric"
    });
  }

  function showFatalError(error) {
    elements.errorSummary.hidden = false;
    elements.errorSummary.textContent = error.message;
    elements.refreshButton.disabled = false;
  }

  function errorFromReason(reason) {
    if (reason instanceof Error) {
      return reason;
    }

    return new Error(String(reason));
  }

  root.ScreenTimeStatsPage = {
    formatDuration,
    windowTitle
  };
})(globalThis);
