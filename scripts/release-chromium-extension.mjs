// Packs the Chromium extension into a signed CRX and uploads it, with its
// update manifest, to the public Supabase bucket that Vivaldi on Android
// force-installs from. Each release gets a version from the current UTC time,
// since Chromium only updates to a higher version.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crx3 from "crx3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = path.join(os.homedir(), ".config/url-blocker/extension-key.pem");
const bucket = "chromium-extension";
const buildPath = path.join(repoRoot, "build/chrome-extension");
const releasePath = path.join(repoRoot, "build/chrome-extension-release");

if (!fs.existsSync(keyPath)) {
  throw new Error(`Missing extension signing key at ${keyPath}. Copy it from another machine that releases URL Blocker.`);
}

const { supabaseUrl } = JSON.parse(fs.readFileSync(path.join(repoRoot, "URLBlockerWebExtension/supabase-config.json"), "utf8"));
const bucketUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}`;
const now = new Date();
const version = [
  now.getUTCFullYear(),
  (now.getUTCMonth() + 1) * 100 + now.getUTCDate(),
  now.getUTCHours() * 100 + now.getUTCMinutes(),
  now.getUTCSeconds()
].join(".");
const crxName = `url-blocker-${version}.crx`;
const crxPath = path.join(repoRoot, "build", crxName);
const xmlPath = path.join(repoRoot, "build/updates.xml");

execFileSync("node", [path.join(repoRoot, "scripts/build-chrome-extension.mjs")], { stdio: "inherit" });
fs.rmSync(releasePath, { recursive: true, force: true });
fs.cpSync(buildPath, releasePath, { recursive: true });

const manifestPath = path.join(releasePath, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.version = version;
manifest.update_url = `${bucketUrl}/updates.xml`;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

await crx3([manifestPath], { keyPath, crxPath, xmlPath, crxURL: `${bucketUrl}/${crxName}`, appVersion: version });

const upload = (file, contentType) => execFileSync("supabase", [
  "storage", "cp", "--linked", "--experimental", "--content-type", contentType,
  file, `ss:///${bucket}/${path.basename(file)}`
], { cwd: repoRoot, stdio: "inherit" });

upload(crxPath, "application/x-chrome-extension");
// The CLI refuses to overwrite, so the old update manifest goes first.
execFileSync("supabase", ["storage", "rm", "--linked", "--experimental", "--yes", `ss:///${bucket}/updates.xml`], { cwd: repoRoot, stdio: "inherit" });
upload(xmlPath, "application/xml");

console.log(`Released URL Blocker ${version}: ${manifest.update_url}`);
