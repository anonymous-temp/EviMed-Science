import { FRONTIER_SPECIALTY_LABELS_ZH } from '@evimed/domain';
import { inputDigest } from './memoryHumanSegments.mjs';

/** Only an independent first-person declaration supplies a candidate. The
 * topic is released only if the complete object is a public vocabulary term. */
function declaredTopic(text) {
  if (typeof text !== 'string' || text.length > 180) return null;
  const match = /^(?:我的研究兴趣是|我(?:长期)?关注)([^，。；：！？\n]{1,80}?)[。！]?$/u.exec(text)
    ?? /^我对([^，。；：！？\n]{1,80})感兴趣[。！]?$/u.exec(text)
    ?? /^(?:my research interest is|i am interested in|i follow) ([\w -]{2,80})\.?$/iu.exec(text);
  return match?.[1]?.trim() || null;
}

export async function frontierSourcedInterests({ userId, files, ownedLines, vocabulary, pausedProjects = [] }) {
  const eligible = files.filter(file => file.type === 'notes' && !file.sensitive && !file.namespaceId
    && (!file.projectId || file.projectId === 'default') && !pausedProjects.includes(file.projectId ?? 'default'));
  const lines = await ownedLines(userId, eligible, declaredTopic);
  const seen = new Set(), phrases = [];
  for (const line of lines.slice(0, 24)) {
    const topic = declaredTopic(line.quote);
    if (!topic || (line.projectId && line.projectId !== 'default')) continue;
    let label = Object.entries(FRONTIER_SPECIALTY_LABELS_ZH).find(([key, name]) => key === topic || name === topic)?.[1];
    if (!label && vocabulary) {
      const keys = (await vocabulary.keysForText({ texts:[topic] })).filter(key => /^(drug|disease):/.test(key));
      const named = keys.length ? await vocabulary.describe(keys) : [];
      label = named.find(item => item.label === topic || item.key.split(':')[1]?.replaceAll('-', ' ') === topic.toLowerCase())?.label;
    }
    if (!label || seen.has(label)) continue;
    seen.add(label);
    phrases.push({ text: label, kind: 'interest', source: 'memory', memoryId: 'interest:' + inputDigest(JSON.stringify([line.source.id,line.source.contentDigest,line.quote])) });
    if (phrases.length >= 6) break;
  }
  return phrases;
}
