(function loadStatsPage(root) {
  "use strict";

  const api = root.browser || root.chrome;
  const HOURLY_CHART_MAX_MS = 60 * 60 * 1000;
  const HOURLY_CHART_HEIGHT = 158;
  const elements = {
    statsShell: document.getElementById("statsShell"),
    refreshButton: document.getElementById("refreshButton"),
    errorSummary: document.getElementById("errorSummary"),
    totalTime: document.getElementById("totalTime"),
    activeDomains: document.getElementById("activeDomains"),
    trackedDomains: document.getElementById("trackedDomains"),
    overLimitMetric: document.getElementById("overLimitMetric"),
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
    const syncedStats = loadStatsResult("getScreenTimeStats");

    try {
      renderStats(await loadStatsMessage("getLocalScreenTimeStats"));
      elements.statsShell.hidden = false;
      renderStats(await unwrapStatsResult(await syncedStats));
    } finally {
      elements.refreshButton.disabled = false;
    }
  }

  async function loadStatsResult(messageType) {
    try {
      return { type: "loaded", stats: await loadStatsMessage(messageType) };
    } catch (error) {
      return { type: "error", error };
    }
  }

  function unwrapStatsResult(result) {
    switch (result.type) {
      case "loaded":
        return result.stats;
      case "error":
        throw result.error;
      default:
        throw new Error(`Unknown stats result: ${result.type}`);
    }
  }

  async function loadStatsMessage(messageType) {
    const response = await api.runtime.sendMessage({ type: messageType });

    switch (response.type) {
      case "screenTimeStats":
        return normalizeStats(response.stats);
      case "error":
        throw errorFromResponse(response);
      default:
        throw new Error(`Unknown ${messageType} response: ${response.type}`);
    }
  }

  function renderStats(stats) {
    const hideLimits = limitsAreHidden(stats.schedule);

    elements.totalTime.textContent = formatDuration(stats.totalMs);
    elements.activeDomains.textContent = String(stats.activeDomainCount);
    elements.trackedDomains.textContent = String(stats.trackedDomainCount);
    elements.overLimitMetric.hidden = hideLimits;
    elements.overLimitDomains.textContent = String(stats.overLimitCount);
    elements.windowTitle.textContent = windowTitle(stats.limitReset);
    elements.updatedAt.textContent = `Updated ${new Date(stats.generatedAtMs).toLocaleString()}`;

    renderHourlyTotals(stats.hourlyTotals);
    renderDomains(stats.entries, hideLimits);
    renderDevices(stats.deviceTotals);
  }

  function renderHourlyTotals(hourlyTotals) {
    const maxMs = Math.max(0, ...hourlyTotals.map((entry) => entry.totalMs));
    const yAxis = document.createElement("div");
    const scroll = document.createElement("div");
    const plot = document.createElement("div");
    const xAxis = document.createElement("div");

    yAxis.className = "hourly-y-axis";
    scroll.className = "hourly-scroll";
    plot.className = "hourly-plot";
    xAxis.className = "hourly-x-axis";

    [HOURLY_CHART_MAX_MS, HOURLY_CHART_MAX_MS / 2, 0].forEach((totalMs) => {
      const tick = document.createElement("span");

      tick.textContent = formatAxisDuration(totalMs);
      yAxis.append(tick);
    });

    hourlyTotals.forEach((entry) => {
      const tick = document.createElement("span");
      const hour = new Date(entry.startedAtMs);

      tick.className = "hourly-x-tick";
      if (hour.getHours() % 2 === 0) {
        tick.textContent = hour.toLocaleTimeString([], { hour: "numeric" });
      }
      plot.append(renderHourlyBar(entry));
      xAxis.append(tick);
    });

    scroll.append(plot, xAxis);
    elements.hourlyBars.replaceChildren(yAxis, scroll);
    elements.emptyHourlyTotals.hidden = maxMs > 0;
  }

  function renderHourlyBar(entry) {
    const bar = document.createElement("div");
    const totalMs = Math.min(entry.totalMs, HOURLY_CHART_MAX_MS);
    const ratio = totalMs / HOURLY_CHART_MAX_MS;
    const height = Math.max(2, Math.round(ratio * HOURLY_CHART_HEIGHT));

    bar.className = entry.totalMs === 0 ? "hourly-bar is-empty" : "hourly-bar";
    bar.style.height = `${height}px`;
    bar.title = `${hourLabel(entry.startedAtMs)}: ${formatDuration(entry.totalMs)}`;

    return bar;
  }

  function renderDomains(entries, hideLimits) {
    elements.domainRows.replaceChildren(...entries.map((entry) => renderDomainRow(entry, hideLimits)));
    elements.emptyDomains.hidden = entries.length !== 0;
  }

  function renderDomainRow(entry, hideLimits) {
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

    row.className = !hideLimits && entry.isOverLimit ? "stats-domain-row is-over-limit" : "stats-domain-row";
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
    detail.textContent = `This device ${formatDuration(entry.localMs)} · Other devices ${formatDuration(entry.remoteMs)}`;

    values.append(used);
    if (!hideLimits) {
      limit.textContent = `Limit ${entry.limitMinutes}m`;
      remaining.textContent = entry.isOverLimit ? "Over limit" : `${formatDuration(entry.remainingMs)} left`;
      fill.style.setProperty("--progress", `${entry.usedPercent}%`);
      values.append(limit, remaining);
    }
    main.append(name, values);
    row.append(main);
    if (!hideLimits) {
      progress.append(fill);
      row.append(progress);
    }
    row.append(detail);

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
      "schedule",
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

  function limitsAreHidden(schedule) {
    switch (schedule.type) {
      case "always":
        return true;
      case "dailyWindow":
        return false;
      default:
        throw new Error(`Unknown schedule type: ${schedule.type}`);
    }
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

  function formatAxisDuration(totalMs) {
    if (totalMs > 0 && totalMs < 60 * 1000) {
      return "<1m";
    }

    if (totalMs >= HOURLY_CHART_MAX_MS && totalMs % HOURLY_CHART_MAX_MS === 0) {
      return `${totalMs / HOURLY_CHART_MAX_MS}h`;
    }

    return formatDuration(totalMs);
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
    elements.errorSummary.textContent = errorMessage(error);
    elements.refreshButton.disabled = false;
    elements.statsShell.hidden = false;
  }

  function errorFromResponse(response) {
    const error = new Error(response.error || `Unexpected response: ${response.type}`);

    error.errorCode = response.errorCode || response.type;
    return error;
  }

  function errorMessage(error) {
    if (error instanceof Error && typeof error.errorCode === "string") {
      return `${error.message}\n\nCode: ${error.errorCode}`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
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
