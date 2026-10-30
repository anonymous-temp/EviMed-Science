import { readFile } from 'node:fs/promises'

const origin = process.env.EVIMED_SEARCH_TOPICS_ORIGIN ?? 'http://127.0.0.1:3000'
const tokenFile = process.env.EVIMED_SEARCH_TOPICS_TOKEN_FILE
if (!tokenFile) throw new Error('Set EVIMED_SEARCH_TOPICS_TOKEN_FILE first')
const token = (await readFile(tokenFile, 'utf8')).trim()
const url = new URL('/api/evimed-search/topics', origin)
url.searchParams.set('category', process.argv[2] ?? 'literature')
url.searchParams.set('limit', '3')
const response = await fetch(url, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(5000),
})
const body = await response.json()
process.stdout.write(`${JSON.stringify({ status: response.status, body }, null, 2)}\n`)
if (!response.ok) process.exitCode = 1
