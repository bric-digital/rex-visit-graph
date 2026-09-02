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
      visitTime: newest.visitTime ?? Date.now()
    }
  } catch (error) {
    // This runs inside an onVisited handler, where an unhandled rejection is
    // invisible. Report the miss instead of throwing.
    console.warn('[rex-visit-graph] getVisits failed:', error)
    return null
  }
}
