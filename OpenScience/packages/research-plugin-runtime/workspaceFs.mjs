import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, readdir, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const nofollow = constants.O_NOFOLLOW ?? 0

/** Check each owned directory without accepting symlinks.
 * @param {string} workspace @param {string} jobId @param {boolean} create
 */
export async function jobDirectory(workspace, jobId, create = false) {
  if (typeof jobId !== 'string' || !/^job_[0-9a-f-]{36}$/.test(jobId)) throw new Error('invalid_job_id')
  const base = await realpath(resolve(workspace))
  let current = base
  for (const part of ['.virtual-research', 'jobs', jobId]) {
    current = join(current, part)
    if (create) { try { await mkdir(current, { mode: 0o700 }) } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error } }
    const entry = await lstat(current)
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(current) !== current) throw new Error('unsafe_workspace_path')
  }
  return current
}

/** @param {string} directory */
export async function assertNoSymlinks(directory) {
  for (const name of await readdir(directory)) {
    try {
      if ((await lstat(join(directory, name))).isSymbolicLink()) throw new Error('unsafe_workspace_path')
    } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error }
  }
}

/** @param {string} directory @param {string} name */
export async function readOwnedFile(directory, name) {
  const handle = await open(join(directory, name), constants.O_RDONLY | nofollow)
  try { return await handle.readFile('utf8') } finally { await handle.close() }
}

/** @param {string} directory @param {string} name @param {string} contents */
export async function writeOwnedFile(directory, name, contents) {
  const temp = join(directory, `.tmp-${randomUUID()}`)
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600)
  try { await handle.writeFile(contents); await handle.close(); await rename(temp, join(directory, name)) }
  catch (error) { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); throw error }
}

/** Numerical subprocesses do not need provider or application credentials.
 * @param {NodeJS.ProcessEnv} env @returns {NodeJS.ProcessEnv}
 */
export function scientificEnvironment(env) {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'R_HOME', 'R_LIBS', 'R_LIBS_USER', 'R_LIBS_SITE', 'VCR_R_LIBS']
  return Object.fromEntries(allowed.filter(key => typeof env[key] === 'string').map(key => [key, env[key]]))
}
