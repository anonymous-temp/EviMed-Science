import { callModelForControlPlane } from './modelGateway.mjs';
import { contentHash, lineFingerprint, memoryLines } from './nativeMemoryOverlay.mjs';

/** Only profile statements and preference-file lines can be two versions of one choice. */
export function preferenceCandidates(records) {
  const profile = records.filter(record => record.nativeType === 'profile' && record.scope === 'user' && record.document);
  const preferences = [];
  records.filter(record => record.nativeType === 'preferences' && record.scope === 'user').forEach((record, recordIndex) => {
    for (const text of memoryLines(record.value)) preferences.push({ recordIndex, text, record });
  });
  return { profile, preferences };
}

/** Parse only offered index pairs with confident semantic agreement; everything else is dropped. */
export function parsePreferenceOverlaps(content, profileCount, preferenceCount) {
  let value;
  try { value = JSON.parse(String(content ?? '')); } catch { return []; }
  if (!value || typeof value !== 'object' || !Array.isArray(value.overlaps)) return [];
  const seen = new Set(), pairs = [];
  for (const pair of value.overlaps) {
    if (!Number.isInteger(pair?.profile) || !Number.isInteger(pair?.preference)
      || pair.profile < 0 || pair.profile >= profileCount || pair.preference < 0 || pair.preference >= preferenceCount
      || typeof pair.confidence !== 'number' || pair.confidence < 0.9 || pair.confidence > 1) continue;
    const key = `${pair.profile}:${pair.preference}`;
    if (!seen.has(key)) { seen.add(key); pairs.push({ profile: pair.profile, preference: pair.preference }); }
  }
  return pairs;
}

/** The newer file revision is current; the older value stays visible as history. Equal times are unknown, not an arbitrary winner. */
export function markPreferenceOverlaps(records, pairs) {
  const { profile, preferences } = preferenceCandidates(records);
  const earlier = new Map();
  for (const pair of pairs) {
    const left = profile[pair.profile], right = preferences[pair.preference];
    if (!left || !right) continue;
    const leftAt = String(left.updatedAt ?? left.createdAt ?? ''), rightAt = String(right.record.updatedAt ?? right.record.createdAt ?? '');
    if (!leftAt || !rightAt || leftAt === rightAt) continue;
    const old = leftAt < rightAt ? { record: left, text: left.value } : { record: right.record, text: right.text };
    const currentId = leftAt < rightAt ? right.record.id : left.id;
    const key = `${old.record.id}\0${lineFingerprint(old.text)}`;
    earlier.set(key, { record: old.record, text: old.text, currentId });
  }
  return records.map(record => {
    const selected = [...earlier.values()].filter(item => item.record.id === record.id);
    if (!selected.length) return record;
    return { ...record, earlierValues: selected.map(item => item.text),
      currentPreferenceId: selected.length === 1 ? selected[0].currentId : undefined };
  });
}

/** One bounded semantic judgement for a changed/read set, never a keyword rule over open prose. */
export function createPreferenceJudge({ config, usageLedger = null, fetchImpl = globalThis.fetch, now = () => new Date(), callModel = callModelForControlPlane }) {
  const model = String(config.memoryExtractionModel || config.deepseekModel || '');
  const timeoutMs = Math.max(1_000, Math.min(120_000, Number(config.memoryExtractionTimeoutMs ?? 30_000)));
  const dailyCalls = Math.max(0, Math.trunc(Number(config.memoryPreferenceJudgeDailyCalls ?? 20)));
  const spent = new Map();
  return {
    get available() {
      return config.memoryPreferenceReconcileEnabled === true && Boolean(model)
        && Boolean(config.deepseekProviderEnabled !== false && config.deepseekApiKey);
    },
    async overlaps({ userId, profile, preferences }) {
      if (!this.available || !profile.length || !preferences.length || profile.length > 20 || preferences.length > 40) return [];
      const day = now().toISOString().slice(0, 10), held = spent.get(userId);
      if (held?.day === day && held.calls >= dailyCalls) return [];
      spent.set(userId, { day, calls: (held?.day === day ? held.calls : 0) + 1 });
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const answer = await callModel({ config, usageLedger, fetchImpl }, {
          userId, projectId: 'default', purpose: 'memory-extraction', signal: controller.signal,
          body: {
            model, thinking: { type: 'disabled' }, temperature: 0, max_tokens: 800, response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: 'Compare personal-memory statements. A pair overlaps only when both describe alternative values of the same preference or standing choice for the same scope, even if the values differ. Merely related facts, different scopes, a biographical fact beside a preference, or compatible independent choices do not overlap. Return JSON only: {"overlaps":[{"profile":<index>,"preference":<index>,"confidence":<0..1>}]}. Include no pair below 0.9.' },
              { role: 'user', content: JSON.stringify({ profile: profile.map((text, index) => ({ index, text })), preferences: preferences.map((text, index) => ({ index, text })) }) },
            ],
          },
        });
        return parsePreferenceOverlaps(answer?.choices?.[0]?.message?.content, profile.length, preferences.length);
      } catch { return []; } finally { clearTimeout(timeout); }
    },
  };
}

/** Cache identity of exactly the text and revision times the judgement saw. */
export function preferenceJudgementKey(records) {
  const { profile, preferences } = preferenceCandidates(records);
  return contentHash(JSON.stringify({
    profile: profile.map(record => [record.id, record.value, record.updatedAt, record.createdAt]),
    preferences: preferences.map(row => [row.record.id, row.text, row.record.updatedAt, row.record.createdAt]),
  }));
}
