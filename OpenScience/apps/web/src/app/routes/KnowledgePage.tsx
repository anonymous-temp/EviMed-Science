import { SourcesPage } from "./SourcesPage";

/**
 * 知识库 — the route. The page is `SourcesPage`: the title with the scope it lists, a search and one 「添加」
 * menu in the header, one row of chips by what a document is, and one list of documents under it; a row opens a
 * drawer with the document's content and its original.
 *
 * It says what the knowledge base is only when it is empty (「把文献、指南、方案、数据表、网页或笔记放进来……」):
 * the plan of 2026-09-23 (§5.5) removed the definition under the title, and the plan of 2026-10-07 (§2) made it a
 * place for whatever a researcher hands over, not a library of clinical papers.
 */
export function KnowledgePage() {
  return <SourcesPage />;
}
