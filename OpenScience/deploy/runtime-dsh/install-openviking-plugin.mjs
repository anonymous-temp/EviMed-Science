/**
 * The official OpenViking memory plugin, built into the image the way LoopX's plugin is: one digest-pinned archive, fetched
 * at build time, added to the seeded profile, never installed during a turn.
 *
 * Unlike LoopX's, this bundle is not adapted: no byte of it is edited. `verify` holds that as a fact of the build rather than
 * as an intention — every file pnpm installed is compared with the same file in the pinned archive, and a difference fails
 * the image by name.
 *
 *   install-openviking-plugin.mjs fetch  [pins]                       the archive, into /opt/evimed/openviking-plugin
 *   install-openviking-plugin.mjs order  <profile package.json> [pins] its bundle before the socket's
 *   install-openviking-plugin.mjs verify <installed dir> [pins]       installed bytes equal the archive's
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const OPENVIKING_PLUGIN_ROOT = '/opt/evimed/openviking-plugin';
const SOCKET_BUNDLE = '@evimed/dsh-socket';
const sha256 = (/** @type {Buffer | string} */ bytes) => createHash('sha256').update(bytes).digest('hex');

/** @param {any} pins @returns {{ name: string, version: string, filename: string, url: string, sha256: string, bundleRow: string }} */
export function openVikingPluginPin(pins) {
  const pin = pins?.openviking?.plugin;
  if (!pin || typeof pin.name !== 'string' || typeof pin.version !== 'string' || typeof pin.filename !== 'string'
    || typeof pin.url !== 'string' || !/^[a-f0-9]{64}$/.test(String(pin.sha256)) || typeof pin.bundleRow !== 'string') {
    throw new Error('deps-version.json openviking.plugin is not a complete pin.');
  }
  // A file name is joined to the archive directory; the pin record is ours, and it is still checked like input.
  if (pin.filename !== path.basename(pin.filename) || !pin.filename.endsWith('.tgz')) throw new Error('The OpenViking plugin archive name is not a plain .tgz file name.');
  return pin;
}

/** @param {string} file @param {string} expected */
export function verifyOpenVikingPluginArchive(file, expected) {
  const actual = sha256(readFileSync(file));
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error('OpenViking plugin archive digest mismatch.');
  return actual;
}

/** Fetch the pinned archive unless the verified bytes are already there. @param {{ pins: any, root?: string }} input */
export function fetchOpenVikingPlugin({ pins, root = OPENVIKING_PLUGIN_ROOT }) {
  const pin = openVikingPluginPin(pins);
  mkdirSync(root, { recursive: true });
  const file = path.join(root, pin.filename);
  try { verifyOpenVikingPluginArchive(file, pin.sha256); }
  catch {
    execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3',
      '--connect-timeout', '20', '--max-time', '600', pin.url, '-o', file], { stdio: 'inherit' });
    verifyOpenVikingPluginArchive(file, pin.sha256);
  }
  return file;
}

/**
 * The plugin's bundle goes before the socket's.
 *
 * A bundle's patch can only reach a row an earlier bundle made, and pnpm orders bundles by package name: `@openviking/…`
 * sorts after `@evimed/…`, so as installed the socket's patch runs first, finds no `openviking-memory-runtime` row to switch
 * off, and the plugin then mounts enabled on its own defaults for every account (measured on the seeded kernel, 2026-10-13;
 * the same defect LoopX had on old project volumes). `mergeProfileBundles` in profile-seed.mjs carries this order to every
 * project volume.
 * @param {string} profileFile @param {string} bundle
 */
export function orderBundleBeforeSocket(profileFile, bundle) {
  const manifest = JSON.parse(readFileSync(profileFile, 'utf8'));
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || [bundle, SOCKET_BUNDLE].some((name) => bundles.filter((value) => value === name).length !== 1)) {
    throw new Error(`The prepared profile must contain exactly one ${bundle} and one ${SOCKET_BUNDLE} bundle.`);
  }
  const ordered = bundles.filter((name) => name !== bundle);
  ordered.splice(ordered.indexOf(SOCKET_BUNDLE), 0, bundle);
  if (JSON.stringify(ordered) !== JSON.stringify(bundles)) {
    manifest.dsh.profile.bundles = ordered;
    writeFileSync(profileFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return ordered;
}

/** Every regular file under a directory, as sorted relative paths. @param {string} root @returns {string[]} */
function files(root) {
  /** @type {string[]} */
  const found = [];
  const walk = (/** @type {string} */ dir, /** @type {string} */ prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (relative !== 'node_modules') walk(path.join(dir, entry.name), relative); }
      else if (entry.isFile()) found.push(relative);
      else throw new Error(`Unexpected entry in the OpenViking plugin: ${relative}`);
    }
  };
  walk(root, '');
  return found.sort();
}

/**
 * The installed package is the pinned archive, file for file.
 * @param {{ pluginDir: string, pins: any, root?: string }} input
 */
export function verifyInstalledOpenVikingPlugin({ pluginDir, pins, root = OPENVIKING_PLUGIN_ROOT }) {
  const pin = openVikingPluginPin(pins);
  const archive = path.join(root, pin.filename);
  verifyOpenVikingPluginArchive(archive, pin.sha256);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'openviking-plugin-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', scratch, '--no-same-owner'], { stdio: 'inherit' });
    const source = path.join(scratch, 'package');
    if (!statSync(source).isDirectory()) throw new Error('The OpenViking plugin archive has no package directory.');
    const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    if (manifest.name !== pin.name || manifest.version !== pin.version) throw new Error(`The installed OpenViking plugin is ${manifest.name}@${manifest.version}, not the pinned ${pin.name}@${pin.version}.`);
    const expected = files(source);
    const installed = files(pluginDir);
    if (JSON.stringify(expected) !== JSON.stringify(installed)) {
      const extra = installed.filter((name) => !expected.includes(name));
      const missing = expected.filter((name) => !installed.includes(name));
      throw new Error(`The installed OpenViking plugin's files differ from the archive's: extra [${extra.join(', ')}], missing [${missing.join(', ')}].`);
    }
    const changed = expected.filter((name) => sha256(readFileSync(path.join(source, name))) !== sha256(readFileSync(path.join(pluginDir, name))));
    if (changed.length) throw new Error(`The installed OpenViking plugin differs from the pinned archive in: ${changed.join(', ')}.`);
    // The row the socket's patch switches is the one this package's own patch inserts.
    const patch = readFileSync(path.join(pluginDir, 'cordis.patch.yml'), 'utf8');
    if (!new RegExp(`^\\s*- id: ${pin.bundleRow}\\s*$`, 'm').test(patch)) throw new Error(`The OpenViking plugin no longer inserts the row ${pin.bundleRow}.`);
    return { schemaVersion: 1, name: pin.name, version: pin.version, archiveSha256: pin.sha256, files: expected.length, adaptation: 'none' };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, first, second] = process.argv.slice(2);
  const readPins = (/** @type {string | undefined} */ file) => JSON.parse(readFileSync(file ?? '/opt/evimed/runtime-deps-version.json', 'utf8'));
  const root = process.env.EVIMED_OPENVIKING_PLUGIN_ROOT || OPENVIKING_PLUGIN_ROOT;
  if (mode === 'fetch') {
    const pins = readPins(first);
    console.log(`OpenViking memory plugin archive ${fetchOpenVikingPlugin({ pins, root })} (${openVikingPluginPin(pins).version}).`);
  } else if (mode === 'order') {
    orderBundleBeforeSocket(first, openVikingPluginPin(readPins(second)).name);
  } else if (mode === 'verify') {
    const receipt = verifyInstalledOpenVikingPlugin({ pluginDir: first, pins: readPins(second), root });
    console.log(`Verified ${receipt.name}@${receipt.version}: ${receipt.files} files equal to the pinned archive.`);
  } else {
    process.stderr.write('usage: install-openviking-plugin.mjs fetch [pins] | order <profile package.json> [pins] | verify <installed dir> [pins]\n');
    process.exitCode = 64;
  }
}
