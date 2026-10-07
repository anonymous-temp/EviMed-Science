import { researchToolGroups } from '@evimed/domain/research-tools';
import { MCP_TOOL_BASE_NAMES } from '@evimed/domain';
import { declinedTools } from './deploymentComposition.mjs';
import { HttpError, sendJson } from './security.mjs';

/**
 * What the plugins page lists: what a conversation in this project really has
 * to work with, and what the platform's calculation engines can take on now.
 *
 * Hidden knowledge: this used to answer with the deployment's pinned versions
 * and a hard-coded `observation: "unknown"` that the page printed as 「运行状态
 * 尚未确认」 — a sentence that could never become anything else, about plugins
 * the page cannot probe (the annotation and diagram packs are drawn in the
 * browser; there is nothing to ask). The page now says only what is true and
 * what a reader can act on: whether each one is on, the tools the research
 * tool set carries (already in Chinese, from the domain's table), whether web
 * reading is offered, and, for each calculation engine, one yes or no from the
 * same health reading the availability labels use. A version, a phase of the
 * configuration being applied or a pin is the platform's business and is not
 * sent.
 *
 * Read-only: it never starts a runtime, never installs, never saves.
 *
 * @param {{store:any,pluginService:any,config:Record<string,any>,engines?:((user:any)=>Promise<{id:string,available:boolean}[]>)|null}} dependencies */
export function createPluginInventoryRoutes({ store, pluginService, config, engines = null }) {
  // Only these constructor-owned booleans can enter the public projection.
  const annotation = typeof config.runtimeAnnotationEnabled === 'boolean' ? config.runtimeAnnotationEnabled : null;
  const mermaid = typeof config.runtimeMermaidEnabled === 'boolean' ? config.runtimeMermaidEnabled : null;
  const researchTools = Object.freeze({ count: MCP_TOOL_BASE_NAMES.length, groups: researchToolGroups() });
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
    let citation = null;
    if (pluginService) {
      try { citation = (await pluginService.list(user, project)).plugins.find(item => item.id === 'dsh-cite') ?? null; }
      catch (error) { if (error?.status !== 503) throw error; }
    }
    const items = [
      { id: 'dsh-cite', management: 'project',
        enabled: typeof citation?.desired?.enabled === 'boolean' ? citation.desired.enabled
          : typeof citation?.effective?.enabled === 'boolean' ? citation.effective.enabled : null },
      { id: 'dsh-annotation', management: 'deployment', enabled: annotation },
      { id: 'dsh-mermaid', management: 'deployment', enabled: mermaid },
    ];
    // An engine reading that cannot be made is no reading: the page then draws no engine rows rather than a guess.
    let calculation = [];
    if (engines) { try { calculation = (await engines(user)).map(({ id, available }) => ({ id, available: available === true })); } catch { calculation = []; } }
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { data: { projectId: project.id, items, webRead: !declinedTools(config, user).has('web_read'), researchTools, engines: calculation } });
    return true;
  };
}
