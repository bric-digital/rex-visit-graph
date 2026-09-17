/**
 * Resolve a URL's visit ids.
 *
 * `chrome.history.onVisited` hands the listener a `HistoryItem`, which carries no
 * visit id and no referring visit id. Those come only from `getVisits()`, which
 * returns every visit that URL has ever had, so the newest one is the visit that
 * just fired.
 */

export interface HopVisit {
  /** The address the ids were resolved from. */
  url: string;
  visitId: string;
  referringVisitId: string;
  visitTime: number;
  /** Chrome's transition type for the visit, `link` for a click. */
  transition?: string;
}

/**
 * How many visits Chrome holds for a URL, without materialising them.
 *
 * `getVisits()` returns every visit and so costs more the more there are;
 * `search()` returns one row per URL carrying the count. Measured 2026-09-17 on
 * a seeded 440,000-visit URL: 16.5ms against 1075ms, and 0.1ms against 0.1ms on
 * an ordinary one, so asking first is free where it does not matter. The
 * reproduction is `AI-extension-testing/one-off/measure_opener_lookup_cost.mjs`.
 *
 * Returns null when the count cannot be established, which callers read as "no
 * answer" rather than as zero.
 */
export async function visitCount(url: string): Promise<number | null> {
  try {
    const items = await chrome.history.search({ text: url, maxResults: 10 })
    const match = items.find((item) => item.url === url)

    return match?.visitCount ?? null
  } catch (error) {
    console.warn('[rex-visit-graph] visit count lookup failed:', error)
    return null
  }
}

/** Holds no state, so a function rather than a class. */
export async function newestVisit(url: string): Promise<HopVisit | null> {
  try {
    const visits = await chrome.history.getVisits({ url })
    let newest = visits[0]

    if (newest === undefined) {
      return null
    }

    for (const visit of visits) {
      if ((visit.visitTime ?? 0) > (newest.visitTime ?? 0)) {
        newest = visit
      }
    }

    return {
      url,
      visitId: newest.visitId,
      referringVisitId: newest.referringVisitId,
      visitTime: newest.visitTime ?? Date.now(),
      transition: newest.transition
    }
  } catch (error) {
    // This runs inside an onVisited handler, where an unhandled rejection is
    // invisible. Report the miss instead of throwing.
    console.warn('[rex-visit-graph] getVisits failed:', error)
    return null
  }
}
