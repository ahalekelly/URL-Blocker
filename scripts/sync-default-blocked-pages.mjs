import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultPagesPath = path.join(repoRoot, "URLBlockerIOSExtension/Resources/default-blocked-pages.json");
const manifestPath = path.join(repoRoot, "URLBlockerIOSExtension/Resources/manifest.json");
const core = require(path.join(repoRoot, "URLBlockerIOSExtension/Resources/blocker.js"));
const defaultPages = JSON.parse(fs.readFileSync(defaultPagesPath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const state = core.emptyState(defaultPages);
const nextManifest = {
  ...manifest,
  host_permissions: core.permissionOriginsForState(state)
};
const nextManifestText = `${JSON.stringify(nextManifest, null, 2)}\n`;

if (!process.argv.includes("--check")) {
  fs.writeFileSync(manifestPath, nextManifestText);
  process.exit(0);
}

if (fs.readFileSync(manifestPath, "utf8") !== nextManifestText) {
  throw new Error("manifest.json host_permissions are out of sync with default-blocked-pages.json.");
}
