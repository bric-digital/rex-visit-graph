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
 * rather than a regular expression, because config is not code-reviewed the way
 * source is: a pattern like `(a+)+$` backtracks catastrophically on a long
 * non-matching input, and this runs once per visit inside the service worker, so
 * a mistyped rule would hang the worker rather than fail a build. Prefix and
 * suffix matching cannot do that.
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
  /**
   * Schemes to capture, matched case-insensitively and without the trailing
   * colon. Defaults to http and https. A study wanting ftp, file or webdav names
   * them here rather than waiting for a boolean per scheme.
   */
  schemes: string[];
  /**
   * How much of the captured address to keep and emit.
   *
   * `none`  — ids only. The address is discarded once the visit ids are resolved.
   * `path`  — origin and pathname, no query. Identifies what the intermediate
   *           WAS (`google.com/goto` vs `google.com/aclk`) without carrying the
   *           encoded destination a redirector puts in its query string.
   * `full`  — the whole address.
   */
  url_detail: UrlDetail;
  /** Forces `url_detail` to `full` in any build, for diagnosing a deployment. */
  debug: boolean;
  max_hop_age_days: number;
  /** Used only when rex-history states no lists of its own. */
  redaction?: RedactionLists;
}

/** Stands in for "no narrowing configured", so every emitted hop names a rule. */
export type UrlDetail = 'none' | 'path' | 'full'

/** Ordinary browsing. Anything else is opt-in via `schemes`. */
export const DEFAULT_SCHEMES = ['http', 'https']

/** Reduce an address to origin plus pathname, dropping query and fragment. */
export function urlAtDetail(url: string, detail: UrlDetail): string | null {
  if (detail === 'none') {
    return null
  }

  if (detail === 'full') {
    return url
  }

  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return null
  }
}

export const CAPTURE_ALL: CaptureRule = { id: 'all', host_suffix: '*', path_prefix: '' }

export class CaptureRules {
  private rules: CaptureRule[] = []
  private schemes: string[] = [...DEFAULT_SCHEMES]

  update(rules: CaptureRule[]): void {
    // Still guarded: this value comes from JSON, where the type says nothing.
    this.rules = Array.isArray(rules) ? rules : []
  }

  /**
   * Which schemes to capture, without the trailing colon.
   *
   * Defaults to http and https because `chrome://`, `file://` and extension pages
   * are not ordinary browsing, and a study that has not asked for them should not
   * receive them — a local file path is a different kind of disclosure from a web
   * page. A study wanting the complete graph names the schemes it wants.
   */
  setSchemes(schemes: string[]): void {
    this.schemes = (Array.isArray(schemes) ? schemes : DEFAULT_SCHEMES)
      .map((scheme) => scheme.toLowerCase().replace(/:$/, ''))
  }

  /** True when a study has narrowed capture to a stated set of rules. */
  isNarrowed(): boolean {
    return this.rules.length > 0
  }

  /**
   * The rule under which this URL is captured, or null to skip it.
   *
   * Unnarrowed, every visit on a configured scheme is captured under CAPTURE_ALL.
   */
  decide(url: string): CaptureRule | null {
    const parsed = this.parse(url)

    if (parsed === null) {
      return null
    }

    if (!this.schemes.includes(parsed.protocol.replace(/:$/, ''))) {
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
   * Exact host, a true subdomain, or `*` for any host.
   *
   * Compared lowercased because DNS is case-insensitive and a config-supplied
   * host may be written any way. A plain `endsWith` would also match
   * `notgoogle.com` against `google.com` and capture from a host no rule names.
   */
  private hostMatches(hostname: string, suffix: string): boolean {
    if (suffix === '*') {
      return true
    }

    const host = hostname.toLowerCase()
    const wanted = suffix.toLowerCase()

    return host === wanted || host.endsWith(`.${wanted}`)
  }
}
