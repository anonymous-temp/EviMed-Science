/** A typed origin for a conversation; the server supplies its canonical title.
 * @param {any} value @returns {{kind: 'frontier-event', id: string, title: string} | null}
 */
export function conversationReference(value) {
  return value?.kind === 'frontier-event' && typeof value.id === 'string' && /^[a-z0-9]{12,32}$/.test(value.id)
    && typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 300
    ? { kind: 'frontier-event', id: value.id, title: value.title } : null;
}
