const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const contentScript = fs.readFileSync(path.join(__dirname, "../URLBlockerWebExtension/content.js"), "utf8");

function checkPage(url, referrer = "") {
  return { type: "checkPage", url, arrival: { type: "referrer", url: referrer } };
}

function checkHistoryPage(url) {
  return { type: "checkPage", url, arrival: { type: "history" } };
}

test("content script reports the startup URL with the document referrer", async () => {
  const page = await runContentScript("https://x.com/home", { referrer: "https://search.example/" });

  assert.deepEqual(page.messages, [checkPage("https://x.com/home", "https://search.example/")]);
});

test("content script keeps the page referrer when the site replaces its URL", async () => {
  const page = await runContentScript("https://www.reddit.com/comments/abc", { referrer: "https://search.example/" });

  page.location.href = "https://www.reddit.com/comments/abc/title_slug";
  await page.dispatch("currententrychange", 0, { navigationType: "replace" });

  assert.deepEqual(page.messages, [
    checkPage("https://www.reddit.com/comments/abc", "https://search.example/"),
    checkPage("https://www.reddit.com/comments/abc/title_slug", "https://search.example/")
  ]);
});

test("content script reports in-page URL changes with the previous URL as referrer", async () => {
  const page = await runContentScript("https://www.youtube.com/watch?v=abc", { referrer: "https://search.example/" });

  page.location.href = "https://www.youtube.com/watch?v=abc&t=30";
  await page.dispatch("currententrychange");
  await page.dispatch("currententrychange");
  page.location.href = "https://www.youtube.com/watch?v=def";
  await page.dispatch("currententrychange");

  assert.deepEqual(page.messages, [
    checkPage("https://www.youtube.com/watch?v=abc", "https://search.example/"),
    checkPage("https://www.youtube.com/watch?v=abc&t=30", "https://www.youtube.com/watch?v=abc"),
    checkPage("https://www.youtube.com/watch?v=abc&t=30", "https://www.youtube.com/watch?v=abc"),
    checkPage("https://www.youtube.com/watch?v=def", "https://www.youtube.com/watch?v=abc&t=30")
  ]);
});

test("content script polls screen time and the current page", async () => {
  const page = await runContentScript("https://x.com/home");

  await page.tick();

  assert.deepEqual(page.messages, [
    checkPage("https://x.com/home"),
    { type: "screenTimeElapsed", url: "https://x.com/home", elapsedMs: 5000 },
    checkPage("https://x.com/home")
  ]);
});

test("content script checks the page when it is shown again", async () => {
  const page = await runContentScript("https://x.com/home");

  await page.dispatch("pageshow", 0, { persisted: false });
  await page.dispatch("pageshow", 0, { persisted: true });
  await page.setHidden(true);
  await page.setHidden(false);

  assert.deepEqual(page.messages, [
    checkPage("https://x.com/home"),
    checkHistoryPage("https://x.com/home"),
    checkHistoryPage("https://x.com/home")
  ]);
});

test("content script reports Back and Forward loads as history", async () => {
  const page = await runContentScript("https://www.youtube.com/watch?v=b", { referrer: "https://search.example/", navigationType: "back_forward" });

  assert.deepEqual(page.messages, [checkHistoryPage("https://www.youtube.com/watch?v=b")]);
});

test("content script marks short video pages and locks single short videos", async () => {
  const page = await runContentScript("https://www.facebook.com/", {
    checkPageResponses: [
      { type: "allowed", shortVideo: { type: "feed", site: "facebook" } },
      { type: "allowed", shortVideo: { type: "singleVideo", site: "facebook" } },
      { type: "allowed", shortVideo: { type: "none" } }
    ]
  });

  assert.equal(page.documentElement.attributes["data-url-blocker-short-video"], "facebook");
  assert.equal(page.documentElement.attributes["data-url-blocker-path"], "/");
  assert.equal(page.documentElement.attributes["data-url-blocker-single-short-video"], undefined);

  page.location.href = "https://www.facebook.com/reel/123";
  await page.dispatch("currententrychange");

  assert.equal(page.documentElement.attributes["data-url-blocker-path"], "/reel/123");
  assert.equal(page.documentElement.attributes["data-url-blocker-single-short-video"], "true");

  const swallowed = [];
  const event = (key) => ({
    key,
    target: { tagName: "DIV", isContentEditable: false },
    preventDefault() { swallowed.push(`${key}:prevent`); },
    stopImmediatePropagation() { swallowed.push(`${key}:stop`); }
  });

  await page.dispatch("wheel", 0, event("wheel"));
  await page.dispatch("keydown", 0, event("ArrowDown"));
  await page.dispatch("keydown", 0, event("a"));
  await page.dispatch("keydown", 0, { ...event("ArrowUp"), target: { tagName: "TEXTAREA", isContentEditable: false } });
  assert.deepEqual(swallowed, ["wheel:prevent", "wheel:stop", "ArrowDown:prevent", "ArrowDown:stop"]);

  page.location.href = "https://www.example.com/";
  await page.dispatch("currententrychange");

  assert.equal(page.documentElement.attributes["data-url-blocker-short-video"], undefined);
  assert.equal(page.documentElement.attributes["data-url-blocker-path"], undefined);
  assert.equal(page.documentElement.attributes["data-url-blocker-single-short-video"], undefined);
  assert.equal(page.hasListener("wheel"), false);
});

test("content script ignores URL check responses for an earlier URL", async () => {
  let respond;
  const page = await runContentScript("https://www.instagram.com/", {
    checkPageResponses: [
      new Promise((resolve) => { respond = resolve; }),
      { type: "allowed", shortVideo: { type: "feed", site: "instagram" } }
    ]
  });

  page.location.href = "https://www.instagram.com/explore/";
  respond({ type: "allowed", shortVideo: { type: "feed", site: "instagram" } });
  await page.flush();

  assert.equal(page.documentElement.attributes["data-url-blocker-short-video"], undefined);

  await page.dispatch("currententrychange");

  assert.equal(page.documentElement.attributes["data-url-blocker-short-video"], "instagram");
  assert.equal(page.documentElement.attributes["data-url-blocker-path"], "/explore/");
});

test("content script logs elapsed time before changed URLs", async () => {
  const page = await runContentScript("https://x.com");

  page.location.href = "https://x.com/home";
  await page.dispatch("currententrychange", 700);

  assert.deepEqual(page.messages, [
    checkPage("https://x.com"),
    { type: "screenTimeElapsed", url: "https://x.com", elapsedMs: 700 },
    checkPage("https://x.com/home", "https://x.com")
  ]);
});

test("content script logs elapsed time when the page hides", async () => {
  const page = await runContentScript("https://x.com/home");

  await page.setHidden(true, 900);
  await page.tick();

  assert.deepEqual(page.messages, [
    checkPage("https://x.com/home"),
    { type: "screenTimeElapsed", url: "https://x.com/home", elapsedMs: 900 }
  ]);
});

test("content script ignores stale screen time after sleep", async () => {
  const page = await runContentScript("https://x.com/home");

  await page.tick(10 * 60 * 1000);
  await page.tick();

  assert.deepEqual(page.messages, [
    checkPage("https://x.com/home"),
    checkPage("https://x.com/home"),
    { type: "screenTimeElapsed", url: "https://x.com/home", elapsedMs: 5000 },
    checkPage("https://x.com/home")
  ]);
});

test("content script logs plain object message errors with details", async () => {
  const error = { message: "Tab update failed.", code: "TabUpdateTestError" };
  const page = await runContentScript("https://x.com/home", { sendError: error });

  await page.flush();

  assert.deepEqual(page.consoleErrors, [[
    `URL Blocker could not check the current URL. ${JSON.stringify(error)} (TabUpdateTestError)`
  ]]);
});

test("content script falls back to the poll without the Navigation API", async () => {
  const page = await runContentScript("https://x.com", { navigationApi: false });

  page.location.href = "https://x.com/home";
  await page.tick();

  assert.deepEqual(page.messages.at(-1), checkPage("https://x.com/home", "https://x.com"));
  assert.match(page.consoleErrors[0][0], /needs the Navigation API/);
});

async function runContentScript(url, options = {}) {
  const checkPageResponses = [...(options.checkPageResponses || [])];
  const documentElement = {
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    }
  };
  const context = {
    browser: {
      runtime: {
        id: "test-extension",
        async sendMessage(message) {
          context.messages.push(message);

          if (options.sendError) {
            throw options.sendError;
          }

          if (message.type === "checkPage" && checkPageResponses.length > 0) {
            return checkPageResponses.shift();
          }

          return { type: "allowed", shortVideo: { type: "none" } };
        }
      }
    },
    console: {
      error(...args) {
        context.consoleErrors.push(args);
      }
    },
    document: { hidden: false, referrer: options.referrer || "", documentElement },
    performance: {
      getEntriesByType(type) {
        return type === "navigation" ? [{ type: options.navigationType || "navigate" }] : [];
      }
    },
    intervals: [],
    listeners: new Map(),
    URL,
    location: { href: url },
    navigation: options.navigationApi === false ? undefined : {
      addEventListener(type, listener) {
        context.listeners.set(type, listener);
      }
    },
    consoleErrors: [],
    messages: [],
    now: options.now || 0,
    Date: {
      now() {
        return context.now;
      }
    },
    addEventListener(type, listener) {
      context.listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (context.listeners.get(type) === listener) {
        context.listeners.delete(type);
      }
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
    documentElement,
    hasListener(type) {
      return context.listeners.has(type);
    },
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
