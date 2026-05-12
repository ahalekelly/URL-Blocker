const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const core = require("../URLBlockerIOSExtension/Resources/blocker.js");
const contentScript = fs.readFileSync(path.join(__dirname, "../URLBlockerIOSExtension/Resources/content.js"), "utf8");

const state = {
  schemaVersion: 4,
  entries: [
    { id: "11111111-1111-4111-8111-111111111111", kind: "url", value: "x.com" },
    { id: "22222222-2222-4222-8222-222222222222", kind: "url", value: "x.com/home" }
  ],
  blockedPageHtml: "<p>Blocked.</p>"
};

test("content script reports blocked startup URLs to the worker", async () => {
  const messages = await runContentScript("https://x.com/home");

  assert.deepEqual(messages, [
    { type: "getState" },
    { type: "urlMatched", url: "https://x.com/home" }
  ]);
});

test("content script leaves unmatched startup URLs alone", async () => {
  const messages = await runContentScript("https://x.com/messages");

  assert.deepEqual(messages, [{ type: "getState" }]);
});

async function runContentScript(url) {
  const messages = [];
  const context = {
    BlockerCore: core,
    browser: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);

          switch (message.type) {
            case "getState":
              return { type: "state", state };
            case "urlMatched":
              return { type: "redirected" };
            default:
              throw new Error(`Unknown message type: ${message.type}`);
          }
        },
        onMessage: {
          addListener() {}
        }
      }
    },
    console,
    document: { hidden: false },
    location: { href: url },
    addEventListener() {},
    clearTimeout() {},
    setInterval() {},
    setTimeout() {}
  };

  vm.runInNewContext(contentScript, context, { filename: "content.js" });
  await new Promise((resolve) => setImmediate(resolve));

  return JSON.parse(JSON.stringify(messages));
}
