/**
 * Holds captured hops until a drain can emit them.
 *
 * ONE STORAGE KEY PER HOP. Persisting to a single array means concurrent
 * onVisited handlers read the same value, push, and write back over each other,
 * so hops disappear and the module looks like it never fired. Distinct keys
 * cannot collide, so there is nothing to serialise.
 *
 * The URL is held only when it is going to be emitted. It is needed to resolve
 * the visit's ids and is worthless afterwards, so in the default configuration
 * the store holds edges and nothing else — no address at rest, none in flight.
 */

import type { CaptureRule } from './capture-rules.mts'
import type { HopVisit } from './visit-lookup.mts'

const KEY_PREFIX = 'rexVisitGraphHop:'

export interface HopRecord {
  visit_id: string;
  referring_visit_id: string;
  visit_time: number;
  url: string | null;
  capture_rule: string;
}

export class HopStore {
  async record(visit: HopVisit, emittableUrl: string | null, rule: CaptureRule): Promise<void> {
    const hop: HopRecord = {
      visit_id: visit.visitId,
      referring_visit_id: visit.referringVisitId,
      visit_time: visit.visitTime,
      url: emittableUrl,
      capture_rule: rule.id
    }

    await chrome.storage.local.set({ [this.keyFor(visit.visitId)]: hop })
  }

  /**
   * Reads by key rather than pulling the extension's whole local storage down to
   * filter it — this module's records are a handful among everything every other
   * module keeps.
   */
  async readAll(): Promise<HopRecord[]> {
    const keys = (await chrome.storage.local.getKeys()).filter((key) => key.startsWith(KEY_PREFIX))

    if (keys.length === 0) {
      return []
    }

    const stored = await chrome.storage.local.get(keys)

    return keys.map((key) => stored[key] as HopRecord).filter((record) => record !== undefined)
  }

  async forget(visitIds: string[]): Promise<void> {
    await chrome.storage.local.remove(visitIds.map((visitId) => this.keyFor(visitId)))
  }

  /** Discard hops recorded under one rule id. Returns how many went. */
  async forgetByRule(ruleId: string): Promise<number> {
    const matching = (await this.readAll()).filter((record) => record.capture_rule === ruleId)

    if (matching.length > 0) {
      await this.forget(matching.map((record) => record.visit_id))
    }

    return matching.length
  }

  /** Discard everything held. Used when the module is turned off. */
  async clear(): Promise<number> {
    const records = await this.readAll()

    if (records.length > 0) {
      await this.forget(records.map((record) => record.visit_id))
    }

    return records.length
  }

  /** Drop anything older than the cutoff, so a wedged run cannot grow the store. */
  async sweep(olderThan: number): Promise<number> {
    const stale = (await this.readAll()).filter((record) => record.visit_time < olderThan)

    if (stale.length > 0) {
      await this.forget(stale.map((record) => record.visit_id))
    }

    return stale.length
  }

  private keyFor(visitId: string): string {
    return `${KEY_PREFIX}${visitId}`
  }
}
