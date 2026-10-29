/** The catalogue uses flat Typert arguments; kernel session methods keep their own request envelope.
 * @param {string} method @param {any} request */
export function catalogueWireArgs(method, request) {
  if (['evimedSkills/list', 'evimedSkills/read', 'evimedSkills/snapshotBuiltin'].includes(method)) return request;
  return method === 'session/list' ? { _request: {} } : { request };
}
