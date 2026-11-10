/** Official answer instructions, pinned separately from corpus bytes. Qwen replaces upstream judge models. */
import { readFileSync } from 'node:fs';
export const PUBLIC_OFFICIAL = JSON.parse(readFileSync(new URL('./public-official.json', import.meta.url), 'utf8'));

export function publicMemoryRubric(set, gold) {
  if (set === 'memsyco') return { status: 'official', text: JSON.stringify(gold.evaluation) };
  if (PUBLIC_OFFICIAL[set]) return { status: 'official', text: PUBLIC_OFFICIAL[set].template };
  return { status: 'approximate', text: `Approximate semantic accuracy, NOT the original LoCoMo Porter-stemmed token F1. Compare the essential reference content by meaning, including all required entities and temporal values. Category: ${gold.categoryName}. Reference: ${JSON.stringify(gold.answer)}.` };
}

/** No historical memories or answer-side traces are added to official HaluMem / RealMem judge requests. */
export function publicOfficialPacket(set, gold, reply) {
  const pin = PUBLIC_OFFICIAL[set];
  if (!pin) return null;
  let prompt;
  if (set === 'halumem') {
    const values = { question: gold.question, reference_answer: gold.answer,
      key_memory_points: (gold.evidence ?? []).map(m => m.memory_content).join('\n'), response: reply };
    prompt = pin.template.replace(/\{(question|reference_answer|key_memory_points|response)\}/g, (_, k) => values[k])
      .replaceAll('{{', '{').replaceAll('}}', '}');
  } else {
    const memories = (gold.memory_used ?? []).map(m => m.content).filter(Boolean).join('\n') || 'No specific memory annotation found.';
    prompt = `${pin.template}\n### Input Data\n1. Query: ${gold.question}\n2. User-related Memory: ${memories}\n3. Reference Answer: ${gold.reference_answer}\n4. Candidate Answer: ${reply}\n`;
  }
  return { set, prompt, pin: { ...pin, template: undefined } };
}

export async function judgePublicOfficial(batch, { key, fetchImpl = globalThis.fetch }) {
  const judgements = await Promise.all(batch.map(async packet => {
    const response = await fetchImpl('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', messages: [{ role: 'user', content: packet.publicOfficial.prompt }],
        temperature: 0, max_tokens: 2048, enable_thinking: false }), signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`judge_http_${response.status}`);
    const data = await response.json();
    if (!/^qwen3\.8-max(?:-(?:0902|2026-09-02))?$/.test(data.model ?? '')) throw new Error('judge_model_mismatch');
    const text = data.choices?.[0]?.message?.content ?? '';
    const result = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
    const halu = packet.publicOfficial.set === 'halumem';
    if (halu ? !['Correct', 'Hallucination', 'Omission'].includes(result.evaluation_result)
      : !Number.isInteger(result.score) || result.score < 0 || result.score > 3) throw new Error('judge_public_result_invalid');
    const correct = halu ? result.evaluation_result === 'Correct' : result.score === 3;
    return { id: packet.id, verdict: correct ? 'correct' : 'incorrect', reason: result.reasoning ?? result.reason,
      failureStep: correct ? null : result.evaluation_result === 'Hallucination' ? 'fabricated' : 'other',
      officialResult: result, model: data.model, requestId: response.headers.get('x-request-id') ?? data.id, usage: data.usage };
  }));
  return { judgements };
}
