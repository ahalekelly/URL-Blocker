#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outputPath = join(mkdtempSync(join(tmpdir(), "urlblocker_devicectl.")), "devices.json");
const result = spawnSync("xcrun", [
  "devicectl",
  "--quiet",
  "--timeout",
  "30",
  "--json-output",
  outputPath,
  "list",
  "devices",
], {
  encoding: "utf8",
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const report = JSON.parse(readFileSync(outputPath, "utf8"));
const devices = report.result?.devices;

if (!Array.isArray(devices)) {
  throw new Error("Expected devicectl JSON to contain result.devices.");
}

const iphones = devices.filter(isIphone);

if (iphones.length === 0) {
  console.error("No iPhone found by devicectl. Connect and trust the iPhone, or pass DEVICE=...");
  process.exit(1);
}

if (iphones.length > 1) {
  console.error("Multiple iPhones found by devicectl. Pass DEVICE=...");

  for (const iphone of iphones) {
    console.error(`- ${deviceIdentifier(iphone)}`);
  }

  process.exit(1);
}

console.log(deviceIdentifier(iphones[0]));

function isIphone(device) {
  return device.hardwareProperties?.productType?.startsWith("iPhone")
    || device.hardwareProperties?.deviceType === "iPhone"
    || device.deviceProperties?.name?.toLowerCase().includes("iphone");
}

function deviceIdentifier(device) {
  const identifier = device.identifier
    ?? device.hardwareProperties?.udid
    ?? device.deviceProperties?.identifier;

  if (!identifier) {
    throw new Error("Expected devicectl iPhone device to have an identifier.");
  }

  return identifier;
}
