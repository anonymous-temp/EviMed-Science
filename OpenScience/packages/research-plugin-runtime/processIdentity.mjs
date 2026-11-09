import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
const exec = promisify(execFile)

/** @typedef {{pid: number, started: string, command: string}} ProcessIdentity */
/** @typedef {ProcessIdentity & {group: number}} GroupMember */
/** Never signal a PID merely because writable workspace state names it.
 * @param {number} pid @param {string} output @param {string} engineRoot
 * @returns {Promise<ProcessIdentity | null>}
 */
export async function processIdentity(pid, output, engineRoot) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null
  try {
    const { stdout: started } = await exec('ps', ['-p', String(pid), '-o', 'lstart='], { maxBuffer: 8192, env: { ...process.env, LC_ALL: 'C.UTF-8' } })
    const { stdout: command } = await exec('ps', ['-ww', '-p', String(pid), '-o', 'command='], { maxBuffer: 32768, env: { ...process.env, LC_ALL: 'C.UTF-8' } })
    if (!started.trim() || !command.includes(join(engineRoot, 'service', 'run_job.R')) || !command.includes(join(output, 'job.json'))) return null
    return { pid, started: started.trim(), command: command.trim() }
  } catch { return null }
}

/** @param {ProcessIdentity | null} record @param {string} output @param {string} engineRoot @param {NodeJS.Signals | 0} signal */
export async function signalVerifiedGroup(record, output, engineRoot, signal) {
  if (!record || typeof record.started !== 'string' || typeof record.command !== 'string') return false
  const current = await processIdentity(record.pid, output, engineRoot)
  if (!current || current.started !== record.started || current.command !== record.command) return false
  try { process.kill(-record.pid, signal); return true } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH') return false; throw error }
}

/** Capture exact members while the verified leader still owns its process group.
 * @param {ProcessIdentity | null} record @param {string} output @param {string} engineRoot @returns {Promise<GroupMember[]>}
 */
export async function groupSnapshot(record, output, engineRoot) {
  if (!record || !await signalableLeader(record, output, engineRoot)) return []
  try {
    const { stdout } = await exec('ps', ['-A', '-o', 'pid=', '-o', 'pgid='], { maxBuffer: 2 * 1024 * 1024 })
    const pids = stdout.split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(([pid, group]) => pid > 1 && group === record.pid).map(([pid]) => pid)
    return (await Promise.all(pids.map(memberIdentity))).filter((member) => member !== null)
  } catch { return [] }
}
/** @param {ProcessIdentity | null} record @param {string} output @param {string} engineRoot */
async function signalableLeader(record, output, engineRoot) {
  if (!record) return false
  const current = await processIdentity(record.pid, output, engineRoot)
  return Boolean(current && current.started === record.started && current.command === record.command)
}
/** @param {number} pid @returns {Promise<GroupMember | null>} */
async function memberIdentity(pid) {
  try {
    const options = { maxBuffer: 32768, env: { ...process.env, LC_ALL: 'C.UTF-8' } }
    const [start, command, group] = await Promise.all([
      exec('ps', ['-p', String(pid), '-o', 'lstart='], options),
      exec('ps', ['-ww', '-p', String(pid), '-o', 'command='], options),
      exec('ps', ['-p', String(pid), '-o', 'pgid='], options),
    ])
    return { pid, started: start.stdout.trim(), command: command.stdout.trim(), group: Number(group.stdout.trim()) }
  } catch { return null }
}
/** @param {GroupMember[]} members @param {number} group @param {NodeJS.Signals | 0} signal */
export async function signalKnownSurvivors(members, group, signal) {
  for (const known of members) {
    const current = await memberIdentity(known.pid)
    if (current && current.group === group && current.started === known.started && current.command === known.command) {
      try { process.kill(-group, signal); return true } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH') return false; throw error }
    }
  }
  return false
}
