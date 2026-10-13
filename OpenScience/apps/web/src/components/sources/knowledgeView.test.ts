import { describe, expect, it } from "vitest";
import type { KnowledgePage, KnowledgeStatus, KnowledgeTreeRow } from "@/lib/sourceClient";
import statusCompiled from "./knowledgeFixtures/status-compiled.json";
import treeMixed from "./knowledgeFixtures/tree-mixed.json";
import pageMine from "./knowledgeFixtures/page-analysis-mine.json";
import pageAbsent from "./knowledgeFixtures/page-concept-absent.json";
import { groupRows, linkPosition, maskEngineAddresses, pageSegments, staleReasons, statusLine, withoutEngineAddresses, withoutLeadingTitle } from "./knowledgeView";

const NOW = new Date("2026-10-13T12:00:00Z");
const status = (patch: Partial<KnowledgeStatus>): KnowledgeStatus => ({ ...(statusCompiled as unknown as KnowledgeStatus), ...patch });

describe("statusLine", () => {
  it("says a compiled project in plain words, with its last round and what it holds", () => {
    const line = statusLine(status({}), NOW)!;
    expect(line.text).toMatch(/^已整理 · 上次整理于 .+ · 13 页，53 个实体$/u);
    expect(line).toMatchObject({ busy: false, canCompile: true, attention: false });
  });

  it("says the stage while a round is under way, and offers nothing to press", () => {
    const wiki = statusLine(status({ state: "compiling", stage: { tree: "wiki", step: "wiki", task: "compile: agent", status: "running", startedAt: "2026-10-13T11:58:00Z" } }), NOW)!;
    expect(wiki.text).toContain("整理中 · 正在整理页面");
    expect(wiki).toMatchObject({ busy: true, canCompile: false });
    const graph = statusLine(status({ state: "compiling", stage: { tree: "kg", step: "kg", task: null, status: null, startedAt: "x" } }), NOW)!;
    expect(graph.text).toContain("正在整理知识图谱");
    expect(statusLine(status({ state: "compiling", stage: { tree: "kg", step: "finish", task: null, status: null, startedAt: "x" } }), NOW)!.text).toContain("正在收尾");
  });

  it("says not enough documents by how many more it takes, and nothing at all for an empty project", () => {
    expect(statusLine(status({ state: "below_threshold", readable: 1, minSources: 3, pages: 0, typedPages: { wiki: 0, kg: 0 } }), NOW)!.text).toBe("资料不足 · 再放入 2 份资料，就会整理成知识页");
    expect(statusLine(status({ state: "below_threshold", readable: 0, pages: 0 }), NOW)).toBeNull();
  });

  it("says the page limit as one sentence with no number in it", () => {
    const line = statusLine(status({ state: "page_limit" }), NOW)!;
    expect(line.text).toMatch(/^页数已到上限，不再整理新的内容/u);
    expect(line.text).not.toMatch(/100|128/u);
    expect(line).toMatchObject({ canCompile: false, attention: true });
  });

  it("says the engine is unavailable without naming it, and keeps the pages readable", () => {
    const line = statusLine(status({ state: "engine_unavailable", engine: { ok: false, code: "engine_down" } }), NOW)!;
    expect(line.text).toBe("知识引擎暂不可用，已有的页面仍可阅读，恢复后会继续整理");
    expect(line.canCompile).toBe(true);
  });

  it("says nothing when compiling is off", () => {
    expect(statusLine(status({ enabled: false }), NOW)).toBeNull();
    expect(statusLine(status({ state: "disabled" }), NOW)).toBeNull();
    expect(statusLine(null, NOW)).toBeNull();
  });
});

describe("groupRows", () => {
  const rows = (treeMixed as unknown as { pages: KnowledgeTreeRow[] }).pages;

  it("groups the pages by type in the reading order and puts the graph's entities last", () => {
    const groups = groupRows(rows);
    expect(groups.map((group) => group.label)).toEqual(["概念", "实体", "方法", "比较", "分析", "目录", "图谱实体"]);
    expect(groups.find((group) => group.label === "图谱实体")!.rows.length).toBeGreaterThan(20);
    expect(groups.flatMap((group) => group.rows).some((row) => row.type === "relations")).toBe(false);
  });

  it("names the graph's own index apart from its entities", () => {
    const index = { ...rows.find((row) => row.tree === "kg")!, type: "index", title: "知识图谱目录", path: "index.md" };
    expect(groupRows([...rows, index]).map((group) => group.label).slice(-2)).toEqual(["图谱实体", "图谱目录"]);
  });

  it("narrows by title without asking again", () => {
    const groups = groupRows(rows, "扫码枪");
    expect(groups.flatMap((group) => group.rows).every((row) => /扫码枪/u.test(row.title + row.path))).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
  });
});

describe("staleReasons", () => {
  it("lists each reason once, a retraction first, and reads an unknown one as a change", () => {
    expect(staleReasons([{ reason: "changed" }, { reason: "retracted" }, { reason: "changed" }])).toEqual(["retracted", "changed"]);
    expect(staleReasons([{ reason: "moved" as "changed" }])).toEqual(["changed"]);
  });
});

describe("pageSegments", () => {
  const mine = pageMine as unknown as KnowledgePage;
  const absent = pageAbsent as unknown as KnowledgePage;

  it("replaces every link the control plane found, and no engine address is left", () => {
    const text = pageSegments(absent).map((segment) => segment.markdown).join("\n");
    expect(text).not.toContain("viking://");
    const addresses = [...text.matchAll(/\]\(#kb-(\d+)\)/gu)].map((match) => Number(match[1]));
    expect(addresses.length).toBe(absent.links.length);
    expect(new Set(addresses).size).toBe(absent.links.length);
  });

  it("keeps the emphasis a link's text was written with", () => {
    const written = "[**要点** 一](viking://x/sources/src_1.md \"q\")";
    const body = `见 ${written} 结束`;
    const page = { body, userBlocks: [], links: [{ kind: "source", text: "要点 一", sourceId: "src_1", title: null, available: true, quote: "q", status: "present", inSourceList: false, index: 2, end: 2 + written.length }] } as unknown as KnowledgePage;
    expect(pageSegments(page)[0]!.markdown).toBe("见 [**要点** 一](#kb-0) 结束");
  });

  it("cuts out the person's own paragraph as a stretch of theirs", () => {
    const segments = pageSegments(mine);
    const theirs = segments.filter((segment) => segment.mine);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.markdown.trim()).toBe(mine.userBlocks[0]!.text.trim());
    expect(segments.filter((segment) => !segment.mine).length).toBeGreaterThanOrEqual(1);
    expect(segments.map((segment) => segment.markdown).join("")).toContain("事实时间线");
  });

  it("leaves a block that is not a whole paragraph in the page's text", () => {
    const page = { body: "# T\n\n- 清单：团队备注在这一行里\n", userBlocks: [{ id: "ub_1", text: "团队备注", heading: "" }], links: [] } as unknown as KnowledgePage;
    expect(pageSegments(page).every((segment) => !segment.mine)).toBe(true);
  });

  it("ignores a link whose offsets are not a Markdown link", () => {
    const page = { body: "plain text with no link", userBlocks: [], links: [{ kind: "external", text: "x", href: "https://x", index: 0, end: 5 }] } as unknown as KnowledgePage;
    expect(pageSegments(page)[0]!.markdown).toBe("plain text with no link");
  });
});

describe("small helpers", () => {
  it("reads a link's place back from its address", () => {
    expect(linkPosition("#kb-12")).toBe(12);
    expect(linkPosition("https://example.org")).toBeNull();
    expect(linkPosition(undefined)).toBeNull();
  });

  it("takes an engine address out of whatever text is left", () => {
    expect(withoutEngineAddresses("a viking://user/u/resources/p/x/sources/src_1.md b")).toBe("a  b");
  });

  it("drops the first heading when it is the title the header already shows", () => {
    expect(withoutLeadingTitle("\n# 盘点差异率\n\n正文", "盘点差异率")).toBe("\n正文");
    expect(withoutLeadingTitle("# 另一个\n正文", "盘点差异率")).toBe("# 另一个\n正文");
  });
});

describe("maskEngineAddresses", () => {
  const mine = pageMine as unknown as KnowledgePage;

  it("shows a page's links to documents without the engine's directory, and puts it back on save", () => {
    const { text, restore } = maskEngineAddresses(mine.markdown);
    expect(text).not.toContain("viking://");
    expect(text).toMatch(/\]\(sources\/src_[a-f0-9]{32}\.md "/u);
    expect(restore(text)).toBe(mine.markdown);
    // What the person wrote is kept, and a link they add to a document goes back with the directory too.
    expect(restore(`${text}\n更多见 [另一份](sources/src_${"0".repeat(32)}.md)。`)).toContain("viking://user/");
  });

  it("leaves a page alone whose links name more than one engine directory", () => {
    const text = "[a](viking://user/u/resources/p/one/sources/src_1.md) [b](viking://user/u/resources/p/two/sources/src_2.md)";
    const masked = maskEngineAddresses(text);
    expect(masked.text).toBe(text);
    expect(masked.restore("x")).toBe("x");
  });
});
