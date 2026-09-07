/**
 * The one pattern that decides whether a piece of captured text is too
 * sensitive to be stored, recalled, or distilled into a method.
 *
 * Hidden knowledge: this used to live inside `memoryIntelligence.mjs`, which
 * was fine while memory extraction was the only thing that captured a
 * researcher's own words. It stopped being fine the moment distillation began
 * reading transcripts too: two captures of the same sentence would have been
 * screened by two regexes, and the one that drifted would be the one nobody
 * looked at. A researcher's credential leaking into a *method* is worse than
 * one leaking into a memory, because a method is mounted read-only into every
 * later run of that project.
 *
 * It is deliberately blunt, and it over-matches on ordinary medical vocabulary
 * (`病历号`, `患者姓名` are words a pharmacist types all day). Over-matching is
 * the safe direction here as long as the caller treats a hit as "park this and
 * say why", never as "drop it silently" — the memory path parks, and the
 * distillation path excludes the excerpt from the model's input rather than
 * failing the whole run.
 *
 * This is a closed-vocabulary check on tokens, not a judgement about language,
 * so it belongs in code (development principle #1). Do not grow it into a
 * classifier: if it needs to decide whether a sentence is *about* a patient,
 * that is a model's job and belongs on the judge path.
 */

/**
 * Credentials, government identifiers, and first-person clinical disclosure.
 * @type {RegExp}
 */
export const SENSITIVE_TEXT_PATTERN =
  /(?:password|passcode|api[ _-]?key|access[ _-]?token|secret|\btoken\b|密码|口令|密钥|令牌|身份证|手机号|银行卡|病历号|患者姓名|家庭住址|我(?:患有|诊断为|正在服用))/i

/**
 * Whether the text carries anything the pattern above names.
 *
 * Takes the text, never a path: this package loads in a browser and in a plugin
 * sandbox, so it cannot read a file even when the caller wishes it would.
 * @param {string} text
 * @returns {boolean}
 */
export function hasSensitiveText(text) {
  return SENSITIVE_TEXT_PATTERN.test(String(text ?? ''))
}

/**
 * Every distinct sensitive token the text contains, for a message that can say
 * *what* it found without echoing the surrounding sentence.
 *
 * The tokens themselves are the vocabulary above — never the matched value — so
 * a caller can log this safely. Echoing the match would defeat the point.
 * @param {string} text
 * @returns {string[]}
 */
export function sensitiveTextTokens(text) {
  const source = String(text ?? '')
  const global = new RegExp(SENSITIVE_TEXT_PATTERN.source, 'gi')
  /** @type {Set<string>} */
  const found = new Set()
  for (const match of source.matchAll(global)) found.add(match[0].toLowerCase())
  return [...found]
}

/**
 * Replace every sensitive run with a fixed marker, so an excerpt can still be
 * shown for context without carrying the credential itself.
 *
 * Redaction is not a substitute for exclusion: the distillation input excludes
 * whole excerpts that trip the pattern. This exists for the narrower case where
 * the surrounding structure is the evidence and the token is incidental.
 * @param {string} text
 * @param {string} [marker]
 * @returns {string}
 */
export function redactSensitiveText(text, marker = '[redacted]') {
  const global = new RegExp(SENSITIVE_TEXT_PATTERN.source, 'gi')
  return String(text ?? '').replace(global, marker)
}
