const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.join(__dirname, "..");
const contentView = fs.readFileSync(path.join(repoRoot, "URLBlockerIOS/ContentView.swift"), "utf8");

function swiftScript(name) {
  const match = contentView.match(new RegExp(`${name}[\\s\\S]*?"""\\n([\\s\\S]*?)\\n\\s*"""`));

  assert.ok(match, `ContentView.swift has no ${name} script.`);
  return match[1].replace(/\\\(Safari\.javaScriptString\((\w+)\)\)/g, (_, argument) => JSON.stringify(`data:,${argument}`));
}

test("the iOS app's blocklist page reaches the shared background controller", async () => {
  const context = vm.createContext({ console, URL, AbortSignal, document: { baseURI: "app:///" } });

  context.window = context;
  context.webkit = {
    messageHandlers: {
      blocklist: {
        postMessage: ({ id, message }) => queueMicrotask(() => context.__URLBlockerReply({ id, response: { type: `stored${message.type.slice(4)}` } }))
      }
    }
  };
  vm.runInContext(swiftScript("func nativeBrowserShim"), context);

  for (const file of ["blocker.js", "supabase-sync.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(repoRoot, "URLBlockerWebExtension", file), "utf8"), context, { filename: file });
  }

  vm.runInContext(swiftScript("let backgroundControllerShim"), context);

  const response = await context.browser.runtime.sendMessage({ type: "getLocalState" });

  assert.notEqual(response.type, "error", response.error);
});
