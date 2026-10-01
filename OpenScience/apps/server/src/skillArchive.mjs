import { Buffer } from 'node:buffer'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, crc32 } from 'node:zlib'
import { HttpError } from './security.mjs'

export const SKILL_ARCHIVE_LIMITS = Object.freeze({ compressedBytes: 4 * 1024 * 1024, files: 128,
  fileBytes: 4 * 1024 * 1024, expandedBytes: 16 * 1024 * 1024, depth: 16, entries: 512,
  heapMb: 64, youngMb: 16, stackMb: 4, diagnosticBytes: 8192, timeoutMs: 5000, concurrentWorkers: 4 })
const WORKER_KIND = 'evimed-skill-archive-v1'
const WORKER_URL = new URL('./skillArchive.mjs', import.meta.url)
let activeWorkers = 0

/** Fixed public errors never carry filenames, imported text or worker diagnostics. @param {string} code */
function refusal(code) {
  return new HttpError(code === 'skill_archive_limit' ? 413 : 400, 'extension_contract_invalid',
    code === 'skill_archive_limit' ? 'The skill archive is too large or complex.' : 'The skill archive is invalid.')
}
/** @param {string} value @param {boolean} directory */
function archivePath(value, directory) {
  const clean = directory && value.endsWith('/') ? value.slice(0, -1) : value
  if (!clean || clean.length > 240 || clean.includes('\\') || clean.split('/').length > SKILL_ARCHIVE_LIMITS.depth
    || clean.split('/').some(part => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/u.test(part) || part === '.' || part === '..')
    || /(?:^|\/)(?:\.env(?:\..*)?|credentials?(?:\.[^/]+)?|secrets?(?:\.[^/]+)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|node_modules|\.git)(?:\/|$)/iu.test(clean)
    || /\.(?:pem|key|p12|pfx)$/iu.test(clean)) throw new Error('skill_archive_invalid')
  return clean
}
/** @param {{path:string,bytes:Buffer}[]} entries */
function normalize(entries) {
  const skills = entries.filter(entry => entry.path.split('/').at(-1).toLowerCase() === 'skill.md')
  if (skills.length !== 1) throw new Error('skill_archive_invalid')
  const skillPath = skills[0].path.split('/')
  if (skillPath.at(-1) !== 'SKILL.md' || skillPath.length > 2) throw new Error('skill_archive_invalid')
  const prefix = skillPath.length === 2 ? `${skillPath[0]}/` : ''
  const paths = new Set()
  return entries.map(entry => {
    if (!entry.path.startsWith(prefix)) throw new Error('skill_archive_invalid')
    const relative = entry.path.slice(prefix.length)
    const folded = relative.toLowerCase()
    if (paths.has(folded)) throw new Error('skill_archive_invalid')
    paths.add(folded)
    if (relative !== 'SKILL.md' && /(?:^|\/)skill\.md$/iu.test(relative)) throw new Error('skill_archive_invalid')
    if (entries.some(other => other !== entry && other.path.toLowerCase().startsWith(`${entry.path.toLowerCase()}/`))) throw new Error('skill_archive_invalid')
    return { type: 'file', path: relative, bytes: entry.bytes }
  })
}
/** A decoder owns bounded entry bookkeeping, not archive-format parsing. */
function collector() {
  const entries = []
  const paths = new Set()
  let count = 0
  let fileCount = 0
  let total = 0
  let exceeded = false
  const limit = () => { exceeded = true; throw new Error('skill_archive_limit') }
  return {
    entries,
    get exceeded() { return exceeded },
    /** @param {string} name @param {boolean} directory @param {number} size */
    entry(name, directory, size) {
      if (++count > SKILL_ARCHIVE_LIMITS.entries) limit()
      const relative = archivePath(name, directory)
      if (paths.has(relative.toLowerCase())) throw new Error('skill_archive_invalid')
      paths.add(relative.toLowerCase())
      if (!Number.isSafeInteger(size) || size < 0 || size > SKILL_ARCHIVE_LIMITS.fileBytes
        || (!directory && ++fileCount > SKILL_ARCHIVE_LIMITS.files)) limit()
      if (directory && size !== 0) throw new Error('skill_archive_invalid')
      return relative
    },
    /** @param {any} stream @param {string} relative @param {number} size @param {number} [expectedCrc] @param {boolean} [directory] */
    async read(stream, relative, size, expectedCrc, directory = false) {
      const chunks = []
      let length = 0
      let crc = 0
      for await (const chunk of stream) {
        length += chunk.length; total += chunk.length
        if (length > size || length > SKILL_ARCHIVE_LIMITS.fileBytes || total > SKILL_ARCHIVE_LIMITS.expandedBytes) limit()
        if (expectedCrc !== undefined) crc = crc32(chunk, crc)
        chunks.push(chunk)
      }
      if (length !== size || (expectedCrc !== undefined && crc !== expectedCrc)) throw new Error('skill_archive_invalid')
      if (!directory) entries.push({ path: relative, bytes: Buffer.concat(chunks, length) })
    },
  }
}

/** Native ZIP directory and streaming local-entry parsers must agree before publication.
 * No archive member is written or executed. @param {Buffer} bytes */
async function decodeZip(bytes) {
  const { default: unzipper } = await import('unzipper')
  const directory = await unzipper.Open.buffer(bytes)
  if (directory.files.length > SKILL_ARCHIVE_LIMITS.entries) throw new Error('skill_archive_limit')
  const metadata = new Map()
  const collected = collector()
  for (const entry of directory.files) {
    const isDirectory = entry.type === 'Directory'
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000
    if ((mode !== 0 && mode !== (isDirectory ? 0x4000 : 0x8000)) || (entry.externalFileAttributes & 0xffc0) !== 0
      || (entry.flags & 1) !== 0 || ![0, 8].includes(entry.compressionMethod)) throw new Error('skill_archive_invalid')
    const relative = collected.entry(entry.path, isDirectory, entry.uncompressedSize)
    metadata.set(entry.path, { ...entry, relative, isDirectory })
  }
  // Entry count is validated independently of the central directory, so local
  // names absent from it and a duplicate local name cannot be smuggled through.
  const input = Readable.from([bytes])
  const parser = unzipper.Parse({ forceStream: true })
  const pumping = pipeline(input, parser)
  pumping.catch(() => {})
  try {
    for await (const entry of parser) {
      const trusted = metadata.get(entry.path)
      if (!trusted || entry.vars.compressionMethod !== trusted.compressionMethod
        || ((entry.vars.flags & 1) !== 0) || (entry.type === 'Directory') !== trusted.isDirectory) throw new Error('skill_archive_invalid')
      metadata.delete(entry.path)
      await collected.read(entry, trusted.relative, trusted.uncompressedSize, trusted.crc32, trusted.isDirectory)
    }
    await pumping
    if (metadata.size !== 0) throw new Error('skill_archive_invalid')
    return normalize(collected.entries)
  } finally { input.destroy(); parser.destroy() }
}

/** @param {Buffer} bytes */
async function decodeTarGzip(bytes) {
  const { default: tar } = await import('tar-stream')
  const extract = tar.extract()
  const collected = collector()
  let archiveBytes = 0
  let boundExceeded = false
  const bounded = new Transform({ transform(chunk, _encoding, next) {
    archiveBytes += chunk.length
    boundExceeded ||= archiveBytes > SKILL_ARCHIVE_LIMITS.expandedBytes + 1024 * 1024
    next(boundExceeded ? new Error('skill_archive_limit') : null, chunk)
  } })
  extract.on('entry', (header, stream, next) => {
    void (async () => {
      if (!['file', 'directory'].includes(header.type) || header.linkname) throw new Error('skill_archive_invalid')
      const relative = collected.entry(header.name, header.type === 'directory', header.size)
      if (header.type === 'directory') stream.resume()
      else await collected.read(stream, relative, header.size)
      next()
    })().catch(error => extract.destroy(error))
  })
  try { await pipeline(Readable.from([bytes]), createGunzip({ chunkSize: 16384 }), bounded, extract) }
  catch (error) {
    if (collected.exceeded || boundExceeded) throw new Error('skill_archive_limit')
    throw error
  }
  return normalize(collected.entries)
}

/** Decode bounded data inside one fixed worker. Completion always joins termination;
 * a timeout or abort cannot leave an archive decoder running behind its result.
 * @param {Buffer} bytes @param {'zip'|'tar-gzip'} kind @param {{signal?:AbortSignal,timeoutMs?:number}} [options]
 * @returns {Promise<{type:'file',path:string,bytes:Buffer}[]>} */
export async function decodeSkillArchive(bytes, kind, options = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > SKILL_ARCHIVE_LIMITS.compressedBytes
    || !['zip', 'tar-gzip'].includes(kind)) throw refusal('skill_archive_limit')
  const timeoutMs = options.timeoutMs ?? SKILL_ARCHIVE_LIMITS.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw refusal('skill_archive_invalid')
  if (options.signal?.aborted) throw refusal('skill_archive_invalid')
  if (activeWorkers >= SKILL_ARCHIVE_LIMITS.concurrentWorkers) throw new HttpError(503, 'product_state_unavailable', 'Skill archive preparation is busy.')
  const input = Uint8Array.from(bytes)
  const worker = new Worker(WORKER_URL, { name: 'skill-archive', workerData: { worker: WORKER_KIND, kind, input },
    transferList: [input.buffer], env: {}, execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: SKILL_ARCHIVE_LIMITS.heapMb, maxYoungGenerationSizeMb: SKILL_ARCHIVE_LIMITS.youngMb,
      stackSizeMb: SKILL_ARCHIVE_LIMITS.stackMb } })
  activeWorkers += 1
  return new Promise((resolve, reject) => {
    let settled = false
    let diagnostics = 0
    /** @param {Error|null} error @param {any[]} [entries] */
    const finish = async (error, entries) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      try { await worker.terminate(); activeWorkers -= 1 }
      catch { reject(refusal('skill_archive_invalid')); return }
      if (error) reject(error)
      else resolve(entries.map(entry => ({ type: 'file', path: entry.path, bytes: Buffer.from(entry.bytes) })))
    }
    const onAbort = () => { void finish(refusal('skill_archive_invalid')) }
    const timer = setTimeout(() => { void finish(refusal('skill_archive_limit')) }, timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => {
      diagnostics += chunk.length
      if (diagnostics > SKILL_ARCHIVE_LIMITS.diagnosticBytes) void finish(refusal('skill_archive_limit'))
    })
    worker.once('message', message => {
      if (!message || !Array.isArray(message.entries)) { void finish(refusal(message?.code === 'skill_archive_limit' ? message.code : 'skill_archive_invalid')); return }
      void finish(null, message.entries)
    })
    worker.once('error', () => { void finish(refusal('skill_archive_invalid')) })
    worker.once('exit', () => { void finish(refusal('skill_archive_invalid')) })
  })
}

if (!isMainThread && workerData?.worker === WORKER_KIND) {
  try {
    const input = Buffer.from(workerData.input)
    const entries = workerData.kind === 'zip' ? await decodeZip(input) : await decodeTarGzip(input)
    parentPort.postMessage({ entries })
  } catch (error) {
    parentPort.postMessage({ code: error?.message === 'skill_archive_limit' ? 'skill_archive_limit' : 'skill_archive_invalid' })
  }
}
