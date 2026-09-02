/**
 * Which visits are worth capturing.
 *
 * The module captures the whole visit graph. Rules are a NARROWING filter, not an
 * allowlist: with none configured every http(s) visit is captured, and a study
 * that wants less states rules to reduce it. That way a redirector nobody has
 * seen yet is captured anyway, rather than going silently uncollected until
 * somebody notices the data is missing.
 *
 * Rules arrive from server configuration so a study can change its own narrowing
 * without a Chrome Web Store release. Matching is host-suffix plus path-prefix
 * rather than a regular expression: the shapes needed are simple, and a
 * config-supplied regex is a denial-of-service surface in a service worker.
 */

import type { RedactionLists } from './redaction.mjs'

export interface CaptureRule {
  /** Stable label emitted with each hop so analysts can tell rules apart. */
  id: string;
  /** Matches this host exactly, or any subdomain of it. */
  host_suffix: string;
  /** Matches when the path starts with this string. */
  path_prefix: string;
}

export interface VisitGraphConfig {
  enabled: boolean;
  capture_rules: CaptureRule[];
  /** Capture visits whose scheme is not http(s). Off by default. */
  include_all_schemes: boolean;
  include_url: boolean;
  drain_interval_minutes: number;
  max_hop_age_days: number;
  /** Used only when rex-history states no lists of its own. */
  redaction?: RedactionLists;
}

/** Stands in for "no narrowing configured", so every emitted hop names a rule. */
export const CAPTURE_ALL: CaptureRule = { id: 'all', host_suffix: '*', path_prefix: '' }

export class CaptureRules {
  private rules: CaptureRule[] = []
  private allSchemes = false

  update(rules: CaptureRule[] | undefined): void {
    this.rules = Array.isArray(rules) ? rules : []
  }

  /**
   * Whether to capture visits outside http(s).
   *
   * Off by default because `chrome://`, `file://` and extension pages are not
   * ordinary browsing and a study that has not asked for them should not receive
   * them — a local file path is a different kind of disclosure from a web page.
   * A study that does want the complete graph turns it on.
   */
  setAllSchemes(value: boolean | undefined): void {
    this.allSchemes = value === true
  }

  /** True when a study has narrowed capture to a stated set of rules. */
  isNarrowed(): boolean {
    return this.rules.length > 0
  }

  /**
   * The rule under which this URL is captured, or null to skip it.
   *
   * Unnarrowed, every http(s) visit is captured under CAPTURE_ALL. Other schemes
   * are skipped unless `include_all_schemes` is on.
   */
  decide(url: string): CaptureRule | null {
    const parsed = this.parse(url)

    if (parsed === null) {
      return null
    }

    if (!this.allSchemes && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }

    if (!this.isNarrowed()) {
      return CAPTURE_ALL
    }

    return this.match(parsed)
  }

  private match(parsed: URL): CaptureRule | null {
    for (const rule of this.rules) {
      if (this.hostMatches(parsed.hostname, rule.host_suffix) && parsed.pathname.startsWith(rule.path_prefix)) {
        return rule
      }
    }

    return null
  }

  private parse(url: string): URL | null {
    try {
      return new URL(url)
    } catch {
      return null
    }
  }

  /**
   * Exact host or a true subdomain. A plain `endsWith` would also match
   * `notgoogle.com` against `google.com` and capture from a host no rule names.
   */
  private hostMatches(hostname: string, suffix: string): boolean {
    return hostname === suffix || hostname.endsWith(`.${suffix}`)
  }
}
