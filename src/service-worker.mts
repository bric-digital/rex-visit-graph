/**
 * Captures the browser visits that `chrome.history.search()` does not return.
 *
 * Chrome stores redirect intermediates but keeps them out of history search
 * results, so a collector that enumerates with `search()` never sees them. The
 * landing page it does collect still points at one through `referringVisitId`,
 * and that id belongs to no exported row, so the chain from a click back to the
 * search that produced it terminates.
 *
 * `chrome.history.onVisited` does fire for those visits, which is the only way to
 * learn the URL. This module listens, keeps the ids, and emits them as their own
 * point type. Analysis joins them to history on `visit_id`; nothing here needs
 * rex-history to be installed.
 *
 * Capture runs unconditionally. Emission waits for configuration, because points
 * must not be dispatched before it exists — but a hop that is not captured while
 * it happens is unrecoverable, so the listener does not wait for anything.
 */

import rexCorePlugin, { REXServiceWorkerModule, registerREXModule, dispatchEvent } from '@bric/rex-core/service-worker'
import { CAPTURE_ALL, CaptureRules, DEFAULT_SCHEMES, urlAtDetail, type CaptureRule, type UrlDetail, type VisitGraphConfig } from './capture-rules.mjs'
import { newestVisit } from './visit-lookup.mjs'
import { HopStore } from './hop-store.mjs'
import { UrlRedactor, resolveRedactionLists, type RedactionLists } from './redaction.mjs'
import { CaptureLists } from './capture-lists.mjs'
import { collectorCanSee } from './history-visibility.mjs'
import { DeferredVisits, type DeferredVisit } from './deferred-visits.mjs'
import { OpenerStore, TabOpenerTracker, chainRoot } from './tab-opener.mjs'

/**
 * Scoped by default to the visits rex-history's collector cannot see, and not
 * narrowed further. Naming sites here would make the module's default a client
 * override, and would leave any redirector nobody has seen yet silently
 * uncollected — which is the failure this module exists to end. Scope catches
 * those without naming them: being absent from history search is what makes a
 * visit a redirect intermediate.
 */
const DEFAULT_CONFIG: VisitGraphConfig = {
  enabled: true,
  capture_rules: [],
  capture_scope: 'hops',
  tab_opener_edges: true,
  // Chosen from the measured cost, which scales with the count: 440,000 visits
  // resolve in ~1075ms, so ~2.4us each, and 25,000 is about 60ms. Above any
  // organic page — visiting one 20 times a day for three years is ~22,000 — and
  // reached in under a day by a page that re-records every few seconds. It is a
  // judgement, not a finding, which is why it is server config.
  max_opener_visits: 25_000,
  schemes: [...DEFAULT_SCHEMES],
  url_detail: 'none',
  debug: false,
  max_hop_age_days: 7
}

class VisitGraphServiceWorkerModule extends REXServiceWorkerModule {
  readonly captureRules = new CaptureRules()
  readonly captureLists = new CaptureLists()
  readonly hopStore = new HopStore()
  readonly openerStore = new OpenerStore()
  readonly deferredVisits = new DeferredVisits()
  readonly redactor = new UrlRedactor()
  readonly tabOpeners = new TabOpenerTracker({
    rules: this.captureRules,
    lists: this.captureLists,
    store: this.openerStore,
    urlDetail: () => this.urlDetail(),
    maxOpenerVisits: () => this.config.max_opener_visits
  })

  private config: VisitGraphConfig = DEFAULT_CONFIG

  /** In-memory, never persisted: a fresh worker restarts with it clear. */
  private draining = false

  /** Held so it can be removed again; a listener is only removable by reference. */
  private historyListener: ((item: chrome.history.HistoryItem) => void) | null = null

  private tabListeners: {
    created: (tab: chrome.tabs.Tab) => void;
    updated: (tabId: number, changeInfo: { url?: string }) => void;
    removed: (tabId: number) => void;
  } | null = null

  moduleName(): string {
    return 'VisitGraph'
  }

  /**
   * Self-describes the config surface, the way rex-page-manipulation does, so the
   * shape is discoverable from the module rather than only from its README.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override configurationDetails(): any {
    return {
      visit_graph: {
        enabled: 'Boolean, true if module is active, false otherwise. When false nothing is captured, '
          + 'nothing is emitted even if a host asks, and anything already captured is discarded.',
        capture_scope: "String: 'hops' (default) captures only visits rex-history's collector cannot "
          + "see, which is the redirect intermediates this module exists for. 'all' captures the whole "
          + 'visit graph, which duplicates ids rex-history already reports and costs a visit lookup on '
          + 'every navigation. Change to all only to restore the earlier behaviour.',
        tab_opener_edges: 'Boolean, default true. Attributes the first visit in a new tab to the page '
          + 'that opened it, emitted as rex-visit-graph-opener points. Chrome records no referrer across '
          + 'a tab boundary, so without this a result opened in a new tab arrives from nowhere. Needs the '
          + 'tabs permission in the host; without it nothing is recorded.',
        max_opener_visits: 'Number, default 25000. A page with more visits than this is not looked '
          + 'up when it opens a tab, so no opener edge is recorded for tabs it opens. getVisits() '
          + 'cannot be bounded and costs about a second on a page that re-records a visit every few '
          + 'seconds, charged per new tab. Raise it to keep attribution on a heavily revisited page, '
          + 'lower it if lookups are still costing participants, 0 to remove the ceiling entirely.',
        capture_rules: [{
          id: 'String, label emitted with each captured hop so rules can be told apart in analysis.',
          host_suffix: 'String, matches this host exactly or any subdomain of it.',
          path_prefix: 'String, matches when the visited path starts with this.'
        }],
        schemes: ['String, a URL scheme to capture, without the colon. Defaults to http and https. '
          + 'Naming others (file, ftp, webdav) opts into them: they are not ordinary browsing, and a '
          + 'local file path is a different kind of disclosure from a web page.'],
        url_detail: "String: 'none' (default), 'path' or 'full'. 'none' keeps ids only and discards the "
          + "address as soon as the visit ids are resolved. 'path' keeps origin and pathname, which says what "
          + "an intermediate was without the destination a redirector encodes in its query. 'full' keeps the "
          + "whole address. Anything kept is redacted before it is emitted, using rex-history's lists when it "
          + 'states any, otherwise visit_graph.redaction.',
        debug: 'Boolean, forces url_detail to full in any build, for diagnosing a deployment. Logs a '
          + 'warning while it is on so a configuration left in this state is visible.',
        max_hop_age_days: 'Number, days after which a hop that was never emitted is discarded.',
        capture_block_lists: ['String, rex-lists list name. A visit matching any of these is not '
          + 'captured at all, and neither is a page that opens a tab, so an excluded page is never '
          + 'looked up and its visit id never reaches a point. Takes precedence over '
          + 'capture_allow_lists. A list that cannot be read blocks, so an unreadable list captures '
          + 'less rather than more.'],
        capture_allow_lists: ['String, rex-lists list name. When any are named, only visits matching '
          + 'one of them are captured. Decides whether a visit is captured; redaction below decides '
          + 'what a captured address looks like.'],
        redaction: {
          allow_lists: ['String, rex-lists list name. Applied only when rex-history states no lists.'],
          filter_lists: ['String, rex-lists list name. Applied only when rex-history states no lists.'],
          domain_only_lists: ['String, rex-lists list name. Applied only when rex-history states no lists.']
        }
      }
    }
  }

  currentConfig(): VisitGraphConfig {
    return this.config
  }

  async captureVisit(item: chrome.history.HistoryItem): Promise<boolean> {
    // Checked here as well as by removing the listener, deliberately. An empty
    // rule set means "capture everything" since capture inverted, so a disabled
    // module that reached this point would collect rather than skip. Two
    // independent guards, and the failure direction of each is to collect
    // nothing.
    if (!this.config.enabled || item.url === undefined) {
      return false
    }

    const rule = this.captureRules.decide(item.url)

    if (rule === null) {
      return false
    }

    const at = item.lastVisitTime ?? Date.now()
    const deferring = this.config.capture_scope !== 'all'
    const candidate = { url: item.url, at, rule }

    // These two run in one synchronous turn, in this order, before any await.
    // Taking first is what stops this visit from answering its own question;
    // holding before the first await is what lets the next visit find it, since
    // Chrome orders onVisited only across handlers' synchronous parts.
    const pending = deferring ? this.deferredVisits.takeAll() : []

    if (deferring) {
      this.deferredVisits.hold(candidate)
    }

    // Everything pending has now had a further navigation happen after it, so a
    // client redirect it was part of has completed.
    await this.reconsider(pending)

    // Ahead of the visit lookup, which is the expensive call: an excluded host
    // should cost nothing to exclude.
    if (!(await this.captureLists.permits(item.url))) {
      this.deferredVisits.drop(candidate)
      return false
    }

    // Also ahead of it, and for the same reason. A visit rex-history can see is
    // one it already reports with these same ids, so capturing it would spend a
    // full getVisits() to duplicate a record we send anyway.
    //
    // Left held rather than discarded: a client redirector is still visible at
    // this moment and stops being visible once it redirects, so the answer here
    // is provisional. The next visit asks again.
    if (deferring && await collectorCanSee(item.url, at)) {
      return false
    }

    this.deferredVisits.drop(candidate)

    return this.storeVisit(item.url, rule)
  }

  /** Capture the ones that have stopped being visible since they were held. */
  private async reconsider(candidates: DeferredVisit[]): Promise<number> {
    let captured = 0

    for (const candidate of candidates) {
      if (await collectorCanSee(candidate.url, candidate.at)) {
        continue
      }

      if (await this.storeVisit(candidate.url, candidate.rule)) {
        captured += 1
      }
    }

    return captured
  }

  /**
   * Settle whatever is still held, for a drain.
   *
   * The next visit is the ordinary signal, and it arrives milliseconds after a
   * redirect. This covers the tail: a redirector whose destination never
   * produced a visit has nothing else coming.
   */
  async reconsiderDeferred(): Promise<number> {
    if (!this.config.enabled) {
      this.deferredVisits.forgetAll()
      return 0
    }

    return this.reconsider(this.deferredVisits.takeAll())
  }

  /**
   * Resolve a URL's ids and keep the edge.
   *
   * Keyed by visit id, so capturing the same visit twice writes the same record
   * rather than a duplicate — which is what lets the deferred path and the
   * direct one overlap without coordinating.
   */
  private async storeVisit(url: string, rule: CaptureRule): Promise<boolean> {
    const visit = await newestVisit(url)

    if (visit === null) {
      return false
    }

    // Store at the granularity that will be emitted, so the module never holds
    // more of an address than it is configured to send. The address has done its
    // job once the ids are resolved.
    await this.hopStore.record(visit, urlAtDetail(visit.url, this.urlDetail()), rule)
    return true
  }

  async drain(): Promise<number> {
    // A host drains on its own cadence, so being switched off has to stop
    // emission here rather than only stopping the alarm being scheduled.
    if (!this.config.enabled || this.draining) {
      return 0
    }

    this.draining = true

    try {
      // Settle any undecided visit before reading the store, so a hop that never
      // got a following visit is emitted in this drain rather than the next one.
      await this.reconsiderDeferred()

      // Sweep first, so a record past its age is discarded rather than sent.
      const cutoff = Date.now() - (this.config.max_hop_age_days * 24 * 60 * 60 * 1000)
      await this.hopStore.sweep(cutoff)
      await this.openerStore.sweep(cutoff)

      const records = await this.hopStore.readAll()
      const openers = await this.openerStore.readAll()
      const emitted: string[] = []
      const emittedOpeners: string[] = []

      for (const record of records) {
        const url = record.url === null ? undefined : await this.redactor.redact(record.url)

        dispatchEvent({
          name: 'rex-visit-graph-hop',
          visit_id: record.visit_id,
          referring_visit_id: record.referring_visit_id,
          visit_time: record.visit_time,
          capture_rule: record.capture_rule,
          date: record.visit_time,
          ...(url === undefined ? {} : { url })
        })

        emitted.push(record.visit_id)
      }

      // Resolved against the hops read in this same drain, so a redirect chain
      // in the new tab attaches the edge to its root rather than its landing.
      for (const record of openers) {
        const root = chainRoot(record, records)
        const url = root.url === null ? undefined : await this.redactor.redact(root.url)

        dispatchEvent({
          name: 'rex-visit-graph-opener',
          visit_id: root.visit_id,
          referring_visit_id: record.opener_visit_id,
          visit_time: root.visit_time,
          capture_rule: record.capture_rule,
          transition: record.transition,
          date: root.visit_time,
          ...(url === undefined ? {} : { url })
        })

        emittedOpeners.push(record.visit_id)
      }

      // Emit, then forget. A worker killed between the two re-emits next cycle;
      // killed in the other order, the hop is gone. A duplicate is recoverable
      // in analysis, a loss is not.
      if (emitted.length > 0) {
        await this.hopStore.forget(emitted)
      }

      if (emittedOpeners.length > 0) {
        await this.openerStore.forget(emittedOpeners)
      }

      return emitted.length + emittedOpeners.length
    } catch (error) {
      console.error('[rex-visit-graph] Drain failed:', error)
      return 0
    } finally {
      this.draining = false
    }
  }

  /**
   * `triggerVisitGraphDrain` emits any stored hops now and responds with the
   * count, so a host extension can drain on its own cadence rather than waiting
   * for the alarm.
   */
  override handleMessage(
    message: { messageType?: string } | undefined,
    _sender: unknown,
    sendResponse: (response: unknown) => void
  ): boolean {
    if (message?.messageType !== 'triggerVisitGraphDrain') {
      return false
    }

    this.drain()
      .then((count) => sendResponse(count))
      .catch(() => sendResponse(0))

    return true
  }

  /**
   * The detail actually in force.
   *
   * `debug` overrides `url_detail` in any build, deliberately: diagnosing a real
   * deployment is exactly when full addresses are needed, so a flag that only
   * worked in a development build would be useless where it matters. It announces
   * itself in the log so a config left in this state is visible rather than
   * silent.
   */
  urlDetail(): UrlDetail {
    if (this.config.debug === true) {
      console.warn('[rex-visit-graph] visit_graph.debug is on: emitting full addresses, '
        + `overriding url_detail="${this.config.url_detail ?? 'none'}".`)
      return 'full'
    }

    return this.config.url_detail ?? 'none'
  }

  /**
   * Test seam: simulates a WORKER RESTART, which clears in-memory state and
   * leaves chrome.storage untouched. Clearing the store here would assert
   * something that never happens.
   */
  simulateWorkerRestart(): void {
    this.draining = false
  }

  /**
   * Test seam: a worker killed mid-drain leaves the guard set in the instance
   * that died. It resets on restart on its own, because `draining` is a plain
   * field and is never persisted; this exists to prove that.
   */
  simulateDrainInterrupted(value: boolean): void {
    this.draining = value
  }

  /**
   * Assigns configuration. Synchronous on purpose: a test, a host, or another
   * module can hand this module its settings directly, with no server round trip
   * and nothing to fake. Anything asynchronous a change implies is the caller's,
   * immediately after — see reconcileStore.
   */
  updateConfiguration(section: Partial<VisitGraphConfig> | undefined, history?: RedactionLists): void {
    this.config = { ...DEFAULT_CONFIG, ...(section ?? {}) }
    this.captureRules.update(this.config.capture_rules)
    this.captureRules.setSchemes(this.config.schemes)
    this.captureLists.update(this.config)
    this.redactor.update(resolveRedactionLists(history, this.config.redaction))

    // Listening follows the enabled flag: a disabled module holds no listener at
    // all, rather than holding one that declines to act. Both calls are
    // synchronous, so this stays inside updateConfiguration.
    if (this.config.enabled) {
      this.startListening()
    } else {
      this.stopListening()
    }

    if (this.config.enabled && this.config.tab_opener_edges) {
      this.startListeningForTabs()
    } else {
      this.stopListeningForTabs()
    }
  }

  /** True while a history listener is registered. Readable for diagnostics. */
  isListening(): boolean {
    return this.historyListener !== null
  }

  /** True while the tabs listeners are registered. Readable for diagnostics. */
  isListeningForTabs(): boolean {
    return this.tabListeners !== null
  }

  private startListeningForTabs(): void {
    if (this.tabListeners !== null || typeof chrome.tabs?.onCreated?.addListener !== 'function') {
      return
    }

    this.tabListeners = {
      created: (tab) => {
        this.tabOpeners.tabCreated(tab)
      },
      updated: (tabId, changeInfo) => {
        // onUpdated fires for every status change of every tab; only a committed
        // URL on a tab this module is holding is of interest.
        if (changeInfo.url === undefined) {
          return
        }

        this.tabOpeners.tabNavigated(tabId, changeInfo.url).catch((error) => {
          console.error('[rex-visit-graph] Opener capture failed:', error)
        })
      },
      removed: (tabId) => {
        this.tabOpeners.tabRemoved(tabId)
      }
    }

    chrome.tabs.onCreated.addListener(this.tabListeners.created)
    chrome.tabs.onUpdated.addListener(this.tabListeners.updated)
    chrome.tabs.onRemoved.addListener(this.tabListeners.removed)
  }

  private stopListeningForTabs(): void {
    if (this.tabListeners === null) {
      return
    }

    chrome.tabs.onCreated.removeListener(this.tabListeners.created)
    chrome.tabs.onUpdated.removeListener(this.tabListeners.updated)
    chrome.tabs.onRemoved.removeListener(this.tabListeners.removed)
    this.tabListeners = null
    this.tabOpeners.forgetAll()
  }

  private startListening(): void {
    if (this.historyListener !== null) {
      return
    }

    this.historyListener = (item: chrome.history.HistoryItem) => {
      this.captureVisit(item).catch((error) => {
        console.error('[rex-visit-graph] Capture failed:', error)
      })
    }

    chrome.history.onVisited.addListener(this.historyListener)
  }

  private stopListening(): void {
    if (this.historyListener === null) {
      return
    }

    chrome.history.onVisited.removeListener(this.historyListener)
    this.historyListener = null
  }

  /**
   * Settle what is already stored against the configuration now in force.
   *
   * Until configuration arrives the module has no rules and captures everything
   * under CAPTURE_ALL; those provisional hops are resolved here.
   */
  async reconcileStore(): Promise<void> {
    if (!this.config.enabled) {
      this.deferredVisits.forgetAll()

      const discarded = await this.hopStore.clear() + await this.openerStore.clear()

      if (discarded > 0) {
        console.log(`[rex-visit-graph] Disabled; discarded ${discarded} edge(s) captured before configuration.`)
      }

      return
    }

    if (this.captureRules.isNarrowed()) {
      // A study that narrows asked for less, so give it less. These cannot be
      // re-matched against the arriving rules: the address they would be tested
      // on was discarded at capture, which is the point of not holding one.
      const discarded = await this.hopStore.forgetByRule(CAPTURE_ALL.id)
        + await this.openerStore.forgetByRule(CAPTURE_ALL.id)

      if (discarded > 0) {
        console.log(`[rex-visit-graph] Narrowed by configuration; discarded ${discarded} hop(s) `
          + 'captured before it arrived.')
      }
    }
  }

  /** rex-core's activation hook: fetch, then hand this module's own section over. */
  async refreshConfiguration(): Promise<void> {
    try {
      const all = await rexCorePlugin.fetchConfiguration() as Record<string, unknown> | undefined

      this.updateConfiguration(
        all?.['visit_graph'] as Partial<VisitGraphConfig> | undefined,
        all?.['history'] as RedactionLists | undefined
      )

      await this.reconcileStore()
    } catch (error) {
      console.error('[rex-visit-graph] Failed to load configuration:', error)
    }
  }

  async setup(): Promise<void> {
    console.log('[rex-visit-graph/service-worker] Setting up visit graph capture')

    // Listen before configuration is fetched, because the module defaults to
    // enabled and onVisited fires once: a visit missed while the fetch is in
    // flight is unrecoverable. refreshConfiguration then removes the listener
    // again if the study has the module turned off, so a disabled module ends up
    // holding no listener and having emitted nothing.
    this.startListening()
    this.startListeningForTabs()

    await this.refreshConfiguration()
  }
}

const plugin = new VisitGraphServiceWorkerModule()

registerREXModule(plugin)

export default plugin
