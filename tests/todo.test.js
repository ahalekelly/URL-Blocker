const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const todoText = fs.readFileSync(path.join(__dirname, "../TODO.md"), "utf8");

test("completed TODO entries include commit hashes", () => {
  const doneSection = todoText.split("Done, ready for review:")[1].split("To Do:")[0];
  const entries = doneSection
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  assert.ok(entries.length > 0);
  entries.forEach((entry) => {
    assert.match(entry, /Commit: [0-9a-f]{7,40}\.?$/);
  });
});
