import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { canonicalJson } from '@evimed/domain'
import { dockerRuntimeMount, assertDockerDataVolumeSupport } from './dockerMounts.mjs'
import { HttpError, openScopedDirectoryNoFollow, openScopedFileNoFollow, readStableFileHandle, writeFileExclusiveNoFollow, writeFileAtomicNoFollow } from './security.mjs'

export const SKILL_VALIDATION_TIMEOUT_MS = 15000
export const SKILL_VALIDATION_OUTPUT_BYTES = 512 * 1024
const NAME = 'evimed-skill-validation'
const HEX = /^[a-f0-9]{64}$/u
const NATIVE = /^personal-[a-f0-9]{16}-[a-f0-9]{32}$/u
const sha = value => createHash('sha256').update(value).digest('hex')
const invalid = () => new HttpError(400, 'extension_contract_invalid', 'The skill validation reference or input is invalid.')

/** Only the control plane supplies an owned opaque reference; never a path/image/command.
 * @param {unknown} value */
export function validateSkillReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).sort().join(',') !== 'contentId,expectedName,kind,ownerHash'
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value'))) throw invalid()
  const reference = /** @type {any} */ (value)
  if (typeof reference.ownerHash !== 'string' || typeof reference.contentId !== 'string'
    || !HEX.test(reference.ownerHash) || !HEX.test(reference.contentId) || !['imports', 'packages'].includes(reference.kind)
    || (reference.expectedName !== null && !NATIVE.test(reference.expectedName))
    || (reference.kind === 'packages' && reference.expectedName === null)) throw invalid()
  return { ownerHash: reference.ownerHash, kind: reference.kind, contentId: reference.contentId, expectedName: reference.expectedName }
}
/** @param {any} config @param {any} reference */
export function skillValidationRoot(config, reference) {
  const checked = validateSkillReference(reference)
  return path.join(config.dataDir, '.openscience', 'skill-library', checked.ownerHash, checked.kind, checked.contentId)
}
/** Resource names are canonical data paths; hidden/credential files are never mounted. @param {string} relative */
function resourcePath(relative) {
  if (!relative || relative.length > 240 || relative.split('/').length > 16
    || relative.split('/').some(part => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/u.test(part) || part === '.' || part === '..')
    || /(?:^|\/)(?:credentials?(?:\.[^/]+)?|secrets?(?:\.[^/]+)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|node_modules)(?:\/|$)/iu.test(relative)
    || /\.(?:pem|key|p12|pfx)$/iu.test(relative)) throw invalid()
}
/** Stable descriptor reads validate the exact set, types, names and hashes; no native code runs here.
 * @param {any} config @param {any} reference */
async function snapshot(config, reference) {
  const root = skillValidationRoot(config, reference)
  const rootOpened = await openScopedDirectoryNoFollow(config.dataDir, root)
  const files = new Map()
  const metadata = []
  let count = 0
  let total = 0
  /** @param {string} directory @param {string} prefix */
  async function walk(directory, prefix) {
    const opened = await openScopedDirectoryNoFollow(config.dataDir, directory)
    try {
      metadata.push([prefix, 'directory', opened.stat.dev, opened.stat.ino, opened.stat.mtimeMs, opened.stat.ctimeMs])
      for (const name of await fs.readdir(opened.path)) {
        const relative = prefix ? `${prefix}/${name}` : name
        resourcePath(relative)
        if (++count > 512) throw invalid()
        const target = path.join(directory, name)
        const info = await fs.lstat(path.join(opened.path, name))
        if (info.isDirectory()) { await walk(target, relative); continue }
        if (!info.isFile() || info.nlink !== 1 || files.size >= 130 || info.size > 4 * 1024 * 1024) throw invalid()
        const file = await openScopedFileNoFollow(config.dataDir, target)
        try {
          if (file.stat.size > 4 * 1024 * 1024 || (total += file.stat.size) > 16 * 1024 * 1024 + 65536) throw invalid()
          files.set(relative, await readStableFileHandle(file.handle, file.stat))
          metadata.push([relative, 'file', file.stat.dev, file.stat.ino, file.stat.size, file.stat.mtimeMs, file.stat.ctimeMs])
        } finally { await file.handle.close() }
      }
    } finally { await opened.handle.close() }
  }
  try {
    await walk(root, '')
    const skills = [...files.keys()].filter(key => key.toLowerCase().endsWith('/skill.md'))
    if (skills.length !== 1 || skills[0].split('/').length !== 2 || !skills[0].endsWith('/SKILL.md')
      || files.get(skills[0]).length > 262144 + 4096 || new Set([...files.keys()].map(key => key.toLowerCase())).size !== files.size) throw invalid()
    const nativeDir = skills[0].split('/')[0]
    const skillText = new TextDecoder('utf-8', { fatal: true }).decode(files.get(skills[0]))
    if (reference.kind === 'imports') {
      if (nativeDir !== 'bundle' || [...files.keys()].some(key => !key.startsWith('bundle/'))) throw invalid()
    } else {
      const bytes = files.get('manifest.json')
      if (!bytes || bytes.length > 65536) throw invalid()
      const manifest = JSON.parse(bytes.toString('utf8'))
      if (Object.keys(manifest).sort().join(',') !== 'digest,nativeName,resources,schemaVersion' || manifest.schemaVersion !== 1
        || manifest.nativeName !== reference.expectedName || nativeDir !== reference.expectedName
        || manifest.digest !== `sha256:${reference.contentId}` || !Array.isArray(manifest.resources) || manifest.resources.length > 128
        || bytes.toString('utf8') !== `${canonicalJson(manifest)}\n`) throw invalid()
      const expected = new Set(['manifest.json', skills[0]])
      for (const resource of manifest.resources) {
        if (!resource || Object.keys(resource).sort().join(',') !== 'digest,id,path,size') throw invalid()
        resourcePath(resource.path)
        const data = files.get(`${nativeDir}/${resource.path}`)
        if (!data || !Number.isSafeInteger(resource.size) || resource.size !== data.length
          || resource.digest !== `sha256:${sha(data)}` || resource.id !== `resource:${sha(data)}` || expected.has(`${nativeDir}/${resource.path}`)) throw invalid()
        expected.add(`${nativeDir}/${resource.path}`)
      }
      if (expected.size !== files.size || [...files.keys()].some(key => !expected.has(key))
        || sha(canonicalJson({ file: skillText, resources: manifest.resources })) !== reference.contentId) throw invalid()
    }
    return { root, dev: rootOpened.stat.dev, ino: rootOpened.stat.ino,
      digest: sha(canonicalJson({ files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, sha(bytes)]),
        metadata: metadata.sort(([a], [b]) => String(a).localeCompare(String(b))) })) }
  } catch { throw invalid() }
  finally { await rootOpened.handle.close() }
}

/** Deployment-owned shape, resolved to an immutable image ID before it executes.
 * @param {any} config @param {any} reference @param {string} imageId @param {string} jobId */
export function skillValidationPlan(config, reference, imageId, jobId) {
  const checked = validateSkillReference(reference)
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageId) || !/^[a-f0-9-]{36}$/u.test(jobId)) throw invalid()
  const identity = sha(canonicalJson(checked))
  return { name: NAME, identity, jobId, args: ['create', '--name', NAME,
    '--label', 'open-science.skill-validation=true', '--label', `open-science.skill-reference=${identity}`, '--label', `open-science.skill-job=${jobId}`,
    '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--cpus=0.5', '--memory=256m', '--memory-swap=256m',
    '--user', String(config.runtimeContainerUser || `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`),
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--env', 'HOME=/tmp', '--env', 'DSH_HOME=/tmp/dsh', '--env', 'DSH_AGENTS_HOME=/tmp/agents',
    '--env', 'DSH_TELEMETRY_DISABLED=1', '--mount', `${dockerRuntimeMount(config, skillValidationRoot(config, checked), '/input')},readonly`,
    '--entrypoint', 'node', imageId, '/opt/evimed/socket/scripts/validate-personal-skill.mjs', checked.expectedName ?? ''] }
}

/** A fixed container name provides one physical slot across processes/restarts.
 * @param {any} config @param {{availableMemory?:()=>Promise<number>,setTimer?:typeof setTimeout,clearTimer?:typeof clearTimeout}} [hooks] */
export function createSkillValidationController(config, hooks = {}) {
  const availableMemory = hooks.availableMemory ?? (async () => {
    const text = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '')
    return Number(text.match(/^MemAvailable:\s+(\d+)/mu)?.[1]) * 1024 || os.freemem()
  })
  const setTimer = hooks.setTimer ?? setTimeout
  const clearTimer = hooks.clearTimer ?? clearTimeout
  const statePath = path.join(config.dataDir, '.openscience', 'skill-validation-state', 'creation-uncertain.json')
  const cancellationPath = identity => path.join(config.dataDir, '.openscience', 'skill-validation-state', 'canceled', `${identity}.json`)
  const docker = args => spawnSync(config.runtimeContainerBin, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 })
  let active = null
  let reserved = false
  let closing = false
  let imagePromise
  const image = () => imagePromise ??= Promise.resolve().then(() => {
    const result = docker(['image', 'inspect', '--format', '{{.Id}}', config.runtimeContainerImage])
    if (result.status !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(result.stdout.trim())) throw new HttpError(503, 'product_state_unavailable', 'The skill validation image is unavailable.')
    return result.stdout.trim()
  })
  const inventory = () => {
    const result = docker(['inspect', '--format', '{{json .}}', NAME])
    if (result.status !== 0) {
      if (/no such (object|container)/iu.test(result.stderr ?? '')) return null
      throw new HttpError(503, 'product_state_unavailable', 'Skill validation availability cannot be verified.')
    }
    try { return JSON.parse(result.stdout) } catch { throw new HttpError(503, 'product_state_unavailable', 'Skill validation state is unavailable.') }
  }
  /** Remove only this exact labeled job and join both Docker state and its CLI. */
  async function stop(job) {
    const current = inventory()
    if (current) {
      if (current.Config?.Labels?.['open-science.skill-job'] !== job.plan.jobId
        || current.Config?.Labels?.['open-science.skill-reference'] !== job.plan.identity) throw new HttpError(503, 'product_state_unavailable', 'Skill validation capacity remains reserved.')
      if (!/^[a-f0-9]{64}$/u.test(current.Id) || docker(['rm', '-f', current.Id]).status !== 0 || inventory() !== null) throw new HttpError(503, 'product_state_unavailable', 'Skill validation cancellation remains pending.')
    }
    if (job.child && job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGKILL')
    if (job.closed) await job.closed
    if (job.uncertain) throw new HttpError(503, 'product_state_unavailable', 'Skill validation creation remains uncertain.')
    const marker = await openScopedFileNoFollow(config.dataDir, statePath).catch(error => {
      if (['ENOENT', 'file_not_found'].includes(error.code)) return null
      throw error
    })
    if (marker) {
      try {
        const saved = JSON.parse((await readStableFileHandle(marker.handle, marker.stat)).toString('utf8'))
        if (saved.jobId !== job.plan.jobId || saved.identity !== job.plan.identity) throw invalid()
      } finally { await marker.handle.close() }
      await fs.rm(statePath)
    }
  }
  /** Label-bound joined cancellation; absence plus an uncertain marker is never an ACK.
   * @param {any} reference */
  async function cancel(reference) {
    const checked = validateSkillReference(reference)
    const identity = sha(canonicalJson(checked))
    // A cancel may arrive before the validation request's body is dispatched.
    // This bounded tombstone prevents that late request from creating a worker
    // after an absence was acknowledged, including across controller restarts.
    await writeFileAtomicNoFollow(config.dataDir, cancellationPath(identity), `${canonicalJson({ until: Date.now() + 60000 })}\n`, { mode: 0o600 })
    if (active?.identity === identity) {
      const job = active
      job.abort.abort()
      await job.done
      if (active === job && reserved) {
        await stop(job)
        active = null
        reserved = false
      }
      return { cancelled: true }
    }
    const current = inventory()
    const marker = await openScopedFileNoFollow(config.dataDir, statePath).catch(error => {
      if (['ENOENT', 'file_not_found'].includes(error.code)) return null
      throw error
    })
    let saved = null
    if (marker) {
      try {
        if (marker.stat.size > 4096) throw invalid()
        saved = JSON.parse((await readStableFileHandle(marker.handle, marker.stat)).toString('utf8'))
      } finally { await marker.handle.close() }
    }
    if (current?.Config?.Labels?.['open-science.skill-reference'] === identity) {
      const jobId = current.Config.Labels['open-science.skill-job']
      if (current.Config.Labels['open-science.skill-validation'] !== 'true' || !/^[a-f0-9-]{36}$/u.test(jobId)
        || saved?.jobId !== jobId || saved?.identity !== identity) throw invalid()
      await stop({ plan: { jobId, identity }, child: null, closed: null, uncertain: false })
      return { cancelled: true }
    }
    if (saved?.identity === identity) throw new HttpError(503, 'product_state_unavailable', 'Skill validation cancellation could not be confirmed.')
    return { cancelled: true }
  }
  /** @param {any} reference @param {AbortSignal} [signal] */
  async function validate(reference, signal) {
    const checked = validateSkillReference(reference)
    if (reserved || closing) throw new HttpError(503, 'product_state_unavailable', 'Skill validation is busy.')
    reserved = true
    const abort = new AbortController()
    signal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    let done = () => {}
    const job = { identity: sha(canonicalJson(checked)), plan: null, child: null, closed: null, uncertain: false, createdAttempted: false, abort,
      done: new Promise(resolve => { done = () => resolve(undefined) }) }
    active = job
    try {
      if (signal?.aborted) throw invalid()
      const cancelled = await openScopedFileNoFollow(config.dataDir, cancellationPath(job.identity)).catch(error => {
        if (['ENOENT', 'file_not_found'].includes(error.code)) return null
        throw error
      })
      if (cancelled) {
        try {
          const until = cancelled.stat.size <= 4096 ? JSON.parse((await readStableFileHandle(cancelled.handle, cancelled.stat)).toString('utf8')).until : null
          if (!Number.isSafeInteger(until) || until < 0 || until > Date.now()) {
            throw new HttpError(409, 'product_state_unavailable', 'Skill validation was cancelled; retry after the pending request expires.')
          }
        } finally { await cancelled.handle.close() }
        await fs.rm(cancellationPath(job.identity))
      }
      const before = await snapshot(config, checked)
      const imageId = await image()
      assertDockerDataVolumeSupport(config)
      job.plan = skillValidationPlan(config, checked, imageId, randomUUID())
      if (inventory() || await fs.lstat(statePath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new HttpError(503, 'product_state_unavailable', 'Skill validation is busy or requires recovery.')
      if (await availableMemory() < 768 * 1024 * 1024) throw new HttpError(503, 'product_state_unavailable', 'Skill validation is waiting for host memory.')
      if (signal?.aborted) throw invalid()
      await writeFileExclusiveNoFollow(config.dataDir, statePath, `${canonicalJson({ jobId: job.plan.jobId, identity: job.plan.identity })}\n`, { mode: 0o600 })
      job.uncertain = true
      job.createdAttempted = true
      const created = docker(job.plan.args)
      if (created.status !== null) job.uncertain = false
      if (created.status !== 0) throw new HttpError(503, 'product_state_unavailable', 'Skill validation could not start.')
      const createdState = inventory()
      const mounts = createdState?.HostConfig?.Mounts
      const expectedSubpath = path.relative(path.resolve(config.dataDir), before.root).split(path.sep).join('/')
      const mountMatches = Array.isArray(mounts) && mounts.length === 1 && mounts[0].Target === '/input' && mounts[0].ReadOnly === true
        && (config.runtimeDataVolume ? mounts[0].Type === 'volume' && mounts[0].Source === config.runtimeDataVolume
          && mounts[0].VolumeOptions?.Subpath === expectedSubpath : mounts[0].Type === 'bind' && mounts[0].Source === before.root)
      if (!createdState || createdState.Config?.Labels?.['open-science.skill-job'] !== job.plan.jobId
        || !/^[a-f0-9]{64}$/u.test(createdState.Id)
        || createdState.Image !== imageId || createdState.HostConfig?.ReadonlyRootfs !== true || createdState.HostConfig?.NetworkMode !== 'none'
        || createdState.HostConfig?.Memory !== 256 * 1024 * 1024 || createdState.HostConfig?.MemorySwap !== 256 * 1024 * 1024
        || createdState.HostConfig?.NanoCpus !== 500000000 || createdState.HostConfig?.PidsLimit !== 32
        || !createdState.HostConfig?.CapDrop?.includes('ALL') || !createdState.HostConfig?.SecurityOpt?.some(value => /^no-new-privileges(?:=true)?$/u.test(value))
        || !mountMatches || createdState.Mounts?.length !== 1 || createdState.Mounts[0].Destination !== '/input' || createdState.Mounts[0].RW !== false) {
        throw new HttpError(503, 'product_state_unavailable', 'Skill validation startup could not be verified.')
      }
      const mounted = await snapshot(config, checked)
      if (before.dev !== mounted.dev || before.ino !== mounted.ino || before.digest !== mounted.digest) throw invalid()
      const result = await new Promise((resolve, reject) => {
        const child = spawn(config.runtimeContainerBin, ['start', '--attach', createdState.Id], { stdio: ['ignore', 'pipe', 'pipe'] })
        job.child = child
        job.closed = new Promise(joined => child.once('close', joined))
        const chunks = []
        let bytes = 0
        let ended = false
        const finish = (error, value = null) => {
          if (ended) return
          ended = true
          clearTimer(timer)
          signal?.removeEventListener('abort', onAbort)
          if (error) reject(error); else resolve(value)
        }
        const onAbort = () => finish(new HttpError(400, 'extension_contract_invalid', 'Skill validation stopped.'))
        const timer = setTimer(() => finish(new HttpError(504, 'extension_contract_invalid', 'Skill validation timed out.')), SKILL_VALIDATION_TIMEOUT_MS)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
        child.stdout.on('data', chunk => {
          bytes += chunk.length
          if (bytes > SKILL_VALIDATION_OUTPUT_BYTES) { finish(invalid()); return }
          chunks.push(chunk)
        })
        let errors = 0
        child.stderr.on('data', chunk => { errors += chunk.length; if (errors > 8192) finish(invalid()) })
        child.once('error', () => finish(invalid()))
        child.once('close', code => {
          if (code !== 0) { finish(invalid()); return }
          try {
            const output = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (!output || Object.keys(output).some(key => !['name', 'description', 'instructions', 'invocation', 'metadata', 'whenToUse'].includes(key))
              || typeof output.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(output.name)
              || typeof output.description !== 'string' || Buffer.byteLength(output.description) > 2048
              || typeof output.instructions !== 'string' || Buffer.byteLength(output.instructions) > 262144
              || !output.invocation || Object.keys(output.invocation).sort().join(',') !== 'modelInvocable,userInvocable'
              || typeof output.invocation.modelInvocable !== 'boolean' || typeof output.invocation.userInvocable !== 'boolean'
              || !output.metadata || typeof output.metadata !== 'object' || Array.isArray(output.metadata) || Buffer.byteLength(JSON.stringify(output.metadata)) > 65536
              || (output.whenToUse !== undefined && (typeof output.whenToUse !== 'string' || Buffer.byteLength(output.whenToUse) > 4096))
              || (checked.expectedName !== null && output.name !== checked.expectedName)) throw invalid()
            finish(null, output)
          } catch { finish(invalid()) }
        })
      })
      const after = await snapshot(config, checked)
      if (before.dev !== after.dev || before.ino !== after.ino || before.digest !== after.digest) throw invalid()
      return result
    } finally {
      try {
        if (job.createdAttempted) await stop(job)
        active = null
        reserved = false
      } finally { done() }
    }
  }
  return { validate, cancel, async close() {
    closing = true
    if (active) { active.abort.abort(); await active.done; if (active?.createdAttempted) await stop(active) }
  } }
}
