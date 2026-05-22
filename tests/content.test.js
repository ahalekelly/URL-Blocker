const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const contentScript = fs.readFileSync(path.join(__dirname, "../URLBlockerIOSExtension/Resources/content.js"), "utf8");

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

test("content script periodically rechecks unchanged URLs", async () => {
  const page = runContentScript("https://x.com/home");

  page.tick();

  assert.deepEqual(page.messages, [
    { type: "urlChanged", url: "https://x.com/home" },
    { type: "urlChanged", url: "https://x.com/home" }
  ]);
});

function runContentScript(url) {
  const context = {
    browser: {
      runtime: {
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
    addEventListener(type, listener) {
      context.listeners.set(type, listener);
    },
    clearTimeout() {},
    setInterval(listener) {
      context.intervals.push(listener);
    },
    setTimeout(listener) {
      listener();
    }
  };

  vm.runInNewContext(contentScript, context, { filename: "content.js" });

  return {
    location: context.location,
    messages: JSON.parse(JSON.stringify(context.messages)),
    dispatch(type) {
      context.listeners.get(type)();
      this.messages = JSON.parse(JSON.stringify(context.messages));
    },
    tick() {
      context.intervals.forEach((listener) => listener());
      this.messages = JSON.parse(JSON.stringify(context.messages));
    }
  };
}
