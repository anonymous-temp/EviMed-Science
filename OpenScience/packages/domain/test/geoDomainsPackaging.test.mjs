import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dnsKey, registrableDomain } from '../src/geoDomains.mjs';

test('vendored tldts bundle is the pinned upstream artifact', async () => {
  const bytes = await readFile(new URL('../src/vendor/tldts-6.1.86.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(Buffer.concat([bytes, Buffer.from('//# sourceMappingURL=index.esm.min.js.map\n')])).digest('hex'), '5cf7636bb2009c3a47b8bdc7990c0af79b547e17e865c3a04bea7f6060697250');
});

test('registrable domains respect IDNA, public and private suffixes', () => {
  assert.equal(registrableDomain('www.食狮.公司.cn'), 'xn--85x722f.xn--55qx5d.cn');
  assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('a.github.io'), 'a.github.io');
  assert.equal(registrableDomain('github.io'), null);
  assert.equal(registrableDomain('example.invalid'), null);
  assert.equal(dnsKey('www.a.github.io'), 'a.github.io');
});
