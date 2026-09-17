/**
 * Attributes a new tab's first visit to the page that opened it.
 *
 * Chrome records no referring visit across a tab boundary: a link opened with a
 * middle click, a modifier click, `target="_blank"` or `window.open()` lands
 * with `referringVisitId` "0", indistinguishable from a typed address. The
 * relationship exists only on `chrome.tabs`: the new tab's `openerTabId` names
 * the tab it was opened from, and that tab's current page is the referrer.
 *
 * Measured 2026-09-10 (plans/rex-visit-graph/2026-09-10-tab-opener-attribution-spike.md):
 * `openerTabId` is present on `tabs.onCreated` for every opening method;
 * `pendingUrl` is present only for middle and modifier clicks, so the new tab's
 * first navigation is read from `tabs.onUpdated` instead, which carries the
 * committed URL on every method. In a redirect chain that URL is the landing
 * page, never the hop, so the chain's root is resolved at drain time from the
 * hops this module already holds.
 *
 * An opener edge is stored under its own key prefix, so a hop and an opener
 * edge for the same visit can both be held.
 */

import { urlAtDetail, type CaptureRules, type UrlDetail } from './capture-rules.mjs'
import type { CaptureLists } from './capture-lists.mjs'
import { EdgeStore, type StoredEdge } from './edge-store.mjs'
import type { HopRecord } from './hop-store.mjs'
import { newestVisit, visitCount } from './visit-lookup.mjs'

const KEY_PREFIX = 'rexVisitGraphOpener:'

/**
 * How long after creation a tab's first navigation still counts as the thing
 * the opener opened. A tab left blank longer than this and then navigated by
 * hand is not a click-through, and Chrome would not attribute it either.
 */
const FIRST_NAVIGATION_WINDOW_MS = 30_000

export interface OpenerRecord extends StoredEdge {
  /** What Chrome recorded as the first visit's referrer, "0" for a new tab. */
  referring_visit_id: string;
  /** The newest visit of the opener tab's page when the tab was created. */
  opener_visit_id: string;
  url: string | null;
  transition: string;
}

interface PendingOpener {
  /** Resolved asynchronously; reserved synchronously so a fast first navigation still finds it. */
  openerVisitId: Promise<string | null>;
  createdAt: number;
}

export class OpenerStore extends EdgeStore<OpenerRecord> {
  constructor() {
    super(KEY_PREFIX)
  }
}

/**
 * The visit an opener edge should attach to.
 *
 * The first URL a tab commits may be the landing of a redirect chain whose root
 * is a hop this module captured. Chrome recorded "0" on that root, not on the
 * landing, so the edge belongs there: it fills exactly the gap Chrome left, and
 * landing -> hop -> opener is then walkable end to end. If the root is not
 * among the hops held, the edge stays on the first committed visit.
 */
export function chainRoot(record: OpenerRecord, hops: HopRecord[]): { visit_id: string; visit_time: number; url: string | null } {
  const byId = new Map(hops.map((hop) => [hop.visit_id, hop]))
  let current: { visit_id: string; referring_visit_id: string; visit_time: number; url: string | null } = record

  // Bounded, so a cycle in stored data cannot hang the drain.
  for (let steps = 0; steps < 16; steps += 1) {
    const hop = byId.get(current.referring_visit_id)

    if (hop === undefined) {
      break
    }

    current = hop
  }

  return { visit_id: current.visit_id, visit_time: current.visit_time, url: current.url }
}

export interface TabOpenerDependencies {
  rules: CaptureRules;
  lists: CaptureLists;
  store: OpenerStore;
  urlDetail: () => UrlDetail;
  /** Ceiling on an opener's visit count; non-positive means no ceiling. */
  maxOpenerVisits: () => number;
}

export class TabOpenerTracker {
  private readonly pending = new Map<number, PendingOpener>()

  constructor(private readonly deps: TabOpenerDependencies) {}

  /**
   * A tab was created. If a page opened it, remember which visit that page was
   * on, so the tab's first navigation can be attributed to it.
   *
   * The entry is reserved before anything is awaited: the first navigation can
   * commit within a millisecond of creation, and a lookup still in flight must
   * not lose it.
   *
   * The lookup starts here rather than in `tabNavigated()`, which means a new tab
   * the capture rules or lists then exclude has already paid for one it will not
   * use. That is deliberate, and AI-Extension#124 raised it. Deferring it would
   * resolve the opener's NEWEST visit at navigation time instead of at creation
   * time, and on the pages this matters for — a dashboard re-recording a visit
   * every few seconds — those are different visits. The attribution window is 30
   * seconds, so the edge could name a visit ten later than the one that opened
   * the tab. Paying for an occasional unused lookup is the cheaper error than
   * silently attributing to the wrong visit of the right page.
   */
  tabCreated(tab: chrome.tabs.Tab): boolean {
    if (tab.id === undefined || tab.openerTabId === undefined) {
      return false
    }

    this.pending.set(tab.id, {
      openerVisitId: this.resolveOpenerVisit(tab.openerTabId),
      createdAt: Date.now()
    })

    return true
  }

  /**
   * A tab committed a URL. The first real one after creation is the visit the
   * opener opened; later ones are the participant browsing on.
   */
  async tabNavigated(tabId: number, url: string): Promise<boolean> {
    const entry = this.pending.get(tabId)

    if (entry === undefined) {
      return false
    }

    // A tab opened empty and then navigated by its opener commits about:blank
    // first. That is not the visit; the next one is.
    if (url === '' || url === 'about:blank') {
      return false
    }

    this.pending.delete(tabId)

    if (Date.now() - entry.createdAt > FIRST_NAVIGATION_WINDOW_MS) {
      return false
    }

    const rule = this.deps.rules.decide(url)

    if (rule === null) {
      return false
    }

    if (!(await this.deps.lists.permits(url))) {
      return false
    }

    const openerVisitId = await entry.openerVisitId

    if (openerVisitId === null) {
      return false
    }

    const visit = await newestVisit(url)

    if (visit === null) {
      return false
    }

    await this.deps.store.put({
      visit_id: visit.visitId,
      referring_visit_id: visit.referringVisitId,
      opener_visit_id: openerVisitId,
      visit_time: visit.visitTime,
      url: urlAtDetail(url, this.deps.urlDetail()),
      capture_rule: rule.id,
      transition: visit.transition ?? ''
    })

    return true
  }

  tabRemoved(tabId: number): void {
    this.pending.delete(tabId)
  }

  /** Drop every reservation. Used when listening stops. */
  forgetAll(): void {
    this.pending.clear()
  }

  /**
   * The opener tab's current visit, or null when it has no page worth
   * attributing to: a blank tab, an extension page, a host without the `tabs`
   * permission (Chrome then reports no URL), a page the capture lists exclude,
   * or a tab that has already gone. The URL is used to resolve the id and then
   * dropped.
   */
  private async resolveOpenerVisit(openerTabId: number): Promise<string | null> {
    let url: string | undefined

    try {
      url = (await chrome.tabs.get(openerTabId)).url
    } catch {
      return null
    }

    if (url === undefined || url === '' || this.deps.rules.decide(url) === null) {
      return null
    }

    // Ahead of the visit lookup, which is the expensive call: `getVisits()`
    // returns every visit the URL has ever had, and an opener is exactly the
    // kind of page that accumulates them. An excluded host should cost nothing
    // to exclude, and its visit id has no business reaching an emitted point.
    if (!(await this.deps.lists.permits(url))) {
      return null
    }

    if (await this.tooManyVisits(url)) {
      return null
    }

    const visit = await newestVisit(url)

    return visit === null ? null : visit.visitId
  }

  /**
   * Whether this opener is too expensive to resolve.
   *
   * The ceiling exists because `getVisits()` cannot be bounded: a page that
   * re-records a visit every few seconds costs about a second to resolve, and
   * the opener path pays it per new tab. A block list would also stop it, but
   * only once somebody has noticed the page and named it, and here noticing cost
   * a participant who uninstalled. This catches the page nobody has named yet.
   *
   * Fails toward looking up, which is the opposite of the list gate above, and
   * deliberately so. The lists decide what may be collected, so an unreadable
   * one has to block. This decides only what is affordable, so an unanswered
   * question leaves behaviour as it was rather than dropping an edge that was
   * wanted.
   */
  private async tooManyVisits(url: string): Promise<boolean> {
    const ceiling = this.deps.maxOpenerVisits()

    if (ceiling <= 0) {
      return false
    }

    const count = await visitCount(url)

    if (count === null || count <= ceiling) {
      return false
    }

    console.log(`[rex-visit-graph] Opener has ${count} visits, over the ${ceiling} ceiling; `
      + 'not resolving it. Set visit_graph.max_opener_visits to change this.')

    return true
  }
}
