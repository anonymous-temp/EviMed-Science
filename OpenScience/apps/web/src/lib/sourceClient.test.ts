import { beforeEach, describe, expect, it, vi } from "vitest";
import { addSourceLink, addSourceNote, getSourceNote, listSources, refetchSource, saveSourceNote, saveToKnowledgeBase, getSourceUnderstanding, listSourceUnderstandingHistory } from "./sourceClient";

const request = vi.hoisted(() => vi.fn());
const command = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));
vi.mock("./apiClient", async (importOriginal) => ({ ...(await importOriginal<object>()), invokeCommand: command }));

describe("source understanding client", () => {
  beforeEach(() => { request.mockReset(); });

  it("uses the authenticated detail route with an encoded source id", async () => {
    const result = { sourceId: "source/one", current: null };
    request.mockResolvedValue(result);
    expect(await getSourceUnderstanding("source/one")).toBe(result);
    expect(request).toHaveBeenCalledWith("/sources/source%2Fone/understanding");
  });

  it("requests bounded history pages and preserves opaque cursor values", async () => {
    request.mockResolvedValue({ items: [], nextCursor: null });
    await listSourceUnderstandingHistory("source-one");
    expect(request).toHaveBeenLastCalledWith("/sources/source-one/understanding/history?limit=20");
    await listSourceUnderstandingHistory("source-one", "next+/=&");
    expect(request).toHaveBeenLastCalledWith("/sources/source-one/understanding/history?limit=20&cursor=next%2B%2F%3D%26");
  });
});

describe("the knowledge base's list", () => {
  beforeEach(() => { request.mockReset(); });

  it("asks for a project's documents as it always did, and for a page, a chip and a search when it is told to", async () => {
    request.mockResolvedValue({ items: [], nextCursor: null, counts: {} });
    await listSources("project-one");
    expect(request).toHaveBeenLastCalledWith("/sources?projectId=project-one");
    await listSources({ kind: "project", projectId: "project-one" }, { state: "ready", limit: 100 });
    expect(request).toHaveBeenLastCalledWith("/sources?projectId=project-one&state=ready&limit=100");
    await listSources("project-one", { kind: "literature", q: "  幽门螺杆菌 ", cursor: "next+/=", limit: 50 });
    expect(request).toHaveBeenLastCalledWith("/sources?projectId=project-one&kind=literature&q=%E5%B9%BD%E9%97%A8%E8%9E%BA%E6%9D%86%E8%8F%8C&cursor=next%2B%2F%3D&limit=50");
    // Reading state or the pipeline's word, never both; and a blank search is no search.
    await listSources("project-one", { status: "failed", q: "   " });
    expect(request).toHaveBeenLastCalledWith("/sources?projectId=project-one&status=failed");
  });

  it("lists the shared documents without naming a project", async () => {
    request.mockResolvedValue({ items: [], nextCursor: null, counts: {} });
    await listSources({ kind: "shared" }, { kind: "table" });
    expect(request).toHaveBeenLastCalledWith("/sources?scope=shared&kind=table");
  });
});

describe("adding a page or a note, and editing one", () => {
  beforeEach(() => { request.mockReset(); command.mockReset(); });

  it("posts the address and the note to their routes, in the project that was asked for", async () => {
    request.mockResolvedValue({});
    await addSourceLink("project-one", "https://www.nmpa.gov.cn/notice");
    expect(request).toHaveBeenLastCalledWith("/sources/links", "POST", { projectId: "project-one", url: "https://www.nmpa.gov.cn/notice" });
    await addSourceNote("project-one", { title: "组会记录", body: "确定分组。" });
    expect(request).toHaveBeenLastCalledWith("/sources/notes", "POST", { projectId: "project-one", title: "组会记录", body: "确定分组。" });
  });

  it("opens a note, saves its next version and reads a saved page again by the document's own id", async () => {
    request.mockResolvedValue({});
    await getSourceNote("src/note");
    expect(request).toHaveBeenLastCalledWith("/sources/src%2Fnote/note");
    await saveSourceNote("src_note", { title: "组会记录", body: "新的正文" });
    expect(request).toHaveBeenLastCalledWith("/sources/src_note/note", "PUT", { title: "组会记录", body: "新的正文" });
    await refetchSource("src_link");
    expect(request).toHaveBeenLastCalledWith("/sources/src_link/refetch", "POST", {});
  });

  it("saves a conversation's file by its path, and names no destination", async () => {
    command.mockResolvedValue({ path: "knowledge-base/chat/a-1a2b3c4d.md", duplicate: false, sourceId: "src_a" });
    expect(await saveToKnowledgeBase("report/评价报告.md")).toEqual({ path: "knowledge-base/chat/a-1a2b3c4d.md", duplicate: false, sourceId: "src_a" });
    expect(command).toHaveBeenCalledWith("save_to_knowledge_base", { path: "report/评价报告.md" });
  });
});
