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
import { CAPTURE_ALL, CaptureRules, DEFAULT_SCHEMES, urlAtDetail, type UrlDetail, type VisitGraphConfig } from './capture-rules.mjs'
import { newestVisit } from './visit-lookup.mjs'
import { HopStore } from './hop-store.mjs'
import { UrlRedactor, resolveRedactionLists, type RedactionLists } from './redaction.mjs'

/**
 * No capture rules by default: the module captures the whole graph, and a study
 * narrows it if it wants less. Naming sites here would make the module's default
 * a client override, and would leave any redirector nobody has seen yet silently
 * uncollected — which is the failure this module exists to end.
 */
const DEFAULT_CONFIG: VisitGraphConfig = {
  enabled: true,
  capture_rules: [],
  schemes: [...DEFAULT_SCHEMES],
  url_detail: 'none',
  debug: false,
  max_hop_age_days: 7
}

class VisitGraphServiceWorkerModule extends REXServiceWorkerModule {
  readonly captureRules = new CaptureRules()
  readonly hopStore = new HopStore()
  readonly redactor = new UrlRedactor()

  private config: VisitGraphConfig = DEFAULT_CONFIG

  /** In-memory, never persisted: a fresh worker restarts with it clear. */
  private draining = false

  /** setup() may run more than once; the listener is added only the first time. */
  private listening = false

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
    if (item.url === undefined) {
      return false
    }

    const rule = this.captureRules.decide(item.url)

    if (rule === null) {
      return false
    }

    const visit = await newestVisit(item.url)

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
      // Sweep first, so a record past its age is discarded rather than sent.
      await this.hopStore.sweep(Date.now() - (this.config.max_hop_age_days * 24 * 60 * 60 * 1000))

      const records = await this.hopStore.readAll()
      const emitted: string[] = []

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

      // Emit, then forget. A worker killed between the two re-emits next cycle;
      // killed in the other order, the hop is gone. A duplicate is recoverable
      // in analysis, a loss is not.
      if (emitted.length > 0) {
        await this.hopStore.forget(emitted)
      }

      return emitted.length
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
    this.captureRules.update(this.config.enabled ? this.config.capture_rules : [])
    this.captureRules.setSchemes(this.config.schemes)
    this.redactor.update(resolveRedactionLists(history, this.config.redaction))
  }

  /**
   * Settle what is already stored against the configuration now in force.
   *
   * Until configuration arrives the module has no rules and captures everything
   * under CAPTURE_ALL; those provisional hops are resolved here.
   */
  async reconcileStore(): Promise<void> {
    if (!this.config.enabled) {
      const discarded = await this.hopStore.clear()

      if (discarded > 0) {
        console.log(`[rex-visit-graph] Disabled; discarded ${discarded} hop(s) captured before configuration.`)
      }

      return
    }

    if (this.captureRules.isNarrowed()) {
      // A study that narrows asked for less, so give it less. These cannot be
      // re-matched against the arriving rules: the address they would be tested
      // on was discarded at capture, which is the point of not holding one.
      const discarded = await this.hopStore.forgetByRule(CAPTURE_ALL.id)

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

    // Registered here rather than at module scope, and once only: rex-core calls
    // setup() at registration, so this must not accumulate listeners if called
    // again. Capture is gated on `enabled` at the moment the event arrives, not
    // at the moment the listener is added, so turning the module off in
    // configuration stops collection without needing the listener removed.
    if (!this.listening) {
      this.listening = true

      chrome.history.onVisited.addListener((item) => {
        if (!this.config.enabled) {
          return
        }

        this.captureVisit(item).catch((error) => {
          console.error('[rex-visit-graph] Capture failed:', error)
        })
      })
    }

    await this.refreshConfiguration()
  }
}

const plugin = new VisitGraphServiceWorkerModule()

registerREXModule(plugin)

export default plugin
