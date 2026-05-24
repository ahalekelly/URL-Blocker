#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const reloadPage = "reload.html";
const browsers = {
  Vivaldi: {
    profileDirectory: "Default",
    userDataDir: path.join(
      homedir(),
      "Library/Application Support/Vivaldi",
    ),
  },
  "Brave Browser": {
    profileDirectory: "Default",
    userDataDir: path.join(
      homedir(),
      "Library/Application Support/BraveSoftware/Brave-Browser",
    ),
  },
};

if (isMainModule()) {
  await main(process.argv.slice(2));
  process.exit(0);
}

async function main(rawArgs) {
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

  const browserState = isAppRunning(appName)
    ? { type: "running", userDataDir: runningUserDataDir(browserPath, browserConfig.userDataDir) }
    : { type: "closed", userDataDir: browserConfig.userDataDir };
  const app = { appName, browserConfig, browserState, extensionPath };

  switch (mode.type) {
    case "preflight":
      await preflightUpdate(app);
      break;
    case "update":
      await updateBrowser(app);
      break;
    default:
      throw new Error(`Unknown mode: ${mode.type}`);
  }
}

async function preflightUpdate(app) {
  await validateInstalled(app);
}

async function updateBrowser(app) {
  const extension = await validateInstalled(app);

  switch (app.browserState.type) {
    case "running":
      await reloadRunningBrowser(app, extension);
      break;
    case "closed":
      console.log(`Updated URL Blocker files for closed ${app.appName} ${profileLabel(app)}: ${extension.id}`);
      break;
    default:
      throw new Error(`Unknown browser state: ${app.browserState.type}`);
  }
}

async function reloadRunningBrowser(app, extension) {
  openRunningBrowser(app.appName, `chrome-extension://${extension.id}/${reloadPage}`);
  await wait(1_000);
  await validateInstalled(app);

  console.log(`Reloaded URL Blocker in running ${app.appName} ${profileLabel(app)}: ${extension.id}`);
}

async function validateInstalled(app) {
  const extension = await readExtensionByPath(app);

  validateEnabled(app, extension.settings);

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

function runningUserDataDir(browserPath, defaultUserDataDir) {
  const command = runningBrowserCommand(browserPath);
  const userDataDir = userDataDirFromCommand(command);

  return userDataDir || defaultUserDataDir;
}

function runningBrowserCommand(browserPath) {
  const result = spawnSync("ps", ["-axww", "-o", "command="], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error("Failed to read running browser processes");
  }

  return result.stdout
    .split("\n")
    .find((command) => command.startsWith(browserPath)) || "";
}

function userDataDirFromCommand(command) {
  const match = command.match(/(?:^|\s)--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);

  return match ? match[1] || match[2] || match[3] : "";
}

function openRunningBrowser(appName, url) {
  const result = spawnSync("open", ["-a", appName, url], { stdio: "inherit" });

  if (result.status !== 0) {
    throw new Error(`Failed to open ${url} in ${appName}`);
  }
}

async function readExtensionByPath(app) {
  const extensions = await readExtensionSettings(app);
  const matches = Object
    .entries(extensions)
    .filter(([, settings]) => settings.path === app.extensionPath);

  if (matches.length === 0) {
    throw new Error(`${app.appName} does not have URL Blocker installed from ${app.extensionPath} in ${profileLabel(app)}`);
  }

  if (matches.length > 1) {
    throw new Error(`${app.appName} has multiple extensions installed from ${app.extensionPath} in ${profileLabel(app)}`);
  }

  const [[id, settings]] = matches;

  return { id, settings };
}

async function readExtensionSettings(app) {
  const preferences = await readPreferences(app);
  const extensionRoot = preferences.extensions;

  if (!extensionRoot || typeof extensionRoot !== "object") {
    throw new Error(`${app.appName} saved invalid extension preferences`);
  }

  if (!extensionRoot.settings || typeof extensionRoot.settings !== "object") {
    throw new Error(`${app.appName} saved invalid extension settings`);
  }

  return extensionRoot.settings;
}

async function readPreferences(app) {
  return JSON.parse(await readFile(securePreferencesPath(app.browserConfig, app.browserState), "utf8"));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateEnabled(app, settings) {
  if (settings.disable_reasons === undefined) {
    return;
  }

  if (!Array.isArray(settings.disable_reasons)) {
    throw new Error(`${app.appName} saved invalid disable reasons for URL Blocker`);
  }

  if (settings.disable_reasons.length > 0) {
    throw new Error(
      `${app.appName} cannot keep URL Blocker enabled: ${settings.disable_reasons.join(", ")}`,
    );
  }
}

function securePreferencesPath(browserConfig, browserState) {
  return path.join(browserState.userDataDir, browserConfig.profileDirectory, "Secure Preferences");
}

function profileLabel(app) {
  if (app.browserState.userDataDir === app.browserConfig.userDataDir) {
    return app.browserConfig.profileDirectory;
  }

  return `${app.browserConfig.profileDirectory} at ${app.browserState.userDataDir}`;
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

export {
  securePreferencesPath,
  userDataDirFromCommand,
};
