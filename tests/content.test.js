const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const contentScript = fs.readFileSync(path.join(__dirname, "../URLBlockerWebExtension/content.js"), "utf8");

function checkPage(url, referrer = "") {
  return { type: "checkPage", url, arrival: { type: "referrer", url: referrer } };
}

test("content script counts a replace from one single short video to another as a hop inside the site", async () => {
  const singleVideo = { type: "allowed", shortVideo: { type: "singleVideo", site: "facebook" } };
  const page = await runContentScript("https://www.facebook.com/reel/123", {
    referrer: "https://news.example/",
    checkPageResponses: [singleVideo, singleVideo]
  });

  page.location.href = "https://www.facebook.com/reel/123/?s=share";
  await page.dispatch("currententrychange", { navigationType: "replace" });
  page.location.href = "https://www.facebook.com/reel/456";
  await page.dispatch("currententrychange", { navigationType: "replace" });

  assert.deepEqual(page.messages, [
    checkPage("https://www.facebook.com/reel/123", "https://news.example/"),
    checkPage("https://www.facebook.com/reel/123/?s=share", "https://news.example/"),
    checkPage("https://www.facebook.com/reel/456", "https://www.facebook.com/reel/123/?s=share")
  ]);
});

test("content script marks short video pages and locks single short videos", async () => {
  const page = await runContentScript("https://www.facebook.com/", {
    checkPageResponses: [
      { type: "allowed", shortVideo: { type: "sitePage", site: "facebook" } },
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

  await page.dispatch("wheel", event("wheel"));
  await page.dispatch("keydown", event("ArrowDown"));
  await page.dispatch("keydown", event("a"));
  await page.dispatch("keydown", { ...event("ArrowUp"), target: { tagName: "TEXTAREA", isContentEditable: false } });
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
      { type: "allowed", shortVideo: { type: "sitePage", site: "instagram" } }
    ]
  });

  page.location.href = "https://www.instagram.com/explore/";
  respond({ type: "allowed", shortVideo: { type: "sitePage", site: "instagram" } });
  await page.flush();

  assert.equal(page.documentElement.attributes["data-url-blocker-short-video"], undefined);

  await page.dispatch("currententrychange");

  assert.equal(page.documentElement.attributes["data-url-blocker-short-video"], "instagram");
  assert.equal(page.documentElement.attributes["data-url-blocker-path"], "/explore/");
});

test("content script logs plain object message errors with details", async () => {
  const error = { message: "Tab update failed.", code: "TabUpdateTestError" };
  const page = await runContentScript("https://x.com/home", { sendError: error });

  await page.flush();

  assert.deepEqual(page.consoleErrors, [[
    `URL Blocker could not check the current URL. ${JSON.stringify(error)} (TabUpdateTestError)`
  ]]);
});

async function runContentScript(url, options = {}) {
  const checkPageResponses = [...(options.checkPageResponses || [])];
  const documentElement = {
    attributes: {},
    children: [],
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    append(child) {
      this.children.push(child);
    }
  };
  const pausedMedia = [];
  const context = {
    browser: {
      runtime: {
        id: "test-extension",
        async sendMessage(message) {
          context.messages.push(message);

          if (options.silent?.()) {
            return new Promise(() => {});
          }

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
    document: {
      hidden: false,
      prerendering: false,
      referrer: options.referrer || "",
      addEventListener(type, listener) {
        context.listeners.set(type, listener);
      },
      documentElement,
      createElement() {
        const element = {
          attributes: {},
          setAttribute(name, value) {
            this.attributes[name] = value;
          },
          remove() {
            documentElement.children = documentElement.children.filter((child) => child !== element);
          }
        };

        return element;
      },
      getElementById(id) {
        return documentElement.children.find((child) => child.id === id) || null;
      },
      querySelectorAll(selector) {
        return selector === "video, audio" ? [{ pause: () => pausedMedia.push("video") }] : [];
      }
    },
    performance: {
      getEntriesByType(type) {
        return type === "navigation" ? [{ type: "navigate" }] : [];
      }
    },
    intervals: [],
    listeners: new Map(),
    URL,
    location: { href: url },
    navigation: {
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
    pausedMedia,
    get coverText() {
      return context.document.getElementById("url-blocker-cover")?.textContent;
    },
    hasListener(type) {
      return context.listeners.has(type);
    },
    async dispatch(type, event = {}) {
      context.listeners.get(type)(event);
      await flush();
    },
    async setHidden(hidden) {
      context.document.hidden = hidden;
      await this.dispatch("visibilitychange");
    },
    async flush() {
      await flush();
    },
    async tick() {
      context.now += context.intervals[0].delay;
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

test("content script covers the page after two polls without a reply and reports the silence once answered", async () => {
  let silent = false;
  const page = await runContentScript("https://x.com/home", { now: 1000, silent: () => silent });

  silent = true;
  await page.tick();
  await page.tick();
  assert.equal(page.coverText, undefined);

  await page.tick();
  assert.match(page.coverText, /isn't responding/);
  assert.deepEqual(page.pausedMedia, ["video"]);

  silent = false;
  await page.tick();

  assert.equal(page.coverText, undefined);
  assert.deepEqual(page.messages.at(-1), { type: "reportSilence", url: "https://x.com/home", sinceMs: 6000 });
});

test("content script covers the page while checks keep failing and shows the error", async () => {
  const failure = { type: "error", error: "Native storage did not answer.", errorCode: "NativeTimeout" };
  const page = await runContentScript("https://x.com/home", { now: 1000, checkPageResponses: [failure, failure, failure] });

  await page.tick();
  assert.equal(page.coverText, undefined);

  await page.tick();
  assert.match(page.coverText, /can't check this page: Native storage did not answer\./);

  await page.tick();
  assert.equal(page.coverText, undefined);
  assert.deepEqual(page.messages.at(-1), { type: "reportSilence", url: "https://x.com/home", sinceMs: 1000 });
});

test("content script does not cover the page for a slow reply", async () => {
  let respond;
  const page = await runContentScript("https://x.com/home", {
    checkPageResponses: [new Promise((resolve) => { respond = resolve; })]
  });

  await page.tick();
  respond({ type: "allowed", shortVideo: { type: "none" } });
  await page.tick();
  await page.tick();

  assert.equal(page.coverText, undefined);
  assert.equal(page.messages.some((message) => message.type === "reportSilence"), false);
});

test("content script restarts the silent poll count when a hidden page is shown again", async () => {
  const page = await runContentScript("https://x.com/home", { silent: () => true });

  await page.tick();
  await page.setHidden(true);
  await page.setHidden(false);
  await page.tick();
  assert.equal(page.coverText, undefined);

  await page.tick();
  assert.match(page.coverText, /isn't responding/);
});
