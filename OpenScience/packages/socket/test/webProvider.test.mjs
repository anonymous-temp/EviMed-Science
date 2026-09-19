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
    assert.deepEqual(page, { url: 'https://www.nhc.gov.cn/wjw/gfxwj/list.shtml', content: '- 关于印发某规范的通知 2026-09-12' })
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
