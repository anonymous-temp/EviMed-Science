/**
 * Where a `share` notice opens (flywheel F17, 2026-10-05), shared by the inbox page and the channels that push the same notice (Feishu), so the
 * link a message carries is the link the in-app notice opens. A delivery (`delivery/<id>`) opens the page that previews it, offers a trial and
 * lets the recipient take it in or turn it down; a withdrawal and a take-down open the memory page, where the pack's shelf says what became of it.
 * @param {{id?: unknown, type?: unknown} | null | undefined} source
 * @returns {string | null} the in-app path, or null for a notice that is not a share
 */
export function shareNoticeHref(source) {
  if (!source || source.type !== 'share') return null
  const delivery = typeof source.id === 'string' ? /^delivery\/([A-Za-z0-9_-]{1,80})$/.exec(source.id) : null
  return delivery ? `/app/memory/delivered/${delivery[1]}` : '/app/memory'
}
