#!/usr/bin/env node
/**
 * Photograph the component gallery.
 *
 * The third of the three mechanisms that keep two front ends looking like one
 * product (fusion plan §6.3). The token package makes them agree about values
 * and `/__gallery` puts every primitive in every state on one page; this turns
 * that page into an image, so changing a component's look is a review with a
 * picture in it rather than a surprise three pages later.
 *
 *   OPEN_SCIENCE_PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
 *   node scripts/ops/gallery-shot.mjs --url http://localhost:5199 --out gallery.png
 *
 * Playwright is not a dependency of this repository — it would pull a browser
 * download into every install and into the runtime image rebuild. The walk
 * (`ui-walk.mjs`) takes the same environment variable for the same reason.
 *
 * The page lives inside a scroll container (`PageShell`), so a `fullPage`
 * capture stops at the viewport and quietly photographs a third of it. The
 * viewport is sized to the container's own scroll height instead — measured,
 * not guessed, because a guess is how a reference image loses its last row.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const base = String(arg('url', 'http://localhost:5199')).replace(/\/+$/, '')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.resolve(repoRoot, String(arg('out', 'apps/web/src/test/__screenshots__/gallery.png')))
const theme = String(arg('theme', 'light'))
const chromium = process.env.OPEN_SCIENCE_WALK_CHROMIUM

const corePath = process.env.OPEN_SCIENCE_PLAYWRIGHT_CORE
if (!corePath) {
  console.error('gallery: set OPEN_SCIENCE_PLAYWRIGHT_CORE to an installed playwright-core')
  process.exit(2)
}
// playwright-core is CommonJS: an ESM import of it hands back a namespace whose
// named exports may be absent, and `default` is the module.
const loaded = await import(corePath.startsWith('/') ? pathToFileURL(path.join(corePath, 'index.js')).href : corePath)
const browserType = (loaded.chromium ?? loaded.default?.chromium)
if (!browserType) throw new Error(`playwright-core at ${corePath} exports no chromium`)
const browser = await browserType.launch({
  headless: true,
  ...(chromium ? { executablePath: chromium } : {}),
  args: ['--no-sandbox', '--font-render-hinting=none'],
})
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1200 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  /** @type {string[]} */
  const consoleErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200)) })
  await page.goto(`${base}/__gallery`, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light' })
  await page.evaluate((scheme) => document.documentElement.setAttribute('data-theme', scheme), theme)
  await page.waitForSelector('[data-gallery-row]')

  const rows = await page.$$eval('[data-gallery-row]', (nodes) => nodes.map((node) => node.getAttribute('data-gallery-row')))
  if (rows.length === 0) throw new Error('the gallery rendered no rows')
  // Measured: the page is inside a scroll container, so `fullPage` would stop
  // at the viewport and photograph a third of it.
  const height = await page.evaluate(() => {
    const scroller = document.querySelector('[data-gallery-row]')?.closest('div[class*="overflow-y-auto"]')
    return Math.ceil((scroller?.scrollHeight ?? document.body.scrollHeight) + 48)
  })
  await page.setViewportSize({ width: 1280, height: Math.min(height, 8000) })
  await page.waitForTimeout(400)
  await mkdir(path.dirname(out), { recursive: true })
  await page.screenshot({ path: out })

  if (consoleErrors.length > 0) {
    console.error(`gallery: ${consoleErrors.length} console error(s):`)
    for (const error of consoleErrors.slice(0, 5)) console.error(`  ${error}`)
    process.exit(1)
  }
  await writeFile(`${out}.rows.json`, `${JSON.stringify(rows, null, 2)}\n`)
  console.log(`gallery: ${rows.length} rows photographed at ${1280}x${height} → ${path.relative(repoRoot, out)}`)
} finally {
  await browser.close()
}
