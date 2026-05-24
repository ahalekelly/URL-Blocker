const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const contentScript = fs.readFileSync(path.join(__dirname, "../URLBlockerWebExtension/content.js"), "utf8");

test("content script reports the startup URL to the worker", async () => {
  const page = runContentScript("https://x.com/home");

  assert.deepEqual(page.messages, [
    { type: "urlChanged", url: "https://x.com/home" }
  ]);
});

test("content script reports changed URLs once", async () => {
  const page = runContentScript("https://x.com");

  page.location.href = "https://x.com/home";
  page.dispatch("popstate");
  page.dispatch("focus");

  assert.deepEqual(page.messages, [
    { type: "urlChanged", url: "https://x.com" },
    { type: "urlChanged", url: "https://x.com/home" }
  ]);
});

test("content script logs elapsed time before changed URLs", async () => {
  const page = runContentScript("https://x.com");

  page.location.href = "https://x.com/home";
  page.dispatch("popstate", 700);

  assert.deepEqual(page.messages, [
    { type: "urlChanged", url: "https://x.com" },
    { type: "screenTimeElapsed", url: "https://x.com", elapsedMs: 700 },
    { type: "urlChanged", url: "https://x.com/home" }
  ]);
});

test("content script periodically rechecks unchanged URLs", async () => {
  const page = runContentScript("https://x.com/home");

  page.tick();

  assert.deepEqual(page.messages, [
    { type: "urlChanged", url: "https://x.com/home" },
    { type: "screenTimeElapsed", url: "https://x.com/home", elapsedMs: 1500 },
    { type: "urlChanged", url: "https://x.com/home" }
  ]);
});

test("content script logs elapsed time when the page hides", async () => {
  const page = runContentScript("https://x.com/home");

  page.setHidden(true, 900);
  page.tick();

  assert.deepEqual(page.messages, [
    { type: "urlChanged", url: "https://x.com/home" },
    { type: "screenTimeElapsed", url: "https://x.com/home", elapsedMs: 900 }
  ]);
});

test("content script ignores stale screen time after sleep", async () => {
  const page = runContentScript("https://x.com/home");

  page.tick(10 * 60 * 1000);
  page.tick();

  assert.deepEqual(page.messages, [
    { type: "urlChanged", url: "https://x.com/home" },
    { type: "urlChanged", url: "https://x.com/home" },
    { type: "screenTimeElapsed", url: "https://x.com/home", elapsedMs: 1500 },
    { type: "urlChanged", url: "https://x.com/home" }
  ]);
});

function runContentScript(url) {
  const context = {
    browser: {
      runtime: {
        id: "test-extension",
        async sendMessage(message) {
          context.messages.push(message);

          return { type: "allowed" };
        }
      }
    },
    console,
    document: { hidden: false },
    intervals: [],
    listeners: new Map(),
    location: { href: url },
    messages: [],
    now: 0,
    Date: {
      now() {
        return context.now;
      }
    },
    addEventListener(type, listener) {
      context.listeners.set(type, listener);
    },
    clearInterval() {},
    clearTimeout() {},
    setInterval(listener) {
      context.intervals.push(listener);
      return context.intervals.length;
    },
    setTimeout(listener) {
      listener();
    }
  };

  vm.runInNewContext(contentScript, context, { filename: "content.js" });

  return {
    location: context.location,
    messages: JSON.parse(JSON.stringify(context.messages)),
    dispatch(type, elapsedMs = 0) {
      context.now += elapsedMs;
      context.listeners.get(type)();
      this.messages = JSON.parse(JSON.stringify(context.messages));
    },
    setHidden(hidden, elapsedMs = 0) {
      context.document.hidden = hidden;
      this.dispatch("visibilitychange", elapsedMs);
    },
    tick(elapsedMs = 1500) {
      context.now += elapsedMs;
      context.intervals.forEach((listener) => listener());
      this.messages = JSON.parse(JSON.stringify(context.messages));
    }
  };
}
