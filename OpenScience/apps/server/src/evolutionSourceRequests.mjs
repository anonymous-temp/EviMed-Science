/**
 * Public pull-only manifest: the plugin owns admission and never receives a push.
 * It used to carry one request, the arXiv query self-research began with. The plugin's registry now carries the whole set that
 * request grew into (the `ai-discovery-` rows of 2026-10-10), and a request for a row the registry no longer has would admit
 * the old query again beside them, so the list of fixed requests is empty and only the requests the platform files are served.
 */
export const AI_DISCOVERY_SOURCE_REQUESTS = Object.freeze(/** @type {any[]} */ ([]));
/** @param {any} service */
export async function evolutionSourceRequestManifest(service){const requested=service?(await service.list('source-request')).filter(r=>r.payload.public===true&&r.payload.status==='requested').map(r=>r.payload.source):[];return {schemaVersion:1,sources:[...AI_DISCOVERY_SOURCE_REQUESTS,...requested].slice(0,25)};}
