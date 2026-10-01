import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { once } from 'node:events'
import tar from 'tar-stream'
import { zipSync, strToU8 } from 'fflate'
import { decodeSkillArchive, SKILL_ARCHIVE_LIMITS } from '../src/skillArchive.mjs'

const skill = Buffer.from('---\nname: imported-review\ndescription: Review the evidence\n---\n# Review\nUse preserved sources.\n')
/** @param {Record<string,any>} files */
const zip = files => Buffer.from(zipSync(files))
/** @param {{name:string,bytes?:Buffer,type?:string,linkname?:string}[]} entries */
async function tarGzip(entries) {
  const pack = tar.pack()
  const chunks = []
  pack.on('data', chunk => chunks.push(chunk))
  for (const entry of entries) {
    await new Promise((resolve, reject) => pack.entry({ name: entry.name, type: entry.type ?? 'file', linkname: entry.linkname }, entry.bytes ?? Buffer.alloc(0), error => error ? reject(error) : resolve()))
  }
  pack.finalize()
  await once(pack, 'end')
  return gzipSync(Buffer.concat(chunks))
}

test('real ZIP and tar.gz import one optional repository directory and preserve inert resource bytes', async () => {
  const csv = Buffer.from('drug,value\naspirin,2\n')
  const script = Buffer.from('throw new Error("must never run")\n')
  const files = { 'review-repo/SKILL.md': skill, 'review-repo/references/evidence.csv': csv, 'review-repo/scripts/example.mjs': script }
  const archives = [['zip', zip(files)], ['tar-gzip', await tarGzip(Object.entries(files).map(([name, content]) => ({ name, bytes: content })))]]
  for (const [kind, bytes] of archives) {
    const decoded = await decodeSkillArchive(bytes, kind)
    assert.deepEqual(decoded.map(entry => entry.path).sort(), ['SKILL.md', 'references/evidence.csv', 'scripts/example.mjs'])
    for (const entry of decoded) {
      assert.equal(entry.type, 'file')
      assert.ok(Buffer.isBuffer(entry.bytes), 'worker Uint8Array replies must hydrate to Buffer')
      assert.deepEqual(entry.bytes, files[`review-repo/${entry.path}`])
    }
  }
})

test('root SKILL.md and explicit directory records import through actual decoders', async () => {
  const zipBytes = zip({ 'SKILL.md': skill, 'references/': new Uint8Array(), 'references/note.txt': strToU8('note') })
  const tarBytes = await tarGzip([{ name: 'SKILL.md', bytes: skill }, { name: 'references/', type: 'directory' }, { name: 'references/note.txt', bytes: Buffer.from('note') }])
  assert.equal((await decodeSkillArchive(zipBytes, 'zip')).length, 2)
  assert.equal((await decodeSkillArchive(tarBytes, 'tar-gzip')).length, 2)
})

test('both decoders reject traversal, absolute paths, backslashes, secrets and reserved trees', async () => {
  for (const name of ['../escape.txt', '/absolute.txt', 'C:/escape.txt', 'folder\\escape.txt', '.env', '.git/config', 'node_modules/a.js', 'secrets.json', 'credentials.json', 'id_rsa', 'private.key']) {
    await assert.rejects(decodeSkillArchive(zip({ 'SKILL.md': skill, [name]: strToU8('x') }), 'zip'), /skill archive is invalid/u, name)
    await assert.rejects(decodeSkillArchive(await tarGzip([{ name: 'SKILL.md', bytes: skill }, { name, bytes: Buffer.from('x') }]), 'tar-gzip'), /skill archive is invalid/u, name)
  }
})

test('casefold collisions, extra SKILL bundles, file-directory collisions and mixed wrapper roots fail', async () => {
  for (const files of [
    { 'SKILL.md': skill, 'notes.txt': strToU8('a'), 'Notes.txt': strToU8('b') },
    { 'SKILL.md': skill, 'child/SKILL.md': skill },
    { 'outer/nested/SKILL.md': skill },
    { 'repo/SKILL.md': skill, 'outside.txt': strToU8('outside') },
    { 'SKILL.md': skill, 'references': strToU8('file'), 'references/note.txt': strToU8('child') },
    { 'skill.md': skill },
  ]) {
    await assert.rejects(decodeSkillArchive(zip(files), 'zip'))
    await assert.rejects(decodeSkillArchive(await tarGzip(Object.entries(files).map(([name, bytes]) => ({ name, bytes: Buffer.from(bytes) }))), 'tar-gzip'))
  }
})

test('ZIP UNIX symlinks, devices and FIFOs cannot become regular resources', async () => {
  for (const mode of [0o120777, 0o020600, 0o060600, 0o010600, 0o140600]) {
    const bytes = zip({ 'SKILL.md': skill, 'malicious': [strToU8('target'), { os: 3, attrs: (mode << 16) >>> 0 }] })
    await assert.rejects(decodeSkillArchive(bytes, 'zip'), /skill archive is invalid/u)
  }
})

test('tar symlinks, hardlinks, devices, FIFOs and duplicate entries are rejected', async () => {
  for (const type of ['symlink', 'link', 'character-device', 'block-device', 'fifo']) {
    const bytes = await tarGzip([{ name: 'SKILL.md', bytes: skill }, { name: 'malicious', type, linkname: type === 'symlink' || type === 'link' ? '../target' : undefined }])
    await assert.rejects(decodeSkillArchive(bytes, 'tar-gzip'), /skill archive is invalid/u)
  }
  await assert.rejects(decodeSkillArchive(await tarGzip([{ name: 'SKILL.md', bytes: skill }, { name: 'SKILL.md', bytes: skill }]), 'tar-gzip'))
})

test('streamed inflated bytes, expanded total, file count and depth are bounded for real bombs', async () => {
  const huge = Buffer.alloc(SKILL_ARCHIVE_LIMITS.fileBytes + 1)
  await assert.rejects(decodeSkillArchive(zip({ 'SKILL.md': skill, 'huge.txt': huge }), 'zip'), /too large or complex/u)
  await assert.rejects(decodeSkillArchive(await tarGzip([{ name: 'SKILL.md', bytes: skill }, { name: 'huge.txt', bytes: huge }]), 'tar-gzip'), /too large or complex/u)
  const many = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`r${index}.txt`, strToU8('x')]))
  await assert.rejects(decodeSkillArchive(zip({ 'SKILL.md': skill, ...many }), 'zip'), /too large or complex/u)
  await assert.rejects(decodeSkillArchive(await tarGzip([{ name: 'SKILL.md', bytes: skill }, ...Object.keys(many).map(name => ({ name, bytes: Buffer.from('x') }))]), 'tar-gzip'), /too large or complex/u)
  const total = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`big${index}.txt`, Buffer.alloc(SKILL_ARCHIVE_LIMITS.fileBytes)]))
  await assert.rejects(decodeSkillArchive(zip({ 'SKILL.md': skill, ...total }), 'zip'), /too large or complex/u)
  await assert.rejects(decodeSkillArchive(await tarGzip([{ name: 'SKILL.md', bytes: skill }, ...Object.entries(total).map(([name, bytes]) => ({ name, bytes }))]), 'tar-gzip'), /too large or complex/u)
  await assert.rejects(decodeSkillArchive(zip({ 'SKILL.md': skill, [`${'a/'.repeat(16)}deep.txt`]: strToU8('x') }), 'zip'))
})

test('corrupt ZIP/tar.gz, wrong format and oversized compressed input fail with fixed diagnostics', async () => {
  for (const kind of ['zip', 'tar-gzip']) {
    await assert.rejects(decodeSkillArchive(Buffer.from('not an archive secret-token'), kind), error => {
      assert.equal(error.code, 'extension_contract_invalid')
      assert.ok(!error.message.includes('secret-token'))
      return true
    })
  }
  await assert.rejects(decodeSkillArchive(Buffer.alloc(SKILL_ARCHIVE_LIMITS.compressedBytes + 1), 'zip'))
  await assert.rejects(decodeSkillArchive(zip({ 'SKILL.md': skill }), 'tar-gzip'))
})

test('timeout and abort settle an actual owned worker before another import succeeds', async () => {
  const input = zip({ 'SKILL.md': skill })
  const original = Buffer.from(input)
  await assert.rejects(decodeSkillArchive(input, 'zip', { timeoutMs: 1 }), /too large or complex/u)
  const control = new AbortController()
  const interrupted = decodeSkillArchive(input, 'zip', { signal: control.signal })
  control.abort()
  await assert.rejects(interrupted)
  assert.deepEqual((await decodeSkillArchive(input, 'zip')).map(entry => entry.path), ['SKILL.md'])
  assert.deepEqual(input, original, 'transfer must not detach caller input')
})

test('real ZIP CRC and local/central filename disagreement are rejected', async () => {
  const stored = Buffer.from(zipSync({ 'SKILL.md': [skill, { level: 0 }] }))
  const corrupted = Buffer.from(stored)
  const contentOffset = corrupted.indexOf(skill)
  assert.ok(contentOffset >= 0)
  corrupted[contentOffset] ^= 1
  await assert.rejects(decodeSkillArchive(corrupted, 'zip'))
  const renamed = Buffer.from(stored)
  const nameOffset = renamed.indexOf(Buffer.from('SKILL.md'))
  Buffer.from('OTHER.md').copy(renamed, nameOffset)
  await assert.rejects(decodeSkillArchive(renamed, 'zip'))
})

test('forged ZIP expansion metadata cannot hide a streamed decompression bomb', async () => {
  const bytes = zip({ 'SKILL.md': skill, 'huge.txt': Buffer.alloc(SKILL_ARCHIVE_LIMITS.fileBytes + 1) })
  const central = Buffer.from([0x50, 0x4b, 0x01, 0x02])
  let offset = bytes.indexOf(central)
  assert.ok(offset >= 0)
  offset = bytes.indexOf(central, offset + 4)
  assert.ok(offset >= 0)
  bytes.writeUInt32LE(1, offset + 24)
  await assert.rejects(decodeSkillArchive(bytes, 'zip'), /too large or complex/u)
})

test('a ZIP directory cannot hide unbounded inflated bytes behind zero declared size', async () => {
  const bytes = zip({ 'SKILL.md': skill, 'folder/': Buffer.alloc(SKILL_ARCHIVE_LIMITS.fileBytes + 1) })
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
  const localSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  const centralOffset = bytes.indexOf(centralSignature, bytes.indexOf(centralSignature) + 4)
  const localOffset = bytes.indexOf(localSignature, bytes.indexOf(localSignature) + 4)
  assert.ok(centralOffset >= 0 && localOffset >= 0)
  bytes.writeUInt32LE(0, centralOffset + 24)
  bytes.writeUInt32LE(0, localOffset + 22)
  await assert.rejects(decodeSkillArchive(bytes, 'zip'))
})

test('worker admission bounds concurrent memory and releases capacity only after settlement', async () => {
  const input = zip({ 'SKILL.md': skill })
  const active = Array.from({ length: SKILL_ARCHIVE_LIMITS.concurrentWorkers }, () => decodeSkillArchive(input, 'zip'))
  await assert.rejects(decodeSkillArchive(input, 'zip'), error => {
    assert.equal(error.status, 503)
    assert.equal(error.code, 'product_state_unavailable')
    return true
  })
  await Promise.all(active)
  assert.equal((await decodeSkillArchive(input, 'zip')).length, 1)
})
