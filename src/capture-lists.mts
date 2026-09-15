/**
 * Whether a visit may be captured at all, by rex-lists list membership.
 *
 * Separate from the redaction lists in redaction.mts, which decide what a
 * captured address looks like once it has been captured. Capture and redaction
 * are independent axes: narrowing what may be recorded should not silently
 * change what is collected.
 *
 * The names follow rex-history's list configuration so a study states the same
 * kind of thing the same way. One difference is worth stating, because it has no
 * counterpart there: rex-history has no list that drops a visit, since its
 * filter_lists redact the address and still upload the record. A capture block
 * list drops the visit outright, which is what lets a study stop collecting from
 * a host that floods the graph without waiting on a Chrome Web Store release.
 *
 * Both failure directions point the same way. An unreadable block list blocks,
 * and an unreadable allow list matches nothing, so a list that cannot be read
 * captures less rather than more.
 */

import * as listUtils from '@bric/rex-lists'

export interface CaptureListNames {
  /** When non-empty, only URLs matching one of these are captured. */
  capture_allow_lists?: string[];
  /** URLs matching any of these are never captured. Takes precedence. */
  capture_block_lists?: string[];
}

export class CaptureLists {
  private lists: CaptureListNames = {}

  update(lists: CaptureListNames | undefined): void {
    this.lists = lists ?? {}
  }

  /** The lists currently in force. Readable for diagnostics. */
  configuredLists(): CaptureListNames {
    return this.lists
  }

  /** True when no list is configured, so this gate would be a no-op. */
  isEmpty(): boolean {
    return this.names('capture_block_lists').length === 0
      && this.names('capture_allow_lists').length === 0
  }

  /**
   * Blocking wins over allowing, so a study can exclude one host without having
   * to restate every allow list around it.
   */
  async permits(url: string): Promise<boolean> {
    for (const listName of this.names('capture_block_lists')) {
      if (await this.blocks(listName, url)) {
        return false
      }
    }

    const allowLists = this.names('capture_allow_lists')

    if (allowLists.length === 0) {
      return true
    }

    for (const listName of allowLists) {
      if (await this.allows(listName, url)) {
        return true
      }
    }

    return false
  }

  private names(key: keyof CaptureListNames): string[] {
    const value = this.lists[key]
    return Array.isArray(value) ? value : []
  }

  /**
   * A block list that cannot be read blocks. Reporting no match would collect
   * from the host the list exists to exclude, which is the failure it is there
   * to prevent.
   */
  private async blocks(listName: string, url: string): Promise<boolean> {
    try {
      return await this.matches(listName, url)
    } catch (error) {
      console.error(`[rex-visit-graph] Block list ${listName} unreadable, treating as a match:`, error)
      return true
    }
  }

  /** An allow list that cannot be read matches nothing, so capture narrows. */
  private async allows(listName: string, url: string): Promise<boolean> {
    try {
      return await this.matches(listName, url)
    } catch (error) {
      console.error(`[rex-visit-graph] Allow list ${listName} unreadable, treating as no match:`, error)
      return false
    }
  }

  private async matches(listName: string, url: string): Promise<boolean> {
    const entry = (await listUtils.matchDomainAgainstList(url, listName)) ?? null
    return entry !== null
  }
}
