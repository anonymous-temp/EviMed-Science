/** @typedef {'report'|'matrix'|'document'|'data'|'figure'|'draft'|'work'} ArtifactRole */
export const ARTIFACT_ROLES = Object.freeze(['report', 'matrix', 'document', 'data', 'figure', 'draft', 'work']);

/** Explicit runtime contract roles take precedence; old runs use this one compatibility classifier.
 * Self-contained because the native frame serializes this function. Executables are never reading material.
 * @param {string} path @param {string | null} [declaredRole]
 */
export function artifactPresentation(path, declaredRole = null) {
  const name = String(path ?? '').split('/').pop() ?? '';
  const lower = name.toLowerCase();
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  /** @type {Record<string, [string, 'doc'|'sheet'|'data'|'image'|'file']>} */
  const types = {
    md: ['Markdown', 'doc'], markdown: ['Markdown', 'doc'], txt: ['文本', 'doc'],
    docx: ['Word', 'doc'], doc: ['Word', 'doc'], pdf: ['PDF', 'doc'], pptx: ['PPT', 'doc'], ppt: ['PPT', 'doc'],
    html: ['网页', 'doc'], htm: ['网页', 'doc'], xlsx: ['Excel', 'sheet'], xls: ['Excel', 'sheet'],
    csv: ['CSV', 'sheet'], tsv: ['TSV', 'sheet'], json: ['JSON', 'data'], jsonl: ['JSON', 'data'],
    xml: ['XML', 'data'], ris: ['RIS', 'data'], bib: ['BibTeX', 'data'],
    png: ['图片', 'image'], jpg: ['图片', 'image'], jpeg: ['图片', 'image'], gif: ['图片', 'image'], svg: ['图片', 'image'], webp: ['图片', 'image'],
    zip: ['压缩包', 'file'], gz: ['压缩数据', 'data'],
  };
  const [type, icon] = types[extension] ?? ['文件', 'file'];
  const role = /^(py|r|mjs|cjs|js|ts|sh|bash|exe|bat|ps1)$/.test(extension) || /^revision-notes?\.md$/.test(lower) ? 'work'
    : ['report', 'matrix', 'document', 'data', 'figure', 'draft', 'work'].includes(declaredRole ?? '') ? declaredRole
      : /matrix.*\.json$/.test(lower) ? 'matrix'
        : icon === 'doc' ? (/report/.test(lower) && lower !== 'reporting-checklist.md' ? 'report' : 'document')
          : icon === 'sheet' ? 'data' : icon === 'image' ? 'figure' : 'work';
  const rank = role === 'report' ? 0 : role === 'matrix' ? 1
    : lower === 'delivery-summary.md' ? 5 : role === 'document' ? 2 : role === 'data' ? 3 : role === 'figure' ? 4 : role === 'draft' ? 2 : 6;
  return { name, type, icon, role, rank, readable: role !== 'work' };
}

/** @param {{path: string, role?: string | null}} a @param {{path: string, role?: string | null}} b */
export function compareArtifacts(a, b) {
  return artifactPresentation(a.path, a.role).rank - artifactPresentation(b.path, b.role).rank || (a.path.split('/').pop() ?? '').localeCompare(b.path.split('/').pop() ?? '', 'en') || a.path.localeCompare(b.path, 'en');
}
