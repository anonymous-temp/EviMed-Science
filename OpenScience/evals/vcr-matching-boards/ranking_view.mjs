/** The trial texts the matching plugin ranks and indexes, built from a collection document (TrialGPT 2.0 JSON or TREC XML ingest). */
import { patientMatchingRankingDocument, TRIAL_RECORD_VIEW } from '../../apps/server/src/patientMatchingRankingText.mjs';

const items = value => (value ? String(value).split(/;\s*|\n+/).map(part => part.trim()).filter(Boolean) : []);

/** The plugin's ranking record from a collection document. */
export function rankingRecord(doc) {
  return {
    title: doc.title, conditions: items(doc.condition), interventions: items(doc.interventions),
    sex: doc.gender, minimumAge: doc.minimum_age, maximumAge: doc.maximum_age, summary: doc.summary, eligibility: doc.eligibility,
  };
}

/** The uncut trial text in the fit stage's field order (jev_arm.trial_text), bounded at 12,000 characters. */
export function fullText(doc) {
  const takes = [doc.gender && `sex ${doc.gender}`, doc.minimum_age && `minimum age ${doc.minimum_age}`, doc.maximum_age && `maximum age ${doc.maximum_age}`].filter(Boolean).join('; ');
  const lines = [`Title: ${doc.title ?? ''}`, `Target conditions: ${doc.condition ?? ''}`];
  if (doc.interventions) lines.push(`Interventions: ${doc.interventions}`);
  lines.push(`Brief summary: ${doc.summary ?? ''}`);
  if (takes) lines.push(`The registry says the trial takes: ${takes}`);
  lines.push(`Eligibility Criteria (raw):\n${doc.eligibility || 'the registry record carries none'}`);
  return lines.join('\n').slice(0, 12000);
}

/** `balanced` is the plugin's bounded view (patientMatchingRankingDocument); `full` the uncut record. */
/** `trial-record` is the production view `trial-record-12k-v1` itself (patientMatchingRankingDocument), byte for byte. */
export const viewText = (view, doc) => (view === 'full' ? fullText(doc) : view === 'trial-record' ? patientMatchingRankingDocument(rankingRecord(doc), TRIAL_RECORD_VIEW).text : patientMatchingRankingDocument(rankingRecord(doc)).text);
