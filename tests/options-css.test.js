const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const css = fs.readFileSync(path.join(__dirname, "../URLBlockerWebExtension/options.css"), "utf8");

test("default block group titles are larger than URL entries", () => {
  assert.match(rule(".default-group-title"), /font-size:\s*20px;/);
  assert.match(rule(".default-group-entry-value"), /font-weight:\s*400;/);
});

test("hidden sync action buttons are not displayed", () => {
  assert.match(rule(".sync-actions button[hidden]"), /display:\s*none;/);
});

test("buttons show clickable and pressed affordances", () => {
  assert.match(rule("button:not(:disabled)"), /cursor:\s*pointer;/);
  assert.match(rule("button:not(:disabled):active"), /transform:\s*translateY\(1px\);/);
});

test("sync now and sign out share the mobile action row", () => {
  assert.match(css, /\.sync-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s);
  assert.match(rule(".provider-button"), /grid-column:\s*1\s*\/\s*-1;/);
});

test("provider sign-in buttons show hover feedback", () => {
  assert.match(rule("#googleSignInButton:not(:disabled):hover"), /background:\s*#f8fafd;/);
  assert.match(rule("#appleSignInButton:not(:disabled):hover"), /background:\s*#1c1c1c;/);
});

test("daily reset select uses the shared form control styling", () => {
  assert.match(css, /input,\s*select,\s*textarea\s*\{[^}]*border:\s*1px\s+solid\s+var\(--border\);/s);
  assert.match(css, /input,\s*select\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(css, /\nselect\s*\{[^}]*appearance:\s*none;/s);
  assert.match(rule("select option"), /background:\s*var\(--surface\);/);
});

test("hidden time limit controls are not displayed", () => {
  assert.match(css, /\.settings-panel\[hidden\]\s*\{[^}]*display:\s*none;/s);
  assert.match(css, /\.default-group-limit\[hidden\],\s*\.row-limit\[hidden\]\s*\{[^}]*display:\s*none;/s);
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
