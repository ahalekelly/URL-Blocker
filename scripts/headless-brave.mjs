// Launches muted headless Brave with a throwaway profile and the freshly built
// unpacked extension, prints its CDP endpoint as JSON, and runs until killed.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(repoRoot, "build/chrome-extension");
const bravePath = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const startupTimeoutMs = 20_000;

const build = spawnSync(process.execPath, [path.join(repoRoot, "scripts/build-chrome-extension.mjs")], { stdio: "inherit" });

if (build.status !== 0) {
  throw new Error(`Chrome extension build failed with exit code ${build.status}.`);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "url-blocker-brave-"));
const port = await freePort();
const logPath = path.join(profile, "brave.log");
const log = fs.openSync(logPath, "w");
const brave = spawn(bravePath, [
  "--headless=new",
  // Headless Chromium still plays page audio through the speakers.
  "--mute-audio",
  "--autoplay-policy=user-gesture-required",
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  // Branded Chromium ignores --load-extension unless this feature is disabled.
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
  `--load-extension=${extensionPath}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--use-mock-keychain",
  "--password-store=basic",
  "--window-size=1400,1000",
  "about:blank"
], { stdio: ["ignore", log, log] });

brave.on("exit", (code, signal) => {
  console.error(`Brave exited (code ${code}, signal ${signal}). Log: ${logPath}`);
  process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => brave.kill());
}

const extensionId = await waitForExtensionId();

console.log(JSON.stringify({
  cdpUrl: `http://127.0.0.1:${port}`,
  extensionId,
  optionsUrl: `chrome-extension://${extensionId}/options.html`,
  profile,
  log: logPath
}, null, 2));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForExtensionId() {
  const deadline = Date.now() + startupTimeoutMs;

  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json(), () => []);
    const worker = targets.find((target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://"));

    if (worker) {
      return new URL(worker.url).host;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  brave.kill();
  throw new Error(`URL Blocker's service worker did not start within ${startupTimeoutMs / 1000} s. Log: ${logPath}`);
}
