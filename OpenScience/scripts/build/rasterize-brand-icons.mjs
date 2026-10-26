#!/usr/bin/env node
/** Rasterize generated SVG sources after `pnpm tokens:css`; no live app or user browser is used. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Reuse the control plane's pinned renderer rather than adding another dependency.
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url))
const { chromium } = require('playwright-core')
const web = new URL('../../apps/web/', import.meta.url)
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
const browser = await chromium.launch(executablePath ? { executablePath } : {})
try {
  for (const [source, output, size] of [
    ['evimed-app-icon.svg', 'evimed-192.png', 192],
    ['evimed-app-icon.svg', 'evimed-512.png', 512],
    ['evimed-app-icon.svg', 'apple-touch-icon.png', 180],
    ['evimed-app-icon-maskable.svg', 'evimed-maskable-512.png', 512],
  ]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    const svg = readFileSync(new URL(`src/assets/${source}`, web), 'utf8')
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%}svg{display:block;width:100%;height:100%}</style>${svg}`)
    await page.screenshot({ path: fileURLToPath(new URL(`public/icons/${output}`, web)) })
    await page.close()
  }
  console.log('brand icons: rasterized all four generated app icons')
} finally {
  await browser.close()
}
