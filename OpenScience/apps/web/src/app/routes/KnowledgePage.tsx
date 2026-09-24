import { SourcesPage } from "./SourcesPage";

/**
 * 知识库 — the route. The page is `SourcesPage`: the title with search, 连接网盘
 * and 上传 beside it, and one list of documents under it.
 *
 * It used to add a definition under the title (「你放进来的资料：文献、方案、
 * 数据……」) and a boxed line about what was still being processed; the plan
 * of 2026-09-23 (§5.5) removed both — each row carries its own state, and only
 * when something went wrong.
 */
export function KnowledgePage() {
  return <SourcesPage />;
}
