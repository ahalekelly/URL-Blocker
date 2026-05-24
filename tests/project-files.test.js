const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const repoRoot = path.resolve(__dirname, "..");
const projectText = fs.readFileSync(path.join(repoRoot, "URLBlocker.xcodeproj/project.pbxproj"), "utf8");
const signingScript = fs.readFileSync(path.join(repoRoot, "scripts/sign-ios-udid.mjs"), "utf8");
const optionsHtml = fs.readFileSync(path.join(repoRoot, "URLBlockerWebExtension/options.html"), "utf8");
const statsHtml = fs.readFileSync(path.join(repoRoot, "URLBlockerWebExtension/stats.html"), "utf8");
const webExtensionFiles = [
  "manifest.json",
  "blocker.js",
  "background.js",
  "content.js",
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

test("options and stats pages link to each other", () => {
  assert.match(optionsHtml, /href="stats\.html"/);
  assert.match(statsHtml, /href="options\.html"/);
});

test("limit reset settings follow the block schedule settings", () => {
  const blockScheduleIndex = optionsHtml.indexOf("<h2>Block Schedule</h2>");
  const limitResetIndex = optionsHtml.indexOf("id=\"limitResetPanel\"");

  assert.notEqual(blockScheduleIndex, -1);
  assert.notEqual(limitResetIndex, -1);
  assert.ok(blockScheduleIndex < limitResetIndex);
  assert.doesNotMatch(optionsHtml, /<h2>Schedule<\/h2>/);
});

test("iOS signing does not prompt for the p12 password", () => {
  assert.doesNotMatch(signingScript, /process\.stdin\.isTTY/);
  assert.doesNotMatch(signingScript, /read -rsp/);
  assert.match(signingScript, /Set P12_PASSWORD or create/);
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
