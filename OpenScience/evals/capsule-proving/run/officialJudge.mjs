import { readFileSync } from 'node:fs';

// Template strings are extracted verbatim from the pinned upstream Python file.
export const OFFICIAL = JSON.parse(readFileSync(new URL('./longmemeval-official.json', import.meta.url), 'utf8'));
export function officialPrompt(gold, reply) {
  const type = gold.question_type;
  const key = gold.question_id.includes('_abs') ? 'abstention'
    : ['single-session-user', 'single-session-assistant', 'multi-session'].includes(type) ? 'default' : type;
  const template = OFFICIAL.templates[key];
  if (!template) throw new Error('official_question_type_unsupported');
  const values = [gold.question, gold.answer, reply];
  return template.replace(/\{\}/g, () => String(values.shift()));
}

export function rubricFacts(rubric, answerModel) {
  return { rubric, prompt: rubric === 'official' ? 'official LongMemEval evaluate_qa.py' : 'capsule approximate',
    ...(rubric === 'official' ? { upstream: { ...OFFICIAL, templates: undefined }, officialJudgeModel: false,
      comparability: 'Official prompt and yes-substring parser; non-official judge model qwen3.8-max (upstream GPT-4o).' } : {}),
    answerJudgeSameFamily: /^qwen/i.test(answerModel ?? '') };
}

/** Match upstream exactly: even "not yes" contains yes and therefore passes. */
export const officialYes = text => text.trim().toLowerCase().includes('yes');

export async function judgeOfficialBatch(packets, { key, fetchImpl = globalThis.fetch }) {
  const results = await Promise.all(packets.map(async packet => {
    const response = await fetchImpl('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', messages: [{ role: 'user', content: packet.officialPrompt }],
        n: 1, temperature: 0, max_tokens: 10, enable_thinking: false }), signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`judge_http_${response.status}`);
    const data = await response.json(), content = data.choices?.[0]?.message?.content;
    if (!/^qwen3\.8-max(?:-(?:0902|2026-09-02))?$/.test(data.model ?? '')) throw new Error('judge_model_mismatch');
    if (typeof content !== 'string' || !content.trim()) throw new Error('judge_incomplete');
    return { id: packet.id, verdict: officialYes(content) ? 'correct' : 'incorrect', reason: content.trim(),
      failureStep: officialYes(content) ? null : 'other', model: data.model,
      requestId: response.headers.get('x-request-id') ?? data.id ?? null, usage: data.usage ?? null };
  }));
  return { judgements: results };
}
