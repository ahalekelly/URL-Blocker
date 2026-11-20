const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const repoRoot = path.resolve(__dirname, "..");
const projectText = fs.readFileSync(path.join(repoRoot, "URLBlocker.xcodeproj/project.pbxproj"), "utf8");
const sharedManifest = require("../URLBlockerWebExtension/manifest.json");
const chromeManifest = require("../ChromeExtension/manifest.json");
const webExtensionFiles = [
  "manifest.json",
  "blocker.js",
  "background.js",
  "content.js",
  "content.css",
  "options.html",
  "options.css",
  "options.js",
  "stats.html",
  "stats.css",
  "stats.js",
  "blocked.html",
  "blocked.css",
  "blocked.js",
  "default-blocked-pages.json",
  "supabase-sync.js",
  "supabase-config.json",
  "icons"
];

test("Xcode references the renamed shared web extension folder", () => {
  assert.doesNotMatch(projectText, /URLBlockerIOSExtension\/Resources/);
  assert.doesNotMatch(projectText, /ios_safari_site_blocker_spec\.md/);
  assert.match(projectText, /path = URLBlockerWebExtension;/);

  webExtensionFiles.forEach((file) => {
    assert.match(projectText, new RegExp(`/\\* ${escapeRegex(file)} in Resources \\*/`));
  });
});

test("blocked page is not exposed to every website", () => {
  assert.equal(sharedManifest.web_accessible_resources, undefined);
  assert.equal(chromeManifest.web_accessible_resources, undefined);
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("Android force-installs the extension ID derived from the Chromium manifest key", () => {
  const digest = require("node:crypto").createHash("sha256").update(Buffer.from(chromeManifest.key, "base64")).digest("hex");
  const extensionId = [...digest.slice(0, 32)].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join("");
  const deviceOwner = fs.readFileSync(path.join(repoRoot, "URLBlockerAndroid/app/src/main/kotlin/com/akelly/urlblocker/DeviceOwner.kt"), "utf8");

  assert.match(deviceOwner, new RegExp(`URL_BLOCKER_EXTENSION_ID = "${extensionId}"`));
});
