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
        `--load-extension=${extensionPath}`
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
      const rule = p.captureRules.match('https://www.google.com/goto?url=CAESUgHrOzAV')
      return rule ? rule.id : null
    }, GOOGLE_RULES)

    expect(matched).toBe('google-goto')
  })

  test('does not match an ordinary Google search page', async () => {
    const matched = await serviceWorker.evaluate((rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update(rules)
      return p.captureRules.match('https://www.google.com/search?q=home+depot')
    }, GOOGLE_RULES)

    expect(matched).toBeNull()
  })

  test('does not match a lookalike host', async () => {
    const matched = await serviceWorker.evaluate((rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update(rules)
      return p.captureRules.match('https://notgoogle.com/goto?url=x')
    }, GOOGLE_RULES)

    expect(matched).toBeNull()
  })

  test('ignores a malformed URL instead of throwing', async () => {
    const matched = await serviceWorker.evaluate((rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      p.captureRules.update(rules)
      return p.captureRules.match('not a url')
    }, GOOGLE_RULES)

    expect(matched).toBeNull()
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
        { id: '1', visitId: '5', referringVisitId: '4', visitTime: 1000, transition: 'link', isLocal: true }
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
        { id: '1', visitId: '5', referringVisitId: '4', visitTime: 1000, transition: 'link', isLocal: true }
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
          { visitId: String(index), referringVisitId: String(index - 1), visitTime: 1000 + index },
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
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: 1000 }, 'https://www.google.com/goto?url=CAES', rules[0])
      await p.hopStore.record({ visitId: '9', referringVisitId: '8', visitTime: 2000 }, 'https://www.google.com/goto?url=CAET', rules[0])

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
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: 1000 }, 'https://www.google.com/goto?url=CAES', rules[0])

      // A worker killed mid-drain leaves the guard set in the dead instance. The
      // replacement reconstructs it clear, and the stored hop is still there.
      p.forceDrainingForTest(true)
      p.resetForTest()

      return await p.drain()
    }, GOOGLE_RULES)

    expect(emitted).toBe(1)
  })

  test('a second drain during the first is refused, not queued', async () => {
    const counts = await serviceWorker.evaluate(async (rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: 1000 }, 'https://www.google.com/goto?url=CAES', rules[0])
      return await Promise.all([p.drain(), p.drain()])
    }, GOOGLE_RULES)

    expect(counts.filter((count) => count > 0)).toHaveLength(1)
    expect(counts).toContain(0)
  })

  test('sweep drops hops older than the cutoff', async () => {
    const remaining = await serviceWorker.evaluate(async (rules) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.hopStore.record({ visitId: '1', referringVisitId: '0', visitTime: 1000 }, 'https://www.google.com/goto?a', rules[0])
      await p.hopStore.record({ visitId: '2', referringVisitId: '1', visitTime: 9000 }, 'https://www.google.com/goto?b', rules[0])
      await p.hopStore.sweep(5000)
      return (await p.hopStore.readAll()).map((r: { visit_id: string }) => r.visit_id)
    }, GOOGLE_RULES)

    expect(remaining).toEqual(['2'])
  })

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  test('ships Google defaults when the server sends nothing', async () => {
    const config = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: {} })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      return p.currentConfig()
    })

    expect(config.enabled).toBe(true)
    expect(config.include_url).toBe(false)
    // /aclk and /goto are both observed in the field; /url is long-standing.
    const paths = config.capture_rules.map((rule: { path_prefix: string }) => rule.path_prefix).sort()
    expect(paths).toEqual(['/aclk', '/goto', '/url'])
  })

  test('server configuration replaces the defaults', async () => {
    const config = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        REXConfiguration: {
          visit_graph: {
            enabled: true,
            capture_rules: [{ id: 'example', host_suffix: 'example.com', path_prefix: '/r' }],
            include_url: false,
            drain_interval_minutes: 5,
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
    expect(config.drain_interval_minutes).toBe(5)
  })

  test('repeated configuration refreshes do not postpone the drain', async () => {
    // A host extension may refresh configuration far more often than the drain
    // interval — AI-Extension does it every minute against a 15-minute drain. If
    // each refresh re-created the alarm, its countdown would restart every time
    // and the drain would never fire, so hops would accumulate and never emit.
    const times = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: {} })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      const first = (await chrome.alarms.get('rex-visit-graph-drain'))?.scheduledTime
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await p.refreshConfiguration()
      const second = (await chrome.alarms.get('rex-visit-graph-drain'))?.scheduledTime
      return { first, second }
    })

    expect(times.first).toBeDefined()
    expect(times.second).toBe(times.first)
  })

  test('changing the drain interval does reschedule the alarm', async () => {
    const period = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        REXConfiguration: { visit_graph: { drain_interval_minutes: 3 } }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      return (await chrome.alarms.get('rex-visit-graph-drain'))?.periodInMinutes
    })

    expect(period).toBe(3)
  })

  test('triggerVisitGraphDrain emits stored hops and answers with the count', async () => {
    const result = await serviceWorker.evaluate(async (rules) => {
      await chrome.storage.local.set({ REXConfiguration: {} })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: 1000 }, 'https://www.google.com/goto?url=CAES', rules[0])
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

  test('include_url puts the URL on the emitted point', async () => {
    const events = await serviceWorker.evaluate(async (rules) => {
      await chrome.storage.local.set({
        REXConfiguration: {
          visit_graph: {
            enabled: true,
            capture_rules: rules,
            include_url: true,
            drain_interval_minutes: 15,
            max_hop_age_days: 7
          }
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: 1000 }, 'https://www.google.com/goto?url=CAES', rules[0])
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
            include_url: false,
            drain_interval_minutes: 15,
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
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now() }, 'https://www.google.com/goto?url=CAES', rules[0])

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
        alarm: await chrome.alarms.get('rex-visit-graph-drain'),
      }
    }, GOOGLE_RULES)

    expect(result.emitted).toBe(0)
    expect(result.viaMessage).toBe(0)
    expect(result.viaAlarm).toBe(0)
    expect(result.alarm).toBeUndefined()
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

      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: Date.now() }, 'https://www.google.com/goto?url=CAES', rules[0])

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
          visit_graph: { capture_rules: rules, include_url: true }
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: 1000 }, 'https://www.google.com/goto?url=CAES', rules[0])
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

  test('with no lists anywhere, include_url emits the URL unchanged', async () => {
    const events = await serviceWorker.evaluate(async (rules) => {
      await chrome.storage.local.set({
        REXConfiguration: { visit_graph: { capture_rules: rules, include_url: true } }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexVisitGraphPlugin
      await p.refreshConfiguration()
      await p.hopStore.record({ visitId: '5', referringVisitId: '4', visitTime: 1000 }, 'https://www.google.com/goto?url=CAES', rules[0])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []
      await p.drain()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-visit-graph-hop')
    }, GOOGLE_RULES)

    expect(events[0].url).toBe('https://www.google.com/goto?url=CAES')
  })

  // -------------------------------------------------------------------------
  // Listener registration
  // -------------------------------------------------------------------------

  test('registers its history listener in the first turn of the worker script', () => {
    // A chrome.history listener added after the worker script's first turn is
    // registered too late to wake an evicted MV3 worker, and the waking event is
    // dropped. That failure only appears on a cold start in the field, never in a
    // spec that drives one continuous worker lifetime, so it is guarded here at
    // the source.
    //
    // Only TOP-LEVEL await delays registration. An await inside a class method
    // body runs when that method is called, not at import, so the pattern is
    // anchored to column zero: `^await`, not `^\s*await`.
    const source = fs.readFileSync(path.join(__dirname, '../../src/service-worker.mts'), 'utf8')
    const listenerAt = source.search(/^chrome\.history\.onVisited\.addListener/m)
    const topLevelAwaitAt = source.search(/^await /m)

    expect(listenerAt, 'listener must be registered at module scope, not indented inside a function')
      .toBeGreaterThan(-1)
    expect(topLevelAwaitAt === -1 || listenerAt < topLevelAwaitAt,
      'no top-level await may precede the listener registration').toBe(true)
  })
})
