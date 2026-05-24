const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const repoRoot = path.resolve(__dirname, "..");
const projectText = fs.readFileSync(path.join(repoRoot, "URLBlocker.xcodeproj/project.pbxproj"), "utf8");
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
