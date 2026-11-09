/**
 * Chain samplers. `dynamicUnlock` is ToolVerse's method: start from a tool with no prerequisite (no input of a derived kind)
 * and unlock a tool only once one of its inputs is reachable from what the chain already returned; chain length grows with
 * the level (level L gives L+1 tools). `randomWalk` is the baseline: for a given length, one chain drawn uniformly from ALL
 * valid chains of that length (any start; every later tool consumes at least one earlier output).
 * `deepen` (off by default) restricts each unlock to the tools newly fed by the latest call when there are any.
 * @module capsule-proving/synthetic/toolverse/samplers
 */
import { DERIVED_KINDS } from './kinds.mjs';
import { pick } from './rng.mjs';

/** Edges that feed `tool` from the tools already in the chain. */
export const feedersFrom = (g, chain, tool) => g.edgesInto(tool).filter((e) => chain.includes(e.from));
/** A tool is startable at this point when every derived-kind input (a handle only a tool can produce) has a feeder in the chain. */
export const derivedFed = (g, chain, tool) => g.byName.get(tool).inputs
  .filter((i) => i.accepts.every((k) => DERIVED_KINDS.has(k)))
  .every((i) => g.edgesInto(tool).some((e) => e.param === i.name && chain.includes(e.from)));
const isRoot = (g, name) => !g.byName.get(name).inputs.some((i) => (i.accepts || []).some((k) => DERIVED_KINDS.has(k)));

/** @returns {string[]|null} tool names of one chain with `length` tools, or null when none was found. */
export function dynamicUnlock(g, rng, level, { tries = 300, deepen = false } = {}) {
  const length = level + 1;
  const roots = g.tools.filter((t) => isRoot(g, t.name) && g.edges.some((e) => e.from === t.name)).map((t) => t.name);
  for (let n = 0; n < tries; n++) {
    const chain = [pick(rng, roots)];
    while (chain.length < length) {
      const unlocked = g.tools.map((t) => t.name).filter((t) => !chain.includes(t) && feedersFrom(g, chain, t).length > 0 && derivedFed(g, chain, t));
      if (!unlocked.length) break;
      // deepen: prefer the tools the latest call has just unlocked (its own outputs feed them), so depth grows with the level
      const fresh = deepen ? unlocked.filter((t) => g.edgesInto(t).some((e) => e.from === chain[chain.length - 1])) : [];
      chain.push(pick(rng, fresh.length ? fresh : unlocked));
    }
    if (chain.length === length) return chain;
  }
  return null;
}

const cache = new WeakMap();
/** All valid chains of `length` tools, enumerated once per graph and length. */
export function allChains(g, length) {
  let byLen = cache.get(g);
  if (!byLen) cache.set(g, (byLen = new Map()));
  if (byLen.has(length)) return byLen.get(length);
  const out = [];
  const walk = (chain) => {
    if (chain.length === length) { out.push([...chain]); return; }
    for (const t of g.tools) {
      if (chain.includes(t.name) || feedersFrom(g, chain, t.name).length === 0 || !derivedFed(g, chain, t.name)) continue;
      chain.push(t.name); walk(chain); chain.pop();
    }
  };
  for (const t of g.tools) if (derivedFed(g, [], t.name)) walk([t.name]);
  byLen.set(length, out);
  return out;
}
export const randomWalk = (g, rng, length) => { const all = allChains(g, length); return all.length ? pick(rng, all) : null; };
