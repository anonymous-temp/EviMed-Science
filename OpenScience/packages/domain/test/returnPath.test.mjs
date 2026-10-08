import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safeAppReturnPath } from '../index.mjs'

test('a sign-in returns to the app address that was asked for, whole', () => {
  for (const address of [
    '/app',
    '/app/chat',
    '/app/chat/ses_1',
    '/app/memory?tab=methods&q=%E8%83%8C%E6%99%AF',
    '/app/runs/run_1/files/.evimed-sources/aspree/fulltext.md?quote=did%20not&version=rv_source',
    '/app/frontier?view=daily&day=2026-10-07#CLM-001',
    '/app?x=1',
    '/app/files?path=a%2Fb',
  ]) assert.equal(safeAppReturnPath(address), address, address)
})

test('anything that is not a path inside /app is refused, so the redirect cannot leave the app or the origin', () => {
  for (const address of [
    // another origin, written the ways a browser reads as one
    '//evil.example/app/chat', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/ /evil.example',
    'https://evil.example/app/chat', 'http:/evil.example', 'javascript:alert(1)', 'data:text/html,x', 'evil.example/app/chat', 'app/chat',
    // not the app
    '/', '/login', '/settings', '/api/auth/logout', '/application', '/apps/chat', '/APP/chat', '/__gallery',
    // a walk out of /app/ in plain and encoded form
    '/app/../login', '/app/./chat', '/app/%2e%2e/login', '/app/%2E%2E/login', '/app/chat/..', '/app/..%2flogin', '/app/%2f%2fevil.example',
    '/app/%5cevil.example', '/app//evil.example', '/app/chat//x',
    // controls, backslashes, spaces, non-ASCII and bare percent in the path
    '/app/chat\\x', '/app/chat\0', '/app/chat\x7f', '/app/ch at', '/app/聊天', '/app/%0d%0aSet-Cookie:x=1', '/app/%00', '/app/%', '/app/%zz', '/app/c%1',
    // a query or a fragment may not smuggle them either
    '/app/chat?next=\\evil', '/app/chat?x=\n', '/app/chat#\t', '/app/chat?x=聊天',
  ]) assert.equal(safeAppReturnPath(address), null, JSON.stringify(address))
})

test('a value that is not a string, is empty or is very long is refused', () => {
  for (const value of [undefined, null, 7, {}, [], '', '/app/' + 'a'.repeat(2048)]) assert.equal(safeAppReturnPath(value), null)
  assert.equal(safeAppReturnPath('/app/' + 'a'.repeat(2043)), '/app/' + 'a'.repeat(2043))
})
