import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultPagesPath = path.join(repoRoot, "URLBlockerIOSExtension/Resources/default-blocked-pages.json");
const manifestPaths = [
  path.join(repoRoot, "URLBlockerIOSExtension/Resources/manifest.json"),
  path.join(repoRoot, "ChromeExtension/manifest.json")
];
const core = require(path.join(repoRoot, "URLBlockerIOSExtension/Resources/blocker.js"));
const defaultPages = JSON.parse(fs.readFileSync(defaultPagesPath, "utf8"));
const state = core.emptyState(defaultPages);
const hostPermissions = core.permissionOriginsForState(state);

manifestPaths.forEach((manifestPath) => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const nextManifest = {
    ...manifest,
    host_permissions: hostPermissions
  };
  const nextManifestText = `${JSON.stringify(nextManifest, null, 2)}\n`;

  if (!process.argv.includes("--check")) {
    fs.writeFileSync(manifestPath, nextManifestText);
    return;
  }

  if (fs.readFileSync(manifestPath, "utf8") !== nextManifestText) {
    throw new Error(`${path.relative(repoRoot, manifestPath)} host_permissions are out of sync with default-blocked-pages.json.`);
  }
});
