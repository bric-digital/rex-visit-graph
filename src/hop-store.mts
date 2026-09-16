/**
 * Holds captured hops until a drain can emit them.
 *
 * The URL is held only when it is going to be emitted. It is needed to resolve
 * the visit's ids and is worthless afterwards, so in the default configuration
 * the store holds edges and nothing else — no address at rest, none in flight.
 */

import type { CaptureRule } from './capture-rules.mts'
import type { HopVisit } from './visit-lookup.mts'
import { EdgeStore, type StoredEdge } from './edge-store.mjs'

const KEY_PREFIX = 'rexVisitGraphHop:'

export interface HopRecord extends StoredEdge {
  referring_visit_id: string;
  url: string | null;
}

export class HopStore extends EdgeStore<HopRecord> {
  constructor() {
    super(KEY_PREFIX)
  }

  async record(visit: HopVisit, emittableUrl: string | null, rule: CaptureRule): Promise<void> {
    await this.put({
      visit_id: visit.visitId,
      referring_visit_id: visit.referringVisitId,
      visit_time: visit.visitTime,
      url: emittableUrl,
      capture_rule: rule.id
    })
  }
}
