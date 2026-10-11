/** The upstream initializer's hosted boundary: verify the image; never pip-install into a serving runtime. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** @param {{root?:string, cli?:string, signal?:AbortSignal}} [options] */
export async function verifyHostedLoopx({ root = '/opt/evimed/loopx', cli = '/opt/evimed/venv/bin/loopx', signal } = {}) {
  try {
    const receipt = JSON.parse(await readFile(path.join(root, 'installation.json'), 'utf8'))
    const { stdout } = await execute(cli, ['--version'], { timeout: 5000, maxBuffer: 1024,
      signal, env: { ...process.env, LOOPX_USAGE_PING: '0', DO_NOT_TRACK: '1', PYTHONDONTWRITEBYTECODE: '1' } })
    if (receipt.schemaVersion !== 1 || stdout.trim() !== `loopx ${receipt.version}`) throw new Error('version mismatch')
    await readFile(path.join(root, 'skills', 'loopx', 'SKILL.md'), 'utf8')
    return { state: 'ready', version: receipt.version, pluginVersion: receipt.pluginVersion }
  } catch {
    return { state: 'failed', message: 'LoopX is unavailable in this runtime image.' }
  }
}

/** This keeps the original /loopx-init entry useful without granting profile mutation.
 * @param {any} ctx @param {{enabled:boolean, root:string, cli:string}} config */
export async function registerHostedLoopx(ctx, config) {
  const status = config.enabled ? await verifyHostedLoopx(config) : { state: 'disabled', message: undefined }
  ctx.provide('loopxBootstrap', status)
  if (status.state === 'failed') ctx.logger.warn(status.message)
  if (status.state === 'ready') ctx.effect(() => ctx.systemPrompt.section({
    name: 'evimed:loopx', order: 122,
    text: 'Use LoopX for sustained goals that benefit from checkpoints and automatic continuation across turns. Keep ordinary single-turn questions lightweight. When using LoopX, follow the complete guided initialization packet, including thread binding. Before claiming automatic continuation is ready, read resolve-agent-thread for deepseek-harness-native and the exact $DSH_SESSION_ID; repair a missing binding with the returned CLI commands. A goal becoming stopped during work records a pause: finish the current checkpoint without resuming it. Resume only after a new user request or GoalBar Start; an earlier request to keep working does not override a later pause. LoopX owns goal scheduling; EviMed owns research artifacts and their provenance. Reuse EviMed tools for clinical calculations, evidence and research memory; LoopX records references to those results.',
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'loopx-init', description: '检查长任务工具是否可用', recordInput: false,
    /** @param {{rawInput:string, signal?:AbortSignal}} invocation */
    async handler(invocation) {
      if (invocation.rawInput.trim()) return { kind: 'error', text: 'Usage: /loopx-init' }
      const result = config.enabled ? await verifyHostedLoopx({ ...config, signal: invocation.signal }) : status
      return result.state === 'ready'
        ? { kind: 'success', text: '长任务工具已就绪。可以使用 /loopx 开始研究。' }
        : { kind: 'error', text: '长任务工具暂不可用，可以继续当前对话。' }
    },
  }))
}
