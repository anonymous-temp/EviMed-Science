import { confirmedAliases } from './nativeMemoryInduction.mjs';
import { lineFingerprint } from './nativeMemoryOverlay.mjs';
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
  if (messages.filter(message => message.role === 'user').at(-1)?.text.trim() !== confirmation.trim()) {
    return 'Ask the person and quote their latest complete answer verbatim.';
  }
  return null;
}

/** Only a single yes/no question whose subject is precisely the two card labels.
 * @param {string} left @param {string} right @param {string} question */
function singlePairQuestion(left, right, question) {
  const named = (/** @type {string} */ label) => {
    const name = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return `(?:${name}|“${name}”|「${name}」|『${name}』|"${name}")`;
  };
  const a = named(left), b = named(right);
  const chinese = new RegExp(`^(?:(?:请确认(?:一下)?|我想确认(?:一下)?)[：:]\\s*)?${a}\\s*(?:和|与|、)\\s*${b}\\s*(?:(?:是|指的是|指)同一(?:个)?人吗|是不是同一(?:个)?人|是否为同一(?:个)?人)[?？](?:\\s*(?:请)?回复\\s*是\\s*[/／]\\s*不是[。.]?)?$`, 'u');
  const english = new RegExp(`^Are ${a} and ${b} the same person\\?(?:\\s*(?:Please )?[Rr]eply yes\\s*/\\s*no\\.?)?$`, 'u');
  return chinese.test(question) || english.test(question);
}

/** A typed consent receipt names both current cards and the operation. Free text is never parsed for intent. */
export function personConsentRefusal(left, right, distinct, confirmation, question = '', hinted = false) {
  const relation = distinct ? '不是同一个人' : '是同一个人';
  const action = distinct ? '记录为不同人' : '合并';
  const answer = String(confirmation ?? '').trim().replace(/[.。]$/u, '');
  const previous = question.trim();
  for (const [a, b] of [[left, right], [right, left]]) {
    const asks = [`“${a}”和“${b}”是同一个人吗？`, `Are ${a} and ${b} the same person?`];
    const answers = distinct ? ['不是', '不是同一个人', 'no'] : ['是', '是的', '是同一个人', 'yes'];
    if (asks.includes(previous) && answers.includes(answer.toLowerCase())) return null;
    if (!distinct && hinted && [...answers, '对', '没错'].includes(answer.toLowerCase()) && singlePairQuestion(a, b, previous)) return null;
    const sentence = `${a}和${b}${relation}`;
    const english = `${a} and ${b} are ${distinct ? 'different people' : 'the same person'}`;
    const forms = [sentence, `${sentence}，请${action}`, `更正一下，${sentence}，请${action}`, english];
    if (forms.includes(answer)) return null;
  }
  return `Ask the person to reply with the full decision about these two cards: ${left}和${right}${relation}。`;
}

/** A later explicit withdrawal also retires the alias as a lookup key. */
export function aliasWithdrawn(label, removals) {
  const prints = new Set([label, `又称：${label}`].map(lineFingerprint));
  return removals.some(row => prints.has(row.fingerprint) || row.text && confirmedAliases(`- ${row.text}`).includes(label));
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
  if (label && !seen.has(alias)) lines.push(alias);
  return lines.join('\n');
}

/** @typedef {{revisionId?:string|null,engineSession?:string|null,archiveUri?:string|null,projectId?:string|null,projectCreatedAt?:string|null,addedAt?:string|null,sources?:PersonOrigin[]}} PersonOrigin */
/** @typedef {{uri:string,body:string,projectId:string|null,sensitive:boolean,origins:[string,PersonOrigin][]}} PersonBefore */
/** @typedef {{keep:PersonBefore,merge:PersonBefore,after:string,confirmationSession:string}} PersonMergeSnapshot */
/** @typedef {{revisionId:string,keepUri:string,mergeUri:string,state:'pending'|'applied'|'undone',snapshot:PersonMergeSnapshot|null}} PersonMerge */

export const PERSON_MEMORY_TOOLS = {
  merge_people: {
    description: 'Merge two people files ONLY after the person explicitly confirms in this conversation that they are the same person. Never infer identity from similar names or facts. After a memory hint, ask one standalone yes/no question naming exactly those two cards, e.g. 「<first name>」和「<second name>」是同一个人吗？. If the question covers several pairs or the answer is unclear, ask the person to name both cards and state the decision. Quote the person’s complete latest answer verbatim. Both histories and conflicting facts are kept; the memory page can undo this operation.',
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
