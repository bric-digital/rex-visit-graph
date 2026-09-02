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
import type { REXConfiguration } from '@bric/rex-core/common'
import { CaptureRules, urlAtDetail, type UrlDetail, type VisitGraphConfig } from './capture-rules.mjs'
import { VisitLookup } from './visit-lookup.mjs'
import { HopStore } from './hop-store.mjs'
import { UrlRedactor, resolveRedactionLists, type RedactionLists } from './redaction.mjs'

const DRAIN_ALARM = 'rex-visit-graph-drain'

/**
 * No capture rules by default: the module captures the whole graph, and a study
 * narrows it if it wants less. Naming sites here would make the module's default
 * a client override, and would leave any redirector nobody has seen yet silently
 * uncollected — which is the failure this module exists to end.
 */
const DEFAULT_CONFIG: VisitGraphConfig = {
  enabled: true,
  capture_rules: [],
  include_all_schemes: false,
  url_detail: 'none',
  debug: false,
  drain_interval_minutes: 15,
  max_hop_age_days: 7
}

class VisitGraphServiceWorkerModule extends REXServiceWorkerModule {
  readonly captureRules = new CaptureRules()
  readonly visitLookup = new VisitLookup()
  readonly hopStore = new HopStore()
  readonly redactor = new UrlRedactor()

  private config: VisitGraphConfig = DEFAULT_CONFIG

  /** In-memory, never persisted: a fresh worker restarts with it clear. */
  private draining = false

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
        include_all_schemes: 'Boolean, true to capture visits outside http and https '
          + '(chrome://, file://, extension pages). False by default: those are not ordinary '
          + 'browsing, and a local file path is a different kind of disclosure from a web page.',
        url_detail: "String: 'none' (default), 'path' or 'full'. 'none' keeps ids only and discards the "
          + "address as soon as the visit ids are resolved. 'path' keeps origin and pathname, which says what "
          + "an intermediate was without the destination a redirector encodes in its query. 'full' keeps the "
          + "whole address. Anything kept is redacted before it is emitted, using rex-history's lists when it "
          + 'states any, otherwise visit_graph.redaction.',
        debug: 'Boolean, forces url_detail to full in any build, for diagnosing a deployment. Logs a '
          + 'warning while it is on so a configuration left in this state is visible.',
        drain_interval_minutes: 'Number, minutes between emitting stored hops. Chrome clamps alarms to a '
          + 'one minute minimum.',
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

    const visit = await this.visitLookup.newestVisit(item.url)

    if (visit === null) {
      return false
    }

    // Store at the granularity that will be emitted, so the module never holds
    // more of an address than it is configured to send. The address has done its
    // job once the ids are resolved.
    await this.hopStore.record(visit, urlAtDetail(item.url, this.urlDetail()), rule)
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

      await this.hopStore.sweep(Date.now() - (this.config.max_hop_age_days * 24 * 60 * 60 * 1000))

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

  /** Test seam: a worker restart reconstructs the instance with the guard clear. */
  resetForTest(): void {
    this.draining = false
  }

  /** Test seam: a worker killed mid-drain leaves the guard set in the dead instance. */
  forceDrainingForTest(value: boolean): void {
    this.draining = value
  }

  /**
   * Leave a correctly scheduled alarm alone.
   *
   * A host extension may refresh configuration far more often than the drain
   * interval. Clearing and re-creating the alarm on every refresh restarts its
   * countdown, so a drain scheduled further out than the refresh cadence would
   * never fire and hops would accumulate unemitted.
   */
  private async scheduleDrain(): Promise<void> {
    const existing = await chrome.alarms.get(DRAIN_ALARM)

    if (!this.config.enabled) {
      if (existing !== undefined) {
        await chrome.alarms.clear(DRAIN_ALARM)
      }

      return
    }

    if (existing !== undefined && existing.periodInMinutes === this.config.drain_interval_minutes) {
      return
    }

    await chrome.alarms.clear(DRAIN_ALARM)
    await chrome.alarms.create(DRAIN_ALARM, {
      periodInMinutes: this.config.drain_interval_minutes,
      delayInMinutes: this.config.drain_interval_minutes
    })
  }

  async refreshConfiguration(): Promise<void> {
    try {
      const configuration = await rexCorePlugin.fetchConfiguration() as REXConfiguration | undefined
      const section = (configuration as Record<string, unknown> | undefined)?.['visit_graph'] as Partial<VisitGraphConfig> | undefined

      this.config = { ...DEFAULT_CONFIG, ...(section ?? {}) }
      this.captureRules.update(this.config.enabled ? this.config.capture_rules : [])
      this.captureRules.setAllSchemes(this.config.include_all_schemes)

      // Capture is seeded with the defaults before configuration arrives, so a
      // disabled arm can still have captured during that window. Discard it
      // rather than hold it against a later re-enable.
      if (!this.config.enabled) {
        const discarded = await this.hopStore.clear()

        if (discarded > 0) {
          console.log(`[rex-visit-graph] Disabled; discarded ${discarded} hop(s) captured before configuration.`)
        }
      }

      const history = (configuration as Record<string, unknown> | undefined)?.['history'] as RedactionLists | undefined
      this.redactor.update(resolveRedactionLists(history, this.config.redaction))

      await this.scheduleDrain()
    } catch (error) {
      console.error('[rex-visit-graph] Failed to load configuration:', error)
    }
  }

  async setup(): Promise<void> {
    console.log('[rex-visit-graph/service-worker] Setting up visit graph capture')

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return
      if (changes['REXConfiguration'] !== undefined) {
        this.refreshConfiguration().catch((error) => {
          console.error('[rex-visit-graph] Failed to react to configuration change:', error)
        })
      }
    })

    await this.refreshConfiguration()
  }
}

const plugin = new VisitGraphServiceWorkerModule()

// Both listeners are registered here, at module scope, in the first turn of the
// worker script. A chrome.history or chrome.alarms listener added after an await
// is registered too late to wake an evicted worker, and the waking event is lost.
chrome.history.onVisited.addListener((item) => {
  plugin.captureVisit(item).catch((error) => {
    console.error('[rex-visit-graph] Capture failed:', error)
  })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DRAIN_ALARM) {
    plugin.drain().catch((error) => {
      console.error('[rex-visit-graph] Drain error:', error)
    })
  }
})

registerREXModule(plugin)

export default plugin
