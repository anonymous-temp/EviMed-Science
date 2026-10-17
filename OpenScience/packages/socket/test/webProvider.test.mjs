// The kernel's `ctx.web` fetch provider reads pages through the gateway's
// web-read mode — the same one `web_read` uses — and passes the gateway's own
// refusal codes through.
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, PROVIDER_ID } from '../plugins/web.mjs'

function fakeContext() {
  /** @type {Record<string, any>} */
  const registered = {}
  const ctx = {
    effect: (/** @type {() => unknown} */ fn) => fn(),
    get: (/** @type {string} */ name) => (name === 'fs'
      ? { resolve: async (/** @type {string} */ file) => file, readText: async () => 'runtime-token\n' }
      : undefined),
    web: {
      registerFetchProvider: (/** @type {any} */ provider) => { registered.fetch = provider; return () => {} },
      registerSearchProvider: (/** @type {any} */ provider) => { registered.search = provider; return () => {} },
    },
  }
  return { ctx, registered }
}

/**
 * @param {(url: string, init: any) => Response} answer
 * @param {(calls: any[]) => Promise<void>} run
 */
async function withGateway(answer, run) {
  const original = globalThis.fetch
  /** @type {any[]} */
  const calls = []
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), init })
    return answer(String(url), init)
  })
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

const config = { searchUrl: '', fetchUrl: 'http://open-science-web:8787/internal/sources/v1/fetch', tokenFile: '/run/evimed/token', timeoutMs: 30000 }

test('a ctx.web fetch is a web read: the page text, from where the bytes came', async () => {
  const { ctx, registered } = fakeContext()
  await apply(ctx, config)
  assert.equal(registered.fetch.id, PROVIDER_ID)
  assert.equal(registered.search, undefined, 'no search endpoint, no search provider')
  await withGateway(() => Response.json({
    receipt: { url: 'http://www.nhc.gov.cn/wjw/gfxwj/list.shtml', finalUrl: 'https://www.nhc.gov.cn/wjw/gfxwj/list.shtml' },
    text: '- 关于印发某规范的通知 2026-09-12',
    links: [],
  }), async (/** @type {any[]} */ calls) => {
    const page = await registered.fetch.fetch({ url: 'http://www.nhc.gov.cn/wjw/gfxwj/list.shtml' })
    // The kernel's `WebFetchResult`: the final address, the page's own status, the text as the `text` kind.
    assert.deepEqual(page, { url: 'https://www.nhc.gov.cn/wjw/gfxwj/list.shtml', statusCode: 200, body: { kind: 'text', content: '- 关于印发某规范的通知 2026-09-12' }, truncated: false })
    assert.equal(calls[0].url, config.fetchUrl)
    assert.deepEqual(JSON.parse(calls[0].init.body), { webRead: { url: 'http://www.nhc.gov.cn/wjw/gfxwj/list.shtml' } })
    assert.equal(calls[0].init.headers.authorization, 'Bearer runtime-token')
  })
})

test("the gateway's refusal reaches the caller under its own code", async () => {
  const { ctx, registered } = fakeContext()
  await apply(ctx, config)
  await withGateway(() => Response.json({ error: { code: 'web_read_robots_disallowed', message: 'robots.txt' } }, { status: 403 }), async () => {
    await assert.rejects(registered.fetch.fetch({ url: 'https://closed.example.org/page' }), (error) => {
      assert.equal(/** @type {any} */ (error).code, 'web_read_robots_disallowed')
      return true
    })
  })
  await assert.rejects(registered.fetch.fetch({ url: 'file:///etc/passwd' }), (error) => /** @type {any} */ (error).code === 'web_fetch_forbidden')
})

test('a ctx.web search reads the gateway\'s envelope and answers in the kernel\'s source shape', async () => {
  const { ctx, registered } = fakeContext()
  await apply(ctx, { ...config, searchUrl: 'http://open-science-web:8787/internal/web-search/v1/search' })
  await withGateway(() => Response.json({
    data: {
      query: 'q', results: [
        { title: 'DeepSeek 发布', url: 'https://example.org/a', snippet: '摘要', engine: 'deepseek', publishedDate: '2026-10-17', site: 'example.org', authority: 3 },
        { title: '', url: 'https://example.org/b', snippet: '', engine: 'bing', publishedDate: null },
        { title: 'no address', url: '', snippet: 'x', engine: 'bing', publishedDate: null },
      ], engines: ['bing', 'deepseek'], unresponsiveEngines: [],
    },
    warnings: ['Results are search hits, not the pages themselves.'],
  }), async (/** @type {any[]} */ calls) => {
    const found = await registered.search.search({ query: ' DeepSeek ', maxResults: 5 })
    assert.deepEqual(found, {
      sources: [
        { url: 'https://example.org/a', title: 'DeepSeek 发布', snippet: '摘要', publishedAt: '2026-10-17' },
        { url: 'https://example.org/b' },
      ],
      truncated: false,
    })
    assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'DeepSeek', limit: 5 })
  })
})
