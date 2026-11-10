/** Closed product wording for scientific prediction limitations. */
export const VCR_PREDICTION_LIMIT_LABELS_ZH = Object.freeze({
  transportability_not_established: '模型在目标人群中的可迁移性和校准尚未建立。',
  calibration_measured_locally: '校准是用这张表里观察到的结局算的；换一个人群，可迁移性仍未建立。',
  predictions_not_observed_controls: '预测值不能视为已观察到的对照结局，也不增加独立样本量。',
  trained_on_own_data: '这个方程是用你自己的历史数据训练的，没有在别的人群验证过。',
  unknown: '另有适用范围或方法局限需要核对，请查看保留的来源说明。',
});
const LEGACY = new Map([
  ['Transportability and calibration in this target population have not been established.', 'transportability_not_established'],
  ['Calibration was measured on the observed outcomes of this table; transportability to any other population has not been established.', 'calibration_measured_locally'],
  ['Predictions are not observed control outcomes or an independent increase in sample size.', 'predictions_not_observed_controls'],
]);
/** Preserve unfamiliar source wording beside a closed, localized state. @param {unknown} input */
export function vcrPredictionLimit(input) {
  const source = typeof input === 'string' ? input : '';
  const code = Object.hasOwn(VCR_PREDICTION_LIMIT_LABELS_ZH, source) ? source : LEGACY.get(source) ?? 'unknown';
  return { code, ...(code === 'unknown' && source ? { source: source.slice(0, 2000) } : {}) };
}
