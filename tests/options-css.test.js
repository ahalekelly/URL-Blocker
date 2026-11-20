const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const css = fs.readFileSync(path.join(__dirname, "../URLBlockerWebExtension/options.css"), "utf8");

test("hidden sync action buttons are not displayed", () => {
  assert.match(rule(".sync-actions button[hidden]"), /display:\s*none;/);
});

test("hidden time limit controls are not displayed", () => {
  assert.match(css, /\.settings-panel\[hidden\]\s*\{[^}]*display:\s*none;/s);
  assert.match(css, /\.limit-control\[hidden\],\s*\.limit-control \[hidden\]\s*\{[^}]*display:\s*none;/s);
});

function rule(selector) {
  const match = css.match(new RegExp(`${escapeRegex(selector)}\\s*\\{([^}]+)\\}`));

  if (!match) {
    throw new Error(`Missing CSS rule: ${selector}`);
  }

  return match[1];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
