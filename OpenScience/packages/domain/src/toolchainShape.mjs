/** Run-scoped tool order, separate from artifact formats and free of call arguments. */
import { isPlatformChoreographyTool, isOpenVikingToolName, mcpToolBaseName } from './toolNames.mjs'

/** @typedef {{tools: string[], bigrams: string[]}} ToolchainFingerprint */

const SUPPORT_TOOLS = new Set(['skill', 'skills', 'load_skill', 'skill_load', 'ask-user', 'ask_user', 'ask_user_question',
  'memory_search', 'memory_read', 'memory_write', 'memory_list', 'memory_remember', 'memory_forget'])

/** @param {string} raw */
function workTool(raw) {
  const name = mcpToolBaseName(raw) ?? raw
  if (isPlatformChoreographyTool(raw) || isPlatformChoreographyTool(name) || isOpenVikingToolName(raw)
    || SUPPORT_TOOLS.has(raw) || SUPPORT_TOOLS.has(name)) return null
  return name
}

/**
 * Build from readToolTraces' already run-scoped traces, in their recorded order.
 * Oversized chains are omitted whole rather than truncated into another workflow.
 * @param {unknown} traces
 * @returns {ToolchainFingerprint | null}
 */
export function toolchainFingerprint(traces) {
  if (!Array.isArray(traces)) return null
  /** @type {string[]} */
  const tools = []
  for (const trace of traces) {
    for (const step of Array.isArray(trace?.steps) ? trace.steps : []) {
      if (typeof step?.tool !== 'string' || !step.tool) continue
      const name = workTool(step.tool)
      if (!name || tools.at(-1) === name) continue
      tools.push(name)
    }
  }
  if (new Set(tools).size < 2) return null
  const bigrams = [...new Set(tools.slice(1).map((tool, index) => JSON.stringify([tools[index], tool])))]
  const fingerprint = { tools, bigrams }
  return new TextEncoder().encode(JSON.stringify(fingerprint)).length <= 2048 ? fingerprint : null
}

/** Canonicalize persisted fingerprints; never trust separately supplied bigrams. @param {unknown} value */
export function cleanToolchainFingerprint(value) {
  const tools = /** @type {any} */ (value)?.tools
  if (!Array.isArray(tools) || tools.length > 256 || tools.some(tool => typeof tool !== 'string' || tool.length > 200)) return null
  return toolchainFingerprint([{ steps: tools.map(tool => ({ tool })) }])
}

/** @param {unknown} a @param {unknown} b @param {{minSimilarity?: number}} [options] */
export function toolchainsMatch(a, b, { minSimilarity = 0.8 } = {}) {
  if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) return false
  const left = cleanToolchainFingerprint(a), right = cleanToolchainFingerprint(b)
  if (!left || !right) return false
  const one = new Set(left.bigrams), two = new Set(right.bigrams)
  const intersection = [...one].filter(bigram => two.has(bigram)).length
  return intersection / new Set([...one, ...two]).size >= minSimilarity
}
