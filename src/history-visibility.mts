/**
 * Whether rex-history's collector can already see a visit.
 *
 * The collector enumerates with `chrome.history.search()`, and Chrome omits
 * redirect intermediates from query results while still storing their visit
 * rows. That is the whole reason this module exists: the hop is in
 * `getVisits()` and missing from `search()`, so the landing page's referrer
 * points at a visit nobody exports.
 *
 * Turned around, it is also a test. A visit `search()` returns is one
 * rex-history will collect, ids included, so capturing it here would duplicate a
 * record we already send and cost a `getVisits()` call to do it. A visit
 * `search()` does not return is one that would otherwise go uncollected.
 *
 * Measured 2026-09-09 on a seeded profile: a bounded `search()` costs under a
 * millisecond against ~935ms for `getVisits()` on a 400,000-visit URL, and it
 * omits the hop for both server (302) and client (`location.replace`)
 * redirects while returning the landing page in the same window. See
 * `plans/rex-visit-graph/2026-09-09-hops-only-capture-scope.md`.
 */

/**
 * Half-width of the window used to look for the visit, in milliseconds.
 *
 * The visit being asked about happened moments ago, so this only has to be wide
 * enough to absorb the gap between Chrome recording it and the worker running.
 */
const DEFAULT_TOLERANCE_MS = 1000

/**
 * True when `search()` returns this URL around this time.
 *
 * Errs toward false, meaning capture. The two failure directions are not
 * symmetric: a wrong `false` writes a duplicate row that analysis can drop on
 * `visit_id`, while a wrong `true` silently discards a hop forever, since
 * `onVisited` only ever sees live visits and no backfill can recover one. So a
 * lookup that throws reports "not visible" and the visit is captured.
 */
export async function collectorCanSee(
  url: string,
  at: number,
  toleranceMs: number = DEFAULT_TOLERANCE_MS
): Promise<boolean> {
  try {
    const items = await chrome.history.search({
      text: '',
      startTime: at - toleranceMs,
      endTime: at + toleranceMs,
      maxResults: 100
    })

    return items.some((item) => item.url === url)
  } catch (error) {
    // Runs inside an onVisited handler, where an unhandled rejection is
    // invisible. Report the miss instead of throwing.
    console.warn('[rex-visit-graph] history.search failed, treating the visit as uncollected:', error)
    return false
  }
}
