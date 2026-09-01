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
import { CaptureRules, type VisitGraphConfig } from './capture-rules.mjs'
import { VisitLookup } from './visit-lookup.mjs'
import { HopStore } from './hop-store.mjs'
import { UrlRedactor, resolveRedactionLists, type RedactionLists } from './redaction.mjs'

const DRAIN_ALARM = 'rex-visit-graph-drain'

/**
 * `/aclk` and `/goto` are both observed in the field (2026-09-01): `/aclk` on an
 * ad click, `/goto` on every organic result in a signed-out session. `/url` is
 * Google's long-standing redirector. All three ship because betting on one path
 * captured nothing when Google moved between them. The server overrides this.
 */
const DEFAULT_CONFIG: VisitGraphConfig = {
  enabled: true,
  capture_rules: [
    { id: 'google-aclk', host_suffix: 'google.com', path_prefix: '/aclk' },
    { id: 'google-goto', host_suffix: 'google.com', path_prefix: '/goto' },
    { id: 'google-url', host_suffix: 'google.com', path_prefix: '/url' }
  ],
  include_url: false,
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

  currentConfig(): VisitGraphConfig {
    return this.config
  }

  async captureVisit(item: chrome.history.HistoryItem): Promise<boolean> {
    if (item.url === undefined) {
      return false
    }

    const rule = this.captureRules.match(item.url)

    if (rule === null) {
      return false
    }

    const visit = await this.visitLookup.newestVisit(item.url)

    if (visit === null) {
      return false
    }

    await this.hopStore.record(visit, item.url, rule)
    return true
  }

  async drain(): Promise<number> {
    if (this.draining) {
      return 0
    }

    this.draining = true

    try {
      const records = await this.hopStore.readAll()
      const emitted: string[] = []

      for (const record of records) {
        const url = this.config.include_url ? await this.redactor.redact(record.url) : undefined

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

// Seeded before any await so a cold worker captures the known Google shapes
// during the window before configuration resolves.
plugin.captureRules.update(DEFAULT_CONFIG.capture_rules)

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
