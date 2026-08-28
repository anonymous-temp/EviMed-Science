/**
 * "When is a run finished, and when is it acceptable" — the whole of it.
 *
 * Hidden knowledge: the delivery decision on the run side. Four rules carry it,
 * and each of them is here because the alternative was tried and failed.
 *
 * 1. **The verdict is a return value, not a refusal.** `evimed_submit_deliverable`
 *    answers `{ok:false, issues}` and the run repairs and resubmits. A first
 *    submission failing is the normal case, and a normal case delivered as an
 *    exception forces every caller to treat "your report is missing a file" the
 *    same way it treats "the disk is gone" (ch.10).
 * 2. **The graded party cannot supply the exam paper.** The question the gate
 *    checks against is the control plane's copy, delivered read-only; the
 *    workspace copy is compared, never trusted.
 * 3. **`deny` is for policy only.** Budgets, attempt ceilings and the path guard
 *    refuse; a business verdict never does.
 * 4. **One implementation of the rules.** Everything mechanical comes from
 *    `@evimed/domain`, which the server-side gate imports too. The run-side
 *    Python preflight that used to restate them drifted three times and cost a
 *    finished package each time.
 *
 * This module is pure: it takes state and content, returns decisions and
 * records. The plugin around it does the I/O.
 *
 * @module @evimed/dsh-socket/src/runPolicy
 */

import {
  MAX_DELEGATION_DEPTH,
  errorCodeMessage,
  deliverableIdOfPath,
  isGateImplementationPath,
  isProtectedWritePath,
  layeredIssues,
  matchedClinicalTriggers,
  normalizeWorkspacePath,
  readyDeliverables,
  runGate,
  validateTaskPlan,
} from '@evimed/domain'

/** Tools whose arguments name a path we must guard from writes. */
const PATH_ARG_TOOLS = Object.freeze({
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  str_replace_editor: ['path'],
})

/** Tools whose arguments name a path we must guard from reads as well. */
const READ_ARG_TOOLS = Object.freeze({
  read: ['path', 'file_path'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  str_replace_editor: ['path'],
  grep: ['path', 'file_path'],
  glob: ['path', 'file_path'],
})

/** What a run is told when it reaches for the marking scheme. */
const GATE_SOURCE_REFUSAL = '交付门禁的实现不在你的阅读范围内。'
  + '按能力技能正文与门禁返回的 issue 来修改交付物——那是同一套规则的说明，'
  + '而按实现反推出来的通过不能说明交付物本身是对的。'

/**
 * Whether one tool call may proceed. Policy only — a rejected deliverable never
 * comes through here.
 *
 * @param {import('@evimed/harness-port').ToolCall | Record<string, any>} call
 * @param {{
 *   budget: { steps: number, tokens: number, children: number },
 *   limits: { maxSteps: number, maxTokens: number, maxChildren: number },
 *   submitAttempts: number,
 *   deliveryAttemptLimit: number,
 *   acceptedDeliverables?: readonly string[],
 * }} state
 * @returns {{ allow: true } | { allow: false, code: string, reason: string }}
 */
export function toolPolicy(call, state) {
  const name = String(call?.name ?? '')
  const args = /** @type {Record<string, any>} */ (call?.args ?? {})
  const accepted = new Set(state.acceptedDeliverables ?? [])

  const readFields = READ_ARG_TOOLS[/** @type {keyof typeof READ_ARG_TOOLS} */ (name)]
  if (readFields) {
    for (const field of readFields) {
      const value = args[field]
      if (typeof value === 'string' && value && isGateImplementationPath(value)) {
        return { allow: false, code: 'gate_source_denied', reason: GATE_SOURCE_REFUSAL }
      }
    }
  }

  const fields = PATH_ARG_TOOLS[/** @type {keyof typeof PATH_ARG_TOOLS} */ (name)]
  if (fields) {
    for (const field of fields) {
      const value = args[field]
      if (typeof value !== 'string' || !value) continue
      // An accepted deliverable is finished, and its files are the ones the
      // receipt names by sha256 — the only thing the control plane can verify
      // once the container is gone.
      //
      // A run that keeps polishing after acceptance edits those files, and the
      // digests stop matching: the accepted package no longer exists anywhere.
      // On a seven-attempt budget one run passed at attempt 4, passed again at 5
      // and 6 while trimming advisory notes, broke something on 7, and finished
      // 部分交付 holding a receipt for a package it had overwritten. Advisory
      // polish is worth having; it is not worth a delivered package.
      if (accepted.has(String(deliverableIdOfPath(value) ?? ''))) {
        return {
          allow: false,
          code: 'accepted_deliverable_frozen',
          reason: `交付物 ${deliverableIdOfPath(value)} 已通过校验并写入回执，其文件按 sha256 记录在案，不能再改动。`
            + '回执认的就是这一版；改了文件，控制面核对散列时这一版就不存在了。'
            + '余下的尝试次数请用在其他交付物上，剩余的都是 advisory，不影响交付。',
        }
      }
      if (isProtectedWritePath(value)) {
        return {
          allow: false,
          code: 'path_guard_denied',
          reason: `${normalizeWorkspacePath(value) ?? value} 属于题面、回执、状态投影或只读数据分区，不能写入。交付物请写在 deliverables/<交付物 id>/ 下。`,
        }
      }
    }
  }
  if (name === 'bash') {
    const command = String(args.command ?? '')
    // Reading is refused before mutation is considered: the run that read the
    // gate did it with `grep -n "function sourceArtifactPaths"`, a command that
    // changes nothing and that the write guard therefore waved through.
    if (isGateImplementationPath(command)) {
      return { allow: false, code: 'gate_source_denied', reason: GATE_SOURCE_REFUSAL }
    }
    const frozen = [...accepted].find((id) => new RegExp(`deliverables/${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`).test(command))
    if (frozen && /(?:^|[|;&]\s*)(?:rm|mv|cp|sed\s+-i|tee|truncate|install|dd|ln)\b/.test(command)) {
      return {
        allow: false,
        code: 'accepted_deliverable_frozen',
        reason: `交付物 ${frozen} 已通过校验并写入回执，其文件按 sha256 记录在案，不能再改动。`,
      }
    }
    const guarded = guardedBashTarget(command)
    if (guarded) {
      return { allow: false, code: 'path_guard_denied', reason: `命令会修改受保护路径 ${guarded}。` }
    }
  }

  if (state.budget.steps > state.limits.maxSteps && state.limits.maxSteps > 0) {
    return { allow: false, code: 'budget_exhausted', reason: `步数已达上限 ${state.limits.maxSteps}。` }
  }
  if (state.budget.tokens > state.limits.maxTokens && state.limits.maxTokens > 0) {
    return { allow: false, code: 'budget_exhausted', reason: `token 已达上限 ${state.limits.maxTokens}。` }
  }
  if (name === 'evimed_delegate' && state.limits.maxChildren > 0 && state.budget.children >= state.limits.maxChildren) {
    return { allow: false, code: 'budget_exhausted', reason: `本次运行的分工数已达上限 ${state.limits.maxChildren}。` }
  }

  return { allow: true }
}

/**
 * A crude but honest read of a shell command's write targets. It errs toward
 * refusing: a redirect or a destructive verb aimed at a protected prefix is
 * denied even when the exact path cannot be parsed, because the alternative is
 * a run that can rewrite its own exam paper through `bash`.
 * @param {string} command
 * @returns {string | null}
 */
export function guardedBashTarget(command) {
  const text = String(command ?? '')
  if (!text) return null
  const candidates = text.match(/[\w./-]*(?:\.evimed-brief|\.evimed-run|\.evimed-capsule|delivery-receipt\.json|(?:^|\s|\/)data\/)[\w./-]*/g) ?? []
  if (!candidates.length) return null
  const mutating = /(?:^|[|;&]\s*)(?:rm|mv|cp|sed\s+-i|tee|truncate|install|chmod|chown|dd|ln)\b/.test(text) || /(?<![<>])>{1,2}(?!&)/.test(text)
  if (!mutating) return null
  for (const candidate of candidates) {
    const cleaned = candidate.trim().replace(/^\.\//, '')
    if (isProtectedWritePath(cleaned)) return cleaned
  }
  return null
}

/**
 * Accumulates the run budget. Cache hits are counted separately from misses
 * because they cost a fraction of the price and a budget that ignores the
 * difference punishes exactly the behaviour we want (a stable prompt prefix).
 * @param {{ steps: number, tokens: number, children: number }} budget
 * @param {{ input: number, output: number, cacheHit: number, cacheMiss: number }} usage
 * @returns {{ steps: number, tokens: number, children: number }}
 */
export function accumulateBudget(budget, usage) {
  return {
    steps: budget.steps + 1,
    tokens: budget.tokens + (usage?.input ?? 0) + (usage?.output ?? 0),
    children: budget.children,
  }
}

/**
 * Whether the next step may start.
 * @param {{ steps: number, tokens: number, children: number }} budget
 * @param {{ maxSteps: number, maxTokens: number, maxChildren: number }} limits
 * @returns {{ allow: true } | { allow: false, code: string, reason: string }}
 */
export function stepPolicy(budget, limits) {
  if (limits.maxSteps > 0 && budget.steps >= limits.maxSteps) {
    return { allow: false, code: 'budget_exhausted', reason: `本次运行已用满 ${limits.maxSteps} 步。请用 evimed_complete_run{partial:true} 交付你已完成的部分。` }
  }
  if (limits.maxTokens > 0 && budget.tokens >= limits.maxTokens) {
    return { allow: false, code: 'budget_exhausted', reason: `本次运行已用满 ${limits.maxTokens} token。请用 evimed_complete_run{partial:true} 交付你已完成的部分。` }
  }
  return { allow: true }
}

/**
 * Validates and indexes a plan the model just wrote.
 * @param {unknown} raw parsed task-plan.json
 * @returns {{ ok: boolean, plan: any, items: Record<string, any>[], issues: any[] }}
 */
export function indexPlan(raw) {
  const { ok, plan, issues } = validateTaskPlan(raw)
  const items = (plan?.deliverables ?? []).map((deliverable) => ({
    id: deliverable.id,
    contractKind: deliverable.contractKind,
    capability: deliverable.capability,
    title: deliverable.title,
    dependsOn: [...deliverable.dependsOn],
    status: 'planned',
    childSessionId: null,
    receiptDigest: null,
    attempts: 0,
    lastIssues: [],
  }))
  return { ok, plan, items, issues }
}

/**
 * Which deliverables may be delegated right now. Dependency sequencing is
 * computed, not asked of the model: making the model chain deliverables by hand
 * is exactly the orchestration detail §14 rule 13 pushes down into the tool.
 * @param {any} plan
 * @param {readonly Record<string, any>[]} items
 * @returns {Record<string, any>[]}
 */
export function delegatableItems(plan, items) {
  const byId = new Map(items.map((item) => [item.id, item]))
  const ready = readyDeliverables(plan, (id) => byId.get(id)?.status ?? 'planned')
  return ready.map((deliverable) => byId.get(deliverable.id)).filter(Boolean)
}

/**
 * Runs the delivery gate on one deliverable.
 *
 * The brief handed in is the read-only copy of the control plane's question.
 * The workspace copy is passed separately and only compared, so a run that
 * edited its own question is visible rather than rewarded.
 *
 * @param {{
 *   contractKind: string,
 *   files: Map<string, string>,
 *   expectedOutputs?: readonly {path: string, required: boolean}[],
 *   briefText?: string | null,
 *   workspaceBriefText?: string | null,
 *   matrix?: any,
 *   runReceipt?: any,
 *   sourceArtifacts?: Record<string, string>,
 *   executedSearchQueries?: readonly string[] | null,
 *   staleEvidenceCount?: number,
 * }} input
 * @returns {ReturnType<typeof runGate>}
 */
export function gateDeliverable(input) {
  return runGate(input)
}

/**
 * The tool envelope for a rejected deliverable: layered so the run knows what
 * it must fix, what it should fix and what it may ignore.
 * @param {ReturnType<typeof runGate>} verdict
 * @returns {{ ok: false, code: string, issues: any[] }}
 */
export function rejectionEnvelope(verdict) {
  const layers = layeredIssues(verdict.issues)
  return {
    ok: false,
    code: verdict.errorCode ?? 'deliverable_rejected',
    issues: [
      ...layers.required.map((issue) => ({ ...issue, severity: 'required' })),
      ...layers.advisory.map((issue) => ({ ...issue, severity: 'advisory' })),
      ...layers.optional.map((issue) => ({ ...issue, severity: 'optional' })),
    ],
  }
}

/**
 * The completion check: every deliverable accepted, clarifications written, and
 * the safety content triggers clean over everything the run produced — including
 * the final reply, because a run that answered in prose instead of delivering a
 * file is still a run that said something about a medicine.
 *
 * @param {{
 *   plan: any,
 *   items: readonly Record<string, any>[],
 *   producedTexts: readonly { path: string, text: string }[],
 *   finalReplyText: string,
 *   partial: boolean,
 * }} input
 * @returns {{ ok: boolean, issues: any[] }}
 */
export function completionCheck(input) {
  /** @type {any[]} */
  const issues = []
  const clarifications = input.plan?.clarifications ?? []
  if (input.plan && !clarifications.length) {
    issues.push({ code: 'plan_missing_clarifications', severity: 'required', message: errorCodeMessage('plan_missing_clarifications') })
  }
  for (const item of input.items) {
    if (item.status !== 'accepted') {
      issues.push({
        code: 'deliverable_not_accepted',
        severity: 'required',
        message: `交付物「${item.title ?? item.id}」当前状态是 ${item.status}，尚未通过契约校验。`,
        path: item.id,
      })
    }
  }
  for (const issue of contentTriggerIssues(input.producedTexts, input.finalReplyText, input.items)) {
    issues.push(issue)
  }
  if (input.partial) {
    // Partial delivery waives "not accepted yet" and "no clarifications" -- that
    // is what partial IS. The waiver used to live only in the ok-condition
    // below, while the issue list still said `(required)`, and a real run took
    // the list at its word: three partial completes came back "failed:
    // run_incomplete / (required) deliverable_not_accepted ...", the model
    // concluded the exit it had been told to use did not exist, and spent 40
    // minutes rearranging files before giving up -- one step short of the
    // retry that would have succeeded. The list must say what the verdict
    // actually weighs.
    for (const issue of issues) {
      if (issue.code === 'deliverable_not_accepted' || issue.code === 'plan_missing_clarifications') {
        issue.severity = 'advisory'
        issue.message = `${issue.message}（partial 交付下不阻断，将如实记录在交付摘要中。）`
      }
    }
  }
  const blocking = issues.filter((issue) => issue.severity === 'required')
  return { ok: blocking.length === 0, issues }
}

/**
 * The safety net that does not depend on the plan being honest: anything the
 * run produced that names a medicine under a non-clinical contract is caught by
 * scanning the output, not by believing the declaration (§9.4).
 * @param {readonly { path: string, text: string }[]} producedTexts
 * @param {string} finalReplyText
 * @param {readonly Record<string, any>[]} items
 * @returns {any[]}
 */
export function contentTriggerIssues(producedTexts, finalReplyText, items) {
  const clinicalPaths = new Set(
    items.filter((item) => String(item.contractKind ?? '').includes('clinical') || String(item.contractKind ?? '').includes('drug') || String(item.contractKind ?? '').includes('adr'))
      .map((item) => String(item.id)),
  )
  // Basenames already delivered under a clinical contract. The transition rule
  // (S153) accepts contract files written at the workspace root, so a root
  // `references.bib` that duplicates `deliverables/<clinical-id>/references.bib`
  // is the same artifact in its transitional location -- not uncontracted
  // clinical content. Flagging it made two of this system's own rules disagree
  // about one file, on every clinical run that used the root location.
  const clinicalBasenames = new Set()
  for (const produced of producedTexts) {
    const segments = String(produced.path ?? '').split('/').filter((part) => part && part !== 'workspace')
    if (segments[0] === 'deliverables' && clinicalPaths.has(segments[1] ?? '')) {
      clinicalBasenames.add(segments.at(-1))
    }
  }
  /** @type {any[]} */
  const issues = []
  for (const produced of producedTexts) {
    const triggers = matchedClinicalTriggers(produced.text)
    if (!triggers.length) continue
    const segments = String(produced.path ?? '').split('/').filter((part) => part && part !== 'workspace')
    const owner = segments[0] === 'deliverables' ? (segments[1] ?? '') : ''
    if (clinicalPaths.has(owner)) continue
    if (!owner && clinicalBasenames.has(segments.at(-1))) continue
    issues.push({
      code: 'clinical_content_without_clinical_contract',
      severity: 'required',
      message: `${produced.path} 提到 ${triggers.slice(0, 3).join('、')}，但它不在临床契约下。请把它作为临床类交付物提交，或移除临床内容。`,
      path: produced.path,
    })
  }
  const replyTriggers = matchedClinicalTriggers(finalReplyText)
  if (replyTriggers.length) {
    issues.push({
      code: 'clinical_content_in_reply',
      severity: 'advisory',
      message: `最终回复提到 ${replyTriggers.slice(0, 3).join('、')}，服务端会对它再跑一次安全扫描。`,
    })
  }
  return issues
}

/**
 * `delivery-summary.md` — always written, even when the run gave up.
 *
 * Apodex makes `report` a mandatory node of the scaffold, and the reason shows
 * up in the ledger: a run that failed silently and a run that never started are
 * indistinguishable without one.
 * @param {{ plan: any, items: readonly Record<string, any>[], issues: readonly any[], partial: boolean, runId: string, at: string }} input
 * @returns {string}
 */
export function renderDeliverySummary(input) {
  const lines = [
    `# 交付摘要`,
    '',
    `- 运行 id：${input.runId}`,
    `- 完成时间：${input.at}`,
    `- 交付方式：${input.partial ? '部分交付（尝试次数或预算已用尽）' : '完整交付'}`,
    '',
    '## 澄清与假设',
    '',
    ...(input.plan?.clarifications?.length
      ? input.plan.clarifications.map((line) => `- ${line}`)
      : ['- （计划未记录澄清）']),
    '',
    '## 交付物',
    '',
  ]
  if (!input.items.length) {
    lines.push('- （本次运行没有交付物，为直接回答）')
  } else {
    lines.push('| 交付物 | 契约种类 | 能力 | 状态 | 提交次数 |', '| --- | --- | --- | --- | --- |')
    for (const item of input.items) {
      lines.push(`| ${item.title ?? item.id} | ${item.contractKind} | ${item.capability} | ${item.status} | ${item.attempts ?? 0} |`)
    }
  }
  lines.push('', '## 未决问题', '')
  if (!input.issues.length) {
    lines.push('- 无')
  } else {
    for (const issue of input.issues) {
      lines.push(`- （${issue.severity ?? 'required'}）${issue.code}：${issue.message}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * The delegation request for one plan item.
 *
 * The child gets the deliverable's specification, the relevant part of the
 * question, the capability's skill bodies pre-injected and its own persona.
 * Pre-injection is what makes `skillsLoaded` true by construction rather than
 * by asking the model to confirm it loaded something.
 *
 * @param {{
 *   manifest: Record<string, any>,
 *   item: Record<string, any>,
 *   briefExcerpt: string,
 *   skillBodies: readonly { name: string, body: string }[],
 *   capsuleMethods?: readonly { name: string, body: string }[],
 *   inputs?: Record<string, unknown>,
 *   toolFilter: readonly string[],
 * }} input
 * @returns {import('@evimed/harness-port').SubagentRequest}
 */
export function buildDelegation(input) {
  const outputs = (input.manifest.produces ?? []).find((entry) => entry.contractKind === input.item.contractKind)?.outputs ?? []
  const prompt = [
    `你负责一件交付物：${input.item.title ?? input.item.id}（契约种类 ${input.item.contractKind}）。`,
    '',
    '## 题面（相关部分）',
    '',
    input.briefExcerpt || '（未提供题面摘录）',
    '',
    '## 你要写出的文件',
    '',
    ...outputs.map((output) => `- \`deliverables/${input.item.id}/${output.path}\`${output.required ? '（必需）' : '（可选）'}`),
    '',
    `全部文件必须写在 \`deliverables/${input.item.id}/\` 下。写完后调用 \`evimed_submit_deliverable{deliverableId:"${input.item.id}"}\`，它会当场返回裁定；未通过就按 issues 修好再提交，直到通过。`,
    '',
    ...(Object.keys(input.inputs ?? {}).length
      ? ['## 输入参数', '', '```json', JSON.stringify(input.inputs, null, 2), '```', '']
      : []),
    '## 方法',
    '',
    ...input.skillBodies.flatMap((skill) => [`### ${skill.name}`, '', skill.body, '']),
    ...(input.capsuleMethods?.length
      ? ['## 用户自己的方法（优先于平台默认流程，但不能突破契约）', '', ...input.capsuleMethods.flatMap((method) => [`### ${method.name}`, '', method.body, ''])]
      : []),
  ].join('\n')

  return {
    capability: String(input.manifest.id),
    label: String(input.item.title ?? input.item.id),
    prompt,
    tools: [...input.toolFilter],
    persona: String(input.manifest.persona ?? ''),
    outputSchema: DELEGATION_REPORT_SCHEMA,
    maxDepth: MAX_DELEGATION_DEPTH,
  }
}

/**
 * What a delegated child reports back. Fixed, so the orchestrator reads one
 * shape from every capability instead of parsing free prose.
 */
export const DELEGATION_REPORT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  required: ['deliverableId', 'submitted', 'summary'],
  properties: {
    deliverableId: { type: 'string' },
    submitted: { type: 'boolean' },
    summary: { type: 'string' },
    unresolved: { type: 'array', items: { type: 'string' } },
    failedSources: { type: 'array', items: { type: 'string' } },
  },
})

/**
 * How a settled child changes the plan. A child that did not complete is
 * retried exactly once with its diagnostic attached, and then marked failed and
 * reported to the parent — a failure that disappears at the boundary is the one
 * failure mode the orchestrator cannot recover from (§14 rule 20).
 * @param {{ item: Record<string, any>, outcome: { stopReason: string, diagnostic: string }, alreadyRetried: boolean }} input
 * @returns {{ action: 'redelegate' | 'fail' | 'settled', reason: string }}
 */
export function settleDelegation(input) {
  if (input.outcome.stopReason === 'completed') return { action: 'settled', reason: '' }
  if (!input.alreadyRetried) {
    return { action: 'redelegate', reason: `上一次分工以 ${input.outcome.stopReason} 结束：${input.outcome.diagnostic || '无诊断信息'}。已自动重派一次。` }
  }
  return { action: 'fail', reason: `分工连续两次以 ${input.outcome.stopReason} 结束：${input.outcome.diagnostic || '无诊断信息'}。` }
}

/**
 * The failure code of an `evimed` MCP tool call, or `''`.
 *
 * Three shapes have to line up for this to be readable, and reading the
 * obvious one returned nothing:
 *
 * 1. Our MCP server frames a failure as `isError: true` with the whole
 *    `failure()` object JSON-encoded into the text block AND repeated in
 *    `structuredContent`.
 * 2. The kernel's MCP bridge throws before it looks at `structuredContent`:
 *    `if (result.isError === true) throw new Error(text)` — a plain `Error`,
 *    so the structured copy is discarded and only the text survives.
 * 3. `ToolFailure.info` (the declared `{name, code}`) is populated *only* for
 *    `HarnessError` subclasses — `errorInfo()` returns `undefined` for
 *    anything else — so an MCP failure never has one.
 *
 * `result.error.code` was therefore always `undefined`, the guard below
 * short-circuited on every failure, and the single backoff-and-retry for a
 * transiently unreachable source never ran once: a source that blinked became
 * a permanent retrieval gap that surfaced fifty tool calls later as a delivery
 * failure with nothing recording why. Reading `error.info.code` instead — the
 * correction the declarations suggest — would have been just as dead.
 * @param {any} result a raw `ToolExecutionResult`
 * @returns {string}
 */
export function evidenceSourceErrorCode(result) {
  const error = result?.error
  if (!error) return ''
  const info = error.info
  if (info && typeof info.code === 'string' && info.code) return info.code
  const message = typeof error.message === 'string' ? error.message : ''
  if (!message.startsWith('{')) return ''
  try {
    const parsed = JSON.parse(message)
    const code = parsed?.error?.code
    return typeof code === 'string' ? code : ''
  } catch {
    return ''
  }
}

/**
 * Which preserved artifacts a submission's quotes may be checked against.
 *
 * The pure half of the join: given the run's evidence records, decide the
 * distinct artifact paths that belong to this run. Reading them is the
 * plugin's job; deciding which ones is the part that was wrong and the part
 * worth pinning.
 *
 * This map arrived empty on every submission, and the validator resolves every
 * `direct` and `synthesized` quote through it — so every quote-bearing claim
 * was rejected with an issue no run could act on. A rejected deliverable means
 * no receipt, and the receipt is the only durable thing the control plane can
 * read once the container is gone. That is six links from "an empty map" to a
 * complete package reported as `failed / artifacts 0`.
 *
 * @param {readonly Record<string, any>[]} records evidence rows for this run
 * @param {string} runId the run these must belong to; '' accepts all
 * @returns {string[]} distinct artifact paths, in first-seen order
 */
export function sourceArtifactPaths(records, runId) {
  /** @type {string[]} */
  const paths = []
  const seen = new Set()
  for (const record of records ?? []) {
    // A row carrying no runId predates the mirror latching one; it belongs to
    // this run by virtue of being in this run's table. Dropping it would be
    // the same empty-map failure in a narrower form.
    if (runId && record?.runId && record.runId !== runId) continue
    const artifactPath = String(record?.artifactPath ?? '')
    if (!artifactPath || seen.has(artifactPath)) continue
    seen.add(artifactPath)
    paths.push(artifactPath)
  }
  return paths
}
