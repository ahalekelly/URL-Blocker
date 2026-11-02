# Simplifying the blocking logic — 2026-11-02 00:10

Proposal only; nothing has changed yet. Combines my review with an independent GPT Astra design pass. We reached the same core conclusion independently.

## Where the complexity is now

About 19 groups of inputs feed a block decision. Most are essential: entries and their matching, aliases, the schedule, the hard schedule, limits and limit groups, reset windows, synced usage, the settings delay, and short-video handling.

The parts that look accidental all concern **how you got to a page**:

- **Five arrival types** run through the policy code: content-script document, Safari document, Chromium committed transition, block page, and unknown. Each has its own rules for reloads and empty versus unknown referrers.
- **A 30-day referrer log, keyed by URL**, rebuilds where you came from on reloads and Back/Forward. "Newest record wins", so it can borrow another tab's arrival.
- **Two per-site toggles**, "Block all pages except via links" and "Block links within this site" (`blockDirectVisits` and `blockInternalLinks` in code). Their combinations, times the arrival types, produce seven block reasons and seven block-page texts.
- **The entry type also sets policy.** A bare-domain "URL" entry turns on arrival rules for the whole site; an exact "URL" match means "feed"; other entry types mean "leave open".
- **Six check points** each apply a different subset of the rules: navigation start, Chromium commit, the content script's page check, the 5-second recheck, the sweep after a settings change, and the block page.
- **Page identity** ("everything before the first `&` or `#`") is copied in two files.

## Proposed model

### 1. Each page gets one of four policies, derived from the existing entries

| Policy | Comes from | Meaning while restricted |
|---|---|---|
| Feed | exact "URL" entry match | always blocked, including open pages |
| No new visits | full-domain, URL-and-subpaths, and regex matches (e.g. netflix.com) | can't be opened; an open page stays open |
| Outside links only | other pages on a bare-domain "URL" entry's site | opens only from an outside link; an open page stays open |
| Unrestricted | nothing matches | allowed |

### 2. One decision table, used by every check point

"Restricted" means the regular schedule applies, or the site or group is over its limit.

| First condition that applies | Result |
|---|---|
| Hard schedule applies to the site | Block |
| Not restricted, or the page is unrestricted | Allow (the tab gets a pass for the page) |
| Page is a feed | Block |
| The tab already holds a pass for this page | Allow |
| "No new visits" page | Block |
| "Outside links only" page | Allow if you arrived from an outside link (the tab gets a pass); otherwise block |

### 3. State describes the current page, not its history

- The background script keeps **one pass per tab** in session storage: the page the tab may stay on. It survives service-worker restarts and is cleared when the tab closes or moves to another page.
- That pass replaces the referrer log, the reload special cases, the open-page rules, and the URL-change versus recheck split.
- Each browser turns its own evidence into one yes/no: "arrived from an outside link". The Chromium transition rules and the Safari empty-referrer rule stay, but only inside that adapter.
- The content script just reports the page and its referrer.

### 4. Remove the two toggles

Both are always on: pages on the site open only from links on other sites. Block reasons shrink from seven to three: hard schedule, schedule, limit.

Short-video handling, limit groups, reset windows, aliases, and custom entries stay as they are. Android keeps checking whole apps, which have no page identity.

## What changes for you

- **Reload gets more lenient.** A page you opened before the limit can be reloaded afterward. That includes a Netflix page, which a reload can block today.
- **Back/Forward gets stricter.** Going back to a page you once reached from an outside link no longer uses the saved arrival. While restricted, it may block. This is the main usability cost, and also the source of most of the simplification.
- **Restored tabs lose their pass.** After a browser restart, a restored tab on a restricted site is judged as a new visit.
- **The toggles disappear.** This only matters if you turn one off for some site.
- **Some redirects happen slightly later.** A "no new visits" page can't be blocked at navigation start, because the extension first has to know whether it's a reload of a page the tab holds a pass for. Hard-schedule and feed blocks still happen at navigation start.
- **External-link detection stays as good as it is now, no better.** Some chat apps strip referrers, and Chromium and Safari still differ there.

## Size and order

A medium refactor that removes roughly a few hundred lines of production code, mostly in `content.js`, the navigation handling in `background.js`, and the arrival-dependent part of `blocker.js`.

Build it in layers, testing in Brave and Safari after each:

1. Add the four page policies and the decision table, with no behavior change.
2. Replace the referrer log and arrival types with the per-tab pass, and test the reload and Back/Forward changes.
3. Remove the two toggles and the extra block reasons, with a settings version bump.

## Decisions needed

1. Do you ever turn off "Block all pages except via links" or "Block links within this site"?
2. Is the Back/Forward cost acceptable, given that the reload behavior gets more lenient in exchange?
