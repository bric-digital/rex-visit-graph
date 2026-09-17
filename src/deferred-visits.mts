/**
 * Visits whose visibility could not be decided when they happened.
 *
 * `collectorCanSee()` asks whether history search returns a URL, and for a
 * client-side redirect that answer changes moments after the visit. A redirector
 * that replaces itself with `location.replace` or a meta refresh is a real
 * document: it loads, runs, and only then redirects, so `onVisited` fires while
 * it is still an ordinary visit that search returns. Chrome reclassifies it as a
 * redirect intermediate once the replacement happens, after which no collector
 * enumerating with `search()` can see it again. Measured 2026-09-17; the
 * reproduction is `AI-extension-testing/one-off/probe_client_redirect_capture.mjs`.
 *
 * So a visit search returns is not necessarily a visit rex-history will collect.
 * It has to be asked again once the navigation it might be part of has settled,
 * and the next visit is that moment: a redirect always has a destination, and
 * the destination's visit arrives milliseconds later, at machine speed rather
 * than at the speed of whoever is browsing. Nothing here waits on a person
 * navigating again or on a drain arriving.
 *
 * That rests on the holding being ordered, and Chrome only guarantees onVisited
 * ordering for the synchronous part of a handler. So a caller takes what is
 * pending and holds its own candidate in the same synchronous turn, in that
 * order, which is also what stops a visit from answering its own question.
 *
 * Held in memory and never persisted, per the MV3 rule that state surviving a
 * worker kill is state that can strand. The address is held transiently the same
 * way `captureVisit()` already holds it while resolving ids; `url_detail` still
 * governs everything kept at rest.
 */

import type { CaptureRule } from './capture-rules.mts'

export interface DeferredVisit {
  url: string;
  /** When the visit happened, so the second probe asks about the same window. */
  at: number;
  /** The rule the visit already matched, so matching is not repeated. */
  rule: CaptureRule;
}

/**
 * Bound on how many candidates are held at once.
 *
 * Each visit takes everything pending, so the list only grows while handlers
 * overlap. The cap stops a burst from holding addresses in memory; the oldest go
 * first, being the least likely to still be awaiting a redirect.
 */
const DEFAULT_LIMIT = 20

export class DeferredVisits {
  private held: DeferredVisit[] = []

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

  hold(visit: DeferredVisit): void {
    this.held.push(visit)

    if (this.held.length > this.limit) {
      this.held = this.held.slice(-this.limit)
    }
  }

  /**
   * Hands back everything held and forgets it.
   *
   * Taking rather than reading means a candidate is reconsidered once, by
   * whichever visit reaches it first.
   */
  takeAll(): DeferredVisit[] {
    const taken = this.held
    this.held = []
    return taken
  }

  /** Forgets one candidate, once its own visit has been decided. */
  drop(visit: DeferredVisit): void {
    this.held = this.held.filter((held) => held !== visit)
  }

  forgetAll(): void {
    this.held = []
  }

  get size(): number {
    return this.held.length
  }
}
