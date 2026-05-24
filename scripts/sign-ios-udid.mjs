#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = process.cwd();
const config = {
  appGroup: process.env.IOS_APP_GROUP ?? "group.d944b664533a4c2f.1",
  derivedData: process.env.IOS_SIGNING_DERIVED_DATA ?? "/tmp/urlblocker_signing/build",
  project: process.env.IOS_PROJECT ?? "URLBlocker.xcodeproj",
  scheme: process.env.IOS_SCHEME ?? "URLBlockerIOS",
  signedDir: process.env.IOS_SIGNED_DIR ?? "/tmp/urlblocker_signed",
  signedIpa: process.env.IOS_SIGNED_IPA ?? join(repoRoot, "build", "URLBlockerIOS-signed.ipa"),
  signingAssets: process.env.IOS_SIGNING_ASSETS ?? join(homedir(), "Documents", "UDIDRegistrations", "iOSSigning"),
  workDir: process.env.IOS_SIGNING_WORK_DIR ?? "/tmp/urlblocker_signing",
};

config.p12Path = join(config.signingAssets, "Development.p12");
config.p12PasswordPath = process.env.P12_PASSWORD_FILE ?? join(config.signingAssets, "Development.p12.password");
config.profilePath = join(config.signingAssets, "Development.mobileprovision");
config.sourceCopy = join(config.workDir, "source", "URL-Blocker");
config.keychainPath = join(config.workDir, "signing.keychain-db");
config.profilePlist = join(config.workDir, "profile.plist");
config.entitlementsPlist = join(config.workDir, "entitlements.plist");

const keychainPassword = "urlblocker";
let originalKeychains = [];

try {
  assertFile(config.p12Path);
  assertFile(config.profilePath);
  resetScratchDir(config.workDir);

  const profile = readMobileProvision();
  const signingValues = readSigningValues(profile);

  copyRepoToScratch();
  patchScratchProject(signingValues);
  buildUnsignedApp();
  writeEntitlements(signingValues);

  originalKeychains = readKeychainSearchList();
  importCertificate();
  setKeychainSearchList([config.keychainPath, ...originalKeychains]);

  const identityHash = process.env.IOS_SIGNING_IDENTITY_HASH ?? findSigningIdentity();

  packageSignedIpa(identityHash);
  verifySignedApp(signingValues);
  restoreKeychains();
  deleteSigningKeychain();

  console.log(`Signed IPA: ${config.signedIpa}`);
} catch (error) {
  restoreKeychains();
  deleteSigningKeychain();
  console.error(error.message);
  process.exit(1);
}

function readMobileProvision() {
  const plist = runCapture("/usr/bin/security", ["cms", "-D", "-i", config.profilePath]);
  writeFileSync(config.profilePlist, plist);

  return {
    Entitlements: {
      "application-identifier": readPlistValue(config.profilePlist, ":Entitlements:application-identifier"),
      "com.apple.security.application-groups": readPlistArray(config.profilePlist, ":Entitlements:com.apple.security.application-groups"),
    },
    ProvisionedDevices: readPlistArray(config.profilePlist, ":ProvisionedDevices"),
    TeamIdentifier: [readPlistValue(config.profilePlist, ":TeamIdentifier:0")],
  };
}

function readSigningValues(profile) {
  const entitlements = profile.Entitlements;
  const teamId = one(profile.TeamIdentifier, "TeamIdentifier");
  const applicationIdentifier = entitlements["application-identifier"];
  const appGroups = entitlements["com.apple.security.application-groups"];
  const devices = profile.ProvisionedDevices;

  if (!applicationIdentifier.startsWith(`${teamId}.`)) {
    throw new Error(`Expected application identifier to start with ${teamId}.`);
  }

  if (!Array.isArray(appGroups) || !appGroups.includes(config.appGroup)) {
    throw new Error(`Expected provisioning profile to include app group ${config.appGroup}.`);
  }

  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error("Expected provisioning profile to include at least one iPhone UDID.");
  }

  const appId = applicationIdentifier.slice(`${teamId}.`.length);

  return {
    appGroup: config.appGroup,
    appId,
    extensionId: `${appId}.Extension`,
    teamId,
  };
}

function copyRepoToScratch() {
  mkdirSync(dirname(config.sourceCopy), { recursive: true });
  run("rsync", [
    "-a",
    "--delete",
    "--exclude",
    ".git",
    "--exclude",
    "build",
    "--exclude",
    ".DS_Store",
    `${repoRoot}/`,
    `${config.sourceCopy}/`,
  ]);
}

function patchScratchProject(values) {
  replaceInFile(join(config.sourceCopy, "URLBlocker.xcodeproj", "project.pbxproj"), [
    ["T3TBGN4UX7", values.teamId],
    ["com.akelly.URLBlockerIOS.Extension", values.extensionId],
    ["com.akelly.URLBlockerIOS", values.appId],
  ]);

  replaceInFile(join(config.sourceCopy, "URLBlockerIOS", "ContentView.swift"), [
    ["com.akelly.URLBlockerIOS.Extension", values.extensionId],
  ]);

  replaceInFile(join(config.sourceCopy, "URLBlockerShared", "NativeBlocklistStore.swift"), [
    ["group.com.akelly.URLBlocker", values.appGroup],
  ]);

  replaceInFile(join(config.sourceCopy, "URLBlockerIOS", "URLBlockerIOS.entitlements"), [
    ["group.com.akelly.URLBlocker", values.appGroup],
  ]);

  replaceInFile(join(config.sourceCopy, "URLBlockerIOSExtension", "URLBlockerIOSExtension.entitlements"), [
    ["group.com.akelly.URLBlocker", values.appGroup],
  ]);
}

function buildUnsignedApp() {
  run("xcodebuild", [
    "-quiet",
    "-project",
    config.project,
    "-scheme",
    config.scheme,
    "-configuration",
    "Release",
    "-sdk",
    "iphoneos",
    "-destination",
    "generic/platform=iOS",
    "-derivedDataPath",
    config.derivedData,
    "CODE_SIGNING_ALLOWED=NO",
    "COMPILATION_CACHE_ENABLE_CACHING=YES",
    "build",
  ], { cwd: config.sourceCopy });
}

function writeEntitlements(values) {
  writeFileSync(config.entitlementsPlist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>application-identifier</key>
\t<string>${values.teamId}.${values.appId}</string>
\t<key>com.apple.developer.team-identifier</key>
\t<string>${values.teamId}</string>
\t<key>com.apple.security.application-groups</key>
\t<array>
\t\t<string>${values.appGroup}</string>
\t</array>
\t<key>get-task-allow</key>
\t<true/>
\t<key>keychain-access-groups</key>
\t<array>
\t\t<string>${values.teamId}.*</string>
\t</array>
</dict>
</plist>
`);
}

function importCertificate() {
  const password = readP12Password();

  run("security", ["create-keychain", "-p", keychainPassword, config.keychainPath]);
  run("security", ["unlock-keychain", "-p", keychainPassword, config.keychainPath]);
  run("security", ["set-keychain-settings", "-lut", "21600", config.keychainPath]);
  run("security", [
    "import",
    config.p12Path,
    "-k",
    config.keychainPath,
    "-P",
    password,
    "-T",
    "/usr/bin/codesign",
    "-T",
    "/usr/bin/security",
  ]);
  run("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:",
    "-s",
    "-k",
    keychainPassword,
    config.keychainPath,
  ]);
}

function findSigningIdentity() {
  const output = runCapture("security", ["find-identity", "-v", "-p", "codesigning"]);
  const matches = [...output.matchAll(/^\s*\d+\)\s+([A-F0-9]{40})\s+"iPhone Developer: Created via API/gm)];

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one UDID Registrations iPhone Developer identity, found ${matches.length}.`);
  }

  return matches[0][1];
}

function packageSignedIpa(identityHash) {
  const appPath = join(config.signedDir, "Payload", "URLBlockerIOS.app");
  const builtAppPath = join(config.derivedData, "Build", "Products", "Release-iphoneos", "URLBlockerIOS.app");
  const extensionPath = join(appPath, "PlugIns", "URLBlockerIOSExtension.appex");

  resetScratchDir(config.signedDir);
  mkdirSync(join(config.signedDir, "Payload"), { recursive: true });
  run("ditto", [builtAppPath, appPath]);
  copyFileSync(config.profilePath, join(appPath, "embedded.mobileprovision"));

  run("codesign", [
    "-f",
    "-s",
    identityHash,
    "--generate-entitlement-der",
    "--entitlements",
    config.entitlementsPlist,
    extensionPath,
  ]);

  run("codesign", [
    "-f",
    "-s",
    identityHash,
    "--generate-entitlement-der",
    "--entitlements",
    config.entitlementsPlist,
    appPath,
  ]);

  mkdirSync(dirname(config.signedIpa), { recursive: true });
  rmSync(config.signedIpa, { force: true });
  run("zip", ["-qry", "-X", resolve(config.signedIpa), "Payload"], { cwd: config.signedDir });
}

function verifySignedApp(values) {
  const appPath = join(config.signedDir, "Payload", "URLBlockerIOS.app");
  const extensionPath = join(appPath, "PlugIns", "URLBlockerIOSExtension.appex");

  assertEquals(readPlistValue(join(appPath, "Info.plist"), ":CFBundleIdentifier"), values.appId);
  assertEquals(readPlistValue(join(extensionPath, "Info.plist"), ":CFBundleIdentifier"), values.extensionId);

  run("codesign", ["-v", "--strict", "--deep", appPath]);
  assertEntitlements(readEntitlements(appPath), values);
  assertEntitlements(readEntitlements(extensionPath), values);
}

function assertEntitlements(entitlements, values) {
  assertEquals(entitlements["application-identifier"], `${values.teamId}.${values.appId}`);
  assertEquals(entitlements["com.apple.developer.team-identifier"], values.teamId);

  const appGroups = entitlements["com.apple.security.application-groups"];

  if (!Array.isArray(appGroups) || !appGroups.includes(values.appGroup)) {
    throw new Error(`Expected signed entitlements to include app group ${values.appGroup}.`);
  }
}

function readEntitlements(path) {
  const result = spawnSync("codesign", ["-d", "--entitlements", ":-", path], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim());
  }

  const plistPath = join(config.workDir, `${path.endsWith(".appex") ? "extension" : "app"}-entitlements.plist`);
  writeFileSync(plistPath, result.stdout);
  return readPlistJson(plistPath);
}

function readP12Password() {
  if (process.env.P12_PASSWORD) {
    return process.env.P12_PASSWORD;
  }

  if (existsSync(config.p12PasswordPath)) {
    const password = readFileSync(config.p12PasswordPath, "utf8").trim();

    if (password.length === 0) {
      throw new Error(`Password file is empty: ${config.p12PasswordPath}`);
    }

    return password;
  }

  if (!process.stdin.isTTY) {
    throw new Error(`Set P12_PASSWORD, create ${config.p12PasswordPath}, or run make ios-install from an interactive terminal.`);
  }

  const result = spawnSync("/bin/zsh", [
    "-c",
    'read -rsp "UDID .p12 password: " password; printf "\\n" >&2; printf "%s" "$password"',
  ], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });

  if (result.status !== 0) {
    throw new Error("Could not read the UDID .p12 password.");
  }

  return result.stdout;
}

function readKeychainSearchList() {
  const output = runCapture("security", ["list-keychains", "-d", "user"]);
  const keychains = [...output.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  if (keychains.length === 0) {
    throw new Error("Expected at least one user keychain in the search list.");
  }

  return keychains;
}

function restoreKeychains() {
  if (originalKeychains.length === 0) {
    return;
  }

  const result = spawnSync("security", ["list-keychains", "-d", "user", "-s", ...originalKeychains], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    console.error(result.stderr.trim());
  }
}

function setKeychainSearchList(keychains) {
  run("security", ["list-keychains", "-d", "user", "-s", ...keychains]);
}

function deleteSigningKeychain() {
  if (!existsSync(config.keychainPath)) {
    return;
  }

  spawnSync("security", ["delete-keychain", config.keychainPath], { encoding: "utf8" });
  rmSync(config.keychainPath, { force: true });
}

function readPlistJson(path) {
  return JSON.parse(runCapture("plutil", ["-convert", "json", "-o", "-", path]));
}

function readPlistValue(path, keyPath) {
  return runCapture("/usr/libexec/PlistBuddy", ["-c", `Print ${keyPath}`, path]).trim();
}

function readPlistArray(path, keyPath) {
  const output = readPlistValue(path, keyPath);
  const values = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "Array {" && line !== "}");

  if (values.length === 0) {
    throw new Error(`Expected ${keyPath} to contain at least one value.`);
  }

  return values;
}

function replaceInFile(path, replacements) {
  let text = readFileSync(path, "utf8");

  for (const [from, to] of replacements) {
    if (!text.includes(from)) {
      throw new Error(`Expected ${path} to contain ${from}.`);
    }

    text = text.split(from).join(to);
  }

  writeFileSync(path, text);
}

function resetScratchDir(path) {
  if (!path.startsWith("/tmp/urlblocker_") && !path.startsWith("/private/tmp/urlblocker_")) {
    throw new Error(`Refusing to delete non-scratch path: ${path}`);
  }

  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

function assertFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing file: ${path}`);
  }
}

function assertEquals(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Expected ${expected}, got ${actual}.`);
  }
}

function one(values, name) {
  if (!Array.isArray(values) || values.length !== 1) {
    throw new Error(`Expected ${name} to contain exactly one value.`);
  }

  return values[0];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${command} failed.`);
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim());
  }

  return result.stdout;
}
