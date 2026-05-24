#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rawArgs = process.argv.slice(2);
const reloadPage = "reload.html";
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
const mode = rawArgs[0] === "--preflight"
  ? { type: "preflight", args: rawArgs.slice(1) }
  : { type: "update", args: rawArgs };

if (mode.args.length !== 3) {
  throw new Error(
    "Usage: node scripts/install-chromium-extension.mjs [--preflight] <app name> <browser binary> <extension directory>",
  );
}

const [appName, browserPath, extensionPath] = mode.args;
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

if (mode.type === "update") {
  await access(path.join(extensionPath, "manifest.json"));
  await access(path.join(extensionPath, reloadPage));
}

const browserState = isAppRunning(appName) ? { type: "running" } : { type: "closed" };

switch (mode.type) {
  case "preflight":
    await preflightUpdate();
    break;
  case "update":
    await updateBrowser();
    break;
  default:
    throw new Error(`Unknown mode: ${mode.type}`);
}

process.exit(0);

async function preflightUpdate() {
  await validateInstalled();
}

async function updateBrowser() {
  const extension = await validateInstalled();

  switch (browserState.type) {
    case "running":
      await reloadRunningBrowser(extension);
      break;
    case "closed":
      console.log(`Updated URL Blocker files for closed ${appName} ${browserConfig.profileDirectory}: ${extension.id}`);
      break;
    default:
      throw new Error(`Unknown browser state: ${browserState.type}`);
  }
}

async function reloadRunningBrowser(extension) {
  openRunningBrowser(`chrome-extension://${extension.id}/${reloadPage}`);
  await wait(1_000);
  await validateInstalled();

  console.log(`Reloaded URL Blocker in running ${appName} ${browserConfig.profileDirectory}: ${extension.id}`);
}

async function validateInstalled() {
  const extension = await readExtensionByPath();

  validateEnabled(extension.settings);

  return extension;
}

function isAppRunning(name) {
  const result = spawnSync("osascript", ["-e", `application "${name}" is running`], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to check whether ${name} is running`);
  }

  const answer = result.stdout.trim();

  if (answer === "true") {
    return true;
  }

  if (answer === "false") {
    return false;
  }

  throw new Error(`Unknown ${name} running state: ${answer}`);
}

function openRunningBrowser(url) {
  const result = spawnSync("open", ["-a", appName, url], { stdio: "inherit" });

  if (result.status !== 0) {
    throw new Error(`Failed to open ${url} in ${appName}`);
  }
}

async function readExtensionByPath() {
  const extensions = await readExtensionSettings();
  const matches = Object
    .entries(extensions)
    .filter(([, settings]) => settings.path === extensionPath);

  if (matches.length === 0) {
    throw new Error(`${appName} does not have URL Blocker installed from ${extensionPath}`);
  }

  if (matches.length > 1) {
    throw new Error(`${appName} has multiple extensions installed from ${extensionPath}`);
  }

  const [[id, settings]] = matches;

  return { id, settings };
}

async function readExtensionSettings() {
  const preferences = await readPreferences();
  const extensionRoot = preferences.extensions;

  if (!extensionRoot || typeof extensionRoot !== "object") {
    throw new Error(`${appName} saved invalid extension preferences`);
  }

  if (!extensionRoot.settings || typeof extensionRoot.settings !== "object") {
    throw new Error(`${appName} saved invalid extension settings`);
  }

  return extensionRoot.settings;
}

async function readPreferences() {
  return JSON.parse(await readFile(browserConfig.securePreferencesPath, "utf8"));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateEnabled(settings) {
  if (settings.disable_reasons === undefined) {
    return;
  }

  if (!Array.isArray(settings.disable_reasons)) {
    throw new Error(`${appName} saved invalid disable reasons for URL Blocker`);
  }

  if (settings.disable_reasons.length > 0) {
    throw new Error(
      `${appName} cannot keep URL Blocker enabled: ${settings.disable_reasons.join(", ")}`,
    );
  }
}
