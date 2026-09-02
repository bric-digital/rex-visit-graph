# rex-visit-graph

REX module that records the browser's visit graph, including the visits `chrome.history.search()` omits, so referral chains resolve.

**Current release: `v1.0.0`.** Pin it:

```json
"@bric/rex-visit-graph": "github:bric-digital/rex-visit-graph#v1.0.0"
```

`package.json` on `main` carries a `-dev` version between releases (`1.0.1-dev` means past 1.0.0, not yet 1.0.1), so the repo never names a release that was not cut. Releases and what the numbers mean: [RELEASING.md](RELEASING.md). 

If your study needs to document which pages referred the browser to a target page, you may need this module. 

## Overview

Chrome stores redirect intermediates but keeps them out of history search results. A collector that enumerates with `chrome.history.search()` therefore never sees them, while the landing page it does collect still points at one through `referringVisitId`. That id belongs to no exported row, so the chain from a click back to the search that produced it terminates, and the visit cannot be attributed to the search.

`chrome.history.onVisited` does fire for those visits, which is the only way to learn they happened. **rex-visit-graph** listens and emits their ids. It:

- Watches every visit the browser reports and captures the whole graph by default
- Resolves each one's visit id and referring visit id via `chrome.history.getVisits()`
- Emits them as `rex-visit-graph-hop` points on its own schedule
- Sends ids only by default, and discards the address once the ids are resolved, so it holds no addresses at all and depends on no other module

**Capture rules narrow, they do not enable.** With none configured every visit on a configured scheme is captured; `schemes` decides which those are. A study that wants less states rules to reduce it. That way a redirector nobody has seen yet is captured anyway, instead of going silently uncollected until somebody notices the data is missing — which is the failure this module exists to end.

Analysis joins on `visit_id`: the landing page's `referring_visit_id` resolves to a held row, and that row's own referrer reaches the search page with its query intact.

Measured against Google on 2026-09-01: twelve organic results across four queries all routed through `google.com/goto`, and none of the twelve click-throughs could be tied back to its search in the uploaded data. A Google ad click routed through `google.com/aclk` with the same result.

## How it works

Four small files, each with one job. The whole module is about 300 lines.

| File | Responsibility |
|------|----------------|
| `capture-rules.mts` | Decides whether a visited URL is one we want. Pure logic, no Chrome APIs. |
| `visit-lookup.mts` | Turns a URL into its visit ids via `chrome.history.getVisits()`. |
| `hop-store.mts` | Holds captured hops in `chrome.storage.local` until they can be emitted. |
| `service-worker.mts` | The REX module itself: listeners, configuration, drain, message handling. |

### The path a hop takes

1. **A visit happens.** `chrome.history.onVisited` fires for *every* visit, including the redirect intermediates `search()` hides. The listener is registered at module scope (see Design notes) and does nothing but hand the item to the module.
2. **Is it interesting?** `CaptureRules.match()` compares the URL against the configured rules. Host must match exactly or be a true subdomain; path must start with the prefix. No match, nothing happens — the overwhelmingly common case.
3. **Resolve its ids.** The `HistoryItem` `onVisited` provides carries *no* visit id and no referrer, so `VisitLookup.newestVisit()` calls `chrome.history.getVisits({url})` and takes the newest visit. This is the step that yields `visitId` and `referringVisitId`.
4. **Store it.** `HopStore.record()` writes one record under `rexVisitGraphHop:<visitId>`. Nothing is emitted yet: points must not be dispatched before configuration exists, and the visit may have happened before configuration loaded.
5. **Drain**, when the host sends `triggerVisitGraphDrain`: sweep anything past `max_hop_age_days`, dispatch one `rex-visit-graph-hop` point per remaining record, then delete them. Any address kept under `url_detail` is redacted first.
6. **Analysis joins.** The landing page's `referring_visit_id` now names a row that exists, and that row's own referrer reaches the SERP.

### Why capture and emission are separated

They answer to different constraints, and collapsing them would break one or the other.

**Capture cannot wait.** `onVisited` is the only way to learn a redirect intermediate's URL, and it fires once. A hop missed because configuration had not loaded is unrecoverable. So the listener runs from the first turn of the worker script with the default rules already seeded.

**Emission must wait.** Points may not be dispatched before configuration is available, and a disabled module must emit nothing at all. So the decision to send is deferred to drain time, where the configuration is known.

The store between them is what lets both be true.

## Configuration

This module reads from the `visit_graph` section of the backend config. Every field has a default, so the module works before the server knows about it — a study needs no `visit_graph` block at all unless it wants to narrow capture, emit URLs, or turn the module off.

The module also declares this shape in code, via `configurationDetails()` in `src/service-worker.mts`. A test asserts that declaration covers every setting the module actually reads, so it cannot fall behind the code the way a README can. Nothing in rex-core consumes `configurationDetails()` today — it is a self-description convention, and this is the copy to trust if the table below ever disagrees with it.

### Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | No | `true` | Enable/disable the module; see below |
| `capture_rules` | array | No | `[]` (capture everything) | Optional narrowing filter; see below |
| `schemes` | array | No | `["http", "https"]` | Schemes to capture, without the colon, matched case-insensitively. Name others (`file`, `ftp`, `webdav`) to opt into them |
| `url_detail` | string | No | `"none"` | `"none"`, `"path"` or `"full"`; how much of the address to keep. See below |
| `debug` | boolean | No | `false` | Forces `url_detail` to `"full"` in any build, for diagnosing a deployment |
| `redaction` | object | No | - | `allow_lists`, `filter_lists`, `domain_only_lists`; used only when rex-history states none |
| `max_hop_age_days` | number | No | `7` | Age after which an un-emitted hop is discarded |

Each entry in `capture_rules` is an object:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Stable label emitted with each hop, so rules can be told apart |
| `host_suffix` | string | Yes | Matches this host exactly or a true subdomain, case-insensitively, never a lookalike such as `notgoogle.com`. `*` matches any host |
| `path_prefix` | string | Yes | Matches when the path starts with this string |

Rules are a narrowing filter and are server-side because a study's appetite changes without a Web Store release. Leaving them empty is the safe choice: it cannot miss a redirector. Stating them reduces volume at the cost of only capturing what you named — and the paths do change, so a rule list is a maintenance commitment. `/goto` and `/aclk` were both observed on Google within one day.

### Address detail

`url_detail` decides how much of a captured address the module keeps. Whatever it keeps is what it stores: the module never holds more of an address than it is configured to emit.

| Value | Kept and emitted | Answers |
|-------|------------------|---------|
| `"none"` (default) | nothing; the address is discarded once the visit ids are resolved | where the path went, via the join to rex-history |
| `"path"` | origin and pathname, no query | **what the intermediate was** — `google.com/goto` versus `google.com/aclk`, an organic click versus an ad — without the destination a redirector encodes in its query |
| `"full"` | the whole address | everything, including that encoded destination |

`"path"` exists because ids alone cannot say what kind of transition a hop was. Under narrowed capture the `capture_rule` field answers that; capturing the whole graph, every hop is `all` and the character of the transition is lost. `"path"` restores it at a fraction of the cost of `"full"`.

`debug: true` forces `"full"` in **any** build, because diagnosing a real deployment is exactly when full addresses are needed. It logs a warning while it is on, so a configuration left in that state is visible rather than silent.

### Redaction, when an address is kept

With ids alone there is nothing to redact, which is why the module needs no lists at its default setting. Any address it does keep is redacted before it is emitted.

**Settings resolve to rex-history's if it states any**, so a study that has already decided what may be recorded does not state it twice and the two modules cannot disagree. `visit_graph.redaction` applies only when rex-history states nothing, which is the case for a study running this module without rex-history.

Rules and precedence match rex-history exactly, and the branches are exclusive:

| Order | Condition | Recorded as |
|-------|-----------|-------------|
| 1 | matches a `domain_only_lists` entry | `DOMAIN ONLY` |
| 2 | `allow_lists` configured and nothing matches | `CATEGORY:NOT_ON_ALLOWLIST` |
| 3 | matches a `filter_lists` entry | `CATEGORY:<category>` |
| 4 | otherwise | the URL, unchanged |

List **contents** are not synced here. Matching reads whatever rex-lists holds in IndexedDB, populated by whichever module owns the sync. An empty database means a configured allow-list matches nothing and everything redacts, so the failure direction is closed rather than open.

One caveat to weigh before enabling it: a Google hop's own host is `google.com`, so these rules ask whether Google is allowed, not whether the destination is. The `?url=…` blob encodes where the click went, so a destination that rex-history redacted can still be reconstructed from an emitted hop URL. Redacting the destination itself would mean decoding that blob, which is undocumented and changes without notice.

### Example

```json
{
  "visit_graph": {
    "enabled": true,
    "capture_rules": [
      { "id": "google-aclk", "host_suffix": "google.com", "path_prefix": "/aclk" },
      { "id": "google-goto", "host_suffix": "google.com", "path_prefix": "/goto" },
      { "id": "google-url", "host_suffix": "google.com", "path_prefix": "/url" }
    ],
    "schemes": ["http", "https"],
    "url_detail": "none",
    "debug": false,
    "max_hop_age_days": 7
  }
}
```

## Emitted data

One `rex-visit-graph-hop` point per captured visit:

```json
{
  "visit_id": "5",
  "referring_visit_id": "4",
  "visit_time": 1788218626270,
  "capture_rule": "google-goto",
  "date": 1788218626270
}
```

No URL, title or domain: nothing about where the participant went, only that one visit led to another.

**A new tab breaks the chain, and this module cannot mend it.** Chrome records no referring visit across a tab boundary: a `target="_blank"` link or a `window.open()` produces `referring_visit_id: "0"`, not a dangling id. Measured on Chrome 152 — same-tab link linked correctly, both new-tab forms did not, and `transition` read `link` for all three so it does not distinguish them either.

That is a different defect from the one this module addresses. A redirect hop leaves a referrer pointing at a visit Chrome hid but still holds; a new tab leaves no referrer at all, and there is nothing for `onVisited` to capture. For analysis it is worse in one way: `referring_visit_id: "0"` is indistinguishable from a typed address or a bookmark, so a new-tab click does not look broken, it looks like arrival from nowhere.

Recovering it needs `chrome.tabs.onCreated`, whose `openerTabId` carries the relationship. That is a separate capability, not an extension of this one.

**The join is exact within one profile's history, and only there.** `visit_id` is a row id in Chrome's history database for that profile, so it is unique across that profile's continuous history and means nothing outside it. A participant with a second computer, or a fresh profile, produces a second id space that starts over at low numbers — so ids from the two will collide and a naive join attaches the wrong URL to the wrong edge, silently.

Partition by install before joining, using the same user-agent comparison rex-history's own `referring_visit_id` already requires. This is not a property of this module: it is how Chrome numbers visits, and it applies identically to walking rex-history's edges on their own.

Note that reinstalling the *extension* on the same profile does not renumber anything — the history database belongs to the browser profile, not to the extension — so an install-time or extension-issued key would over-partition rather than help.

Two further properties analysis should know about:

- **The series starts at install.** `onVisited` sees only live visits, so hops from before the module ships are unrecoverable and a backfill keeps its dangling references.
- **A hop may arrive twice.** The drain emits before deleting, so a worker killed between the two re-emits next cycle. Deduplicate on `visit_id`.

## Installation

Add to your extension's `package.json` dependencies:

```json
{
  "dependencies": {
    "@bric/rex-visit-graph": "github:bric-digital/rex-visit-graph#main"
  }
}
```

Then run `npm install`, and import the module for its side effects in your service worker:

```ts
import '@bric/rex-visit-graph/service-worker'
```

No new permission is required: `chrome.history.onVisited` is covered by `history`.

## Messages

| Message | Response | Purpose |
|---------|----------|---------|
| `triggerVisitGraphDrain` | number of hops emitted | Emit stored hops now instead of waiting for the alarm, so a host extension can drain on its own cadence |

## Module Context Exports

- `./service-worker` - Service worker context

There is no extension or browser context. The module has no UI and injects nothing into pages.

## Module conventions

It is an ordinary REX service-worker module and does nothing bespoke.

| Convention | How this module meets it |
|------------|--------------------------|
| Extends `REXServiceWorkerModule` from `@bric/rex-core` | `VisitGraphServiceWorkerModule` |
| Registers itself at import | `registerREXModule(plugin)` at module scope; consumers `import` for side effects |
| `setup()` for one-time wiring | Subscribes to configuration changes, then loads configuration |
| `refreshConfiguration()` as the activation hook | Re-reads `visit_graph`, updates rules, redactor and alarm |
| `handleMessage()` returning a boolean | Claims `triggerVisitGraphDrain`, returns `false` for everything else so other modules see it |
| `moduleName()` | Returns `VisitGraph` |
| `configurationDetails()` | Self-describes every setting, as rex-page-manipulation does. Nothing consumes it yet; a test asserts it covers every setting actually read, so it cannot drift |
| Emits through `dispatchEvent` | One `rex-visit-graph-hop` point per hop; PDK picks it up with no server change |
| Configuration under its own key | `REXConfiguration.visit_graph`, defaults for every field |
| Publishes `.mts` source | Consumers compile it with their own toolchain; toolchain is in `devDependencies` so they do not install it |
| No functionality duplicated from rex-core | Configuration read via `rexCorePlugin.fetchConfiguration()`, never `chrome.storage` directly |

Two conventions it deliberately does **not** follow, both because it has no UI:

- No `./extension` or `./browser` export. The `exports` map has only `./service-worker`.
- No `activateInterface()`. There is no interface to activate.

## Design notes

- **Capture never waits; emission always does.** A hop not captured while it happens is unrecoverable, so the listener runs before configuration exists and with the default rules already seeded. Points are dispatched only at drain, after configuration is available.
- **One storage key per hop.** A single shared array lets concurrent handlers overwrite each other, which presents as the listener never firing.
- **Emit, then forget.** A worker killed between the two re-emits next cycle; the other order loses the hop. Duplicates are recoverable in analysis, losses are not.
- **`enabled: false` stops everything, not just capture.** No rules match, no drain alarm is scheduled, `drain()` refuses even when a host calls `triggerVisitGraphDrain` on its own cadence, and anything captured in the window before configuration arrived is discarded rather than held against a later re-enable.
- **A study that narrows gets only what it asked for.** Until configuration arrives the module has no rules and captures everything under `all`. When configuration then narrows capture, those provisional hops are discarded rather than emitted: they cannot be re-tested against the arriving rules, because the address they would be tested on was dropped at capture. The window is small, since configuration is read from rex-core's cache within milliseconds of worker start.
- **The module owns no alarm.** The host extension decides what runs when and drives draining with `triggerVisitGraphDrain`. A module scheduling itself would be invisible in the host's accounting of its own schedule. A host that never asks will accumulate hops until `max_hop_age_days` discards them.
- **Configuration is applied by a synchronous `updateConfiguration()`.** `refreshConfiguration()` fetches from rex-core and hands over this module's section; `updateConfiguration()` assigns and returns. So a host or a test can configure the module directly, with no server round trip to fake.
- **A disabled module holds no listener.** Listening follows the `enabled` flag: the listener is added when enabled and removed when disabled, rather than kept and made to decline. `setup()` starts listening before it fetches configuration, because the module defaults to enabled and `onVisited` fires once — a visit missed while the fetch is in flight is unrecoverable — and configuration then takes the listener away again if the study has the module off.
- **The in-progress guard is in memory, never persisted**, so a killed worker cannot strand it and wedge every later drain.

## Tests

```
npm install
npm test
```

Loads the module as a real Chrome extension with real `chrome.history`, `chrome.storage` and `chrome.alarms`. Headless is off because Chrome's CDP bridge does not expose extension service workers in headless mode; wrap in Xvfb on Linux CI.

`npm test` runs the `pretest` bundler. `npx playwright test` skips it and runs whatever bundle is already on disk.

## License

Apache 2.0
