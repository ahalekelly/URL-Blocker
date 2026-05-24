const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const resourcesPath = path.join(__dirname, "../URLBlockerWebExtension");
const statsScript = fs.readFileSync(path.join(resourcesPath, "stats.js"), "utf8");

test("stats page renders screen time stats", async () => {
  const response = screenTimeStatsResponse();
  const { document, messages } = await openStatsPage(response);
  const yAxis = document.elements.hourlyBars.children[0];
  const scroll = document.elements.hourlyBars.children[1];
  const plot = scroll.children[0];
  const xAxis = scroll.children[1];

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "getScreenTimeStats");
  assert.equal(document.elements.totalTime.textContent, "2m");
  assert.equal(document.elements.activeDomains.textContent, "1");
  assert.equal(document.elements.trackedDomains.textContent, "2");
  assert.equal(document.elements.overLimitDomains.textContent, "0");
  assert.equal(document.elements.windowTitle.textContent, "Last 2 Hours");
  assert.equal(yAxis.children[0].textContent, "1m");
  assert.equal(yAxis.children[1].textContent, "<1m");
  assert.equal(yAxis.children[2].textContent, "0m");
  assert.equal(plot.children.length, 2);
  assert.equal(xAxis.children.length, 2);
  assert.equal(xAxis.children[0].textContent, hourTickLabel(response.stats.hourlyTotals[0].startedAtMs));
  assert.equal(document.elements.emptyHourlyTotals.hidden, true);
  assert.equal(document.elements.domainRows.children.length, 2);
  assert.equal(document.elements.emptyDomains.hidden, true);
  assert.equal(document.elements.domainRows.children[0].children[0].children[1].children[0].textContent, "2m");
  assert.equal(document.elements.domainRows.children[0].children[0].children[1].children[2].textContent, "4m left");
  assert.equal(document.elements.domainRows.children[0].children[2].textContent, "This device 1m · Other devices 1m");
  assert.equal(document.elements.deviceRows.children.length, 1);
  assert.equal(document.elements.emptyDevices.hidden, true);
  assert.equal(document.elements.deviceRows.children[0].children[1].textContent, "1m");
});

test("stats page shows background errors", async () => {
  const { document } = await openStatsPage({
    type: "error",
    error: "Screen time could not be loaded.",
    errorCode: "ScreenTimeTestError"
  });

  assert.equal(document.elements.errorSummary.hidden, false);
  assert.equal(document.elements.errorSummary.textContent, "Screen time could not be loaded.\n\nCode: ScreenTimeTestError");
  assert.equal(document.elements.refreshButton.disabled, false);
});

async function openStatsPage(response) {
  const document = statsDocument();
  const messages = [];
  const context = {
    browser: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);

          return response;
        }
      }
    },
    document,
    addEventListener() {}
  };

  context.globalThis = context;
  vm.runInNewContext(statsScript, context, { filename: "stats.js" });
  await settle();

  return { document, messages };
}

function hourTickLabel(startedAtMs) {
  return new Date(startedAtMs).toLocaleTimeString([], { hour: "numeric" });
}

function screenTimeStatsResponse() {
  return {
    type: "screenTimeStats",
    stats: {
      generatedAtMs: 20 * 60 * 60 * 1000,
      limitReset: { type: "rollingWindow", windowHours: 2 },
      totalMs: 90000,
      trackedDomainCount: 2,
      activeDomainCount: 1,
      overLimitCount: 0,
      entries: [
        {
          domain: "example.com",
          totalMs: 90000,
          localMs: 60000,
          remoteMs: 30000,
          limitMinutes: 5,
          remainingMs: 210000,
          usedPercent: 30,
          isOverLimit: false
        },
        {
          domain: "unused.example",
          totalMs: 0,
          localMs: 0,
          remoteMs: 0,
          limitMinutes: 5,
          remainingMs: 300000,
          usedPercent: 0,
          isOverLimit: false
        }
      ],
      hourlyTotals: [
        { hour: 19, startedAtMs: 19 * 60 * 60 * 1000, totalMs: 60000 },
        { hour: 20, startedAtMs: 20 * 60 * 60 * 1000, totalMs: 30000 }
      ],
      deviceTotals: [
        { label: "This Device", totalMs: 60000 }
      ]
    }
  };
}

function statsDocument() {
  return testDocument([
    "refreshButton",
    "errorSummary",
    "totalTime",
    "activeDomains",
    "trackedDomains",
    "overLimitDomains",
    "windowTitle",
    "updatedAt",
    "hourlyBars",
    "emptyHourlyTotals",
    "domainRows",
    "emptyDomains",
    "deviceRows",
    "emptyDevices"
  ]);
}

function testDocument(ids) {
  const elements = Object.fromEntries(ids.map((id) => [id, new TestElement("div", id)]));

  elements.refreshButton = new TestElement("button", "refreshButton");

  return {
    elements,
    createElement(tagName) {
      return new TestElement(tagName);
    },
    getElementById(id) {
      const element = elements[id];

      if (!element) {
        throw new Error(`Missing test element: ${id}`);
      }

      return element;
    }
  };
}

class TestElement {
  constructor(tagName, id = "") {
    const style = {};

    style.setProperty = (name, value) => {
      style[name] = value;
    };

    this.tagName = tagName;
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.className = "";
    this.title = "";
    this.style = style;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
}

async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
