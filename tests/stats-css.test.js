const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const css = fs.readFileSync(path.join(__dirname, "../URLBlockerWebExtension/stats.css"), "utf8");

test("hourly chart fits the page without horizontal scrolling", () => {
  assert.doesNotMatch(css, /overflow-x:\s*auto;/);
  assert.match(rule(".hourly-plot"), /border-top:\s*1px solid var\(--border\);/);
  assert.match(rule(".hourly-plot"), /border-right:\s*1px solid var\(--border\);/);
  assert.match(rule(".hourly-x-tick"), /min-width:\s*max-content;/);
  assert.match(
    css,
    /\.hourly-plot,\s*\.hourly-x-axis\s*\{[^}]*grid-auto-columns:\s*minmax\(0,\s*1fr\);/s
  );
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
