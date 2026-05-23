import { createRequire } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharedResourcesPath = path.join(repoRoot, "URLBlockerIOSExtension/Resources");
const chromeManifestPath = path.join(repoRoot, "ChromeExtension/manifest.json");
const defaultPagesPath = path.join(sharedResourcesPath, "default-blocked-pages.json");
const outputPath = path.join(repoRoot, "build/chrome-extension");
const core = require(path.join(sharedResourcesPath, "blocker.js"));
const chromeManifest = JSON.parse(fs.readFileSync(chromeManifestPath, "utf8"));
const defaultPages = JSON.parse(fs.readFileSync(defaultPagesPath, "utf8"));
const expectedHostPermissions = core.permissionOriginsForState(core.emptyState(defaultPages));
const requiredFiles = [
  "background.js",
  "blocked.css",
  "blocked.html",
  "blocked.js",
  "blocker.js",
  "content.js",
  "default-blocked-pages.json",
  "icons/icon-48.png",
  "icons/icon-96.png",
  "icons/icon-128.png",
  "options.css",
  "options.html",
  "options.js"
];

requiredFiles.forEach((file) => {
  const filePath = path.join(sharedResourcesPath, file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing shared extension file: ${file}`);
  }
});

assert.deepEqual(chromeManifest.permissions, ["scripting", "storage", "tabs"]);
assert.deepEqual(chromeManifest.host_permissions, expectedHostPermissions);
assert.deepEqual(chromeManifest.optional_host_permissions, ["*://*/*"]);

if (chromeManifest.permissions.includes("nativeMessaging")) {
  throw new Error("Chrome extension must not request nativeMessaging.");
}

if (process.argv.includes("--check")) {
  process.exit(0);
}

fs.rmSync(outputPath, { recursive: true, force: true });
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.cpSync(sharedResourcesPath, outputPath, { recursive: true });
fs.copyFileSync(chromeManifestPath, path.join(outputPath, "manifest.json"));

console.log(`Built Chrome extension at ${outputPath}`);
