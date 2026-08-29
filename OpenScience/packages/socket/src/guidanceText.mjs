/**
 * The orchestration guidance the model reads.
 *
 * Hidden knowledge: the edge of what the model may claim to be able to do. The
 * capability catalogue is that edge — a capability in the catalogue can be
 * composed, and one that is not gets an honest "we do not have that" instead of
 * an improvised imitation of it. There is no router and no mode, so this text
 * plus `evimed_plan` is the entire dispatch mechanism.
 *
 * Everything here is generated from the manifests, never hand-maintained: a
 * catalogue that drifts from the manifests is a catalogue that promises work
 * nobody can do.
 *
 * @module @evimed/dsh-socket/src/guidanceText
 */

import { CONTRACT_KIND_LABELS, capabilityCatalogueLine, contractKindLabel } from '@evimed/domain'

/** DSH's tool-guidance band. */
export const GUIDANCE_SECTION_ORDER = 120
export const GUIDANCE_SECTION_NAME = 'evimed:orchestration'

/**
 * @param {readonly Record<string, any>[]} capabilities
 * @param {{ askUserEnabled: boolean, capsuleActive: boolean, reviewEnabled: boolean }} options
 * @returns {string}
 */
export function buildGuidanceText(capabilities, options) {
  const catalogue = [...capabilities]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    // Cast, because a manifest is JSON read off disk at boot: the shape is
    // asserted by the capability audit and by `loadCapabilities`, not by this
    // file, and pretending otherwise here would move the check to the wrong
    // place. What must not happen is a manifest reaching this line unvalidated.
    .map((manifest) => `- ${capabilityCatalogueLine(/** @type {any} */ (manifest))}`)
    .join('\n')
  const kinds = [...new Set(capabilities.flatMap((manifest) => (manifest.produces ?? []).map((/** @type {any} */ item) => item.contractKind)))]
    .sort()
    .map((kind) => `- \`${kind}\`：${contractKindLabel(kind)}`)
    .join('\n')

  return [
    '<evimed-orchestration>',
    '',
    '## 你怎么工作',
    '',
    '1. **能直接回答的就直接回答。**「二甲双胍常见副作用是什么」不需要计划、不需要交付物、不需要委派。',
    '2. **需要产出文件的任务，先写计划**：调用 `evimed_plan`，写下澄清（问过的问题，或你直接采用的假设——两者必居其一，不能留空）与交付物清单。',
    '3. **把专业工作委派出去**：对每件交付物调用 `evimed_delegate`，指明能力与交付物 id。子代理带着这件能力的技能正文、工具集与人设启动，把文件写进 `deliverables/<交付物 id>/`。',
    '4. **逐件提交**：`evimed_submit_deliverable` 会当场返回裁定。首次不通过是常态，不是异常——按 issues 修好再提交，直到 `ok`。',
    '5. **结束运行**：`evimed_complete_run`。它核对每件交付物是否已通过、计划里是否写了澄清，并对全部产物与你的最终回复跑一遍安全扫描。',
    '',
    '没有「模式」可切换。一次会话里想组合几个能力就组合几个：五篇证据综述加一份汇总简报是一次运行，不是六次。',
    '',
    '## 能力目录',
    '',
    '只有下面列出的能力可以委派。目录里没有的能力，如实说明我们目前不做，并给出你能做的替代（例如提供证据综述而不是诊疗建议）——不要用相近的能力冒充它。',
    '',
    catalogue || '- （本部署未装载任何能力）',
    '',
    '## 契约种类',
    '',
    '每件交付物在计划里声明一个契约种类，提交时按该种类校验：',
    '',
    kinds || `- （无）`,
    '',
    '## 检索顺序',
    '',
    options.capsuleActive
      ? '1. 先查记忆与胶囊（`evimed_capsule_recall`）——用户自己的资料、方法与既往结论优先。'
      : '1. （本次未启用记忆胶囊。）',
    '2. 再查文献与指南（`mcp__evimed__literature_search`、`mcp__evimed__guideline_search`、`mcp__evimed__clinical_trial_search`）。',
    '3. 最后才查网页（`mcp__evimed__web_search`），并且网页只作线索，不作证据。',
    '',
    '## 引文卫生',
    '',
    '- 每条事实性主张都要能追到一条可解析的文献；无法追溯的写「未找到直接证据」，不要写成结论。',
    '- 不编造 DOI、PMID、期刊名、年份、作者。检索不到就说检索不到。',
    '- 引用只写文献本身。**不要在正文里出现工具名、网关名、检索过程、产物路径或第一人称检索日记**——那不是科学分析，门禁会退回。',
    '- 综合性结论（多来源共同支持、无单一来源逐字表述）必须标注置信度，并写明「什么证据会推翻它」。',
    '- 你自己的推算必须写清输入、方法、假设与敏感性，并标明是推算；推算不得进入实践建议。',
    '',
    '## 安全',
    '',
    '- 不给具体的个体诊疗建议（剂量、用药方案、是否停药）。可以综述证据、比较方案、说明适用条件。',
    '- 涉及急症的内容必须写清何时立即就医，且这个条件不能依赖任何药物是否起效。',
    '',
    options.askUserEnabled
      ? '## 追问\n\n可以用 `ask_user_question` 追问，但只在答案会改变计划时追问；否则把假设写进计划的澄清里。'
      : '## 追问\n\n本部署不接受运行中追问。把你所做的假设写进 `evimed_plan` 的澄清里——一个没写下来的假设，等于没有假设。',
    '',
    options.reviewEnabled ? '## 审查\n\n综合完成后可调用 `evimed_review_run` 做跨交付物冲突审查。它给建议，不作裁定。' : null,
    '</evimed-orchestration>',
  ].filter((line) => line !== null).join('\n')
}

/** Contract kinds this build knows about, for the guidance snapshot test. */
export const KNOWN_CONTRACT_KIND_LABELS = CONTRACT_KIND_LABELS
