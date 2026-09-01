/**
 * Holds captured hops until a drain can emit them.
 *
 * ONE STORAGE KEY PER HOP. Persisting to a single array means concurrent
 * onVisited handlers read the same value, push, and write back over each other,
 * so hops disappear and the module looks like it never fired. Distinct keys
 * cannot collide, so there is nothing to serialise.
 *
 * The stored record always holds the URL. Whether the URL is emitted is a
 * separate decision made at drain time: storage is local and short-lived,
 * emission leaves the machine.
 */

import type { CaptureRule } from './capture-rules.mts'
import type { HopVisit } from './visit-lookup.mts'

const KEY_PREFIX = 'rexVisitGraphHop:'

export interface HopRecord {
  visit_id: string;
  referring_visit_id: string;
  visit_time: number;
  url: string;
  capture_rule: string;
}

export class HopStore {
  async record(visit: HopVisit, url: string, rule: CaptureRule): Promise<void> {
    const hop: HopRecord = {
      visit_id: visit.visitId,
      referring_visit_id: visit.referringVisitId,
      visit_time: visit.visitTime,
      url,
      capture_rule: rule.id
    }

    await chrome.storage.local.set({ [this.keyFor(visit.visitId)]: hop })
  }

  async readAll(): Promise<HopRecord[]> {
    const stored = await chrome.storage.local.get()
    const records: HopRecord[] = []

    for (const key of Object.keys(stored)) {
      if (key.startsWith(KEY_PREFIX)) {
        records.push(stored[key] as HopRecord)
      }
    }

    return records
  }

  async forget(visitIds: string[]): Promise<void> {
    await chrome.storage.local.remove(visitIds.map((visitId) => this.keyFor(visitId)))
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
