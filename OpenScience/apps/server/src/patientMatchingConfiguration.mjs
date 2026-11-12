/** Matching owns its provider profile; memory and platform-wide model choices do not select it. */
import { PINNED } from './pinnedVersions.mjs';

/** @param {Record<string, any>} [overrides] @param {Record<string, string | undefined>} [environment] */
export function patientMatchingConfiguration(overrides = {}, environment = process.env) {
  const defaults = PINNED.patientMatching.modelProfile;
  const reasoningModel = String(overrides.vcrMatchModel ?? (environment.OPEN_SCIENCE_VCR_MATCH_MODEL?.trim() || defaults.reasoningModel));
  if (reasoningModel !== 'deepseek-flash') {
    throw Object.assign(new Error('Patient matching requires DeepSeek V4.1 Flash.'), { code: 'patient_matching_flash_required' });
  }
  return Object.freeze({
    revision: defaults.revision,
    reasoningModel,
    embeddingModel: String(overrides.vcrMatchEmbeddingModel ?? (environment.OPEN_SCIENCE_VCR_MATCH_EMBEDDING_MODEL?.trim() || defaults.embeddingModel)),
    embeddingApiBase: String(overrides.vcrMatchEmbeddingApiBase ?? (environment.OPEN_SCIENCE_VCR_MATCH_EMBEDDING_API_BASE?.trim() || defaults.embeddingApiBase)),
    embeddingDimensions: defaults.embeddingDimensions,
    rerankModel: String(overrides.vcrMatchRerankModel ?? (environment.OPEN_SCIENCE_VCR_MATCH_RERANK_MODEL?.trim() || defaults.rerankModel)),
    rerankApiBase: String(overrides.vcrMatchRerankApiBase ?? (environment.OPEN_SCIENCE_VCR_MATCH_RERANK_API_BASE?.trim() || defaults.rerankApiBase)),
    triageModel: defaults.triageModel,
    proEscalation: false,
  });
}
