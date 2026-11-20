const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

test("reads the running Chromium user data directory", async () => {
  const script = await importScript();
  const command = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser --user-data-dir=/private/tmp/urlblocker-brave-profile.123 --load-extension=/repo/build/chrome-extension";

  assert.equal(script.userDataDirFromCommand(command), "/private/tmp/urlblocker-brave-profile.123");
});

test("reads space-separated Chromium user data directories", async () => {
  const script = await importScript();
  const command = "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi --user-data-dir /private/tmp/urlblocker-vivaldi-profile.123 --no-first-run";

  assert.equal(script.userDataDirFromCommand(command), "/private/tmp/urlblocker-vivaldi-profile.123");
});

async function importScript() {
  return import(pathToFileURL(path.join(__dirname, "../scripts/install-chromium-extension.mjs")).href);
}
