/**
 * What the seam manifest may name on the wire that the kernel does not ship.
 *
 * The manifest classifies every method the control plane may call (`wire.unary`)
 * or refuses (`wire.denied`), and `verify-harness-seams.mjs` compares that with
 * the methods the installed kernel declares. A name the kernel does not declare
 * is a phantom — retired upstream and still listed — except for the methods this
 * platform registers on the same wire itself: `packages/harness-port` mounts two
 * Typert services of its own (`evimedPlugins`, `evimedSkills`), so the kernel
 * never ships them and their absence is not a finding.
 *
 * The check exempted `evimedPlugins/` by a literal prefix. `evimedSkills/` was
 * added after it, and its three methods (`list`, `read`, `snapshotBuiltin`)
 * were reported as phantoms on every run since. The namespaces are read from the
 * services that register them instead, so the next one cannot be missed the same
 * way, and an `evimed…/` entry nothing registers is still a phantom.
 *
 * Kept apart from the verifier because the verifier installs the kernel from the
 * network on import; this part needs nothing and is held by a test.
 *
 * @module wire-surface
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The Typert namespaces the platform's own services register, read from the
 * `super(ctx, '<namespace>')` of each `TypertRemoteService` subclass in a
 * directory of sources.
 * @param {string} sourceDir `packages/harness-port/src`
 * @returns {Set<string>}
 */
export function ownWireNamespaces(sourceDir) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const file of readdirSync(sourceDir)) {
    if (!file.endsWith(".mjs")) continue;
    for (const match of readFileSync(path.join(sourceDir, file), "utf8").matchAll(/super\(ctx, '([A-Za-z][A-Za-z0-9]*)'\)/g)) {
      found.add(match[1]);
    }
  }
  return found;
}

/**
 * The two ways the manifest and the shipped surface can disagree.
 * @param {{ declared: Iterable<string>, shipped: Iterable<string>, streams?: Iterable<string>, own?: ReadonlySet<string> }} input
 *   `declared` the manifest's `wire.unary` and `wire.denied`; `shipped` the
 *   methods the kernel declares; `streams` the stream endpoints the manifest
 *   classifies under `wire.streamEndpoints` (the gateway registers them as
 *   methods too); `own` the platform's own namespaces.
 * @returns {{ unclassified: string[], phantom: string[] }}
 *   `unclassified`: shipped, and the manifest has no opinion about it.
 *   `phantom`: declared, and neither shipped nor ours.
 */
export function wireSurfaceFindings({ declared, shipped, streams = [], own = new Set() }) {
  const declaredSet = new Set(declared);
  const shippedSet = new Set(shipped);
  const streamSet = new Set(streams);
  return {
    unclassified: [...shippedSet].filter((name) => !declaredSet.has(name) && !streamSet.has(name)).sort(),
    phantom: [...declaredSet].filter((name) => !shippedSet.has(name) && !own.has(name.split("/")[0])).sort(),
  };
}
