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
        '--window-size=800,600'
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
})
