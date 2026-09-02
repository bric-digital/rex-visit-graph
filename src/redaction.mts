/**
 * Redacts a captured URL using the same rules and precedence rex-history applies.
 *
 * Only relevant when `url_detail` keeps an address. At its default of `none`
 * there is nothing to redact, which is why the module needs no lists to run.
 *
 * Settings resolve to rex-history's first, so a study that has already decided
 * what may be recorded does not have to state it twice and the two modules cannot
 * disagree. A study running this module without rex-history configures the same
 * keys under `visit_graph.redaction`.
 *
 * List CONTENTS are not synced here. Matching reads whatever rex-lists holds in
 * IndexedDB, populated by whichever module owns the sync. An empty database means
 * a configured allow-list matches nothing, so everything redacts: the failure
 * direction is closed, not open.
 */

import * as listUtils from '@bric/rex-lists'

export interface RedactionLists {
  allow_lists?: string[];
  filter_lists?: string[];
  domain_only_lists?: string[];
}

export const REDACTED_DOMAIN_ONLY = 'DOMAIN ONLY'
export const REDACTED_NOT_ALLOWED = 'CATEGORY:NOT_ON_ALLOWLIST'

export class UrlRedactor {
  private lists: RedactionLists = {}

  update(lists: RedactionLists | undefined): void {
    this.lists = lists ?? {}
  }

  /** The lists currently in force, after resolution. Readable for diagnostics. */
  configuredLists(): RedactionLists {
    return this.lists
  }

  /** True when no list is configured, so redaction would be a no-op. */
  isEmpty(): boolean {
    return this.names('allow_lists').length === 0
      && this.names('filter_lists').length === 0
      && this.names('domain_only_lists').length === 0
  }

  /**
   * Returns the URL as it should be recorded.
   *
   * Precedence matches rex-history and the branches are exclusive: a domain-only
   * match wins outright; otherwise a configured allow-list that does not match
   * redacts; otherwise a filter-list match redacts to its category.
   */
  async redact(url: string): Promise<string> {
    if (await this.matchesAny(this.names('domain_only_lists'), url)) {
      return REDACTED_DOMAIN_ONLY
    }

    const allowLists = this.names('allow_lists')

    if (allowLists.length > 0 && !(await this.matchesAny(allowLists, url))) {
      return REDACTED_NOT_ALLOWED
    }

    for (const listName of this.names('filter_lists')) {
      const match = await this.match(listName, url)

      if (match !== null) {
        const category = (match.metadata?.category as string | undefined) ?? null
        return `CATEGORY:${category ?? 'null'}`
      }
    }

    return url
  }

  private names(key: keyof RedactionLists): string[] {
    const value = this.lists[key]
    return Array.isArray(value) ? value : []
  }

  private async matchesAny(listNames: string[], url: string): Promise<boolean> {
    for (const listName of listNames) {
      if (await this.match(listName, url) !== null) {
        return true
      }
    }

    return false
  }

  /**
   * A list that cannot be read is reported as no match rather than throwing, so
   * one broken list cannot stop a hop being emitted. Combined with the
   * precedence above, an unreadable allow-list redacts rather than exposes.
   */
  private async match(listName: string, url: string): Promise<listUtils.ListEntry | null> {
    try {
      return (await listUtils.matchDomainAgainstList(url, listName)) ?? null
    } catch (error) {
      console.error(`[rex-visit-graph] Error checking list ${listName}:`, error)
      return null
    }
  }
}

/**
 * rex-history's settings win when it has any, so the two modules cannot disagree
 * about what may be recorded. `visit_graph.redaction` applies only when rex-history
 * states nothing.
 */
export function resolveRedactionLists(
  historySection: RedactionLists | undefined,
  ownSection: RedactionLists | undefined
): RedactionLists {
  const history: RedactionLists = {
    allow_lists: historySection?.allow_lists ?? [],
    filter_lists: historySection?.filter_lists ?? [],
    domain_only_lists: historySection?.domain_only_lists ?? []
  }

  const historyStatesSomething = (history.allow_lists?.length ?? 0) > 0
    || (history.filter_lists?.length ?? 0) > 0
    || (history.domain_only_lists?.length ?? 0) > 0

  if (historyStatesSomething) {
    return history
  }

  return {
    allow_lists: ownSection?.allow_lists ?? [],
    filter_lists: ownSection?.filter_lists ?? [],
    domain_only_lists: ownSection?.domain_only_lists ?? []
  }
}
