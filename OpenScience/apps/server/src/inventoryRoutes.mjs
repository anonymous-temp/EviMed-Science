import { researchToolsOfModule } from '@evimed/domain/research-tools';
import { listInventory, listResearchTools } from '@evimed/domain/runtime-inventory';
import { declinedTools, moduleState } from './deploymentComposition.mjs';
import { HttpError, sendJson } from './security.mjs';

/**
 * What the plugins page lists for a project: the things a conversation in it really has to work with, in the words
 * `runtime-inventory-zh.json` holds for them, and the research tool set as this account's runtime has it.
 *
 * Hidden knowledge: this used to be a hand-typed answer (three plugin ids, two booleans, a count of tools and a column of
 * calculation engines) beside a hand-typed table in the browser, and neither was the image's own list — so 长任务, the
 * memory plugin and the kernel's own step list were in every session and on no page. The members are now the vocabulary's
 * (`@evimed/domain/runtime-inventory`, held equal to the composition the image is built from by a test), and what this
 * file decides is only each one's state for this account: a switch the deployment turned off is not a row, a tool the
 * account's runtime is not given is not in the tool set, the citation check says what the project holds. Nothing a
 * deployment's operator would read — a version, a phase, an engine's health — is in the answer.
 *
 * Read-only: it never starts a runtime, never installs, never saves.
 *
 * `/plugin-inventory` answers the same payload with the old fields beside it for one release (delete it with the one after
 * the release that ships this): a tab opened before the release still has the old page's code, and the old fields are what
 * that page reads.
 *
 * @param {{store:any,pluginService:any,config:Record<string,any>}} dependencies */
export function createInventoryRoutes({ store, pluginService, config }) {
  // Only these constructor-owned booleans can enter the public projection.
  const flag = (/** @type {unknown} */ value) => typeof value === 'boolean' ? value : null;
  const deployment = Object.freeze({
    loopxEnabled: flag(config.loopxEnabled),
    memoryEnabled: flag(config.memoryEnabled),
    runtimeAnnotationEnabled: flag(config.runtimeAnnotationEnabled),
    runtimeMermaidEnabled: flag(config.runtimeMermaidEnabled),
  });
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://evimed.local');
    const match = /^\/api\/projects\/([^/]+)\/(inventory|plugin-inventory)$/.exec(url.pathname);
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
      try { citation = (await pluginService.list(user, project)).plugins.find((/** @type {any} */ item) => item.id === 'dsh-cite') ?? null; }
      catch (error) { if (/** @type {any} */ (error)?.status !== 503) throw error; }
    }
    const citationEnabled = typeof citation?.desired?.enabled === 'boolean' ? citation.desired.enabled
      : typeof citation?.effective?.enabled === 'boolean' ? citation.effective.enabled : null;
    // What this account's runtime is not given, and the tools of a module the account is outside of whether or not the launch
    // names each of them (the visibility probe is served by the probe host and is on no declined list).
    const declined = [
      ...declinedTools(config, user).keys(),
      ...['geo', 'vcr'].filter(module => moduleState(config, user, /** @type {'geo' | 'vcr'} */ (module)) !== 'on')
        .flatMap(module => researchToolsOfModule(/** @type {'geo' | 'vcr'} */ (module))),
    ];
    /** @type {Record<string, unknown>} */
    const data = {
      projectId: project.id,
      groups: listInventory({ config: deployment, projectSettings: { 'dsh-cite': citationEnabled }, declinedTools: declined }),
      researchTools: listResearchTools(declined),
    };
    if (match[2] === 'plugin-inventory') {
      data.items = [
        { id: 'dsh-cite', management: 'project', enabled: citationEnabled },
        { id: 'dsh-annotation', management: 'deployment', enabled: deployment.runtimeAnnotationEnabled },
        { id: 'dsh-mermaid', management: 'deployment', enabled: deployment.runtimeMermaidEnabled },
      ];
      data.webRead = !declined.includes('web_read');
      data.engines = [];
    }
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { data });
    return true;
  };
}
