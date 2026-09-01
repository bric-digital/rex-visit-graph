# rex-visit-graph

Captures the browser visits `chrome.history.search()` does not return, so referrer
chains resolve.

## Why

Chrome stores redirect intermediates but keeps them out of history search results.
A collector that enumerates with `search()` therefore never sees them, while the
landing page it does collect still points at one through `referringVisitId`. That
id belongs to no exported row, so the chain from a click back to the search that
produced it terminates, and the visit cannot be attributed to the search.

Measured on 2026-09-01 against Google: twelve organic results across four queries
all routed through `google.com/goto`, and none of the twelve click-throughs could
be tied back to its search in the uploaded data. A Google ad click routed through
`google.com/aclk` with the same result.

`chrome.history.onVisited` does fire for those visits, which is the only way to
learn the URL. This module listens, keeps the ids, and emits them.

## What it emits

One `rex-visit-graph-hop` point per captured visit:

```json
{
  "visit_id": "5",
  "referring_visit_id": "4",
  "visit_time": 1788218626270,
  "capture_rule": "google-goto"
}
```

Analysis joins on `visit_id`: the landing page's `referring_visit_id` now resolves
to a held row, and that row's own referrer reaches the search page with its query
intact.

**No URL by default.** The chain closes on ids alone, so the URL is not needed
downstream. Leaving it out means the module has nothing to redact and therefore
depends on no other module, and it cannot reproduce a destination that history
redaction removed — the `?url=…` blob in a Google hop is an encoded form of where
the click went. Set `include_url` to emit it, and read the note below first.

## Configuration

Under `REXConfiguration.visit_graph`. Every field has a default, so the module
works before the server knows about it.

```json
{
  "enabled": true,
  "capture_rules": [
    { "id": "google-aclk", "host_suffix": "google.com", "path_prefix": "/aclk" },
    { "id": "google-goto", "host_suffix": "google.com", "path_prefix": "/goto" },
    { "id": "google-url",  "host_suffix": "google.com", "path_prefix": "/url" }
  ],
  "include_url": false,
  "drain_interval_minutes": 15,
  "max_hop_age_days": 7
}
```

Rules are server-side because the paths change: `/goto` and `/aclk` were both
observed in one day, and a build shipping only one of them would have captured
nothing. `host_suffix` matches the host or a true subdomain, never a lookalike
like `notgoogle.com`.

`include_url` is not yet safe to turn on. The open question is which URL to emit
and what to redact it against: the hop's own host is `google.com`, but the part
that matters is the destination encoded inside it, so redacting the hop as written
checks the wrong thing. See `docs/rex-module-contracts.md` in the umbrella repo.

## Design notes

- **Capture never waits; emission always does.** A hop not captured while it
  happens is unrecoverable, so the listener runs before configuration exists and
  with Google's shapes already seeded. Points are only dispatched at drain.
- **Listeners register at module scope, in the worker script's first turn.** A
  `chrome.history` or `chrome.alarms` listener added after a top-level `await` is
  too late to wake an evicted MV3 worker. A spec asserts this at the source,
  because the failure only appears on a cold start in the field.
- **One storage key per hop.** A single shared array lets concurrent handlers
  overwrite each other, which presents as the listener never firing.
- **Emit, then forget.** A worker killed between the two re-emits next cycle; the
  other order loses the hop. Duplicates are recoverable in analysis, losses are not.
- **The in-progress guard is in memory, never persisted**, so a killed worker
  cannot strand it and wedge every later drain.
- No new permission: `chrome.history.onVisited` is covered by `history`.

## Tests

```
npm install --allow-git=all
npm test
```

Loads the module as a real Chrome extension with real `chrome.history`,
`chrome.storage` and `chrome.alarms`. Headless is off because Chrome's CDP bridge
does not expose extension service workers in headless mode; wrap in Xvfb on Linux
CI.

`npm test` runs the `pretest` bundler. `npx playwright test` skips it and runs
whatever bundle is on disk, which can be days old.
