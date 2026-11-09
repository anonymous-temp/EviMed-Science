/** Instructions to the generator model. Natural-language eval content is written by Kimi only; this file only briefs it. */
import { KINDS } from './kinds.mjs';
import { intermediateValues, userValues } from './env.mjs';

const render = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const chainText = (g, task) => task.steps.map((s, i) => {
  const t = g.byName.get(s.tool);
  return `Step ${i + 1}: ${t.desc} (it returns: ${t.outputs.map((o) => o.name).join(', ')})`;
}).join('\n');
const valueLines = (task, which) => userValues(task).filter((u) => which(u)).map((u) => {
  return `- ${KINDS[u.kind]?.label ?? u.param} (for step ${u.step + 1}): ${render(u.value)}`;
}).join('\n');
const hidden = (task) => intermediateValues(task).map((i) => `- ${render(i.value)}`).join('\n') || '- (none)';

const common = (en) => `Rules for every text you write:
- ${en ? 'English' : 'Simplified Chinese (English technical terms and the given values stay as they are)'}. Natural, like a real busy person typing to an assistant.
- State only the GOAL. Never mention tool names, function names, field names, or say which steps to run.
- Write every value you are told to include exactly as given, character for character (dates as YYYY-MM-DD, codes and ids unchanged, numbers as plain digits).
- Never write any of the "hidden" values: they are produced during the work and the person does not know them.
- Output ONLY one JSON object, no commentary.`;

export function c3Prompt(g, task, feedback, lang = 'zh') {
  const COMMON = common(lang === 'en');
  return `You write one user request for an evaluation of an AI assistant that can call tools.

The assistant will do the work in these steps (the person does not know the steps):
${chainText(g, task)}

Values the person states in the request (include ALL of them verbatim):
${valueLines(task, () => true) || '- (none)'}

Hidden values (never write them):
${hidden(task)}

Write ONE request (1-2 sentences) a person would send whose natural fulfilment needs exactly this work, without describing the steps.
${COMMON}
Output: {"request": "..."}${feedback ? `\n\nYour previous attempt was rejected: ${feedback}. Fix it.` : ''}`;
}

export function l8Prompt(g, task, removed, source, feedback) {
  const COMMON = common(false);
  const gone = new Set(removed.map((r) => `${r.step}:${r.param}`));
  const rm = removed.map((r) => `- ${KINDS[r.kind].label} (needed at step ${r.step + 1}): ${r.value}`).join('\n');
  const where = source === 'sessions'
    ? `Also write "sessions": 1 or 2 short EARLIER conversations (2-6 messages each, roles "user"/"assistant") on everyday work topics. In some user message of them the person naturally states each withheld value (verbatim, as a passing detail or a preference, not as an instruction for the current job). The conversations must not be about the current request and must never mention the tools or the current request's other details.`
    : `Also write "card": a short learned working rule of the person's team: {"title": "...", "body": "..."}. The body (at most 120 characters) states each withheld value verbatim as a standing habit, e.g. 「我们组的……一律按……」, general and not about the current request. Also write "distractorSessions": 1 short earlier conversation (2-4 messages, roles "user"/"assistant") on an unrelated everyday topic that never states any withheld value.`;
  return `You write test material for an evaluation of whether an AI assistant uses what it already knows about its user.

The assistant will do the work in these steps (the person does not know the steps):
${chainText(g, task)}

Values the person states in the REQUEST (include ALL verbatim):
${valueLines(task, (u) => !gone.has(`${u.step}:${u.param}`)) || '- (none)'}

Withheld values: the person does NOT state these in the request (never write them in the request, but the request must still make the work need them, e.g. by implying "the usual" one or by simply asking for the work without saying which):
${rm}

Hidden values (never write them anywhere):
${hidden(task)}

Write "request": ONE request (1-2 sentences) a person would send, as in the rules.
${where}
${COMMON}
Output JSON: {"request": "...", ${source === 'sessions' ? '"sessions": [{"messages": [{"role": "user", "content": "..."}, ...]}]' : '"card": {"title": "...", "body": "..."}, "distractorSessions": [{"messages": [...]}]'}}${feedback ? `\n\nYour previous attempt was rejected: ${feedback}. Fix it.` : ''}`;
}
