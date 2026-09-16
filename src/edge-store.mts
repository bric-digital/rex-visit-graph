/**
 * Holds captured edges in chrome.storage.local until a drain can emit them.
 *
 * ONE STORAGE KEY PER EDGE. Persisting to a single array means concurrent
 * handlers read the same value, push, and write back over each other, so
 * records disappear and the module looks like it never fired. Distinct keys
 * cannot collide, so there is nothing to serialise.
 *
 * Each kind of edge gets its own key prefix, so a hop and an opener edge for
 * the same visit can both be held.
 */

export interface StoredEdge {
  visit_id: string;
  visit_time: number;
  capture_rule: string;
}

export class EdgeStore<T extends StoredEdge> {
  constructor(private readonly prefix: string) {}

  async put(record: T): Promise<void> {
    await chrome.storage.local.set({ [this.keyFor(record.visit_id)]: record })
  }

  /**
   * Reads by key rather than pulling the extension's whole local storage down to
   * filter it — this module's records are a handful among everything every other
   * module keeps.
   */
  async readAll(): Promise<T[]> {
    const keys = (await chrome.storage.local.getKeys()).filter((key) => key.startsWith(this.prefix))

    if (keys.length === 0) {
      return []
    }

    const stored = await chrome.storage.local.get(keys)

    return keys.map((key) => stored[key] as T).filter((record) => record !== undefined)
  }

  async forget(visitIds: string[]): Promise<void> {
    await chrome.storage.local.remove(visitIds.map((visitId) => this.keyFor(visitId)))
  }

  /** Discard records held under one rule id. Returns how many went. */
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
    return `${this.prefix}${visitId}`
  }
}
