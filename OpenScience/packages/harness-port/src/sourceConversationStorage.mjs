/** Pinned JSONL storage maintenance, adopted 2026-11-05. Upstream exposes
 * read/header and KV APIs, but no source-session deletion API. Remove the path
 * encoding and backup adapters when an upstream deletion operation covers them.
 * This module runs only in an isolated, networkless helper while its kernel is
 * absent. It never loads an agent or a model provider. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

/** @typedef {{id:string, version?:number, createdAt?:number, cwd?:string, isSeeded?:boolean, origin?:string, parentSession?:string, delegationDepth?:number, absent?:boolean}} Header */
/** @typedef {{sessions:string, storages:string}} StoragePaths */
/** @typedef {{headers:()=>Promise<Header[]>, scrubReferences:(ids:Set<string>)=>Promise<void>}} NativeStorage */
const fail = () => new Error('Native source storage identity is missing, changed or unsafe.');
/** @param {unknown} value */
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
/** @param {string} value */
function encode(value) {
  if (!value) throw fail();
  if (value === '.' || value === '..') return value.replaceAll('.', '~002E');
  let result = '';
  for (let i = 0; i < value.length; i++) result += /[a-zA-Z0-9._-]/.test(value[i]) ? value[i] : `~${value.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  return result;
}
/** @param {Header} header */
export function sourceSessionRelativePath(header) {
  if (!validId(header?.id)) throw fail();
  let project = '_no-cwd';
  if (header.cwd !== undefined) {
    if (typeof header.cwd !== 'string' || !header.cwd || header.cwd.length > 16384) throw fail();
    let readable = '', separator = false;
    for (let i = 0; i < header.cwd.length; i++) {
      const c = header.cwd[i];
      if (/[\\/:]/.test(c)) { if (!separator) readable += '-'; separator = true; }
      else { readable += /[a-zA-Z0-9._-]/.test(c) ? c : `~${header.cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`; separator = false; }
    }
    project = `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
  }
  return `${project}/${encode(header.id)}`;
}
/** @param {Header} value */
function checkedHeader(value) {
  if (!validId(value?.id) || !Number.isSafeInteger(value.version) || Number(value.version) < 0 || Number(value.version) > 4
    || !Number.isFinite(value.createdAt) || typeof value.isSeeded !== 'boolean'
    || value.parentSession !== undefined && !validId(value.parentSession)) throw fail();
  sourceSessionRelativePath(value);
  return globalThis.structuredClone(value);
}
/** @param {Header} value */
function identity(value) {
  return JSON.stringify([value.id, value.createdAt, value.cwd ?? null, value.isSeeded, value.origin ?? null, value.parentSession ?? null, value.delegationDepth ?? 0]);
}
/** Only managed activations belong to a parent's deletion. An independent fork
 * also has parentSession, so parentSession alone is never authority to erase it.
 * @param {Header[]} rows @param {string} rootId */
export function sourceClosure(rows, rootId) {
  const unique = new Map();
  for (const row of rows) { checkedHeader(row); if (unique.has(row.id)) throw fail(); unique.set(row.id, row); }
  const ids = new Set([rootId]); let changed = true;
  while (changed) { changed = false; for (const row of rows) if (row.origin === 'subagent' && row.parentSession !== undefined && ids.has(row.parentSession) && !ids.has(row.id)) { ids.add(row.id); changed = true; } }
  return rows.filter(row => ids.has(row.id)).map(row => globalThis.structuredClone(row));
}
/** @param {string} root @param {number} [maxDepth] */
async function safeTree(root, maxDepth = 8) {
  let count = 0;
  /** @param {string} full @param {number} depth */
  async function walk(full, depth) {
    const stat = await fs.lstat(full).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return;
    if (++count > 100000 || depth > maxDepth || stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw fail();
    if (stat.isDirectory()) for (const entry of await fs.readdir(full)) await walk(path.join(full, entry), depth + 1);
  }
  await walk(root, 0);
}
/** Check the adapter's path against actual files as well as the public header.
 * @param {StoragePaths} paths @param {Header[]} rows @param {string[]} ids */
async function verifyDirectories(paths, rows, ids) {
  await safeTree(paths.sessions);
  const projects = await fs.readdir(paths.sessions, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const id of ids) {
    const candidates = [];
    for (const project of projects) {
      if (!project.isDirectory()) throw fail();
      const candidate = path.join(paths.sessions, project.name, encode(id));
      if (await fs.lstat(candidate).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) candidates.push(candidate);
    }
    const row = rows.find(value => value.id === id);
    if (row ? candidates.length !== 1 || candidates[0] !== path.join(paths.sessions, sourceSessionRelativePath(row)) : candidates.length !== 0) throw fail();
  }
}
/** @param {StoragePaths} paths @param {string} rootId @param {NativeStorage} [native] */
export async function captureSourceStorage(paths, rootId, native = nativeStorage(paths)) {
  if (!validId(rootId)) throw fail();
  await safeTree(paths.sessions);
  const rows = await native.headers(); if (rows.length > 10000) throw fail();
  const sessions = sourceClosure(rows, rootId), root = sessions.find(row => row.id === rootId);
  await verifyDirectories(paths, rows, [rootId, ...sessions.map(row => row.id)]);
  return { root: root ?? { id: rootId, absent: true }, sessions: root ? sessions : [{ id: rootId, absent: true }] };
}
/** The caller holds the same project mutex used by start/cleanup and has proved
 * no container exists. Re-read identities here to refuse reuse of a session id.
 * @param {StoragePaths} paths @param {{root:Header,sessions:Header[]}} frozen @param {NativeStorage} [native] */
export async function purgeSourceStorage(paths, frozen, native = nativeStorage(paths)) {
  if (!validId(frozen?.root?.id) || !Array.isArray(frozen.sessions) || frozen.sessions.length > 10000) throw fail();
  const rootId = frozen.root.id, absent = frozen.root.absent === true;
  const known = absent ? [] : sourceClosure(frozen.sessions, rootId);
  if (!absent && (!known.some(row => row.id === rootId && identity(row) === identity(frozen.root)) || known.length !== frozen.sessions.length)) throw fail();
  await safeTree(paths.storages);
  // A late managed activation can disappear from the public header list after
  // its raw directory is erased. Persist the expanded closure before that first
  // destructive step, so an interrupted cache scrub cannot lose its identity.
  const receipt = path.join(paths.storages, `.evimed-source-purge-${createHash('sha256').update(identity(frozen.root)).digest('hex')}.json`);
  const previous = await readEnvelope(receipt);
  if (previous) {
    if (previous.schema !== 'native-source-purge/1' || identity(previous.root) !== identity(frozen.root) || !Array.isArray(previous.sessions)) throw fail();
    const saved = sourceClosure(previous.sessions, rootId); if (saved.length !== previous.sessions.length || saved.length > 10000) throw fail();
    for (const row of saved) { const existing = known.find(value => value.id === row.id); if (existing && identity(existing) !== identity(row)) throw fail(); if (!existing) known.push(row); }
  }
  const rows = await native.headers(); if (rows.length > 10000) throw fail(); sourceClosure(rows, rootId);
  const actualRoot = rows.find(row => row.id === rootId);
  if (actualRoot && (absent || identity(actualRoot) !== identity(frozen.root))) throw fail();
  for (const row of known) { const actual = rows.find(value => value.id === row.id); if (actual && identity(actual) !== identity(row)) throw fail(); }
  const all = new Map(known.map(row => [row.id, row]));
  for (const row of rows) if (!all.has(row.id)) all.set(row.id, row);
  const removal = sourceClosure([...all.values()], rootId), ids = new Set([rootId, ...removal.map(row => row.id)]);
  await verifyDirectories(paths, rows, [...ids]);
  await fs.mkdir(paths.storages, { recursive: true, mode: 0o700 });
  const temporary = `${receipt}.${randomUUID()}.tmp`;
  const opened = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await opened.writeFile(`${JSON.stringify({ schema: 'native-source-purge/1', root: frozen.root, sessions: removal })}\n`); await opened.sync(); } finally { await opened.close(); }
  await fs.rename(temporary, receipt);
  const parent = await fs.open(paths.storages, constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); }
  for (const row of rows.filter(value => ids.has(value.id))) await fs.rm(path.join(paths.sessions, sourceSessionRelativePath(row)), { recursive: true, force: false });
  await native.scrubReferences(ids);
  const remaining = await native.headers();
  if (remaining.some(row => ids.has(row.id))) throw fail();
  await verifyDirectories(paths, remaining, [...ids]);
  return { sourceRemoved: true, removedSessionIds: [...ids].sort() };
}

/** Resolve only public export entries from the installed image, without a
 * dependency on the host's optional SDK installation. @param {string} name */
async function upstream(name) {
  const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
  return /** @type {any} */ (await import(pathToFileURL(require.resolve(name)).href));
}
/** @param {StoragePaths} paths @returns {NativeStorage} */
function nativeStorage(paths) {
  return {
    async headers() {
      const [{ Context }, jsonl] = await Promise.all([upstream('@deepseek-ai/cordis'), upstream('@deepseek-ai/dsh-session-persistence-jsonl')]);
      const context = new Context();
      try {
        const scope = context.plugin(jsonl, { root: paths.sessions, compression: 'zstd' }); await scope.await();
        const rows = await context.get('sessionPersistence').list();
        return rows.map((/** @type {any} */ row) => checkedHeader(row.header));
      } finally { await context.fiber.dispose(); }
    },
    async scrubReferences(ids) {
      const [{ JsonStorageBackend }, { descriptorOf }, { projectionCacheDomainSpec }, { workspaceDomainSpec }] = await Promise.all([
        upstream('@deepseek-ai/dsh-storage-json'), upstream('@deepseek-ai/dsh-storage-domain'),
        upstream('@deepseek-ai/dsh-session-projection-cache'), upstream('@deepseek-ai/dsh-workspace'),
      ]);
      const backend = new JsonStorageBackend(paths.storages);
      try {
        // Clean the legacy single-file cache before the backend can migrate it.
        const legacy = path.join(paths.storages, 'session_projcache.json');
        const envelope = await readEnvelope(legacy);
        if (envelope) {
          if (envelope.unit?.name !== 'session_projcache' || ![3, 4, 5, 6, 7].includes(envelope.unit.version)) throw fail();
          const unit = await backend.kv.open({ name: 'session_projcache', version: envelope.unit.version, tables: ['sessions'], hasGlobal: false, layout: 'single' });
          try { for (const id of Object.keys((await unit.loadAll()).tables.sessions ?? {})) if (ids.has(id)) await unit.deleteRecord('sessions', id); } finally { await unit.close(); }
        }
        const cache = await backend.kv.open(descriptorOf(projectionCacheDomainSpec));
        try { for (const id of Object.keys((await cache.loadAll()).tables.sessions ?? {})) if (ids.has(id)) await cache.deleteRecord('sessions', id); } finally { await cache.close(); }
        const workspace = await backend.kv.open(descriptorOf(workspaceDomainSpec));
        try {
          const { tables, global } = await workspace.loadAll();
          for (const [key, value] of Object.entries(tables.workspaces ?? {})) {
            const row = /** @type {any} */ (value);
            if (Array.isArray(row?.sessionIds) && row.sessionIds.some((/** @type {string} */ id) => ids.has(id))) await workspace.putRecord('workspaces', key, { ...row, sessionIds: row.sessionIds.filter((/** @type {string} */ id) => !ids.has(id)) });
          }
          if (global && typeof global === 'object') await workspace.setGlobal(scrubGlobal(global, ids));
        } finally { await workspace.close(); }
      } finally { await backend.close(); }
      await scrubBackups(paths.storages, ids);
    },
  };
}
/** @param {any} global @param {Set<string>} ids */
function scrubGlobal(global, ids) {
  const next = { ...global };
  for (const key of ['archivedSessionIds', 'pinnedSessionIds']) if (Array.isArray(next[key])) next[key] = next[key].filter((/** @type {string} */ id) => !ids.has(id));
  return next;
}
/** @param {string} file @returns {Promise<any>} */
async function readEnvelope(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!handle) return null;
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw fail(); return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
}
/** Backups are an upstream recovery path too. Keep other sessions and fields.
 * @param {string} root @param {Set<string>} ids */
async function scrubBackups(root, ids) {
  // Stages from an interrupted producer are never upstream backups. Old
  // releases used a suffix on the backup name; current stages have their own
  // closed prefix so even a partial write cannot be parsed as a backup.
  for (const file of await fs.readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (/^\.evimed-source-stage-[a-f0-9-]{36}\.tmp$/.test(file)
      || /^(?:session_projcache|workspace)\.json\.bak\..+\.source-cleanup-(?:\d+|[a-f0-9-]{36})$/.test(file)) await fs.rm(path.join(root, file));
  }
  const cacheDir = path.join(root, 'session_projcache', 'sessions');
  for (const file of await fs.readdir(cacheDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if ([...ids].some(id => file.startsWith(`${id}.json.bak.`))) await fs.rm(path.join(cacheDir, file));
  }
  for (const file of await fs.readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    const cache = file.startsWith('session_projcache.json.bak.'), workspace = file.startsWith('workspace.json.bak.');
    if (!cache && !workspace) continue;
    const full = path.join(root, file), value = await readEnvelope(full);
    if (!value || value.unit?.name !== (cache ? 'session_projcache' : 'workspace') || !value.tables || typeof value.tables !== 'object') throw fail();
    if (cache) { for (const id of ids) delete value.tables.sessions?.[id]; }
    else {
      for (const row of Object.values(value.tables.workspaces ?? {})) { const record = /** @type {any} */ (row); if (Array.isArray(record?.sessionIds)) record.sessionIds = record.sessionIds.filter((/** @type {string} */ id) => !ids.has(id)); }
      if (value.global && typeof value.global === 'object') value.global = scrubGlobal(value.global, ids);
    }
    const temporary = path.join(root, `.evimed-source-stage-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, full);
  }
}

/** Trusted maintenance program. The caller supplies no code or filesystem
 * paths in stdin; Docker exposes only these two exact maintenance mounts. */
export function sourceStorageHelperProgram() {
  const source = readFileSync(new URL('./sourceConversationStorage.mjs', import.meta.url), 'utf8');
  return `${source}\nimport process from 'node:process';\nlet input='';for await(const chunk of process.stdin)input+=chunk;\ntry{const request=JSON.parse(input);const paths={sessions:'/source/sessions',storages:'/source/storages'};const result=request.operation==='capture'?await captureSourceStorage(paths,request.sessionId):request.operation==='purge'?await purgeSourceStorage(paths,request.frozen):null;if(!result)throw fail();process.stdout.write(JSON.stringify({ok:true,data:result}));}catch{process.stdout.write(JSON.stringify({ok:false}));process.exitCode=1;}\n`;
}
