/**
 * Loads the module as a real Chrome extension with real chrome.history,
 * chrome.storage and chrome.alarms.
 *
 * Headless mode is off because Chrome's CDP bridge does not expose extension
 * service workers in headless: a window appears during the run on macOS and
 * Windows; wrap in Xvfb on Linux CI.
 */

import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const GOOGLE_RULES = [{ id: 'google-goto', host_suffix: 'google.com', path_prefix: '/goto' }]


test.describe('rex-visit-graph — real extension', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let serviceWorker: Worker
  let userDataDir: string

  test.beforeAll(async () => {
    const extensionPath = path.join(__dirname, '../extension')
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-visit-graph-'))

    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        // Headed is not a choice: Chrome's CDP bridge does not expose extension
        // service workers in headless mode, so the specs cannot reach the module.
        // Parking the window off-screen keeps it out of the way of whoever is at
        // the keyboard; it still takes focus briefly on launch.
        '--window-position=-3000,-3000',
        '--window-size=800,600',
        // Gives the local server a name that rex-lists will match. Domain list
        // matching resolves a registrable domain, and returns null for both
        // "localhost" and "127.0.0.1" (probed 2026-09-17), so a list cannot name
        // either one. example.com is IANA-reserved, so the name cannot collide
        // with anything real.
        '--host-resolver-rules=MAP dashboard.example.com 127.0.0.1'
      ]
    })

    serviceWorker = context.serviceWorkers()[0]
      ?? await context.waitForEvent('serviceworker', { timeout: 30_000 })
  })

  test.afterAll(async () => {
    await context?.close()
    if (userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  test.beforeEach(async () => {
    await serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.local.get()
      const hopKeys = Object.keys(stored).filter((key) => key.startsWith('rexVisitGraphHop:'))
      if (hopKeys.length > 0) await chrome.storage.local.remove(hopKeys)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []
    })
  })

  // -------------------------------------------------------------------------
  // Capture rules
  // -------------------------------------------------------------------------

  test('matches a Google goto hop', async () => {
    const matched = await serviceWorker.evaluate((rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update(rules)
      const rule = p.captureRules.decide('https://www.google.com/goto?url=CAESUgHrOzAV')
      return rule ? rule.id : null
    }, GOOGLE_RULES)

    expect(matched).toBe('google-goto')
  })

  test('does not match an ordinary Google search page', async () => {
    const matched = await serviceWorker.evaluate((rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update(rules)
      return p.captureRules.decide('https://www.google.com/search?q=home+depot')
    }, GOOGLE_RULES)

    expect(matched).toBeNull()
  })

  test('does not match a lookalike host', async () => {
    const matched = await serviceWorker.evaluate((rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update(rules)
      return p.captureRules.decide('https://notgoogle.com/goto?url=x')
    }, GOOGLE_RULES)

    expect(matched).toBeNull()
  })

  test('ignores a malformed URL instead of throwing', async () => {
    const matched = await serviceWorker.evaluate((rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update(rules)
      return p.captureRules.decide('not a url')
    }, GOOGLE_RULES)

    expect(matched).toBeNull()
  })

  test('with no rules configured, captures any http visit', async () => {
    const decisions = await serviceWorker.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update([])
      return {
        narrowed: p.captureRules.isNarrowed(),
        goto: p.captureRules.decide('https://www.google.com/goto?url=CAES')?.id ?? null,
        ordinary: p.captureRules.decide('https://example.com/some/page')?.id ?? null,
        insecure: p.captureRules.decide('http://example.com/')?.id ?? null,
      }
    })

    expect(decisions.narrowed).toBe(false)
    expect(decisions.goto).toBe('all')
    expect(decisions.ordinary).toBe('all')
    expect(decisions.insecure).toBe('all')
  })

  test('skips non-http schemes unless asked for them', async () => {
    const decisions = await serviceWorker.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update([])
      p.captureRules.setSchemes(['http', 'https'])
      return [
        p.captureRules.decide('chrome://history/'),
        p.captureRules.decide('file:///Users/someone/private.pdf'),
        p.captureRules.decide('chrome-extension://abc/page.html'),
      ]
    })

    expect(decisions).toEqual([null, null, null])
  })

  test('other schemes are captured only when named, and are not by default', async () => {
    const result = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: {} })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      const configuredDefault = p.currentConfig().schemes
      const byDefault = p.captureRules.decide('file:///Users/someone/private.pdf')

      await chrome.storage.local.set({
        REXConfiguration: { visit_graph: { schemes: ['http', 'https', 'file', 'CHROME'] } }
      })
      await p.refreshConfiguration()

      return {
        configuredDefault,
        byDefault,
        file: p.captureRules.decide('file:///Users/someone/private.pdf')?.id ?? null,
        // Named in mixed case in the config above, matched case-insensitively.
        chromeUrl: p.captureRules.decide('chrome://history/')?.id ?? null,
        stillSkipsGarbage: p.captureRules.decide('not a url'),
      }
    })

    expect(result.configuredDefault).toEqual(['http', 'https'])
    expect(result.byDefault).toBeNull()
    expect(result.file).toBe('all')
    expect(result.chromeUrl).toBe('all')
    // An unparseable value is still not a visit, whatever the scheme setting.
    expect(result.stillSkipsGarbage).toBeNull()
  })

  test('rules narrow capture rather than enabling it', async () => {
    const decisions = await serviceWorker.evaluate((rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update(rules)
      return {
        narrowed: p.captureRules.isNarrowed(),
        matching: p.captureRules.decide('https://www.google.com/goto?url=CAES')?.id ?? null,
        other: p.captureRules.decide('https://example.com/some/page')?.id ?? null,
      }
    }, GOOGLE_RULES)

    expect(decisions.narrowed).toBe(true)
    expect(decisions.matching).toBe('google-goto')
    // Captured when unnarrowed, skipped once a study states rules.
    expect(decisions.other).toBeNull()
  })

  test('does not hold the URL when it will not be emitted', async () => {
    const stored = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: { visit_graph: { url_detail: 'none' } } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()

      const real = chrome.history.getVisits
      chrome.history.getVisits = async () => ([
        { id: '1', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true }
      ]) as never
      try {
        await p.captureVisit({ id: '1', url: 'https://example.com/private/page?token=secret' })
      } finally {
        chrome.history.getVisits = real
      }

      return await p.hopStore.readAll()
    })

    expect(stored).toHaveLength(1)
    // The address did its job resolving the ids and is not kept.
    expect(stored[0].url).toBeNull()
    expect(stored[0].visit_id).toBe('5')
  })

  test('host matching is case-insensitive, and * matches any host', async () => {
    const decisions = await serviceWorker.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.setSchemes(['http', 'https'])

      // DNS is case-insensitive, so a rule written in any case must match.
      p.captureRules.update([{ id: 'mixed', host_suffix: 'GOOGLE.com', path_prefix: '/goto' }])
      const upperRule = p.captureRules.decide('https://WWW.Google.COM/goto?url=x')?.id ?? null
      const stillNotLookalike = p.captureRules.decide('https://notgoogle.com/goto')

      // `*` is what CAPTURE_ALL uses; it must also work written in config.
      p.captureRules.update([{ id: 'any', host_suffix: '*', path_prefix: '/goto' }])
      const wildcard = p.captureRules.decide('https://anything.example/goto')?.id ?? null
      const wildcardWrongPath = p.captureRules.decide('https://anything.example/other')

      return { upperRule, stillNotLookalike, wildcard, wildcardWrongPath }
    })

    expect(decisions.upperRule).toBe('mixed')
    expect(decisions.stillNotLookalike).toBeNull()
    expect(decisions.wildcard).toBe('any')
    expect(decisions.wildcardWrongPath).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  test('stores a hop under its own key', async () => {
    const stored = await serviceWorker.evaluate(async (rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update(rules)
      const real = chrome.history.getVisits
      chrome.history.getVisits = async () => ([
        { id: '1', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true }
      ]) as never
      try {
        await p.captureVisit({ id: '1', url: 'https://www.google.com/goto?url=CAES' })
      } finally {
        chrome.history.getVisits = real
      }
      const all = await chrome.storage.local.get()
      return Object.keys(all).filter((key) => key.startsWith('rexVisitGraphHop:'))
    }, GOOGLE_RULES)

    expect(stored).toEqual(['rexVisitGraphHop:5'])
  })

  test('ignores a visit that matches no rule', async () => {
    const stored = await serviceWorker.evaluate(async (rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update(rules)
      await p.captureVisit({ id: '1', url: 'https://www.google.com/search?q=x' })
      return await p.hopStore.readAll()
    }, GOOGLE_RULES)

    expect(stored).toHaveLength(0)
  })

  test('captures even when no configuration has loaded', async () => {
    const stored = await serviceWorker.evaluate(async (rules) => {
      await chrome.storage.local.remove('REXConfiguration')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update(rules)
      const real = chrome.history.getVisits
      chrome.history.getVisits = async () => ([
        { id: '1', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true }
      ]) as never
      try {
        await p.captureVisit({ id: '1', url: 'https://www.google.com/goto?url=CAES' })
      } finally {
        chrome.history.getVisits = real
      }
      return await p.hopStore.readAll()
    }, GOOGLE_RULES)

    expect(stored).toHaveLength(1)
  })

  test('concurrent captures do not overwrite each other', async () => {
    const count = await serviceWorker.evaluate(async (rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update(rules)
      const writes = []
      for (let index = 0; index < 20; index += 1) {
        writes.push(p.hopStore.record(
          { visitId: String(index), referringVisitId: String(index - 1), visitTime: Date.now() + index },
          `https://www.google.com/goto?url=CAES${index}`,
          rules[0]
        ))
      }
      await Promise.all(writes)
      return (await p.hopStore.readAll()).length
    }, GOOGLE_RULES)

    expect(count).toBe(20)
  })

  // -------------------------------------------------------------------------
  // Drain
  // -------------------------------------------------------------------------

  test('emits one point per stored hop, ids only, and clears the store', async () => {
    const result = await serviceWorker.evaluate(async (rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      // url_detail defaults to 'none', so capture stores no address at all.
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, null, rules[0])
      await p.hopStore.record({ visitId: '9', referringVisitId: '8', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, null, rules[0])

      const count = await p.drain()
      const remaining = await p.hopStore.readAll()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const events = (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-visit-graph-hop')
      return { count, remaining: remaining.length, events }
    }, GOOGLE_RULES)

    expect(result.count).toBe(2)
    expect(result.remaining).toBe(0)
    expect(result.events).toHaveLength(2)
    expect(result.events[0].visit_id).toBe('5')
    expect(result.events[0].referring_visit_id).toBe('4')
    expect(result.events[0].capture_rule).toBe('google-goto')
    expect(result.events[0].url).toBeUndefined()
  })

  test('a hop stranded by a worker kill is emitted after restart', async () => {
    const emitted = await serviceWorker.evaluate(async (rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, 'https://www.google.com/goto?url=CAES', rules[0])

      // A worker killed mid-drain leaves the guard set in the dead instance. The
      // replacement reconstructs it clear, and the stored hop is still there.
      p.simulateDrainInterrupted(true)
      p.simulateWorkerRestart()

      return await p.drain()
    }, GOOGLE_RULES)

    expect(emitted).toBe(1)
  })

  test('a second drain during the first is refused, not queued', async () => {
    const counts = await serviceWorker.evaluate(async (rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, 'https://www.google.com/goto?url=CAES', rules[0])
      return await Promise.all([p.drain(), p.drain()])
    }, GOOGLE_RULES)

    expect(counts.filter((count) => count > 0)).toHaveLength(1)
    expect(counts).toContain(0)
  })

  test('sweep drops hops older than the cutoff', async () => {
    const remaining = await serviceWorker.evaluate(async (rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      const old = Date.now() - 60_000
      await p.hopStore.record({ visitId: '1', referringVisitId: '0', visitTime: old, url: 'x', url: 'https://www.google.com/goto?u' }, null, rules[0])
      await p.hopStore.record({ visitId: '2', referringVisitId: '1', visitTime: Date.now(), url: 'x', url: 'https://www.google.com/goto?u' }, null, rules[0])
      await p.hopStore.sweep(Date.now() - 30_000)
      return (await p.hopStore.readAll()).map((r: { visit_id: string }) => r.visit_id)
    }, GOOGLE_RULES)

    expect(remaining).toEqual(['2'])
  })

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  test('narrows nothing when the server sends no configuration', async () => {
    const config = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: {} })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      return p.currentConfig()
    })

    expect(config.enabled).toBe(true)
    expect(config.url_detail).toBe('none')
    expect(config.debug).toBe(false)
    // No rules by default: capture the whole graph, let a study narrow it. Naming
    // sites here would make the module's default a client override, and would
    // leave any redirector nobody has seen yet silently uncollected.
    expect(config.capture_rules).toEqual([])
  })

  test('server configuration replaces the defaults', async () => {
    const config = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        REXConfiguration: {
          visit_graph: {
            enabled: true,
            capture_rules: [{ id: 'example', host_suffix: 'example.com', path_prefix: '/r' }],
            url_detail: 'none',
            max_hop_age_days: 3
          }
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      return p.currentConfig()
    })

    expect(config.capture_rules).toHaveLength(1)
    expect(config.capture_rules[0].id).toBe('example')
  })

  test('triggerVisitGraphDrain emits stored hops and answers with the count', async () => {
    const result = await serviceWorker.evaluate(async (rules) => {
      await chrome.storage.local.set({ REXConfiguration: {} })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, 'https://www.google.com/goto?url=CAES', rules[0])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []

      const count = await new Promise((resolve) => {
        p.handleMessage({ messageType: 'triggerVisitGraphDrain' }, null, resolve)
      })

      return { count, remaining: (await p.hopStore.readAll()).length }
    }, GOOGLE_RULES)

    expect(result.count).toBe(1)
    expect(result.remaining).toBe(0)
  })

  test('an unrelated message is not claimed', async () => {
    const claimed = await serviceWorker.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      return p.handleMessage({ messageType: 'getIdentifier' }, null, () => {})
    })

    expect(claimed).toBe(false)
  })

  test("url_detail 'full' puts the whole address on the emitted point", async () => {
    const events = await serviceWorker.evaluate(async (rules) => {
      await chrome.storage.local.set({
        REXConfiguration: {
          visit_graph: {
            enabled: true,
            capture_rules: rules,
            url_detail: 'full',
            max_hop_age_days: 7
          }
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, 'https://www.google.com/goto?url=CAES', rules[0])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []
      await p.drain()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-visit-graph-hop')
    }, GOOGLE_RULES)

    expect(events).toHaveLength(1)
    expect(events[0].url).toBe('https://www.google.com/goto?url=CAES')
  })

  test('disabling the module stops capture', async () => {
    const stored = await serviceWorker.evaluate(async (rules) => {
      await chrome.storage.local.set({
        REXConfiguration: {
          visit_graph: {
            enabled: false,
            capture_rules: rules,
            url_detail: 'none',
            max_hop_age_days: 7
          }
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      await p.captureVisit({ id: '1', url: 'https://www.google.com/goto?url=CAES' })
      return await p.hopStore.readAll()
    }, GOOGLE_RULES)

    expect(stored).toHaveLength(0)
  })

  test('a disabled module emits nothing, including hops captured before config arrived', async () => {
    // Capture rules are seeded with the defaults before configuration loads, so a
    // cold worker does not miss hops. On an arm where the module is disabled that
    // window can still capture, and the host calls triggerVisitGraphDrain on its
    // own cadence — so "disabled" has to mean nothing is emitted, not merely that
    // the drain alarm is never scheduled.
    const result = await serviceWorker.evaluate(async (rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, 'https://www.google.com/goto?url=CAES', rules[0])

      await chrome.storage.local.set({
        REXConfiguration: { visit_graph: { enabled: false, capture_rules: rules } }
      })
      await p.refreshConfiguration()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []
      const viaMessage = await new Promise((resolve) => {
        p.handleMessage({ messageType: 'triggerVisitGraphDrain' }, null, resolve)
      })
      const viaAlarm = await p.drain()

      return {
        viaMessage,
        viaAlarm,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        emitted: (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-visit-graph-hop').length,
        stillStored: (await p.hopStore.readAll()).length,
      }
    }, GOOGLE_RULES)

    expect(result.emitted).toBe(0)
    expect(result.viaMessage).toBe(0)
    expect(result.viaAlarm).toBe(0)
    // Nothing captured while disabled may sit waiting for a later re-enable.
    expect(result.stillStored).toBe(0)
  })

  test('a disabled module refuses to drain a hop that arrives after it was turned off', async () => {
    // Isolates the drain guard from the purge. The purge empties the store at
    // configuration time; this covers a hop reaching the store afterwards, which
    // the guard is the only thing standing in front of.
    const result = await serviceWorker.evaluate(async (rules) => {
      await chrome.storage.local.set({
        REXConfiguration: { visit_graph: { enabled: false, capture_rules: rules } }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()

      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, 'https://www.google.com/goto?url=CAES', rules[0])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []
      const drained = await p.drain()

      return {
        drained,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        emitted: (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-visit-graph-hop').length,
      }
    }, GOOGLE_RULES)

    expect(result.drained).toBe(0)
    expect(result.emitted).toBe(0)
  })

  test('narrowing discards hops captured before configuration arrived', async () => {
    const result = await serviceWorker.evaluate(async (rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin

      // Two hops as a cold worker would have them: one caught before any rules
      // existed, one under a rule the study went on to state.
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, null,
        { id: 'all', host_suffix: '*', path_prefix: '' })
      await p.hopStore.record({ visitId: '9', referringVisitId: '8', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, null, rules[0])

      await chrome.storage.local.set({ REXConfiguration: { visit_graph: { capture_rules: rules } } })
      await p.refreshConfiguration()

      return (await p.hopStore.readAll()).map((h: { visit_id: string, capture_rule: string }) =>
        [h.visit_id, h.capture_rule])
    }, GOOGLE_RULES)

    // The provisional one goes; the one the study asked for stays.
    expect(result).toEqual([['9', 'google-goto']])
  })

  test('an unnarrowed study keeps what was captured before configuration', async () => {
    const result = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, null,
        { id: 'all', host_suffix: '*', path_prefix: '' })

      await chrome.storage.local.set({ REXConfiguration: { visit_graph: {} } })
      await p.refreshConfiguration()

      return (await p.hopStore.readAll()).length
    })

    // Nothing was narrowed, so nothing was asked to be dropped.
    expect(result).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Redaction (include_url only)
  // -------------------------------------------------------------------------

  test("rex-history's lists win when it states any", async () => {
    const lists = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        REXConfiguration: {
          history: { allow_lists: ['history-allow'], filter_lists: [], domain_only_lists: [] },
          visit_graph: { redaction: { allow_lists: ['our-own'] } }
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      return p.redactor.configuredLists()
    })

    expect(lists.allow_lists).toEqual(['history-allow'])
  })

  test('our own lists apply only when rex-history states none', async () => {
    const lists = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        REXConfiguration: {
          history: { allow_lists: [], filter_lists: [], domain_only_lists: [] },
          visit_graph: { redaction: { allow_lists: ['our-own'] } }
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      return p.redactor.configuredLists()
    })

    expect(lists.allow_lists).toEqual(['our-own'])
  })

  test('a URL off a configured allow-list is redacted before it is emitted', async () => {
    const events = await serviceWorker.evaluate(async (rules) => {
      await chrome.storage.local.set({
        REXConfiguration: {
          history: { allow_lists: ['nonempty-list'], filter_lists: [], domain_only_lists: [] },
          visit_graph: { capture_rules: rules, url_detail: 'full' }
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, 'https://www.google.com/goto?url=CAES', rules[0])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []
      await p.drain()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-visit-graph-hop')
    }, GOOGLE_RULES)

    // The list is empty in IndexedDB, so nothing matches it. An allow-list that
    // matches nothing must redact rather than pass the URL through.
    expect(events).toHaveLength(1)
    expect(events[0].url).toBe('CATEGORY:NOT_ON_ALLOWLIST')
    expect(events[0].visit_id).toBe('5')
  })

  test('with no lists anywhere, a kept address is emitted unchanged', async () => {
    const events = await serviceWorker.evaluate(async (rules) => {
      await chrome.storage.local.set({
        REXConfiguration: { visit_graph: { capture_rules: rules, url_detail: 'full' } }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now(), url: 'https://www.google.com/goto?u' }, 'https://www.google.com/goto?url=CAES', rules[0])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []
      await p.drain()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-visit-graph-hop')
    }, GOOGLE_RULES)

    expect(events[0].url).toBe('https://www.google.com/goto?url=CAES')
  })

  test('describes its own configuration surface', async () => {
    const details = await serviceWorker.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (self as any).rexVisitGraphPlugin.configurationDetails()
    })

    // Keyed by the config section it reads, matching rex-page-manipulation.
    expect(Object.keys(details)).toEqual(['visit_graph'])
    expect(Object.keys(details.visit_graph.capture_rules[0]).sort()).toEqual(
      ['host_suffix', 'id', 'path_prefix']
    )
  })

  test('describes every setting it actually reads', async () => {
    // Compared against the live config rather than a hardcoded list, so adding a
    // setting without describing it fails here instead of silently shipping a
    // config surface only the source reveals.
    const { described, inUse } = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: {} })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      return {
        described: Object.keys(p.configurationDetails().visit_graph).sort(),
        inUse: Object.keys(p.currentConfig()).sort(),
      }
    })

    expect(inUse.filter((key: string) => !described.includes(key))).toEqual([])
  })

  test("url_detail 'path' keeps what the intermediate was, not where it pointed", async () => {
    const result = await serviceWorker.evaluate(async (rules) => {
      await chrome.storage.local.set({
        REXConfiguration: { visit_graph: { capture_rules: rules, url_detail: 'path' } }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()

      const real = chrome.history.getVisits
      chrome.history.getVisits = async () => ([
        { id: '1', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true }
      ]) as never
      try {
        await p.captureVisit({ id: '1', url: 'https://www.google.com/goto?url=CAESqgEB6zswFTni' })
      } finally {
        chrome.history.getVisits = real
      }

      const stored = await p.hopStore.readAll()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []
      await p.drain()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const events = (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-visit-graph-hop')
      return { stored: stored[0].url, emitted: events[0].url }
    }, GOOGLE_RULES)

    // Says it was a /goto rather than an /aclk; carries none of the encoded
    // destination the redirector puts in its query.
    expect(result.emitted).toBe('https://www.google.com/goto')
    // And the query is never held, not merely not emitted.
    expect(result.stored).toBe('https://www.google.com/goto')
  })

  test('debug forces full addresses in any build, and says so', async () => {
    const result = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        REXConfiguration: { visit_graph: { url_detail: 'none', debug: true } }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      return { detail: p.urlDetail(), configured: p.currentConfig().url_detail }
    })

    expect(result.configured).toBe('none')
    expect(result.detail).toBe('full')
  })

  test('updateConfiguration applies settings without a server round trip', async () => {
    // Synchronous and directly callable, which is the point: a host or a test can
    // configure the module without a served config to fetch.
    const result = await serviceWorker.evaluate((rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      const returned = p.updateConfiguration({ capture_rules: rules, url_detail: 'path' })

      return {
        isPromise: returned instanceof Promise,
        detail: p.currentConfig().url_detail,
        narrowed: p.captureRules.isNarrowed(),
        matches: p.captureRules.decide('https://www.google.com/goto?u=1')?.id ?? null,
      }
    }, GOOGLE_RULES)

    expect(result.isPromise).toBe(false)
    expect(result.detail).toBe('path')
    expect(result.narrowed).toBe(true)
    expect(result.matches).toBe('google-goto')
  })

  test('the module owns no alarm; the host drives draining', async () => {
    const alarms = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: { visit_graph: {} } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (self as any).rexVisitGraphPlugin.refreshConfiguration()
      return (await chrome.alarms.getAll()).map((a) => a.name)
    })

    // The host extension owns what runs when; a module scheduling itself would be
    // invisible in that accounting.
    expect(alarms.filter((n: string) => n.includes('visit-graph'))).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Listener registration
  // -------------------------------------------------------------------------

  test('registers its history listener in setup(), not at module scope', async () => {
    // Chris's position, 2026-09-02: listeners belong in setup() and are gated on
    // whether the module is enabled, rather than listening regardless. Asserted
    // against the source because the alternative shape is invisible at runtime —
    // both register a listener; they differ in when and under what conditions.
    const fs = await import('node:fs')
    const source = fs.readFileSync(path.join(__dirname, '../../src/service-worker.mts'), 'utf8')

    const listenerAt = source.indexOf('chrome.history.onVisited.addListener')
    const classEndsAt = source.indexOf('const plugin = new VisitGraphServiceWorkerModule()')

    // Inside the class, reached from setup(), rather than at module scope.
    expect(listenerAt).toBeGreaterThan(-1)
    expect(listenerAt).toBeLessThan(classEndsAt)
    // Nothing may register a listener at module scope.
    expect(source.slice(classEndsAt).includes('addListener')).toBe(false)
    // And the module schedules nothing of its own.
    expect(source.includes('chrome.alarms.create')).toBe(false)
  })

  test('setup() called twice does not stack listeners', async () => {
    const calls = await serviceWorker.evaluate(async (rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await chrome.storage.local.set({ REXConfiguration: { visit_graph: { capture_rules: rules } } })
      await p.setup()
      await p.setup()

      const real = chrome.history.getVisits
      let seen = 0
      chrome.history.getVisits = async () => {
        seen += 1
        return [{ id: '1', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true }] as never
      }
      try {
        await p.captureVisit({ id: '1', url: 'https://www.google.com/goto?u=1' })
      } finally {
        chrome.history.getVisits = real
      }
      return seen
    }, GOOGLE_RULES)

    expect(calls).toBe(1)
  })

  test('a disabled module captures nothing even if captureVisit is called directly', async () => {
    // Chris, 2026-09-02: "if something goofs up the gate check for some reason,
    // we're gathering data when we shouldn't be." Removing the listener is the
    // outer guard; this is the inner one. Both must hold independently.
    const stored = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: { visit_graph: { enabled: false } } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()

      const real = chrome.history.getVisits
      chrome.history.getVisits = async () => ([
        { id: '1', visitId: '77', referringVisitId: '76', visitTime: Date.now(), transition: 'link', isLocal: true }
      ]) as never
      try {
        await p.captureVisit({ id: '1', url: 'https://example.com/anything' })
      } finally {
        chrome.history.getVisits = real
      }

      return (await p.hopStore.readAll()).length
    })

    expect(stored).toBe(0)
  })

  test('a disabled module holds no listener at all', async () => {
    const states = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin

      await chrome.storage.local.set({ REXConfiguration: { visit_graph: { enabled: true } } })
      await p.refreshConfiguration()
      const whenEnabled = p.isListening()

      await chrome.storage.local.set({ REXConfiguration: { visit_graph: { enabled: false } } })
      await p.refreshConfiguration()
      const whenDisabled = p.isListening()

      // And it comes back, rather than being a one-way door.
      await chrome.storage.local.set({ REXConfiguration: { visit_graph: { enabled: true } } })
      await p.refreshConfiguration()
      const whenReEnabled = p.isListening()

      return { whenEnabled, whenDisabled, whenReEnabled }
    })

    // Chris, 2026-09-02: "we shouldn't be listening when the module is disabled".
    // Not a listener that declines to act — no listener.
    expect(states.whenEnabled).toBe(true)
    expect(states.whenDisabled).toBe(false)
    expect(states.whenReEnabled).toBe(true)
  })

  test('listens before configuration arrives, since a missed visit is unrecoverable', async () => {
    const listening = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await chrome.storage.local.set({ REXConfiguration: { visit_graph: { enabled: false } } })
      await p.refreshConfiguration()

      // setup() starts listening synchronously, before it awaits the fetch.
      const promise = p.setup()
      const duringFetch = p.isListening()
      await promise

      return { duringFetch, afterFetch: p.isListening() }
    })

    expect(listening.duringFetch).toBe(true)
    // ...and the disabled configuration then takes the listener away again.
    expect(listening.afterFetch).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Capture lists
  //
  // Whether a visit is captured at all, as distinct from the redaction lists
  // above, which decide what a captured address looks like. Seeded as real
  // rex-lists entries in real IndexedDB, so these exercise the same matching
  // path a study's server-synced lists would.
  // -------------------------------------------------------------------------

  const BLOCKED = 'https://dashboard.example.com/participant'
  const ORDINARY = 'https://www.google.com/goto?url=CAESUgHrOzAV'

  /**
   * Captures one visit and reports both the outcome and whether the visit
   * lookup was reached, since the gate is only worth having if it runs before
   * the expensive call.
   */
  async function tryCapture(url: string, config: Record<string, unknown>) {
    return serviceWorker.evaluate(async ({ url, config }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin

      // Seed with the listener off, so recording the visit does not capture it
      // through onVisited before the spec calls captureVisit itself. The visit
      // has to exist for the lookup to resolve ids at all.
      p.updateConfiguration({ enabled: false })
      await chrome.history.addUrl({ url })

      // Scope is pinned to 'all' because these cover the lists, not the scope.
      // Under the default scope the seeded visit is one history can see, so
      // every case here would skip for that reason and prove nothing about lists.
      p.updateConfiguration({ ...config, capture_scope: 'all' })

      let lookups = 0
      const realGetVisits = chrome.history.getVisits
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(chrome.history as any).getVisits = (details: { url: string }) => {
        lookups++
        return realGetVisits.call(chrome.history, details)
      }

      try {
        const captured = await p.captureVisit({ url, title: '', lastVisitTime: Date.now(), visitCount: 1, typedCount: 0, id: '1' })
        return { captured, lookups }
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(chrome.history as any).getVisits = realGetVisits
      }
    }, { url, config })
  }

  async function seedList(listName: string, pattern: string) {
    await serviceWorker.evaluate(async ({ listName, pattern }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lists = (self as any).__listUtils
      await lists.deleteAllEntriesInList(listName, 'generated')
      await lists.bulkCreateListEntries([
        { list_name: listName, pattern, pattern_type: 'domain', source: 'generated', metadata: {} }
      ])
    }, { listName, pattern })
  }

  test('a visit on a block list is not captured, and costs no visit lookup', async () => {
    await seedList('vg-block', 'example.com')

    const result = await tryCapture(BLOCKED, { capture_block_lists: ['vg-block'] })

    expect(result.captured).toBe(false)
    // The gate has to sit ahead of getVisits, which is the 1.3-1.5s call this
    // whole change exists to avoid paying on an excluded host.
    expect(result.lookups).toBe(0)
  })

  test('a visit not on the block list is still captured', async () => {
    await seedList('vg-block', 'example.com')

    const result = await tryCapture(ORDINARY, { capture_block_lists: ['vg-block'] })

    expect(result.captured).toBe(true)
  })

  test('with an allow list configured, a non-matching visit is not captured', async () => {
    await seedList('vg-allow', 'google.com')

    const result = await tryCapture(BLOCKED, { capture_allow_lists: ['vg-allow'] })

    expect(result.captured).toBe(false)
    expect(result.lookups).toBe(0)
  })

  test('with an allow list configured, a matching visit is captured', async () => {
    await seedList('vg-allow', 'google.com')

    const result = await tryCapture(ORDINARY, { capture_allow_lists: ['vg-allow'] })

    expect(result.captured).toBe(true)
  })

  test('a block list wins over an allow list naming the same host', async () => {
    await seedList('vg-allow', 'google.com')
    await seedList('vg-block', 'google.com')

    const result = await tryCapture(ORDINARY, {
      capture_allow_lists: ['vg-allow'],
      capture_block_lists: ['vg-block']
    })

    expect(result.captured).toBe(false)
  })

  test('no capture lists leaves capture exactly as it was', async () => {
    const result = await tryCapture(BLOCKED, {})

    // Premise for every negative case above: this URL is capturable by default,
    // so the false results are the lists acting and not some other refusal.
    expect(result.captured).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Capture scope
  //
  // Driven through a real redirect rather than a synthesised HistoryItem: what
  // is under test is Chrome's own treatment of a redirect chain, and a hand-made
  // item would let the test pass while the real distinction failed.
  // -------------------------------------------------------------------------

  test.describe('capture scope', () => {
    const PORT = 8793
    const ORIGIN = `http://127.0.0.1:${PORT}`
    let server: import('http').Server

    test.beforeAll(async () => {
      const http = await import('http')
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', ORIGIN)

        if (url.pathname === '/start') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<!doctype html><meta charset="utf-8">'
            + '<a id="go" href="/hop">go</a>'
            + '<a id="client" href="/client-hop">client</a>'
            + '<a id="meta" href="/meta-hop">meta</a>')
          return
        }

        if (url.pathname === '/hop') {
          res.writeHead(302, { location: '/landing' })
          res.end()
          return
        }

        // A redirector that is a real document and replaces itself once its
        // script runs. History search returns it until it does, which is why it
        // needs a second look rather than the one the 302 above needs.
        if (url.pathname === '/client-hop') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<!doctype html><meta charset="utf-8">'
            + '<script>location.replace("/client-landing")</script>')
          return
        }

        // The same shape, driven by the parser rather than by script.
        if (url.pathname === '/meta-hop') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<!doctype html><meta charset="utf-8">'
            + '<meta http-equiv="refresh" content="0;url=/meta-landing">')
          return
        }

        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><meta charset="utf-8"><h1>${url.pathname}</h1>`)
      })
      await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))
    })

    test.afterAll(async () => {
      // close() alone waits on keep-alive sockets the browser is holding open,
      // which outlasts the hook timeout.
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    /** Click through start -> hop -> landing, then report what was kept. */
    async function walkRedirect(scope: 'hops' | 'all', linkId: string = 'go') {
      await serviceWorker.evaluate(async (scope) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexVisitGraphPlugin
        p.updateConfiguration({ capture_scope: scope, url_detail: 'full' })
        const stored = await chrome.storage.local.get()
        const keys = Object.keys(stored).filter((k) => k.startsWith('rexVisitGraphHop:'))
        if (keys.length > 0) await chrome.storage.local.remove(keys)
      }, scope)

      const tab = await context.newPage()
      await tab.goto(`${ORIGIN}/start`)
      await tab.click(`#${linkId}`)
      await tab.waitForLoadState('load')
      await tab.waitForTimeout(700)
      await tab.close()

      return serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexVisitGraphPlugin
        const records = await p.hopStore.readAll()
        return records.map((r: { url: string | null }) => r.url)
      })
    }

    test("scope 'hops' keeps the redirect and drops the pages history can see", async () => {
      const urls = await walkRedirect('hops')

      // The hop is the whole point: no collector can see it any other way.
      expect(urls).toContain(`${ORIGIN}/hop`)
      // These two are returned by history.search(), so rex-history reports them
      // already, with the same visit ids this module would have emitted.
      expect(urls).not.toContain(`${ORIGIN}/start`)
      expect(urls).not.toContain(`${ORIGIN}/landing`)
    })

    test("scope 'all' still captures everything, so a study can revert", async () => {
      const urls = await walkRedirect('all')

      // Premise for the test above: without the scope these ARE captured, so the
      // absences there are the scope acting rather than a navigation that never
      // happened.
      expect(urls).toContain(`${ORIGIN}/hop`)
      expect(urls).toContain(`${ORIGIN}/landing`)
    })

    // A client-side redirector is a document, so unlike a 302 it is an ordinary
    // visit at the moment onVisited fires and history search returns it. Chrome
    // reclassifies it once the replacement happens, after which no collector
    // enumerating with search() can see it. Deciding on the first answer drops
    // the hop from every export.
    test("scope 'hops' keeps a redirect done with location.replace", async () => {
      const urls = await walkRedirect('hops', 'client')

      expect(urls).toContain(`${ORIGIN}/client-hop`)
      expect(urls).not.toContain(`${ORIGIN}/client-landing`)
    })

    test("scope 'hops' keeps a redirect done with a meta refresh", async () => {
      const urls = await walkRedirect('hops', 'meta')

      expect(urls).toContain(`${ORIGIN}/meta-hop`)
      expect(urls).not.toContain(`${ORIGIN}/meta-landing`)
    })

    test("scope 'all' captures the client redirects too", async () => {
      // Premise for the two above, the same way the 302 has one: these are
      // captured when the scope is not applied, so a miss under 'hops' is the
      // scope deciding rather than a navigation that never happened.
      const viaScript = await walkRedirect('all', 'client')
      expect(viaScript).toContain(`${ORIGIN}/client-hop`)

      const viaMeta = await walkRedirect('all', 'meta')
      expect(viaMeta).toContain(`${ORIGIN}/meta-hop`)
    })
  })

  // -------------------------------------------------------------------------
  // Tab opener edges
  //
  // Chrome records no referring visit across a tab boundary, so a result opened
  // in a new tab arrives with referringVisitId "0". These drive real new tabs
  // from a real page, because what is under test is what Chrome exposes on
  // chrome.tabs when a page opens one; a synthesised event would pass while the
  // real signal changed shape. Measured 2026-09-10: openerTabId is always
  // present, pendingUrl is not, and tabs.onUpdated carries the committed URL.
  // -------------------------------------------------------------------------

  test.describe('tab opener edges', () => {
    const PORT = 8794
    const ORIGIN = `http://127.0.0.1:${PORT}`
    let server: import('http').Server

    test.beforeAll(async () => {
      const http = await import('http')
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', ORIGIN)

        if (url.pathname === '/start') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<!doctype html><meta charset="utf-8">'
            + '<a id="same" href="/landing-same">same</a>'
            + '<a id="blank" href="/landing-blank" target="_blank">blank</a>'
            + '<a id="redirect" href="/hop" target="_blank">redirect</a>'
            + '<button id="open-empty" onclick="var w = window.open(\'\'); '
            + 'setTimeout(function () { w.location = \'/landing-open-empty\' }, 200)">open</button>'
            + '<button id="open-window" onclick="window.open(\'/landing-window\', \'_blank\', \'popup,width=600,height=400\')">window</button>')
          return
        }

        if (url.pathname === '/hop') {
          res.writeHead(302, { location: '/landing-redirect' })
          res.end()
          return
        }

        // Opens a tab, for testing the opener visit ceiling. Same host is fine
        // here: what varies is the opener's visit count, not its name.
        if (url.pathname === '/start-ceiling') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<!doctype html><meta charset="utf-8">'
            + '<a id="blank" href="/landing-ceiling" target="_blank">blank</a>')
          return
        }

        // Opens a tab on a different host from its own, so a block list can name
        // the opener without also naming what it opens. Same server either way.
        if (url.pathname === '/start-cross') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<!doctype html><meta charset="utf-8">'
            + `<a id="blank" href="http://127.0.0.1:${PORT}/landing-cross" target="_blank">blank</a>`)
          return
        }

        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><meta charset="utf-8"><h1>${url.pathname}</h1>`)
      })
      await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))
    })

    test.afterAll(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    test.beforeEach(async () => {
      await serviceWorker.evaluate(async () => {
        const keys = (await chrome.storage.local.getKeys())
          .filter((key) => key.startsWith('rexVisitGraphHop:') || key.startsWith('rexVisitGraphOpener:'))
        if (keys.length > 0) await chrome.storage.local.remove(keys)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(self as any).__capturedEvents = []
      })
    })

    /** The newest visit Chrome holds for a URL, as analysis would see it. */
    async function newestVisit(url: string) {
      return serviceWorker.evaluate(async (url) => {
        const visits = await chrome.history.getVisits({ url })
        const newest = visits.reduce((best, v) => (best === null || (v.visitTime ?? 0) > (best.visitTime ?? 0) ? v : best), null as chrome.history.VisitItem | null)
        return newest === null ? null : { visitId: newest.visitId, referringVisitId: newest.referringVisitId }
      }, url)
    }

    /**
     * Load /start, open a link from it, wait for the new tab to land, then
     * report what the module stored and what Chrome recorded.
     */
    async function openFromStart(selector: string, landing: string, config: Record<string, unknown> = {}) {
      await serviceWorker.evaluate((config) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(self as any).rexVisitGraphPlugin.updateConfiguration({ url_detail: 'full', ...config })
      }, config)

      const tab = await context.newPage()
      await tab.goto(`${ORIGIN}/start`)
      const startVisit = await newestVisit(`${ORIGIN}/start`)

      const opened = context.waitForEvent('page', { timeout: 5000 }).catch(() => null)
      await tab.click(selector)
      const newTab = await opened
      await (newTab ?? tab).waitForLoadState('load').catch(() => {})
      await tab.waitForTimeout(1200)

      const stored = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexVisitGraphPlugin
        return {
          openers: await p.openerStore.readAll(),
          hops: await p.hopStore.readAll(),
        }
      })

      await newTab?.close().catch(() => {})
      await tab.close()

      return { startVisit, landingVisit: await newestVisit(`${ORIGIN}${landing}`), ...stored }
    }

    test('a link opened in a new tab is attributed to the page that opened it', async () => {
      const result = await openFromStart('#blank', '/landing-blank')

      // Premise: Chrome itself recorded no referrer, so anything attributing the
      // landing came from this module and not from the browser.
      expect(result.landingVisit?.referringVisitId).toBe('0')

      expect(result.openers).toHaveLength(1)
      expect(result.openers[0].visit_id).toBe(result.landingVisit?.visitId)
      expect(result.openers[0].opener_visit_id).toBe(result.startVisit?.visitId)
      expect(result.openers[0].url).toBe(`${ORIGIN}/landing-blank`)
    })

    /**
     * Opens a tab from a page on a DIFFERENT host, so a block list can name the
     * opener without also naming what it opens.
     *
     * Entering through the shared `/start` fixture would not do: opener and
     * landing are both 127.0.0.1 there, so one block list covers both, and
     * `tabNavigated()` already refuses a block-listed landing. The edge would be
     * absent either way and the test would pass with the opener-side check still
     * missing. Reports the URLs `getVisits()` was called with, because the
     * complaint in AI-Extension#124 is the cost of that call, not only the edge.
     */
    async function openFromBlockedOpener() {
      await serviceWorker.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = self as any
        g.rexVisitGraphPlugin.updateConfiguration({
          url_detail: 'full',
          capture_block_lists: ['vg-opener-block']
        })

        g.__lookedUp = []
        g.__realGetVisits = chrome.history.getVisits
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(chrome.history as any).getVisits = (details: { url: string }) => {
          g.__lookedUp.push(details.url)
          return g.__realGetVisits.call(chrome.history, details)
        }
      })

      const opener = `http://dashboard.example.com:${PORT}/start-cross`
      const tab = await context.newPage()
      await tab.goto(opener)

      const opened = context.waitForEvent('page', { timeout: 5000 }).catch(() => null)
      await tab.click('#blank')
      const newTab = await opened
      await (newTab ?? tab).waitForLoadState('load').catch(() => {})
      await tab.waitForTimeout(1200)

      const result = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = self as any
        ;(chrome.history as any).getVisits = g.__realGetVisits
        return {
          openers: await g.rexVisitGraphPlugin.openerStore.readAll(),
          lookedUp: g.__lookedUp as string[]
        }
      })

      await newTab?.close().catch(() => {})
      await tab.close()

      return { opener, ...result }
    }

    test('an opener on a block list costs no visit lookup, and records no edge', async () => {
      await seedList('vg-opener-block', 'example.com')

      const result = await openFromBlockedOpener()

      // The cost is the whole complaint: getVisits returns every visit Chrome
      // holds for the URL, which is seconds on a heavily reloaded page. The gate
      // has to sit ahead of it, not merely discard the answer afterwards.
      expect(result.lookedUp).not.toContain(result.opener)
      // And the opener's visit id must not reach an emitted point, since a
      // block-listed site is one the study said not to collect from.
      expect(result.openers).toHaveLength(0)
    })

    test('an opener that is not block-listed is still attributed across hosts', async () => {
      // Premise for the test above: the cross-host walk DOES produce an edge
      // when nothing blocks it, so the absences there are the block list acting
      // rather than a fixture that never opened a tab.
      await seedList('vg-opener-block', 'example.invalid')

      const result = await openFromBlockedOpener()

      expect(result.lookedUp).toContain(result.opener)
      expect(result.openers).toHaveLength(1)
    })

    /**
     * Opens a tab from an opener visited enough times to test a ceiling against.
     *
     * Two visits and a ceiling of one, rather than a seeded 440,000-visit
     * profile: what is under test is the comparison and where it sits relative to
     * the lookup, and both are the same at either scale. The cost that motivates
     * the ceiling is measured separately, in
     * `AI-extension-testing/one-off/measure_opener_lookup_cost.mjs`.
     */
    async function openWithCeiling(maxOpenerVisits: number) {
      const opener = `http://127.0.0.1:${PORT}/start-ceiling`

      await serviceWorker.evaluate(async ({ opener, maxOpenerVisits }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = self as any
        g.rexVisitGraphPlugin.updateConfiguration({ url_detail: 'full', max_opener_visits: maxOpenerVisits })

        // A second visit, so the count exceeds a ceiling of one. The navigation
        // below supplies the first.
        await chrome.history.addUrl({ url: opener })

        g.__lookedUp = []
        g.__realGetVisits = chrome.history.getVisits
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(chrome.history as any).getVisits = (details: { url: string }) => {
          g.__lookedUp.push(details.url)
          return g.__realGetVisits.call(chrome.history, details)
        }
      }, { opener, maxOpenerVisits })

      const tab = await context.newPage()
      await tab.goto(opener)

      const opened = context.waitForEvent('page', { timeout: 5000 }).catch(() => null)
      await tab.click('#blank')
      const newTab = await opened
      await (newTab ?? tab).waitForLoadState('load').catch(() => {})
      await tab.waitForTimeout(1200)

      const result = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = self as any
        ;(chrome.history as any).getVisits = g.__realGetVisits
        return {
          openers: await g.rexVisitGraphPlugin.openerStore.readAll(),
          lookedUp: g.__lookedUp as string[]
        }
      })

      await newTab?.close().catch(() => {})
      await tab.close()

      return { opener, ...result }
    }

    test('an opener past the visit ceiling is not looked up, and records no edge', async () => {
      const result = await openWithCeiling(1)

      expect(result.lookedUp).not.toContain(result.opener)
      expect(result.openers).toHaveLength(0)
    })

    test('a ceiling of 0 removes the limit, so a study can turn it off', async () => {
      // Premise for the test above: the same walk with the ceiling disabled DOES
      // look the opener up and record the edge, so the absences there are the
      // ceiling acting rather than a fixture that never opened a tab.
      const result = await openWithCeiling(0)

      expect(result.lookedUp).toContain(result.opener)
      expect(result.openers).toHaveLength(1)
    })

    test('a same-tab link records no opener edge, since Chrome attributes it already', async () => {
      const result = await openFromStart('#same', '/landing-same')

      // Positive control for the test above: the same click in the same tab
      // IS attributed by Chrome, so the "0" there is the tab boundary acting.
      expect(result.landingVisit?.referringVisitId).toBe(result.startVisit?.visitId)
      expect(result.openers).toHaveLength(0)
    })

    test('a tab opened blank and then navigated is attributed to its opener', async () => {
      const result = await openFromStart('#open-empty', '/landing-open-empty')

      expect(result.landingVisit?.referringVisitId).toBe('0')
      expect(result.openers).toHaveLength(1)
      expect(result.openers[0].visit_id).toBe(result.landingVisit?.visitId)
      expect(result.openers[0].opener_visit_id).toBe(result.startVisit?.visitId)
    })

    test('a link opened in a new window is attributed to its opener, since a window is a tab boundary too', async () => {
      // The popup feature string is what makes Chrome open a separate window
      // rather than a tab; it still creates the tab with an openerTabId.
      const result = await openFromStart('#open-window', '/landing-window')

      expect(result.landingVisit?.referringVisitId).toBe('0')
      expect(result.openers).toHaveLength(1)
      expect(result.openers[0].visit_id).toBe(result.landingVisit?.visitId)
      expect(result.openers[0].opener_visit_id).toBe(result.startVisit?.visitId)
    })

    test('the drained edge attaches to the redirect hop, so landing -> hop -> opener closes', async () => {
      const result = await openFromStart('#redirect', '/landing-redirect')
      const hopVisit = await newestVisit(`${ORIGIN}/hop`)

      // Chrome's own chain: landing refers to the hop, and the hop refers to
      // nothing, because the hop was the first page in the new tab.
      expect(result.landingVisit?.referringVisitId).toBe(hopVisit?.visitId)
      expect(hopVisit?.referringVisitId).toBe('0')
      // The hop is captured as usual under the default scope.
      expect(result.hops.map((h: { visit_id: string }) => h.visit_id)).toContain(hopVisit?.visitId)

      const events = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexVisitGraphPlugin
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(self as any).__capturedEvents = []
        await p.drain()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (self as any).__capturedEvents
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const openerPoints = events.filter((e: any) => e.name === 'rex-visit-graph-opener')
      expect(openerPoints).toHaveLength(1)
      // Attached to the root of the chain in the new tab, which is where Chrome
      // recorded "0", rather than to the landing page.
      expect(openerPoints[0].visit_id).toBe(hopVisit?.visitId)
      expect(openerPoints[0].referring_visit_id).toBe(result.startVisit?.visitId)
      expect(openerPoints[0].url).toBe(`${ORIGIN}/hop`)
      // And the hop itself still goes out as a hop.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(events.filter((e: any) => e.name === 'rex-visit-graph-hop').map((e: any) => e.visit_id)).toContain(hopVisit?.visitId)
    })

    test('the drained edge carries ids and the configured address detail', async () => {
      const result = await openFromStart('#blank', '/landing-blank', { url_detail: 'none' })

      const events = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexVisitGraphPlugin
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(self as any).__capturedEvents = []
        await p.drain()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-visit-graph-opener')
      })

      expect(events).toHaveLength(1)
      expect(events[0].visit_id).toBe(result.landingVisit?.visitId)
      expect(events[0].referring_visit_id).toBe(result.startVisit?.visitId)
      expect(events[0].url).toBeUndefined()
      // The address is not held either, not merely not emitted.
      expect(result.openers[0].url).toBeNull()

      const remaining = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await (self as any).rexVisitGraphPlugin.openerStore.readAll()).length
      })
      expect(remaining).toBe(0)
    })

    test('capture rules narrow opener edges the way they narrow hops', async () => {
      const result = await openFromStart('#blank', '/landing-blank', {
        capture_rules: [{ id: 'elsewhere', host_suffix: 'example.com', path_prefix: '/' }]
      })

      expect(result.landingVisit?.referringVisitId).toBe('0')
      expect(result.openers).toHaveLength(0)
    })

    test('tab_opener_edges: false records nothing and holds no tabs listener', async () => {
      const result = await openFromStart('#blank', '/landing-blank', { tab_opener_edges: false })

      expect(result.landingVisit?.referringVisitId).toBe('0')
      expect(result.openers).toHaveLength(0)

      const listening = await serviceWorker.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexVisitGraphPlugin
        const whenOff = p.isListeningForTabs()
        p.updateConfiguration({ tab_opener_edges: true })
        const whenOn = p.isListeningForTabs()
        p.updateConfiguration({ enabled: false })
        const whenDisabled = p.isListeningForTabs()
        p.updateConfiguration({})
        return { whenOff, whenOn, whenDisabled, byDefault: p.isListeningForTabs() }
      })

      expect(listening.whenOff).toBe(false)
      expect(listening.whenOn).toBe(true)
      expect(listening.whenDisabled).toBe(false)
      expect(listening.byDefault).toBe(true)
    })

    test('disabling the module discards stored opener edges too', async () => {
      const remaining = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexVisitGraphPlugin
        await p.openerStore.put({
          visit_id: '9', referring_visit_id: '0', opener_visit_id: '3', visit_time: Date.now(),
          url: null, capture_rule: 'all', transition: 'link'
        })
        await chrome.storage.local.set({ REXConfiguration: { visit_graph: { enabled: false } } })
        await p.refreshConfiguration()
        const afterDisable = (await p.openerStore.readAll()).length
        await chrome.storage.local.set({ REXConfiguration: {} })
        await p.refreshConfiguration()
        return afterDisable
      })

      expect(remaining).toBe(0)
    })
  })
})
