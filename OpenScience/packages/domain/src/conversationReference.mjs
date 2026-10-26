/**
 * A typed origin for a conversation: a hot event or one item of 前沿动态. The server supplies its canonical title.
 * @param {any} value @returns {{kind: 'frontier-event' | 'frontier-item', id: string, title: string} | null}
 */
export function conversationReference(value) {
  return (value?.kind === 'frontier-event' || value?.kind === 'frontier-item') && typeof value.id === 'string' && /^[a-z0-9]{12,32}$/.test(value.id)
    && typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 300
    ? { kind: value.kind, id: value.id, title: value.title } : null;
}
