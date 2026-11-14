import { createHash } from 'node:crypto';

/** Exact URI pair identity, shared with the existing map dismissal store. @param {string} a @param {string} b */
export function personPairId(a, b) {
  return `e_${createHash('sha256').update(JSON.stringify(['distinct-people', ...[a, b].sort()])).digest('hex').slice(0, 24)}`;
}

// A default-project label is account memory; a named project is a narrower write scope.
/** @param {string|null|undefined} projectId */
export const personProjectScope = projectId => !projectId || projectId === 'default' ? null : projectId;

/** Syntax and witnessed authorship only; the model must ask for an explicit yes/no, never infer identity.
 * @param {{root:string,a:unknown,b:unknown,confirmation:unknown,messages:readonly {role:string,text:string}[]}} input */
export function personDecisionRefusal({ root, a, b, confirmation, messages }) {
  /** @param {unknown} value */
  const peopleUri = value => typeof value === 'string' && value.startsWith(`${root}/memories/people/`)
    && value.length <= 600 && /^[^/%.?#\\]+\.md$/u.test(value.slice(`${root}/memories/people/`.length));
  if (!peopleUri(a) || !peopleUri(b)) return 'Both URIs must name people files in this conversation’s writable memory scope.';
  if (a === b) return 'Choose two different people files.';
  if (typeof confirmation !== 'string' || !confirmation.trim() || confirmation.length > 6000) return 'Supply the person’s confirming sentence verbatim.';
  if (!messages.some(message => message.role === 'user' && message.text.includes(confirmation))) {
    return 'The confirmation was not found in a user message of this conversation. Ask the person and quote their answer verbatim.';
  }
  return null;
}

/** Append intact dated lines. Only byte-identical lines collapse; headings remain in their original order.
 * @param {string} keep @param {string} merge @param {string} label */
export function mergePeopleText(keep, merge, label) {
  /** @type {string[]} */
  const lines = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const line of keep.split('\n')) {
    if (!line.trim() || !seen.has(line) || /^#{1,6}\s/u.test(line)) lines.push(line);
    if (line.trim()) seen.add(line);
  }
  /** @type {string[]} */
  let headings = [];
  for (const line of merge.split('\n')) {
    if (/^#{1,6}\s/u.test(line)) {
      const depth = line.indexOf(' ');
      headings = headings.filter(heading => heading.indexOf(' ') < depth);
      headings.push(line);
      continue;
    }
    if (!line.trim() || seen.has(line)) continue;
    // Headings are context, not deduplicated facts: a repeated date must still qualify its new lines.
    lines.push(...headings, line); headings = []; seen.add(line);
  }
  const alias = `- 又称：${label}`;
  if (!seen.has(alias)) lines.push(alias);
  return lines.join('\n');
}

/** @typedef {{revisionId?:string|null,engineSession?:string|null,archiveUri?:string|null,projectId?:string|null,projectCreatedAt?:string|null,addedAt?:string|null,sources?:PersonOrigin[]}} PersonOrigin */
/** @typedef {{uri:string,body:string,projectId:string|null,sensitive:boolean,origins:[string,PersonOrigin][]}} PersonBefore */
/** @typedef {{keep:PersonBefore,merge:PersonBefore,after:string,confirmationSession:string}} PersonMergeSnapshot */
/** @typedef {{revisionId:string,keepUri:string,mergeUri:string,state:'pending'|'applied'|'undone',snapshot:PersonMergeSnapshot|null}} PersonMerge */

export const PERSON_MEMORY_TOOLS = {
  merge_people: {
    description: 'Merge two people files ONLY after the person explicitly confirms in this conversation that they are the same person. Never infer identity from similar names or facts. Quote the person’s confirming sentence verbatim. Both histories and conflicting facts are kept; the memory page can undo this operation.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['keep', 'merge', 'confirmation'], properties: {
      keep: { type: 'string' }, merge: { type: 'string' }, confirmation: { type: 'string', minLength: 1, maxLength: 6000 },
    } },
  },
  distinct_people: {
    description: 'Record that two people files refer to different people ONLY after an explicit no from the person in this conversation. Quote their confirming sentence verbatim. This stops suggesting this pair; it changes neither file.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['a', 'b', 'confirmation'], properties: {
      a: { type: 'string' }, b: { type: 'string' }, confirmation: { type: 'string', minLength: 1, maxLength: 6000 },
    } },
  },
};
