import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { projectTopicsResponse } from '@evimed/dsh-search-topics/contract';
import { HttpError } from './security.mjs';

export const SEARCH_TOPICS_RUNTIME_DIR = '/opt/evimed/search-topics-data';
export const SEARCH_TOPICS_TOKEN_FILE = 'search-topics.token';
export const SEARCH_TOPICS_NATIVE_PATH = '/api/evimed-search/topics';
export const SEARCH_TOPICS_IMAGE_LABEL = 'io.open-science.search-topics.version';
export const SEARCH_TOPICS_MAX_BYTES = 256 * 1024;
const CATEGORIES = Object.freeze(['literature', 'guidelines', 'drugs', 'trials']);

/** A source-backed response is available only when the installed plugin understands its provenance contract. */
export function supportsSearchTopicRecommendations(/** @type {unknown} */ value) {
  if (typeof value !== 'string') return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z0-9.-]+))?$/.exec(value);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return major > 0 || minor > 2 || (minor === 2 && (patch > 0 || !match[4]));
}

/** The operator-owned feed stays outside every researcher's workspace. No path comes from a request. */
export function searchTopicsSource(/** @type {any} */ config) {
  if (config.searchTopicsEnabled !== true || config.runtimeSandboxMode !== 'docker') return null;
  const root = path.resolve(config.dataDir);
  const directory = path.join(root, '.openscience', 'search-topics');
  const file = path.join(directory, 'topics.json');
  try {
    // Refuse links at every component below the configured data root, including the file. Directory mounting allows
    // an operator's atomic replacement to appear in an already running runtime without retaining an old file inode.
    let current = root;
    for (const component of ['.openscience', 'search-topics', 'topics.json']) {
      current = path.join(current, component);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (current === file ? !stat.isFile() || stat.size > SEARCH_TOPICS_MAX_BYTES : !stat.isDirectory())) return null;
    }
    if (realpathSync(directory) !== path.join(realpathSync(root), '.openscience', 'search-topics')) return null;
    return { directory, file };
  } catch { return null; }
}

/** A label is an installed image fact, not a promise made by a web configuration switch. */
export function searchTopicsImageVersion(/** @type {any} */ config, /** @type {string} */ image = config.runtimeContainerImage) {
  if (config.searchTopicsEnabled !== true || config.runtimeSandboxMode !== 'docker') return '';
  const result = spawnSync(config.runtimeContainerBin, ['image', 'inspect', '--format', `{{index .Config.Labels "${SEARCH_TOPICS_IMAGE_LABEL}"}}`, image],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  const version = result.status === 0 ? result.stdout.trim() : '';
  return supportsSearchTopicRecommendations(version) ? version : '';
}

/** One closed request shape at both boundaries; callers cannot select an origin, source path or credential. */
export function searchTopicsQuery(/** @type {URLSearchParams} */ params) {
  const category = params.get('category'), limit = params.get('limit') ?? '3';
  if (!CATEGORIES.includes(category) || !/^(?:[1-9]|1[0-2])$/.test(limit)
    || [...params.keys()].some(key => !['category', 'limit'].includes(key) || params.getAll(key).length !== 1)) {
    throw new HttpError(400, 'invalid_request', 'Use one search category and a topic limit between 1 and 12.');
  }
  return { category, limit: Number(limit) };
}

/** Only the public topic contract crosses the control plane. Native errors, paths, headers and credentials never do. */
export function projectSearchTopics(/** @type {any} */ value, /** @type {{category:string, limit:number}} */ request) {
  try {
    return projectTopicsResponse(value, request);
  } catch {
    throw new HttpError(502, 'evimed_search_topics_unavailable', 'Search topic recommendations are temporarily unavailable.');
  }
}
