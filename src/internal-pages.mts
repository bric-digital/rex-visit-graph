/**
 * Records the browser's own pages, which Chrome keeps out of history entirely.
 *
 * `chrome://` pages, including AI Mode at `chrome://contextual-tasks/`, never
 * reach the history database, so `onVisited` does not fire for them and there is
 * no visit id, referrer or transition to resolve. `tabs.onUpdated` still carries
 * the committed URL, so the page is recorded from there, with the time it was
 * seen. AI-Extension#132.
 *
 * Opt-in through `schemes`, like any scheme beyond http and https: these
 * addresses can carry text the participant typed, such as
 * `chrome://history/?q=`. Schemes Chrome does record in history (`file`,
 * `chrome-extension`) are left to the history path, which has the ids.
 */

import { urlAtDetail, type CaptureRules, type UrlDetail } from './capture-rules.mjs'
import type { CaptureLists } from './capture-lists.mjs'
import { EdgeStore, type StoredRecord } from './edge-store.mjs'

const KEY_PREFIX = 'rexVisitGraphPage:'

/** Edge serves its own pages as `edge://`. */
export const UNRECORDED_SCHEMES = ['chrome', 'chrome-untrusted', 'edge']

export interface PageRecord extends StoredRecord {
  page_id: string;
  tab_id: number;
  url: string | null;
}

export class PageStore extends EdgeStore<PageRecord> {
  constructor() {
    super(KEY_PREFIX, (record) => record.page_id)
  }
}

export interface InternalPageDependencies {
  rules: CaptureRules;
  lists: CaptureLists;
  store: PageStore;
  urlDetail: () => UrlDetail;
}

export class InternalPageRecorder {
  constructor(private readonly deps: InternalPageDependencies) {}

  /** True when the study names any scheme this recorder serves. */
  isWanted(): boolean {
    return UNRECORDED_SCHEMES.some((scheme) => this.deps.rules.capturesScheme(scheme))
  }

  async pageCommitted(tabId: number, url: string): Promise<boolean> {
    if (!isUnrecorded(url)) {
      return false
    }

    const rule = this.deps.rules.decide(url)

    if (rule === null) {
      return false
    }

    if (!(await this.deps.lists.permits(url))) {
      return false
    }

    const seenAt = Date.now()

    await this.deps.store.put({
      page_id: `${tabId}:${seenAt}`,
      tab_id: tabId,
      visit_time: seenAt,
      url: urlAtDetail(url, this.deps.urlDetail()),
      capture_rule: rule.id
    })

    return true
  }
}

function isUnrecorded(url: string): boolean {
  const scheme = url.slice(0, url.indexOf(':')).toLowerCase()
  return UNRECORDED_SCHEMES.includes(scheme)
}
