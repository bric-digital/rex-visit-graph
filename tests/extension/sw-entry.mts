/**
 * Service worker entry point for the Playwright test extension.
 *
 * Loads the real module by side-effect import, so the listener registration at
 * its module scope runs exactly as it does in a shipped extension. Adds an
 * EventCaptureModule so specs can assert on dispatched points without a server.
 */
import rexCorePlugin, { registerREXModule, REXServiceWorkerModule } from '@bric/rex-core/service-worker'
import * as listUtils from '@bric/rex-lists'
import plugin from '../../src/service-worker.mjs'

chrome.runtime.onMessage.addListener(rexCorePlugin.handleMessage)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any

class EventCaptureModule extends REXServiceWorkerModule {
  moduleName(): string { return 'EventCapture' }
  override setup(): void { /* intentional no-op */ }
  override handleMessage(): boolean { return false }
  override logEvent(event: object): void {
    const captured = g.__capturedEvents
    if (Array.isArray(captured)) {
      captured.push(event)
    }
  }
}

g.__capturedEvents = []
// Specs seed real rex-lists entries so capture-list matching runs against the
// real IndexedDB path rather than a stand-in that could pass while the real one
// fails.
g.__listUtils = listUtils
registerREXModule(new EventCaptureModule())

g.rexVisitGraphPlugin = plugin
