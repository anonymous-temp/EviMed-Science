/** Compact notation for the curated tool lists: `name:kind` or `name:kindA|kindB` (accepted kinds; the first sets the type); a trailing `[]` makes it a list of that kind. */
import { KINDS } from './kinds.mjs';

const parse = (s, isInput) => {
  const [name, ks] = s.split(':');
  const array = ks.endsWith('[]');
  const kinds = ks.replace(/\[\]/g, '').split('|');
  for (const k of kinds) if (!KINDS[k]) throw new Error(`unknown kind ${k} in ${s}`);
  const type = array ? `${KINDS[kinds[0]].type}[]` : KINDS[kinds[0]].type;
  return isInput ? { name, type, kind: kinds[0], accepts: kinds, required: true } : { name, type, kind: kinds[0] };
};
/** @returns {import('./graph.mjs').Tool} */
export const tool = (name, server, desc, inputs, outputs) => ({
  name, server, desc, inputs: inputs.map((s) => parse(s, true)), outputs: outputs.map((s) => parse(s, false)),
});
