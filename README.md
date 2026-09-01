# rex-visit-graph

REX module that captures the browser visits `chrome.history.search()` omits, so referral chains resolve.

## Overview

Chrome stores redirect intermediates but keeps them out of history search results. A collector that enumerates with `chrome.history.search()` therefore never sees them, while the landing page it does collect still points at one through `referringVisitId`. That id belongs to no exported row, so the chain from a click back to the search that produced it terminates, and the visit cannot be attributed to the search.

`chrome.history.onVisited` does fire for those visits, which is the only way to learn the URL. **rex-visit-graph** listens for them and emits their ids. It:

- Watches every visit and keeps the ones matching a server-configured rule
- Resolves each one's visit id and referring visit id via `chrome.history.getVisits()`
- Emits them as `rex-visit-graph-hop` points on its own schedule
- Sends ids only by default, so it holds no addresses and depends on no other module

Analysis joins on `visit_id`: the landing page's `referring_visit_id` resolves to a held row, and that row's own referrer reaches the search page with its query intact.

Measured against Google on 2026-09-01: twelve organic results across four queries all routed through `google.com/goto`, and none of the twelve click-throughs could be tied back to its search in the uploaded data. A Google ad click routed through `google.com/aclk` with the same result.

## Configuration

This module reads from the `visit_graph` section of the backend config. Every field has a default, so the module works before the server knows about it.

### Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | No | `true` | Enable/disable the module; see below |
| `capture_rules` | array | No | Google `/aclk`, `/goto`, `/url` | Which visits to keep; see below |
| `include_url` | boolean | No | `false` | Emit the captured URL as well as the ids; see Redaction below |
| `redaction` | object | No | - | `allow_lists`, `filter_lists`, `domain_only_lists`; used only when rex-history states none |
| `drain_interval_minutes` | number | No | `15` | How often stored hops are emitted (Chrome clamps to 1 minute) |
| `max_hop_age_days` | number | No | `7` | Age after which an un-emitted hop is discarded |

Each entry in `capture_rules` is an object:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Stable label emitted with each hop, so rules can be told apart |
| `host_suffix` | string | Yes | Matches this host exactly or a true subdomain, never a lookalike such as `notgoogle.com` |
| `path_prefix` | string | Yes | Matches when the path starts with this string |

Rules are server-side because the paths change: `/goto` and `/aclk` were both observed in one day, and a build shipping only one of them would have captured nothing.

### Redaction, when `include_url` is on

With ids alone there is nothing to redact, which is why the module needs no lists by default. Turning `include_url` on brings the captured URL into the emitted point, and it is redacted first.

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
    "include_url": false,
    "drain_interval_minutes": 15,
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

Two properties analysis should know about:

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

## Design notes

- **Capture never waits; emission always does.** A hop not captured while it happens is unrecoverable, so the listener runs before configuration exists and with the default rules already seeded. Points are dispatched only at drain, after configuration is available.
- **Listeners register at module scope, in the worker script's first turn.** A `chrome.history` or `chrome.alarms` listener added after a top-level `await` is registered too late to wake an evicted MV3 worker. A spec asserts this against the source, because the failure appears only on a cold start in the field.
- **One storage key per hop.** A single shared array lets concurrent handlers overwrite each other, which presents as the listener never firing.
- **Emit, then forget.** A worker killed between the two re-emits next cycle; the other order loses the hop. Duplicates are recoverable in analysis, losses are not.
- **`enabled: false` stops everything, not just capture.** No rules match, no drain alarm is scheduled, `drain()` refuses even when a host calls `triggerVisitGraphDrain` on its own cadence, and anything captured in the window before configuration arrived is discarded rather than held against a later re-enable.
- **A correctly scheduled drain alarm is left alone.** A host extension may refresh configuration far more often than the drain interval; re-creating the alarm each time restarts its countdown, and a drain scheduled further out than the refresh cadence would never fire.
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
