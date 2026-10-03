import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { canonicalJson, extensionGenerationIdentity, personalSkillName, canonicalPersonalSkillResourcePath } from '@evimed/domain'
import { ProductDocuments, ProductJobs } from './productStore.mjs'
import { selectPersonalSkillMounts } from './personalSkillMount.mjs'
import { HttpError, openScopedDirectoryNoFollow, openScopedFileNoFollow, readStableFileHandle, writeFileExclusiveNoFollow, assertProjectCapacity, directorySize } from './security.mjs'

export const PERSONAL_SKILLS_RUNTIME_DIR = '/opt/evimed/personal-skills'
const sha = value => createHash('sha256').update(value).digest('hex')
const HEX = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const fail = () => new HttpError(400, 'extension_contract_invalid', 'The personal skill generation is invalid.')
const stateId = project => `personal-skills:project:${project.id}`
/** Domain identity plus authoritative account/project epochs and the selection CAS version.
 * @param {any} identity @param {any} scope @param {number} selectionRevision */
const generationIdentity = (identity, scope, selectionRevision) => sha(canonicalJson({
  identity: extensionGenerationIdentity(identity, { ownerId: identity.ownerId, projectId: identity.projectId }, sha), scope, selectionRevision,
}))

/** The private controller never accepts an arbitrary mount or another owner's reference. @param {any} project @param {any} value */
export function validatePersonalGenerationReference(project, value) {
  if (value === null || value === undefined) return null
  if (!value || Object.keys(value).sort().join(',') !== 'generationHash,ownerHash,projectHash'
    || value.ownerHash !== sha(project.userId) || value.projectHash !== sha(project.id) || !HEX.test(value.generationHash)) throw fail()
  return { ownerHash: value.ownerHash, projectHash: value.projectHash, generationHash: value.generationHash }
}
/** @param {any} config @param {any} reference */
export function personalGenerationRoot(config, reference) {
  if (!reference || !HEX.test(reference.ownerHash) || !HEX.test(reference.projectHash) || !HEX.test(reference.generationHash)) throw fail()
  return path.join(config.dataDir, '.openscience', 'personal-skill-generations', reference.ownerHash, reference.projectHash, reference.generationHash)
}
/** Only an internal selected path strips the fixed namespace prefix.
 * @param {string} value @param {boolean} [selected] @param {Map<string,string>} [prefixes] */
function filePath(value, selected = false, prefixes) {
  if (typeof value !== 'string') throw fail()
  const parts = value.split('/')
  const prefix = selected ? parts.slice(0, 2).join('/') + '/' : ''
  if (selected && (parts[0] !== 'skills' || !/^personal-[a-f0-9]{16}-[a-f0-9]{32}$/u.test(parts[1]))) throw fail()
  const relative = selected ? parts.slice(2).join('/') : value
  try { if (canonicalPersonalSkillResourcePath(relative, prefixes).path !== relative) throw fail() }
  catch { throw fail() }
  return prefix + relative
}
/** @param {string} value */
const selectedKey = value => value.split('/').slice(0, 2).join('/') + '/' + canonicalPersonalSkillResourcePath(value.split('/').slice(2).join('/')).key
/** Independent generation verification shared by the controller and trusted runtime planner.
 * Manifest content never grants filesystem or execution authority.
 * @param {any} config @param {any} project @param {any} reference @param {string|null} [expectedImage] */
export async function verifyPersonalSkillGeneration(config, project, reference, expectedImage = null) {
  const checked = validatePersonalGenerationReference(project, reference)
  if (!checked) return null
  const root = personalGenerationRoot(config, checked)
  for (const privateRoot of [path.dirname(path.dirname(root)), path.dirname(root), root]) {
    const directory = await openScopedDirectoryNoFollow(config.dataDir, privateRoot)
    try { if ((directory.stat.mode & 0o7777) !== 0o700) throw fail() }
    finally { await directory.handle.close() }
  }
  const input = await openScopedFileNoFollow(config.dataDir, path.join(root, 'manifest.json'))
  let bytes
  try { if (input.stat.size > 1024 * 1024 || (input.stat.mode & 0o7777) !== 0o400) throw fail(); bytes = await readStableFileHandle(input.handle, input.stat) }
  finally { await input.handle.close() }
  let manifest
  try { manifest = JSON.parse(bytes.toString('utf8')) } catch { throw fail() }
  if (Object.keys(manifest).sort().join(',') !== 'files,identity,pins,reference,schemaVersion,scope,selectionRevision'
    || manifest.schemaVersion !== 1 || canonicalJson(manifest.reference) !== canonicalJson(checked)
    || bytes.toString('utf8') !== `${canonicalJson(manifest)}\n` || !Array.isArray(manifest.files) || manifest.files.length > 512
    || !Array.isArray(manifest.pins) || manifest.pins.length > 64 || !Number.isSafeInteger(manifest.selectionRevision)
    || manifest.identity.ownerId !== project.userId || manifest.identity.projectId !== project.id
    || (expectedImage && manifest.identity.baseRuntimeImageDigest !== expectedImage)
    || generationIdentity(manifest.identity, manifest.scope, manifest.selectionRevision) !== checked.generationHash) throw fail()
  const seen = new Set()
  const contents = new Map(), prefixMaps = new Map()
  let total = 0
  for (const item of manifest.files) {
    if (!item || Object.keys(item).sort().join(',') !== 'digest,path,size') throw fail()
    const native = item.path.split('/')[1]
    if (!prefixMaps.has(native)) prefixMaps.set(native, new Map())
    const relative = filePath(item.path, true, prefixMaps.get(native))
    if (!relative.startsWith('skills/') || seen.has(selectedKey(relative)) || !DIGEST.test(item.digest)
      || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 4 * 1024 * 1024 || (total += item.size) > 64 * 1024 * 1024) throw fail()
    seen.add(selectedKey(relative))
    const file = await openScopedFileNoFollow(config.dataDir, path.join(root, relative))
    try {
      const content = await readStableFileHandle(file.handle, file.stat)
      if (file.stat.size !== item.size || (file.stat.mode & 0o7777) !== 0o444 || `sha256:${sha(content)}` !== item.digest) throw fail()
      contents.set(relative, content)
    } finally { await file.handle.close() }
  }
  const declared = new Set()
  for (const pin of manifest.pins) {
    if (pin.nativeName !== personalSkillName(project.userId, pin.skillId, sha) || pin.ownerHash !== checked.ownerHash || pin.contentId !== pin.digest?.slice(7)
      || !manifest.identity.skills.some(item => item.skillId === pin.skillId && item.revision === pin.revision && item.digest === pin.digest)
      || !seen.has(`skills/${pin.nativeName}/skill.md`) || !Array.isArray(pin.resources) || pin.resources.length > 128) throw fail()
    declared.add(`skills/${pin.nativeName}/skill.md`)
    for (const resource of pin.resources) {
      const resourceKey = `skills/${pin.nativeName}/` + canonicalPersonalSkillResourcePath(resource.path).key
      if (declared.has(resourceKey) || resourceKey.split('/').at(-1) === 'skill.md') throw fail()
      declared.add(resourceKey)
      filePath(resource.path)
      const content = contents.get(`skills/${pin.nativeName}/${resource.path}`)
      if (!content || resource.id !== `resource:${sha(content)}` || resource.digest !== `sha256:${sha(content)}` || resource.size !== content.length) throw fail()
    }
    const file = new TextDecoder('utf-8', { fatal: true }).decode(contents.get(`skills/${pin.nativeName}/SKILL.md`))
    if (`sha256:${sha(canonicalJson({ file, resources: pin.resources }))}` !== pin.digest) throw fail()
  }
  if (declared.size !== seen.size || [...declared].some(key => !seen.has(key))) throw fail()
  if (manifest.identity.skills.length !== manifest.pins.length || new Set(manifest.pins.map(pin => pin.skillId)).size !== manifest.pins.length) throw fail()
  // Detect unmanifested files and any symbolic/special entry, including directories.
  const actual = new Set()
  const expectedDirectories = new Set(['', 'skills'])
  for (const file of manifest.files) {
    const parts = file.path.split('/')
    for (let depth = 1; depth < parts.length; depth++) expectedDirectories.add(parts.slice(0, depth).join('/'))
  }
  let count = 0
  const walk = async directoryPath => {
    const opened = await openScopedDirectoryNoFollow(config.dataDir, directoryPath)
    try {
      const relative = path.relative(root, directoryPath).split(path.sep).join('/')
      if (!expectedDirectories.has(relative) || (opened.stat.mode & 0o7777) !== (relative ? 0o755 : 0o700)) throw fail()
      for (const entry of await fs.readdir(opened.path, { withFileTypes: true })) {
        if (++count > 1024) throw fail()
        const target = path.join(directoryPath, entry.name)
        if (entry.isDirectory()) { await walk(target); continue }
        if (!entry.isFile()) throw fail()
        const relativeFile = path.relative(root, target).split(path.sep).join('/')
        if (relativeFile !== relativeFile.normalize('NFC') || relativeFile !== 'manifest.json' && !contents.has(relativeFile)) throw fail()
        const key = relativeFile === 'manifest.json' ? relativeFile : selectedKey(filePath(relativeFile, true))
        if (actual.has(key)) throw fail()
        actual.add(key)
      }
    } finally { await opened.handle.close() }
  }
  await walk(root)
  if (actual.size !== seen.size + 1 || !actual.has('manifest.json') || [...seen].some(name => !actual.has(name))) throw fail()
  return { reference: checked, pins: manifest.pins, selectionRevision: manifest.selectionRevision, identity: manifest.identity,
    scope: manifest.scope, root, mountRoot: path.join(root, 'skills') }
}

/** Product documents/jobs remain the only durable state. Identity callbacks are trusted deployment authority. */
export class PersonalSkillGenerationService {
  /** @param {any} database @param {{config:any,skillService:any,pluginService:any,resolveUser:(project:any)=>Promise<any>,identities:(project:any)=>Promise<any>,ledgerBusy?:(project:any)=>Promise<boolean>,documents?:any,jobs?:any}} options */
  constructor(database, { config, skillService, pluginService, resolveUser, identities, ledgerBusy = async () => true,
    documents = new ProductDocuments(database), jobs = new ProductJobs(database) }) {
    this.database = database; this.config = config; this.skills = skillService; this.plugins = pluginService
    this.resolveUser = resolveUser; this.identities = identities; this.ledgerBusy = ledgerBusy; this.documents = documents; this.jobs = jobs
  }
  /** @param {any} project */
  async current(project) {
    const user = await this.resolveUser(project)
    await this.skills.requireProject(user, project)
    return this.documents.get(user.id, 'extension-generation', stateId(project))
  }
  /** @param {any} user @param {any} project */
  async reconcile(user, project) {
    await this.skills.requireProject(user, project)
    await this.skills.initializeProject(user, project)
    if (String(this.config.runtimeProvider ?? 'docker') !== 'docker') throw new HttpError(503, 'product_state_unavailable', 'Personal skill runtime mounting is unavailable for this provider.')
    const selected = await selectPersonalSkillMounts({ service: this.skills, user, project })
    const borrowedScope = this.plugins.borrowAdmission(`${user.id}:${project.id}`, client => this.plugins.scope(user, project, client))
    const scope = borrowedScope ? await borrowedScope : await this.database.transaction(client => this.plugins.scope(user, project, client))
    let trusted
    try { trusted = await this.identities(project) }
    catch {
      return this.database.transaction(client => this.database.withTransactionClient(client, async () => {
        const locked = await client.query(`SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind='extension-defaults'
          AND id=$2 AND deleted_at IS NULL FOR SHARE`, [user.id, `skills:project:${project.id}`])
        if (locked.rows[0]?.revision !== selected.selectionRevision) throw new HttpError(409, 'product_revision_conflict', 'Project skills changed.')
        const old = await this.documents.get(user.id, 'extension-generation', stateId(project))
        if (old?.payload.desired?.waiting && old.payload.desired.selectionRevision === selected.selectionRevision) return old.payload.desired
        const pending = { reference: null, pins: [], identity: null, scope, selectionRevision: selected.selectionRevision,
          findings: [...selected.findings, { code: 'runtime_image_unavailable' }], waiting: true }
        const row = await this.documents.put(user.id, 'extension-generation', stateId(project), { desired: pending,
          effective: old?.payload.effective ?? null, lastGood: old?.payload.lastGood ?? null, phase: 'waiting', error: 'runtime_image_unavailable' },
        { expectedRevision: old?.revision ?? 0, projectId: project.id })
        await this.jobs.enqueue(user.id, 'personal-skill-apply', { stateRevision: row.revision, generationHash: null,
          selectionRevision: selected.selectionRevision, accountCreatedAt: scope.accountCreatedAt, projectCreatedAt: scope.projectCreatedAt },
        { idempotencyKey: `personal-skill-apply:${project.id}:${row.revision}`, projectId: project.id, maxAttempts: 3, transactionClient: client })
        return pending
      }))
    }
    if (!trusted || Object.keys(trusted).sort().join(',') !== 'adapterRevision,baseRuntimeImageDigest,permissionProfileRevision'
      || Object.values(trusted).some(value => !DIGEST.test(String(value)))) throw fail()
    const identity = { ownerId: user.id, projectId: project.id, ...trusted, selections: [],
      skills: selected.skills.map(pin => ({ skillId: pin.skillId, revision: pin.revision, digest: pin.digest })) }
    const generationHash = generationIdentity(identity, scope, selected.selectionRevision)
    const reference = { ownerHash: sha(user.id), projectHash: sha(project.id), generationHash }
    const root = personalGenerationRoot(this.config, reference)
    const files = []; const pins = []; let total = 0
    const ownerRoot = path.join(this.config.dataDir, '.openscience', 'personal-skill-generations', reference.ownerHash)
    const owned = await openScopedDirectoryNoFollow(this.config.dataDir, ownerRoot, { create: true })
    await owned.handle.close()
    /** @param {string} relative @param {Buffer} bytes */
    const publishImmutable = async (relative, bytes) => {
      const target = path.join(root, filePath(relative, relative.startsWith('skills/')))
      const mode = relative.startsWith('skills/') ? 0o444 : 0o400
      const write = () => this.database.transaction(client => this.database.withTransactionClient(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ['evimed-personal-skill-storage'])
        // Reusing an immutable generation consumes no new bytes, even at capacity.
        let existing
        try { existing = await openScopedFileNoFollow(this.config.dataDir, target) }
        catch (error) { if (!['ENOENT', 'file_not_found'].includes(error.code)) throw error }
        if (existing) {
          try {
            if (existing.stat.size !== bytes.length || !bytes.equals(await readStableFileHandle(existing.handle, existing.stat))) throw fail()
            await existing.handle.chmod(mode)
          }
          finally { await existing.handle.close() }
          return
        }
        await assertProjectCapacity({ baseDir: ownerRoot, maxBytes: 256 * 1024 * 1024 }, target, bytes.length, { maxProjectUsageScanEntries: 20000 })
        const globalRoot = path.dirname(ownerRoot)
        const extensionRoot = path.join(this.config.dataDir, '.openscience', 'extension-generations')
        let extensionBytes = 0
        try {
          const companion = await openScopedDirectoryNoFollow(this.config.dataDir, extensionRoot)
          await companion.handle.close()
          extensionBytes = await directorySize(extensionRoot, { maxEntries: 50000 })
        } catch (error) { if (!['ENOENT', 'file_not_found'].includes(error.code)) throw error }
        const used = await directorySize(globalRoot, { maxEntries: 50000 })
          + await directorySize(this.skills.artifacts.root, { maxEntries: 50000 }) + extensionBytes
        const disk = await fs.statfs(globalRoot)
        if (used + bytes.length > this.skills.artifacts.maxGlobalBytes || disk.bavail * disk.bsize < bytes.length + this.skills.artifacts.minFreeBytes) {
          throw new HttpError(503, 'extension_storage_capacity', 'Personal skill generation is waiting for storage space.')
        }
        await writeFileExclusiveNoFollow(this.config.dataDir, target, bytes, { mode })
        // A restrictive web-process umask must not make the selected projection
        // unreadable to its distinct runtime UID. Clamp through the vetted FD.
        const written = await openScopedFileNoFollow(this.config.dataDir, target)
        try { await written.handle.chmod(mode) }
        finally { await written.handle.close() }
      }))
      try { await write() }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        const existing = await openScopedFileNoFollow(this.config.dataDir, target)
        try { if (existing.stat.size !== bytes.length || !bytes.equals(await readStableFileHandle(existing.handle, existing.stat))) throw fail() }
        finally { await existing.handle.close() }
      }
    }
    /** @param {string} relative @param {Buffer} bytes */
    const publish = async (relative, bytes) => {
      if (files.length >= 512 || (total += bytes.length) > 64 * 1024 * 1024) throw fail()
      await publishImmutable(relative, bytes)
      files.push({ path: relative, size: bytes.length, digest: `sha256:${sha(bytes)}` })
    }
    for (const pin of selected.skills) {
      const row = await this.skills.atRevision(user, pin.skillId, pin.revision)
      if (row.payload.digest !== pin.digest) throw fail()
      const original = await this.skills.artifacts.preparedRoot(user, row.payload)
      pins.push({ ...pin, resources: row.payload.resources })
      const opened = await openScopedFileNoFollow(this.skills.artifacts.root, path.join(original, pin.nativeName, 'SKILL.md'))
      try { await publish(`skills/${pin.nativeName}/SKILL.md`, await readStableFileHandle(opened.handle, opened.stat)) }
      finally { await opened.handle.close() }
      for (const resource of row.payload.resources) {
        if (canonicalPersonalSkillResourcePath(resource.path.split('/').at(-1)).key === 'skill.md') throw fail()
        await publish(`skills/${pin.nativeName}/${filePath(resource.path)}`, await this.skills.artifacts.read(user, { resource }))
      }
    }
    // Only the selected mount subtree is readable across runtime UIDs; the
    // owner/project/generation ancestors and its manifest remain private.
    const readableDirectories = new Set(['skills'])
    for (const file of files) {
      const parts = file.path.split('/')
      for (let depth = 1; depth < parts.length; depth++) readableDirectories.add(parts.slice(0, depth).join('/'))
    }
    for (const relative of readableDirectories) {
      const directory = await openScopedDirectoryNoFollow(this.config.dataDir, path.join(root, relative), { create: true })
      try { await directory.handle.chmod(0o755) }
      finally { await directory.handle.close() }
    }
    const manifest = { schemaVersion: 1, reference, identity, scope, selectionRevision: selected.selectionRevision,
      pins, files: files.sort((a, b) => a.path.localeCompare(b.path)) }
    const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`)
    if (manifestBytes.length > 1024 * 1024) throw fail()
    await publishImmutable('manifest.json', manifestBytes)
    await verifyPersonalSkillGeneration(this.config, project, reference, trusted.baseRuntimeImageDigest)
    const candidate = { reference, pins, selectionRevision: selected.selectionRevision, findings: selected.findings, identity, scope }
    return this.database.transaction(client => this.database.withTransactionClient(client, async () => {
      const locked = await client.query(`SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind='extension-defaults'
        AND id=$2 AND deleted_at IS NULL FOR SHARE`, [user.id, `skills:project:${project.id}`])
      if (locked.rows[0]?.revision !== selected.selectionRevision) throw new HttpError(409, 'product_revision_conflict', 'Project skills changed before publication.')
      const freshScope = await this.plugins.scope(user, project, client)
      if (canonicalJson(freshScope) !== canonicalJson(scope)) throw new HttpError(409, 'plugin_generation_changed', 'Project ownership changed.')
      const immutableId = `personal-skills:generation:${generationHash}`
      const immutable = await this.documents.get(user.id, 'extension-generation', immutableId)
      if (!immutable) await this.documents.put(user.id, 'extension-generation', immutableId, candidate, { expectedRevision: 0, projectId: project.id })
      else if (canonicalJson(immutable.payload) !== canonicalJson(candidate)) throw fail()
      const old = await this.documents.get(user.id, 'extension-generation', stateId(project))
      if (old?.payload.desired?.reference?.generationHash === generationHash && old.payload.desired.selectionRevision === selected.selectionRevision) return old.payload.desired
      const state = await this.documents.put(user.id, 'extension-generation', stateId(project), { desired: candidate,
        effective: old?.payload.effective ?? null, lastGood: old?.payload.lastGood ?? null, phase: 'waiting', error: null },
      { expectedRevision: old?.revision ?? 0, projectId: project.id })
      await this.jobs.enqueue(user.id, 'personal-skill-apply', { stateRevision: state.revision, generationHash,
        selectionRevision: selected.selectionRevision, accountCreatedAt: scope.accountCreatedAt, projectCreatedAt: scope.projectCreatedAt },
      { idempotencyKey: `personal-skill-apply:${project.id}:${state.revision}`, projectId: project.id, maxAttempts: 3, transactionClient: client })
      return candidate
    }))
  }
  /** Existing effective bytes survive cold recovery; only first-ever idle startup may use desired.
   * @param {any} project */
  async prepareForRuntime(project) {
    const user = await this.resolveUser(project)
    let state = await this.current(project)
    const selection = await this.skills.projectSelections(user, project)
    const identity = await this.identities(project).catch(() => null)
    const baseline = () => ({ reference: null, pins: [], selectionRevision: selection.revision, findings: [] })
    const compatible = candidate => !!identity && !!candidate?.reference
      && ['baseRuntimeImageDigest', 'adapterRevision', 'permissionProfileRevision'].every(key => identity[key] === candidate.identity?.[key])
    if (!identity || !state || state.payload.desired?.selectionRevision !== selection.revision
      || !compatible(state.payload.desired)) {
      try { await this.reconcile(user, project); state = await this.current(project) }
      catch { return baseline() }
    }
    // Cold recovery must not depend on a retired image. Existing active runtime
    // entries keep their captured pins; this only selects bytes for a new start.
    if (!identity) return baseline()
    const permitted = candidate => compatible(candidate) && (candidate.pins ?? []).every(pin =>
      (state.payload.desired?.pins ?? []).some(wanted => wanted.skillId === pin.skillId && wanted.revision === pin.revision && wanted.digest === pin.digest))
    const candidate = [state.payload.effective, state.payload.lastGood].find(permitted)
      ?? (await this.ledgerBusy(project) || !compatible(state.payload.desired) ? null : state.payload.desired)
    if (!candidate) return baseline()
    try { await verifyPersonalSkillGeneration(this.config, project, candidate.reference, identity.baseRuntimeImageDigest) }
    catch { return baseline() }
    // Startup is not proof: markEffective remains the leased worker's decision.
    return candidate
  }
  /** @param {any} project @param {any} candidate @param {string} runtimeGeneration @param {any} [transactionClient] */
  async markEffective(project, candidate, runtimeGeneration, transactionClient = null) {
    const current = await this.documents.get(project.userId, 'extension-generation', stateId(project))
    if (current?.payload.desired?.reference.generationHash !== candidate.reference.generationHash) throw new HttpError(409, 'product_revision_conflict', 'Project skill generation changed.')
    return this.documents.put(project.userId, 'extension-generation', stateId(project), { ...current.payload,
      effective: candidate, lastGood: candidate, phase: 'effective', runtimeGeneration, error: null },
    { expectedRevision: current.revision, projectId: project.id, transactionClient })
  }
  /** @param {any} project @param {string} skillId @param {number} revision */
  async requireInvocation(project, skillId, revision) {
    const user = await this.resolveUser(project)
    const source = await this.skills.atRevision(user, skillId, revision)
    const desired = await this.skills.projectSelections(user, project)
    if (!desired.payload.skills.some(pin => pin.skillId === skillId && pin.revision === revision && pin.digest === source.payload.digest)) throw fail()
    if (source.payload.invocation.userInvocable !== true) throw new HttpError(403, 'extension_access_denied', 'This skill cannot be invoked by a user.')
    return source.payload
  }
}
