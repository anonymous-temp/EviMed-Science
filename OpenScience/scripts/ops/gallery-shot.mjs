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
 *   node scripts/ops/gallery-shot.mjs --url ... --check    # diff against the reference
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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
const checking = process.argv.includes('--check')
const chromium = process.env.OPEN_SCIENCE_WALK_CHROMIUM

/** A PNG as a data URL: a page served over http cannot read a local file, and
 *  a cross-origin image taints the canvas so `getImageData` throws.
 *  @param {string} file @returns {Promise<string>} */
const dataUrl = async (file) => `data:image/png;base64,${(await readFile(file)).toString('base64')}`

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
  const shot = checking ? `${out}.actual.png` : out
  await page.screenshot({ path: shot })

  if (checking) {
    // The diff runs in the browser that just drew the page: two images onto two
    // canvases, and a count of the pixels that differ. Doing it here is what
    // keeps this script dependency-free — a pixel-comparison library would put
    // a package in the lockfile, and a changed lockfile makes the next release
    // a full image rebuild.
    //
    // The images go in as data URLs, not `file://`: a page served over http
    // cannot read a local file, and drawing a cross-origin image taints the
    // canvas so `getImageData` throws.
    const result = await page.evaluate(async ([a, b, tolerance]) => {
      const load = (src) => new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error(`could not read ${src}`))
        image.src = src
      })
      const [one, two] = await Promise.all([load(a), load(b)])
      if (one.width !== two.width || one.height !== two.height) {
        return { sized: false, one: `${one.width}x${one.height}`, two: `${two.width}x${two.height}` }
      }
      const pixels = (image) => {
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.drawImage(image, 0, 0)
        return context.getImageData(0, 0, image.width, image.height).data
      }
      const [left, right] = [pixels(one), pixels(two)]
      let differing = 0
      // 8 per channel absorbs antialiasing; anything a reader would notice is
      // far beyond it.
      for (let index = 0; index < left.length; index += 4) {
        if (Math.abs(left[index] - right[index]) > 8
          || Math.abs(left[index + 1] - right[index + 1]) > 8
          || Math.abs(left[index + 2] - right[index + 2]) > 8) differing += 1
      }
      const total = left.length / 4
      return { sized: true, differing, total, fraction: differing / total, tolerance }
    }, [await dataUrl(out), await dataUrl(shot), 0.005])

    if (!result.sized) {
      console.error(`gallery: the page changed size — reference ${result.one}, now ${result.two}`)
      console.error(`  the new image is at ${path.relative(repoRoot, shot)}; look at it, then re-record if it is right`)
      process.exit(1)
    }
    const percent = (result.fraction * 100).toFixed(3)
    if (result.fraction > result.tolerance) {
      console.error(`gallery: ${percent}% of pixels differ from the reference (budget ${(result.tolerance * 100).toFixed(1)}%)`)
      console.error(`  ${path.relative(repoRoot, shot)} against ${path.relative(repoRoot, out)}`)
      process.exit(1)
    }
    console.log(`gallery: ${rows.length} rows, ${percent}% of pixels differ from the reference`)
  }

  if (consoleErrors.length > 0) {
    console.error(`gallery: ${consoleErrors.length} console error(s):`)
    for (const error of consoleErrors.slice(0, 5)) console.error(`  ${error}`)
    process.exit(1)
  }
  if (!checking) {
    await writeFile(`${out}.rows.json`, `${JSON.stringify(rows, null, 2)}\n`)
    console.log(`gallery: ${rows.length} rows photographed at ${1280}x${height} → ${path.relative(repoRoot, out)}`)
  }
} finally {
  await browser.close()
}
