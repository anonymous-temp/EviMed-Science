/** Closed product wording for scientific prediction limitations. */
export const VCR_PREDICTION_LIMIT_LABELS_ZH = Object.freeze({
  transportability_not_established: '模型在目标人群中的可迁移性和校准尚未建立。',
  predictions_not_observed_controls: '预测值不能视为已观察到的对照结局，也不增加独立样本量。',
  unknown: '另有适用范围或方法局限需要核对，请查看保留的来源说明。',
});
const LEGACY = new Map([
  ['Transportability and calibration in this target population have not been established.', 'transportability_not_established'],
  ['Predictions are not observed control outcomes or an independent increase in sample size.', 'predictions_not_observed_controls'],
]);
/** Preserve unfamiliar source wording beside a closed, localized state. @param {unknown} input */
export function vcrPredictionLimit(input) {
  const source = typeof input === 'string' ? input : '';
  const code = Object.hasOwn(VCR_PREDICTION_LIMIT_LABELS_ZH, source) ? source : LEGACY.get(source) ?? 'unknown';
  return { code, ...(code === 'unknown' && source ? { source: source.slice(0, 2000) } : {}) };
}
