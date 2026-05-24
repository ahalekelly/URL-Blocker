#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const unsupportedDeveloperExtension = 1 << 24;
const browsers = {
  Vivaldi: {
    profileDirectory: "Default",
    securePreferencesPath: path.join(
      homedir(),
      "Library/Application Support/Vivaldi/Default/Secure Preferences",
    ),
  },
  "Brave Browser": {
    profileDirectory: "Default",
    securePreferencesPath: path.join(
      homedir(),
      "Library/Application Support/BraveSoftware/Brave-Browser/Default/Secure Preferences",
    ),
  },
};

if (args.length !== 3) {
  throw new Error(
    "Usage: node scripts/install-chromium-extension.mjs <app name> <browser binary> <extension directory>",
  );
}

const [appName, browserPath, extensionPath] = args;
const browserConfig = browsers[appName];

if (!browserConfig) {
  throw new Error(`Unknown browser: ${appName}`);
}

if (!path.isAbsolute(browserPath)) {
  throw new Error(`Browser binary must be absolute: ${browserPath}`);
}

if (!path.isAbsolute(extensionPath)) {
  throw new Error(`Extension directory must be absolute: ${extensionPath}`);
}

await access(browserPath);
await access(path.join(extensionPath, "manifest.json"));

const browser = spawn(
  browserPath,
  [
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    `--profile-directory=${browserConfig.profileDirectory}`,
    "chrome://extensions",
  ],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
);

const chromeInput = browser.stdio[3];
const chromeOutput = browser.stdio[4];
let nextMessageId = 1;
let pendingOutput = "";

browser.stderr.on("data", () => {});

async function sendChromeMessage(method, params) {
  const id = nextMessageId;
  nextMessageId += 1;

  writeChromeMessage(id, method, params);

  return await readChromeMessage(id);
}

function writeChromeMessage(id, method, params) {
  chromeInput.write(`${JSON.stringify({ id, method, params })}\0`);
}

function readChromeMessage(expectedId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedId}`)), 10_000);

    chromeOutput.on("data", function readData(chunk) {
      pendingOutput += chunk.toString();
      const messages = pendingOutput.split("\0");
      pendingOutput = messages.pop();

      for (const messageText of messages) {
        if (messageText === "") {
          continue;
        }

        const message = JSON.parse(messageText);

        if (message.id !== expectedId) {
          continue;
        }

        chromeOutput.off("data", readData);
        clearTimeout(timeout);

        if (message.error) {
          reject(new Error(message.error.message));
          return;
        }

        resolve(message.result);
      }
    });
  });
}

const result = await sendChromeMessage("Extensions.loadUnpacked", { path: extensionPath });
writeChromeMessage(nextMessageId, "Browser.close", {});

await new Promise((resolve) => browser.on("exit", resolve));

const extensionSettings = await readExtensionSettings(result.id);

const openResult = spawnSync(
  "open",
  ["-na", appName, "--args", `--profile-directory=${browserConfig.profileDirectory}`, "chrome://extensions"],
  { stdio: "inherit" },
);

if (openResult.status !== 0) {
  throw new Error(`Failed to reopen ${appName}`);
}

if (extensionSettings.disable_reasons.includes(unsupportedDeveloperExtension)) {
  throw new Error(
    `${appName} updated URL Blocker, but disabled it because Developer mode is off. ` +
      `In ${appName}, open chrome://extensions, turn on Developer mode, enable URL Blocker, then rerun this target.`,
  );
}

if (extensionSettings.disable_reasons.length > 0) {
  throw new Error(
    `${appName} updated URL Blocker, but disabled it: ${extensionSettings.disable_reasons.join(", ")}`,
  );
}

console.log(`Updated URL Blocker in ${appName} ${browserConfig.profileDirectory}: ${result.id}`);
process.exit(0);

async function readExtensionSettings(extensionId) {
  const preferences = JSON.parse(await readFile(browserConfig.securePreferencesPath, "utf8"));
  const extensionSettings = preferences.extensions?.settings?.[extensionId];

  if (!extensionSettings) {
    throw new Error(`${appName} did not save URL Blocker in ${browserConfig.profileDirectory}`);
  }

  if (extensionSettings.path !== extensionPath) {
    throw new Error(`${appName} saved URL Blocker from ${extensionSettings.path}`);
  }

  if (!Array.isArray(extensionSettings.disable_reasons)) {
    throw new Error(`${appName} saved invalid disable reasons for URL Blocker`);
  }

  return extensionSettings;
}
