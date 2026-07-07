const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const contentScript = fs.readFileSync(path.join(__dirname, "../URLBlockerWebExtension/content.js"), "utf8");
const referrerRecordPrefix = "referrerRecords:";
const referrerRecordRetentionMs = 30 * 24 * 60 * 60 * 1000;
const defaultSource = { type: "document", referrer: knownReferrer(""), navigationType: "navigate" };

function knownReferrer(url) {
  return { type: "known", url };
}

function unknownReferrer() {
  return { type: "unknown" };
}

function documentSource(referrer, navigationType = "navigate") {
  return { type: "document", referrer: knownReferrer(referrer), navigationType };
}

function urlChanged(url, source = defaultSource) {
  return { type: "urlChanged", url, source };
}

test("content script reports the startup URL to the worker", async () => {
  const page = await runContentScript("https://x.com/home");

  assert.deepEqual(page.messages, [
    urlChanged("https://x.com/home")
  ]);
});

test("content script reports changed URLs once", async () => {
  const page = await runContentScript("https://x.com");

  page.location.href = "https://x.com/home";
  await page.dispatch("popstate");
  await page.dispatch("focus");

  assert.deepEqual(page.messages, [
    urlChanged("https://x.com"),
    urlChanged("https://x.com/home", documentSource("https://x.com"))
  ]);
});

test("content script reports SPA route changes as internal navigation", async () => {
  const page = await runContentScript("https://www.youtube.com", { referrer: "https://search.example/" });

  page.location.href = "https://www.youtube.com/watch?v=abc123";
  await page.dispatch("popstate");

  assert.deepEqual(page.messages, [
    urlChanged("https://www.youtube.com", documentSource("https://search.example/")),
    urlChanged("https://www.youtube.com/watch?v=abc123", documentSource("https://www.youtube.com"))
  ]);
});

test("content script logs elapsed time before changed URLs", async () => {
  const page = await runContentScript("https://x.com");

  page.location.href = "https://x.com/home";
  await page.dispatch("popstate", 700);

  assert.deepEqual(page.messages, [
    urlChanged("https://x.com"),
    { type: "screenTimeElapsed", url: "https://x.com", elapsedMs: 700 },
    urlChanged("https://x.com/home", documentSource("https://x.com"))
  ]);
});

test("content script periodically rechecks unchanged URLs", async () => {
  const page = await runContentScript("https://x.com/home");

  await page.tick();

  assert.deepEqual(page.messages, [
    urlChanged("https://x.com/home"),
    { type: "screenTimeElapsed", url: "https://x.com/home", elapsedMs: 5000 },
    urlChanged("https://x.com/home")
  ]);
});

test("content script logs elapsed time when the page hides", async () => {
  const page = await runContentScript("https://x.com/home");

  await page.setHidden(true, 900);
  await page.tick();

  assert.deepEqual(page.messages, [
    urlChanged("https://x.com/home"),
    { type: "screenTimeElapsed", url: "https://x.com/home", elapsedMs: 900 }
  ]);
});

test("content script ignores stale screen time after sleep", async () => {
  const page = await runContentScript("https://x.com/home");

  await page.tick(10 * 60 * 1000);
  await page.tick();

  assert.deepEqual(page.messages, [
    urlChanged("https://x.com/home"),
    urlChanged("https://x.com/home"),
    { type: "screenTimeElapsed", url: "https://x.com/home", elapsedMs: 5000 },
    urlChanged("https://x.com/home")
  ]);
});

test("content script reports referrer and navigation type", async () => {
  const source = { type: "document", referrer: knownReferrer("https://x.com/from"), navigationType: "reload" };
  const page = await runContentScript("https://x.com/home", { referrer: source.referrer.url, navigationType: source.navigationType });

  assert.deepEqual(page.messages, [urlChanged("https://x.com/home", source)]);
});

test("content script logs plain object message errors with details", async () => {
  const error = { message: "Tab update failed.", code: "TabUpdateTestError" };
  const page = await runContentScript("https://x.com/home", { sendError: error });

  await page.flush();

  assert.deepEqual(JSON.parse(JSON.stringify(page.consoleErrors)), [[
    "URL Blocker could not check the current URL.",
    { message: JSON.stringify(error), code: "TabUpdateTestError" }
  ]]);
});

test("content script writes referrer records on navigate loads", async () => {
  const page = await runContentScript("https://example.com/path?tab=1&view=2", { referrer: "https://search.example/" });

  assert.deepEqual(page.messages, [
    urlChanged("https://example.com/path?tab=1&view=2", documentSource("https://search.example/"))
  ]);
  assert.deepEqual(page.storageData[`${referrerRecordPrefix}https://example.com/path?tab=1`], {
    records: [{ referrer: "https://search.example/", recordedAt: 0 }]
  });
});

test("content script writes referrer records on SPA hops", async () => {
  const page = await runContentScript("https://example.com/start", { referrer: "https://search.example/" });

  page.location.href = "https://example.com/next";
  await page.dispatch("popstate");

  assert.deepEqual(page.messages.at(-1), urlChanged("https://example.com/next", documentSource("https://example.com/start")));
  assert.deepEqual(page.storageData[`${referrerRecordPrefix}https://example.com/next`], {
    records: [{ referrer: "https://example.com/start", recordedAt: 0 }]
  });
});

test("content script reports SPA hops from reload documents as navigate", async () => {
  const page = await runContentScript("https://example.com/start", {
    referrer: "https://search.example/",
    navigationType: "reload"
  });

  page.location.href = "https://example.com/next";
  await page.dispatch("popstate");

  assert.deepEqual(page.messages.at(-1), urlChanged("https://example.com/next", documentSource("https://example.com/start", "navigate")));
});

test("content script reads the newest record for back and forward loads", async () => {
  const page = await runContentScript("https://example.com/page", {
    navigationType: "back_forward",
    initialStorage: {
      [`${referrerRecordPrefix}https://example.com/page`]: {
        records: [
          { referrer: "https://old.example/", recordedAt: 0 },
          { referrer: "https://new.example/", recordedAt: 1 }
        ]
      }
    }
  });

  assert.deepEqual(page.messages, [
    urlChanged("https://example.com/page", { type: "document", referrer: knownReferrer("https://new.example/"), navigationType: "back_forward" })
  ]);
});

test("content script reports unknown referrers for back and forward loads without records", async () => {
  const page = await runContentScript("https://example.com/page", { navigationType: "back_forward" });

  assert.deepEqual(page.messages, [
    urlChanged("https://example.com/page", { type: "document", referrer: unknownReferrer(), navigationType: "back_forward" })
  ]);
});

test("content script ignores expired back and forward records", async () => {
  const page = await runContentScript("https://example.com/page", {
    navigationType: "back_forward",
    initialStorage: {
      [`${referrerRecordPrefix}https://example.com/page`]: {
        records: [{ referrer: "https://old.example/", recordedAt: -referrerRecordRetentionMs - 1 }]
      }
    }
  });

  assert.deepEqual(page.messages, [
    urlChanged("https://example.com/page", { type: "document", referrer: unknownReferrer(), navigationType: "back_forward" })
  ]);
});

test("content script fails closed when reading back and forward records fails", async () => {
  const page = await runContentScript("https://example.com/page", {
    navigationType: "back_forward",
    storageGetError: { message: "Storage get failed.", code: "StorageGetTestError" }
  });

  assert.deepEqual(page.messages, [
    urlChanged("https://example.com/page", { type: "document", referrer: unknownReferrer(), navigationType: "back_forward" })
  ]);
  assert.equal(page.consoleErrors[0][0], "URL Blocker could not read referrer records.");
});

test("content script force-checks bfcache restores with the stored SPA arrival", async () => {
  const page = await runContentScript("https://example.com/a", { referrer: "https://search.example/" });

  page.location.href = "https://example.com/b";
  await page.dispatch("popstate");
  await page.dispatch("pageshow", 0, { persisted: true });

  assert.deepEqual(page.messages, [
    urlChanged("https://example.com/a", documentSource("https://search.example/")),
    urlChanged("https://example.com/b", documentSource("https://example.com/a")),
    urlChanged("https://example.com/b", documentSource("https://example.com/a"))
  ]);
});

test("content script poll rechecks report SPA arrival instead of document referrer", async () => {
  const page = await runContentScript("https://example.com/a", { referrer: "https://search.example/" });

  page.location.href = "https://example.com/b";
  await page.dispatch("popstate");
  await page.tick();

  assert.deepEqual(page.messages.at(-1), urlChanged("https://example.com/b", documentSource("https://example.com/a")));
});

test("content script appends referrer records and caps history at 20", async () => {
  const storageData = {
    [`${referrerRecordPrefix}https://example.com/page`]: {
      records: Array.from({ length: 19 }, (_, index) => ({ referrer: `https://old${index}.example/`, recordedAt: index }))
    }
  };

  await runContentScript("https://example.com/page", { referrer: "https://one.example/", storageData, now: 20 });
  await runContentScript("https://example.com/page", { referrer: "https://two.example/", storageData, now: 21 });

  assert.equal(storageData[`${referrerRecordPrefix}https://example.com/page`].records.length, 20);
  assert.deepEqual(storageData[`${referrerRecordPrefix}https://example.com/page`].records.at(-2), {
    referrer: "https://one.example/",
    recordedAt: 20
  });
  assert.deepEqual(storageData[`${referrerRecordPrefix}https://example.com/page`].records.at(-1), {
    referrer: "https://two.example/",
    recordedAt: 21
  });
});

test("content script keeps the page arrival across &/# URL changes", async () => {
  const page = await runContentScript("https://example.com/watch?v=abc", { referrer: "https://search.example/" });

  page.location.href = "https://example.com/watch?v=abc&t=30";
  await page.dispatch("popstate");
  page.location.href = "https://example.com/watch?v=abc&t=30#comments";
  await page.dispatch("hashchange");
  page.location.href = "https://example.com/next";
  await page.dispatch("popstate");

  assert.deepEqual(page.messages, [
    urlChanged("https://example.com/watch?v=abc", documentSource("https://search.example/")),
    urlChanged("https://example.com/watch?v=abc&t=30", documentSource("https://search.example/")),
    urlChanged("https://example.com/watch?v=abc&t=30#comments", documentSource("https://search.example/")),
    urlChanged("https://example.com/next", documentSource("https://example.com/watch?v=abc&t=30#comments"))
  ]);
  assert.deepEqual(page.storageData[`${referrerRecordPrefix}https://example.com/watch?v=abc`], {
    records: [{ referrer: "https://search.example/", recordedAt: 0 }]
  });
});

test("content script fails closed on unrecognized navigation types", async () => {
  const page = await runContentScript("https://example.com/page", { navigationType: "future_type" });

  assert.deepEqual(page.messages, [
    urlChanged("https://example.com/page", { type: "document", referrer: unknownReferrer(), navigationType: "future_type" })
  ]);
});

test("content script reload loads reuse records without writing new ones", async () => {
  const pageWithRecord = await runContentScript("https://example.com/page", {
    navigationType: "reload",
    referrer: "https://document.example/",
    initialStorage: {
      [`${referrerRecordPrefix}https://example.com/page`]: {
        records: [{ referrer: "https://stored.example/", recordedAt: 0 }]
      }
    }
  });
  const pageWithoutRecord = await runContentScript("https://example.com/other", {
    navigationType: "reload",
    referrer: "https://document.example/"
  });
  const pageWithReadError = await runContentScript("https://example.com/error", {
    navigationType: "reload",
    referrer: "https://document.example/",
    storageGetError: { message: "Storage get failed.", code: "StorageGetTestError" }
  });

  assert.deepEqual(pageWithRecord.messages, [
    urlChanged("https://example.com/page", { type: "document", referrer: knownReferrer("https://stored.example/"), navigationType: "reload" })
  ]);
  assert.deepEqual(pageWithRecord.storageSets, []);
  assert.deepEqual(pageWithoutRecord.messages, [
    urlChanged("https://example.com/other", { type: "document", referrer: knownReferrer("https://document.example/"), navigationType: "reload" })
  ]);
  assert.deepEqual(pageWithoutRecord.storageSets, []);
  assert.deepEqual(pageWithReadError.messages, [
    urlChanged("https://example.com/error", { type: "document", referrer: unknownReferrer(), navigationType: "reload" })
  ]);
});

async function runContentScript(url, options = {}) {
  const storageData = options.storageData || JSON.parse(JSON.stringify(options.initialStorage || {}));
  const context = {
    browser: {
      runtime: {
        id: "test-extension",
        async sendMessage(message) {
          context.messages.push(message);

          if (options.sendError) {
            throw options.sendError;
          }

          return { type: "allowed" };
        }
      },
      storage: {
        local: {
          async get(key) {
            if (options.storageGetError) {
              throw options.storageGetError;
            }

            if (key === null) {
              return { ...storageData };
            }

            if (Array.isArray(key)) {
              return Object.fromEntries(key.map((storageKey) => [storageKey, storageData[storageKey]]));
            }

            return { [key]: storageData[key] };
          },
          async set(value) {
            if (options.storageSetError) {
              throw options.storageSetError;
            }

            const plainValue = JSON.parse(JSON.stringify(value));

            context.storageSets.push(plainValue);
            Object.assign(storageData, plainValue);
          }
        }
      }
    },
    console: {
      error(...args) {
        context.consoleErrors.push(args);
      }
    },
    document: { hidden: false, referrer: options.referrer || "" },
    intervals: [],
    listeners: new Map(),
    location: { href: url },
    consoleErrors: [],
    messages: [],
    storageSets: [],
    now: options.now || 0,
    performance: {
      getEntriesByType(type) {
        if (type !== "navigation") {
          return [];
        }

        return [{ type: options.navigationType || "navigate" }];
      }
    },
    Date: {
      now() {
        return context.now;
      }
    },
    addEventListener(type, listener) {
      context.listeners.set(type, listener);
    },
    clearInterval() {},
    clearTimeout() {},
    setInterval(listener, delay) {
      context.intervals.push({ listener, delay });
      return context.intervals.length;
    },
    setTimeout(listener) {
      listener();
    }
  };

  vm.runInNewContext(contentScript, context, { filename: "content.js" });
  await flush();

  return {
    location: context.location,
    consoleErrors: context.consoleErrors,
    get messages() {
      return JSON.parse(JSON.stringify(context.messages));
    },
    storageData,
    storageSets: context.storageSets,
    async dispatch(type, elapsedMs = 0, event = {}) {
      context.now += elapsedMs;
      context.listeners.get(type)(event);
      await flush();
    },
    async setHidden(hidden, elapsedMs = 0) {
      context.document.hidden = hidden;
      await this.dispatch("visibilitychange", elapsedMs);
    },
    async flush() {
      await flush();
    },
    async tick(elapsedMs = context.intervals[0].delay) {
      context.now += elapsedMs;
      context.intervals.forEach((interval) => interval.listener());
      await flush();
    }
  };

  async function flush() {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  }
}
