/** Shared, model-independent document conversion vocabulary. */
export const DOCUMENT_EXPORT_VERSION = 1;
export const DOCUMENT_RENDERER_VERSION = 'pandoc-chromium-v1';
export const DOCUMENT_EXPORT_FORMATS = Object.freeze(['docx', 'pdf', 'html']);
export const DOCUMENT_EXPORT_MIME = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf', html: 'text/html; charset=utf-8',
});
/** @param {unknown} value @returns {string[]} */
export function documentExportFormats(value) {
  if (!Array.isArray(value) || !value.length || value.length > 3 || value.some(x => !DOCUMENT_EXPORT_FORMATS.includes(x))) {
    throw new TypeError('Choose docx, pdf or html.');
  }
  return DOCUMENT_EXPORT_FORMATS.filter(x => value.includes(x));
}
/** Stable JSON for cross-process input identity; bytes are hashed on the server. @param {any} value @returns {string} */
export function documentExportDigest(value) {
  if (Array.isArray(value)) return `[${value.map(documentExportDigest).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${documentExportDigest(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Conversion errors describe this file operation, never a verdict on research. */
export const DOCUMENT_EXPORT_ERROR_MESSAGES = Object.freeze({
  document_export_unavailable: '当前无法访问或导出这份文稿。',
  document_export_request_invalid: '导出请求无效，请重新选择文稿和格式。',
  document_export_format_invalid: '请选择 Word、PDF 或 HTML 格式。',
  document_format_unsupported: '请从 Markdown 或纯文本文稿导出。',
  document_export_too_large: '这个格式的文件超出导出大小限制，其他已完成格式仍可下载。',
  document_source_changed: '文稿已有变化，请从当前文稿重新导出。',
  document_source_pending: '研究报告仍在准备，完成后即可导出。',
  document_export_quota: '导出文件存储已满，暂时无法创建更多副本。',
  document_export_capacity: '磁盘空间暂时不足，请稍后再导出。',
  document_export_changed: '导出状态已变化，请刷新后重试。',
  document_export_retry_invalid: '只有未完成的格式需要重试，请刷新查看文件。',
  document_export_attempts_exhausted: '这个文稿的格式转换多次未完成，请检查原文稿后重新导出。',
  document_export_canceled: '文件导出已取消，原报告仍保留。',
  document_export_hash_mismatch: '文件校验未通过，未提供这份副本。',
  document_input_changed: '导出输入的校验未通过，未继续转换。',
  document_input_invalid: '导出输入不符合格式要求。',
  document_output_invalid: '这个格式的文件校验未通过，其他已核验格式仍可下载。',
  document_output_not_empty: '导出目录状态异常，请重新导出。',
  document_renderer_changed: '导出工具已更新，请重新生成文件。',
  document_render_reference_invalid: '导出请求无效，请重新选择文稿。',
  document_render_inventory_failed: '暂时无法确认导出工具状态，请稍后再试。',
  document_render_state_unknown: '尚未确认上次导出已经停止，正在等待恢复。',
  document_render_stop_unconfirmed: '尚未确认上次导出已经停止，正在等待恢复。',
  document_render_cancel_failed: '尚未确认导出取消，请稍后查看状态。',
  document_render_start_failed: '文件转换未能启动，请稍后重试。',
  document_render_busy: '其他文件正在转换，请稍候。',
  document_render_capacity: '文件转换正在等待可用内存。',
  document_render_timeout: '文件转换超时，已完成的格式仍保留。',
  document_render_canceled: '文件转换已停止，已完成的格式仍保留。',
  document_render_failed: '这个格式未能完成，可单独重试；其他格式仍保留。',
  document_html_render_failed: '网页格式未能生成，已完成的 Word 文件仍保留。',
  document_export_worker_failed: '文件导出暂时未完成，请稍后查看状态。',
});
