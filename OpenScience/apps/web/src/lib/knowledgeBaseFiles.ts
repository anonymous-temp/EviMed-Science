import { KNOWLEDGE_BASE_FORMATS, sourceFormatRoute } from "@evimed/domain";

/**
 * The knowledge base's accepted formats as a researcher reads them: eight
 * families instead of thirty extensions. The families are held equal to the
 * list the upload check itself uses (`KNOWLEDGE_BASE_FORMATS` in
 * `@evimed/domain`, which the server refuses against) by a test, so the copy
 * cannot promise a format the server turns away.
 */
export const KNOWLEDGE_BASE_FORMAT_FAMILIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["PDF", ["pdf"]],
  ["Word", ["doc", "docx", "rtf"]],
  ["PPT", ["ppt", "pptx"]],
  ["Excel 与表格", ["xls", "xlsx", "xlsm", "csv", "tsv"]],
  ["图片", ["jpg", "jpeg", "png", "bmp", "gif"]],
  ["电子书", ["epub", "mobi"]],
  ["网页", ["htm", "html", "xml"]],
  ["纯文本与代码", ["txt", "md", "json", "yaml", "yml", "r", "py", "sql"]],
];
/** The picker's default filter: what the knowledge base accepts. */
export const KNOWLEDGE_BASE_ACCEPT = KNOWLEDGE_BASE_FORMATS.map((format) => `.${format}`).join(",");
export const KNOWLEDGE_BASE_UPLOAD_HINT =
  `支持 ${KNOWLEDGE_BASE_FORMAT_FAMILIES.map(([label]) => label).join("、")}；音视频暂不支持。`;

/**
 * What the knowledge base would refuse, told before anything is sent: a
 * recording is not parsed at all yet, and any other format is outside the
 * list. The server refuses the same files with the same reasons; this only
 * saves the round trip and keeps one refused file from stopping the rest.
 */
export function partitionKnowledgeBaseFiles(files: readonly File[]) {
  const accepted: File[] = [];
  const refused: { name: string; reason: string }[] = [];
  for (const file of files) {
    const route = sourceFormatRoute(file.name);
    if (route === "local" || route === "api") accepted.push(file);
    else refused.push({ name: file.name, reason: route === "media" ? "音视频暂不支持" : "格式不在支持范围内" });
  }
  return { accepted, refused };
}
