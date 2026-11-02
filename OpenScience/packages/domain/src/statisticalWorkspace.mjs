/** The native statistical workspace namespace is ordinary user work, with one immutable root conversation. */
/** @param {unknown} value */
export function isStatisticalWorkspaceProjectId(value) {
  return typeof value === 'string' && /^stat-[a-f0-9]{40}$/.test(value)
}
