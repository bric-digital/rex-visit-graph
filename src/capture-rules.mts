/**
 * Which visits are worth capturing.
 *
 * Rules arrive from server configuration so the set can change without a Chrome
 * Web Store release. Matching is host-suffix plus path-prefix rather than a
 * regular expression: the shapes we need are simple, and a config-supplied regex
 * is a denial-of-service surface in a service worker.
 */

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
  include_url: boolean;
  drain_interval_minutes: number;
  max_hop_age_days: number;
}

export class CaptureRules {
  private rules: CaptureRule[] = []

  update(rules: CaptureRule[] | undefined): void {
    this.rules = Array.isArray(rules) ? rules : []
  }

  match(url: string): CaptureRule | null {
    const parsed = this.parse(url)

    if (parsed === null) {
      return null
    }

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
