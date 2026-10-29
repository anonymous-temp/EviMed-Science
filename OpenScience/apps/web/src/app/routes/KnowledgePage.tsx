import { SourcesPage } from "./SourcesPage";

/**
 * 知识库 — the route. The page is `SourcesPage`: a master-detail page with the account's documents on the left — each saying where it takes
 * effect, and one 「添加」 menu in the header — and the chosen document read on the right (`SourceReader`: its original beside what it
 * says). 知识页, 图谱 and 对话产出 are a project's, and in those views the left column lists the projects.
 *
 * It says what the knowledge base is only when it is empty (「把文献、指南、方案、数据表、网页或笔记放进来……」): the plan of 2026-09-23 (§5.5)
 * removed the definition under the title, and the plan of 2026-10-07 (§2) made it a place for whatever a researcher hands over, not a
 * library of clinical papers.
 */
export { SourcesPage as KnowledgePage };
