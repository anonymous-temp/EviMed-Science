/** Study and project names share a one-line, 40 Unicode character limit. */
export const VCR_STUDY_NAME_MAX = 40;
export const normalizeVcrStudyName = (value: string): string => value.replace(/\s+/gu, " ").trim();
export const vcrStudyNameError = (value: string): string | undefined => [...normalizeVcrStudyName(value)].length > VCR_STUDY_NAME_MAX ? "研究名称最多 40 个字符，请缩短后继续；当前名称已保留。" : undefined;
