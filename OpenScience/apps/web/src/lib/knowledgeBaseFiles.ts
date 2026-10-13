/**
 * What the knowledge base's file picker offers, and what it turns away before anything is sent: every file, and none.
 *
 * Until 2026-10-13 the picker filtered by a closed list of twenty-nine extensions and this module refused the rest
 * with a reason, as the server did. No file is refused for what it is any more: text, code, PDF, Office and images
 * are read and can be searched; a recording, or a file nothing can read text out of, is kept as an original
 * (`SOURCE_ORIGINAL_CODES` in `@evimed/domain`, whose sentences are the registry's). Where each file is read is the
 * server's to decide from its name and its bytes (`sourceReadRoute`), so nothing here reads a name.
 */

/** The picker's filter: none. An empty `accept` leaves the system dialog showing every file. */
export const KNOWLEDGE_BASE_ACCEPT = "";

/** What a person is told about what can be added, where a page says it. */
export const KNOWLEDGE_BASE_UPLOAD_HINT = "任何文件都可以添加；音视频和读不出文字的文件只保存原件。";

/**
 * The files of a selection that go on to be uploaded, and the ones that do not. Nothing is turned away for its
 * format, so every file goes on; the size limit and the project's room are the server's answers, one file at a time.
 */
export function partitionKnowledgeBaseFiles(files: readonly File[]) {
  const accepted: File[] = [...files];
  const refused: { name: string; reason: string }[] = [];
  return { accepted, refused };
}
