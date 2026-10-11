/**
 * LoopX beta.6 recognizes the DSH 0.2 user/tool-result envelope. DSH 0.1.7
 * records the same successful call as a tool-role message. Match the exact
 * call identity in both formats; a failed skill never activates a driver.
 * @param {any} data @param {string} callId @returns {boolean}
 */
export function isSuccessfulLoopxSkillResult(data, callId) {
  const message = data?.message;
  if (!callId || data?.error != null || message?.source?.kind !== 'tool' || message.source.callId !== callId) return false;
  if (message.role === 'tool') return message.toolCallId === callId && message.isError !== true;
  const block = Array.isArray(message.content) && message.content.length === 1 ? message.content[0] : null;
  return message.role === 'user' && block?.type === 'tool-result' && block.toolCallId === callId && block.isError !== true;
}
