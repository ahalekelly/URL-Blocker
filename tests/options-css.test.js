const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const css = fs.readFileSync(path.join(__dirname, "../URLBlockerIOSExtension/Resources/options.css"), "utf8");

test("default block group titles are larger than URL entries", () => {
  assert.match(rule(".default-group-title"), /font-size:\s*20px;/);
  assert.match(rule(".default-group-entry-value"), /font-weight:\s*400;/);
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
