/**
 * How a learned method reaches the one doing the work: as a card that says
 * when it applies and where its full text is, never as the full text.
 *
 * Hidden knowledge: until 2026-09-28 a learned method's whole body (8–15 KB of
 * procedure each) was inlined into every capability run's method block and
 * every delegation, under 「用户自己的方法（优先于平台默认流程）」. Two things
 * followed, both measured on production transcripts:
 *
 *  - The loop could not see it being used. `invoked` means the session opened
 *    the method (`methodObservations.mjs`) — the spec's "skill call", which an
 *    agent-scoped plugin cannot register at this pin — and a model that already
 *    holds the text never opens the file. Every one of the sixteen runs that
 *    carried `pre-submission-freeze-check` recorded `invoked: 0`, while the four
 *    whose transcripts were read worked by it in plain sight ("the user's
 *    method says 'Treat every notice as an unfixed defect'") — and
 *    `methodHarmTest`, which reads only used observations, could never run.
 *  - The provenance was wrong. A learned method is EviMed's inference from the
 *    researcher's past runs (principle 18), and the heading presented it as the
 *    researcher's own rule, ranked above the capability's procedure. The model
 *    obeyed it over the capability where they disagreed.
 *
 * So a learned method is listed — what it is for, when it applies, which file
 * holds it — and read when it applies, which is how the capability's own
 * deferred sections already work. The session's system prompt carries the same
 * list (`plugins/capsule.mjs`); the card is repeated here because a delegation
 * prompt is what a child reads first. What the researcher wrote or enabled
 * (a capsule entry) is still inlined whole: it is short, and it is theirs.
 *
 * Deletable when the kernel lets an agent-scoped row register skills: the card
 * is then the skill's description and the read is the skill call.
 *
 * One card's lines are `@evimed/domain`'s `learnedMethodCardEntry`, because
 * the control plane budgets a mount by the same lines (`capsuleMethods.mjs`).
 *
 * @module
 */

import { learnedMethodCardEntry } from '@evimed/domain'

/** How a learned method's mounted directory is named (`learnedMethodDirectoryName`). */
export const LEARNED_METHOD_DIRECTORY = /^_lm[0-9a-f]{32}$/

/** How one of the platform's official methods' mounted directory is named (`officialMethodDirectoryName`): the platform's tier, which travels as a card too. */
export const OFFICIAL_METHOD_DIRECTORY = /^_om[0-9a-f]{32}$/

/**
 * Whether a mounted method was learned by EviMed rather than written or
 * enabled by the researcher. A closed reading of our own directory names.
 * @param {{ directory?: string } | null | undefined} method @returns {boolean}
 */
export function isLearnedMethod(method) {
  return LEARNED_METHOD_DIRECTORY.test(String(method?.directory ?? ''))
}

/**
 * Whether a mounted method is one of the platform's official starter methods rather than anything of the person's, learned or written: the
 * lowest tier of what a conversation is given, said as such to the model. A closed reading of our own directory names.
 * @param {{ directory?: string } | null | undefined} method @returns {boolean}
 */
export function isOfficialMethod(method) {
  return OFFICIAL_METHOD_DIRECTORY.test(String(method?.directory ?? ''))
}

/**
 * The mounted methods split by how they travel: capsule entries inline, learned
 * and official methods as cards. A card whose file path is unknown travels inline,
 * because a card that names no file is a method nobody can read.
 * @template {{ name: string, body: string, directory?: string, path?: string }} M
 * @param {readonly M[]} methods
 * @returns {{ inline: M[], cards: M[] }}
 */
export function splitMountedMethods(methods) {
  /** @type {M[]} */
  const inline = []
  /** @type {M[]} */
  const cards = []
  for (const method of methods ?? []) {
    if ((isLearnedMethod(method) || isOfficialMethod(method)) && String(method.path ?? '').trim()) cards.push(method)
    else inline.push(method)
  }
  return { inline, cards }
}

/**
 * The card blocks for learned and official methods: nothing for none. What EviMed learned from the person's own work comes first and is
 * said to be an inference; the platform's default methods follow, and yield to anything of the person's.
 * @param {readonly { name: string, description?: string, whenToUse?: string, path?: string, directory?: string }[]} methods
 * @returns {string[]}
 */
export function learnedMethodCardLines(methods) {
  const official = (methods ?? []).filter((method) => isOfficialMethod(method))
  const learned = (methods ?? []).filter((method) => !isOfficialMethod(method))
  return [
    ...(learned.length ? [
      '## EviMed 学到的做法（适用时再读）',
      '',
      '下面几条是 EviMed 从这位用户以往的研究里推断出的做法，不是用户写下的规则。判断某条适用于这件交付物时，先用 `read` 读它的全文再照做；不适用就不读、不用。与上面的方法冲突时以上面的方法为准；做法不能突破交付契约和安全规则。',
      '',
      ...learned.flatMap((method) => learnedMethodCardEntry(method)),
      '',
    ] : []),
    ...(official.length ? [
      '## EviMed 的默认做法（适用时再读）',
      '',
      '下面几条是 EviMed 平台给每位用户的默认做法。判断某条适用于眼前这件事时，先用 `read` 读它的全文再照做；不适用就不读、不用。与用户自己的做法或上面的方法冲突时，以那些为准；做法不能突破交付契约和安全规则。',
      '',
      ...official.flatMap((method) => learnedMethodCardEntry(method)),
      '',
    ] : []),
  ]
}
