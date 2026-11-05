/** Stable kernel input/turn identity shared by all run evidence readers. */
/**
 * The turns of the root session that belong to the run, by the rule the ledger assigns history with: a turn one of the run's
 * own request ids entered, or the native turn it was adopted from when it has no request ids. Null when the run names neither
 * (a record from before turn identity), and then every turn is read.
 * @param {readonly any[]} messages the run's own (root) session @param {any} run
 * @returns {Set<number> | null}
 */
export function ownTurnStarts(messages, run) {
  const requestIds = new Set(Array.isArray(run?.kernelRequestIds) ? run.kernelRequestIds : [])
  /** @type {Set<number>} */
  const turns = new Set()
  for (const message of messages) {
    if (message?.role === 'user' && message.source === 'user' && Number.isSafeInteger(message.turnStartSeq)
      && requestIds.has(message.sourceRequestId)) turns.add(message.turnStartSeq)
  }
  if (!requestIds.size && Number.isSafeInteger(run?.nativeTurn?.startSeq)) turns.add(run.nativeTurn.startSeq)
  return turns.size ? turns : null
}

/**
 * The run's root session and its messages. A stored transcript carries `sessionId` on every line; a live one does not, and
 * then every message is the root's.
 * @param {{ header?: any, messages?: readonly any[] } | null | undefined} transcript @param {any} run
 * @returns {{ sessionId: string | null, messages: any[] }}
 */
export function rootSessionOf(transcript, run) {
  const declared = typeof run?.sessionId === 'string' && run.sessionId ? run.sessionId : null
  const fromHeader = (transcript?.header?.sessions ?? []).find((/** @type {any} */ session) => session?.parentSessionId == null)?.sessionId
  const sessionId = declared ?? (typeof fromHeader === 'string' && fromHeader ? fromHeader : null)
  const messages = (transcript?.messages ?? []).filter((/** @type {any} */ message) => !sessionId || message?.sessionId === undefined || message.sessionId === sessionId)
  return { sessionId, messages }
}
