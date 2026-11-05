/**
 * The knowledge-source plugin's AI-discovery rows, as the medical feed tells them apart.
 *
 * Those rows bring what is not medicine (arXiv phrase queries over the core AI categories, Hugging Face Daily Papers, agent framework
 * releases, model releases, lab blogs, proceedings: `项目代码/knowledge-plugin/registry/extra-sources.json`). The offline lab reads them through
 * the plugin; the medical feed drops them. The plugin's contract has no field that says so and the closed `facts` whitelist has no room for one,
 * so the id is the marker: every such row starts with `ai-discovery-`. A test holds this file and the plugin's registry to the same list.
 *
 * @module evolutionDiscoverySources
 */

/** Every row that exists only for discovery has an id that starts with this. */
export const AI_DISCOVERY_PREFIX = 'ai-discovery-';
/** The single arXiv query the channel began with. Its row is gone from the registry; the entries it stored keep their meaning. */
export const LEGACY_DISCOVERY_SOURCE_ID = 'arxiv-agent-self-improvement';

/** The medical feed drops these entries. @param {unknown} sourceId */
export function isDiscoveryOnlySource(sourceId) {
  const id = String(sourceId ?? '');
  return id.startsWith(AI_DISCOVERY_PREFIX) || id === LEGACY_DISCOVERY_SOURCE_ID;
}
