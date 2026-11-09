#!/usr/bin/env node
// One Kimi call writes the English sentence templates for the brand/generic probe. Kimi sees no drug pair and no gold.
// Code rejects any template without exactly one {drug} slot. Usage: SYNTH_MIN_FREE_MB=1200 node brand_generic_templates.mjs OUT.json
import { writeFileSync } from 'node:fs';
import { callKimi } from '../../synthetic/kimi.mjs';

export const slots = template => (template.match(/\{drug\}/g) ?? []).length;
export const braceFree = template => !/[{}]/.test(template.replaceAll('{drug}', ''));
const prompt = `You write sentence templates for a memory test of a health assistant. Reply with ONE JSON object and nothing else:
{"statements": [20 strings], "questions": [20 strings]}
Rules:
- Every string is natural English and contains the placeholder {drug} exactly once, spelled exactly {drug}, and no other braces.
- "statements" are things a person says to an assistant to tell it they take a medicine ("I take {drug}"): vary the phrasing, tone, length (5 to 25 words), context (morning routine, a doctor visit, travel, a pharmacy refill, a side remark inside another topic), person (I, my mother takes it is NOT allowed: the speaker takes it themselves) and register (casual, formal, hurried).
- "questions" are things the same person asks the assistant LATER, in a separate conversation, in which the medicine is named with {drug}: about timing, interactions with food or alcohol, a missed dose, travel, storage, or what to tell a new doctor. Each must be answerable in a few sentences and must not state anything about whether the person takes it.
- Do not use any real drug name anywhere. Do not mention dosage numbers.
- No two strings may start with the same three words.`;

if (process.argv[1] === new URL(import.meta.url).pathname) {
  process.env.SYNTH_MIN_FREE_MB ||= '1200';
  const result = await callKimi(prompt, { timeoutMs: 10 * 60_000 });
  if (!result.ok) { console.error(result.error); process.exit(1); }
  const keep = list => (Array.isArray(list) ? list : []).filter(t => typeof t === 'string' && slots(t) === 1 && braceFree(t));
  const out = { generator: 'kimi-code/k3.1-pro', promptSha256: (await import('node:crypto')).createHash('sha256').update(prompt).digest('hex'),
    statements: keep(result.value.statements), questions: keep(result.value.questions),
    rejected: { statements: (result.value.statements ?? []).length - keep(result.value.statements).length, questions: (result.value.questions ?? []).length - keep(result.value.questions).length } };
  writeFileSync(process.argv[2], `${JSON.stringify(out, null, 2)}\n`);
  console.log(out.statements.length, out.questions.length, out.rejected);
}
