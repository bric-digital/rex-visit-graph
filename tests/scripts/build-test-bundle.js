#!/usr/bin/env node

/**
 * Bundle the test extension's service worker with esbuild.
 *
 * Output goes to tests/extension/, which is the directory Playwright loads as an
 * unpacked extension. `dist/` is a different output produced by `npm run build`;
 * grepping it proves nothing about what the tests ran.
 */

import * as esbuild from 'esbuild'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const extensionDir = join(__dirname, '../extension')

try {
  await esbuild.build({
    entryPoints: [join(extensionDir, 'sw-entry.mts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2021',
    outfile: join(extensionDir, 'service-worker.bundle.js'),
    sourcemap: true,
    resolveExtensions: ['.mts', '.ts', '.js', '.mjs'],
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    define: { chrome: 'globalThis.chrome' }
  })
  console.log('test extension bundle created:', join(extensionDir, 'service-worker.bundle.js'))
} catch (error) {
  console.error('Build failed:', error)
  process.exit(1)
}
