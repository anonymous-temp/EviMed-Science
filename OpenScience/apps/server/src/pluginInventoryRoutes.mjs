import { readFileSync } from 'node:fs';
import { HttpError, sendJson } from './security.mjs';

/** Fixed source pins are shipped with config.mjs in the web image; no runtime/customer path is accepted. */
function deploymentPins() {
  try {
    const pins = JSON.parse(readFileSync(new URL('../../../deps-version.json', import.meta.url), 'utf8')).dsh;
    if (['citeVersion', 'annotationVersion', 'mermaidVersion'].some(key => typeof pins?.[key] !== 'string' || !pins[key])) return null;
    return { cite: pins.citeVersion, annotation: pins.annotationVersion, mermaid: pins.mermaidVersion };
  } catch { return null; }
}

/** Read-only deployment declarations and existing project configuration, never readiness or installation authority.
 * @param {{store:any,pluginService:any,config:Record<string,any>}} dependencies */
export function createPluginInventoryRoutes({ store, pluginService, config }) {
  const pins = deploymentPins();
  // Only these constructor-owned booleans can enter the public projection.
  const annotation = typeof config.runtimeAnnotationEnabled === 'boolean' ? config.runtimeAnnotationEnabled : null;
  const mermaid = typeof config.runtimeMermaidEnabled === 'boolean' ? config.runtimeMermaidEnabled : null;
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://evimed.local');
    const match = /^\/api\/projects\/([^/]+)\/plugin-inventory$/.exec(url.pathname);
    if (!match) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (req.method !== 'GET') throw new HttpError(404, 'not_found', 'Inventory route not found.');
    if ([...url.searchParams].length) throw new HttpError(400, 'extension_contract_invalid', 'Invalid inventory query.');
    let projectId;
    try { projectId = decodeURIComponent(match[1]); } catch { throw new HttpError(400, 'plugin_path_invalid', 'Invalid project path.'); }
    const project = await store.requireProject(user, projectId);
    if (!pins) throw new HttpError(503, 'product_state_unavailable', 'The pinned plugin inventory is unavailable.');
    let citation = null;
    if (pluginService) {
      try { citation = (await pluginService.list(user, project)).plugins.find(item => item.id === 'dsh-cite') ?? null; }
      catch (error) { if (error?.status !== 503) throw error; }
    }
    const clientRow = (id, version, enabled) => ({ id, version, kind: 'client', management: 'deployment', configuredEnabled: enabled,
      configurationPhase: enabled === null ? 'unknown' : enabled ? 'configured' : 'disabled', observation: 'unknown' });
    const items = [
      { id: 'dsh-cite', version: pins.cite, kind: 'tool', management: 'project',
        configuredEnabled: typeof citation?.desired?.enabled === 'boolean' ? citation.desired.enabled
          : typeof citation?.effective?.enabled === 'boolean' ? citation.effective.enabled : null,
        configurationPhase: citation?.phase ?? 'unavailable', observation: 'unknown' },
      clientRow('dsh-annotation', pins.annotation, annotation), clientRow('dsh-mermaid', pins.mermaid, mermaid),
    ];
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { data: { projectId: project.id, items } });
    return true;
  };
}
