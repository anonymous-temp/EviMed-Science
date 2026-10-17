/**
 * Which host namespaces each of the kernel's browser packages reaches, read from the package's own client bundle.
 *
 * The hosted profile hides a set of the kernel's settings panels, and the method deny list is what actually stops what
 * they do (`apps/server/test/hiddenPanelsHaveAMethodBan.test.mjs`). That pairing used to be written by hand, panel by
 * panel, and a hand-written pairing can name a namespace the panel never calls: the plugin inventory's was paired with
 * our own `evimedPlugins` while its client calls `pluginInventory/*`, which the proxy did not deny (found 2026-10-14).
 * The namespaces a client reaches are a fact of its bundle, so they are read from it.
 *
 * A browser package reaches a host namespace in one of two ways, both visible in its `lib/client.js`:
 *
 *   - `ctx.remote.<namespace>` (or the service name `"remote.<namespace>"` in its inject list), the generated Remote face
 *     of a Typert service;
 *   - the `configForms` service, the generic configuration-form client of `@deepseek-ai/dsh-client-ui-settings`, whose
 *     calls are `remote.settings` (recorded from that package, below), so a panel that only names `configForms` reaches
 *     `settings` without ever writing the word.
 *
 * Recorded to `panel-remotes.json` by `record-panel-remotes.mjs` for the pinned closure, and compared with a fresh
 * installation by `scripts/ops/verify-harness-seams.mjs`, so the recording cannot go stale in silence.
 *
 * @module panel-remotes
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** A reference in a bundle: `ctx.remote.x`, or a quoted `remote.x` service name. */
const REMOTE_REFERENCE = /(?:ctx\.|["'`])remote\.([A-Za-z][A-Za-z0-9]*)/g;
/** The generic form client's service name, as a bundle's inject list or `ctx.configForms` uses it. */
const CONFIG_FORMS = /(?:ctx\.configForms\b|["'`]configForms["'`])/;
/** The package whose client implements `configForms`. */
export const CONFIG_FORMS_PROVIDER = "@deepseek-ai/dsh-client-ui-settings";

/**
 * Package names the composition mounts, by row id, from a `--dump-config` text.
 * @param {string} baselineText
 * @returns {Map<string, string>} row id -> package name (the part before any `/subpath`)
 */
export function rowPackages(baselineText) {
  /** @type {Map<string, string>} */
  const rows = new Map();
  for (const block of baselineText.split(/\n(?=- id: )/)) {
    const id = /^- id: (\S+)/m.exec(block)?.[1];
    const name = /^\s+name: '?([^'\n]+)'?/m.exec(block)?.[1];
    if (!id || !name) continue;
    rows.set(id, name.replace(/^(@[^/]+\/[^/]+)\/.+$/, "$1"));
  }
  return rows;
}

/**
 * What one bundle's source reaches.
 * @param {string} source the text of a package's `lib/client.js`
 * @returns {{ remotes: string[], configForms: boolean }}
 */
export function referencesIn(source) {
  const remotes = new Set();
  for (const match of source.matchAll(REMOTE_REFERENCE)) remotes.add(match[1]);
  return { remotes: [...remotes].sort(), configForms: CONFIG_FORMS.test(source) };
}

/**
 * The file a package serves the browser: its `./client` export's browser target. Until 0.2.1 that was always
 * `lib/client.js`; 0.2.1 split `dsh-client-connection`'s into `lib/client.browser.js` and `lib/client.node.js`, and the
 * fixed path read it as a package with no client at all.
 * @param {string} dir @returns {string}
 */
export function clientBundleOf(dir) {
  try {
    const target = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).exports?.["./client"];
    const entry = typeof target === "string" ? target : target?.browser ?? target?.default;
    if (typeof entry === "string" && entry.startsWith("./")) return path.join(dir, entry);
  } catch { /* no manifest to read: the conventional path below */ }
  return path.join(dir, "lib", "client.js");
}

/**
 * Every client package the composition mounts, with what its bundle reaches.
 * @param {string | ((name: string) => string | null)} where a `node_modules` holding the flat kernel closure, or a
 *   function from a package name to its directory (a pnpm-isolated install)
 * @param {string} baselineText `deploy/runtime-dsh/dump-config.baseline.json`
 * @returns {{ packages: Record<string, { remotes: string[], configForms: boolean }>, unreadable: string[] }}
 */
export function panelRemotes(where, baselineText) {
  const locate = typeof where === "function" ? where : (/** @type {string} */ name) => path.join(where, name);
  /** @type {Record<string, { remotes: string[], configForms: boolean }>} */
  const packages = {};
  /** @type {string[]} */
  const unreadable = [];
  for (const name of [...new Set(rowPackages(baselineText).values())].sort()) {
    // Only browser-side packages have a client bundle; a host-only package is not a panel.
    if (!/^@deepseek-ai\/dsh-client-/.test(name)) continue;
    const dir = locate(name);
    const file = dir ? clientBundleOf(dir) : null;
    if (!file || !existsSync(file)) { unreadable.push(name); continue; }
    packages[name] = referencesIn(readFileSync(file, "utf8"));
  }
  return { packages, unreadable };
}

/**
 * The namespaces a package's client reaches: its remotes, plus `settings` when it goes through the generic form client.
 * @param {{ remotes: string[], configForms: boolean }} entry
 * @returns {string[]}
 */
export function reachedNamespaces(entry) {
  return [...new Set([...entry.remotes, ...(entry.configForms ? ["settings"] : [])])].sort();
}
