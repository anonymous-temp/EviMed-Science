/**
 * The one vocabulary for the state of a piece of module work, read by every module page (DESIGN.md, 模块工作台).
 *
 * A module maps its own records onto these states and never words a state itself: the 2026-11-01 audit found twenty-two label sets
 * for this, five ways to say running and one word, 待核对, with four meanings. `null` is the eleventh answer and the commonest: the work
 * is outside what was asked for, and a step that is outside says nothing but its name.
 *
 * The words are a closed vocabulary, so a test can hold them; what a run says about itself is another matter and stays the run's.
 */

export const WORK_STATES = Object.freeze(['todo', 'queued', 'running', 'waiting', 'minimal', 'done', 'failed', 'stale', 'stopped', 'paused'])

/** @type {Readonly<Record<string, string>>} */
export const WORK_STATE_LABEL = Object.freeze({
  todo: '待开始',
  queued: '排队中',
  running: '进行中',
  waiting: '等你',
  minimal: '简版已完成',
  done: '已完成',
  failed: '未完成',
  stale: '已过期',
  stopped: '已停止',
  paused: '已暂停',
})

/**
 * What a person is waiting to give. Question and approval are apart because they are answered differently; nothing here is a new
 * step: a module lists only what already needs its person.
 */
export const WORK_NEED_KINDS = Object.freeze(['provide', 'confirm', 'resolve', 'offline'])

/** @type {Readonly<Record<string, string>>} */
export const WORK_NEED_LABEL = Object.freeze({
  provide: '待提供',
  confirm: '待确认',
  resolve: '需处理',
  offline: '平台外',
})

/**
 * What pressing a module's action does. `draft` fills the composer and nothing happens until the person sends; `start` runs now, on the
 * server, and costs what it costs; `set` changes the project's state where it stands; `external` spends money or goes outside the
 * platform and says so first.
 */
export const WORK_ACTION_KINDS = Object.freeze(['draft', 'start', 'set', 'external'])

/**
 * The word for a state, with what it waits for when it is the person's: `等你设预算`.
 * @param {string | null | undefined} state
 * @param {string | null} [detail]
 * @returns {string}
 */
export function workStateLabel(state, detail = null) {
  if (!state) return ''
  const word = WORK_STATE_LABEL[state] ?? ''
  return state === 'waiting' && detail ? `${word}${detail}` : word
}
