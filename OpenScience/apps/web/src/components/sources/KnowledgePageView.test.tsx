import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { KnowledgePage, KnowledgeStatus, SourceRecord } from "@/lib/sourceClient";
import pageMine from "./knowledgeFixtures/page-analysis-mine.json";
import pageAbsent from "./knowledgeFixtures/page-concept-absent.json";
import statusCompiled from "./knowledgeFixtures/status-compiled.json";
import { KnowledgePageView } from "./KnowledgePageView";

const mocks = vi.hoisted(() => ({ page: vi.fn(), pageAt: vi.fn(), status: vi.fn(), locate: vi.fn(), compile: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/sourceClient", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getKnowledgePage: mocks.page, getKnowledgePageAt: mocks.pageAt, getKnowledgeStatus: mocks.status, locateSourceQuote: mocks.locate,
  requestKnowledgeCompile: mocks.compile, saveKnowledgePage: mocks.save,
}));

const mine = pageMine as unknown as KnowledgePage;
const absent = pageAbsent as unknown as KnowledgePage;
const sourceFor = (page: KnowledgePage) => ({ id: page.sourceId, projectId: "p1", payload: { paths: [`knowledge-base/wiki/${page.path}`] }, display: { origin: "wiki", kind: "wiki", title: page.title } }) as unknown as SourceRecord;

function Where() { const location = useLocation(); return <p data-testid="where">{location.pathname}{location.search}</p>; }
function renderView(page: KnowledgePage, onPage?: (page: KnowledgePage) => void) {
  return render(
    <MemoryRouter initialEntries={[`/app/files/${page.sourceId}?scope=p1&kind=wiki`]}>
      <Routes><Route path="*" element={<><KnowledgePageView source={sourceFor(page)} onPage={onPage} /><Where /></>} /></Routes>
    </MemoryRouter>,
  );
}

describe("KnowledgePageView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.page.mockImplementation(async (id: string) => (id === absent.sourceId ? absent : mine));
    mocks.status.mockResolvedValue(statusCompiled as unknown as KnowledgeStatus);
  });
  afterEach(() => vi.restoreAllMocks());

  it("scrolls in a region a keyboard can reach and a screen reader can name — the page's own title", async () => {
    renderView(mine);
    await screen.findByRole("heading", { name: "事实时间线" });
    const region = screen.getByRole("region", { name: mine.title });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.className).toContain("overflow-y-auto");
    expect(region).toHaveAttribute("data-knowledge-page");
  });

  it("gives a page of four sections or more its contents, and a short one none", async () => {
    const long = { ...mine, body: ["第一节", "第二节", "第三节", "第四节", "第五节"].map((name) => `## ${name}\n\n${name}的内容。\n`).join("\n"), links: [], userBlocks: [], quotations: null, stale: [] } as unknown as KnowledgePage;
    mocks.page.mockResolvedValue(long);
    const view = renderView(long);
    await screen.findByRole("heading", { name: "第三节" });
    await waitFor(() => expect(document.querySelector("[data-outline]")).not.toBeNull());
    const contents = within(document.querySelector("[data-outline]") as HTMLElement);
    expect(contents.getAllByRole("button").map((button) => button.textContent)).toEqual(expect.arrayContaining(["第一节", "第五节"]));
    view.unmount();
    const short = { ...mine, body: "## 只有一节\n\n内容。\n", links: [], userBlocks: [], quotations: null, stale: [] } as unknown as KnowledgePage;
    mocks.page.mockResolvedValue(short);
    renderView(short);
    await screen.findByRole("heading", { name: "只有一节" });
    expect(document.querySelector("[data-outline]")).toBeNull();
  });

  it("draws the page as a document — headings, a table, the person's own paragraph as theirs — and shows no engine address", async () => {
    renderView(mine);
    expect(await screen.findByRole("heading", { name: "事实时间线" })).toBeInTheDocument();
    expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
    const theirs = document.querySelector("[data-knowledge-mine]") as HTMLElement;
    expect(within(theirs).getByText("我的补充")).toBeInTheDocument();
    expect(theirs.textContent).toContain("试点三家门店以 4 月 8 日例会结论为准");
    expect(document.body.textContent).not.toContain("viking://");
    expect(document.body.innerHTML).not.toContain("viking://");
    // The title is the header's; the page does not say it twice.
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("leads to the pages it names and writes a page that is not there yet as plain text", async () => {
    const lacking = { ...mine, links: mine.links.map((link) => (link.kind === "page" && link.text.startsWith("栖木") ? { ...link, exists: false, sourceId: null } : link)) } as KnowledgePage;
    mocks.page.mockResolvedValue(lacking);
    renderView(lacking);
    const link = await screen.findByRole("link", { name: "离线优先盘点与冲突合并" });
    expect(link).toHaveAttribute("href", expect.stringMatching(/^\/app\/files\/src_[a-f0-9]{32}\?scope=p1&kind=wiki$/));
    expect(screen.queryByRole("link", { name: "栖木软件工作室（乙方）" })).toBeNull();
    expect(screen.getAllByText("栖木软件工作室（乙方）").length).toBeGreaterThan(0);
  });

  it("marks a quotation the platform found with a ✓ and one it did not find with a ⚠ that says which sentence", async () => {
    renderView(absent);
    await screen.findAllByRole("img", { name: "原文里找到了这句引文" });
    expect(screen.getAllByRole("img", { name: "原文里找到了这句引文" })).toHaveLength(8);
    const warning = screen.getByRole("button", { name: /没能在原文里核对到这句引文/ });
    const lost = absent.links.find((link) => link.kind === "source" && link.status === "absent");
    expect(lost && lost.kind === "source" ? lost.quote : "").toBeTruthy();
    expect(warning).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(warning);
    expect(warning).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("note")).toHaveTextContent(`“${lost && lost.kind === "source" ? lost.quote : ""}”`);
  });

  it("labels the historical source version and check time independently of present availability", async () => {
    mocks.page.mockResolvedValue({ ...absent, links: absent.links.map((link) => link.kind === "source" ? { ...link, checkedAt: "2026-10-20T10:00:00Z", sourceVersion: 3, available: false } : link) });
    renderView(absent);
    expect((await screen.findAllByText(/曾核对于.*来源第 3 版，当前不可读取/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("img", { name: "原文里找到了这句引文" })).toBeNull();
  });

  it("opens the document at the quotation", async () => {
    mocks.locate.mockResolvedValueOnce({ status: "verified", start: 12, end: 20, page: 3, textSha256: "d".repeat(64) });
    renderView(absent);
    const present = absent.links.find((link) => link.kind === "source" && link.status === "present" && link.quote);
    if (!present || present.kind !== "source") throw new Error("fixture");
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: present.text }))[0]!);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toMatch(/^\/app\/files\/src_[a-f0-9]{32}\?tab=original&start=12&end=20&sha=d{64}&page=3&scope=p1&kind=wiki$/));
    expect(mocks.locate).toHaveBeenCalledWith(present.sourceId, present.quote);
  });

  it("opens the document alone when the quotation can no longer be found", async () => {
    mocks.locate.mockResolvedValueOnce({ status: "quote_not_found", start: null, end: null, page: null, textSha256: null });
    renderView(absent);
    const present = absent.links.find((link) => link.kind === "source" && link.status === "present" && link.quote);
    if (!present || present.kind !== "source") throw new Error("fixture");
    await userEvent.setup().click((await screen.findAllByRole("button", { name: present.text }))[0]!);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toMatch(/^\/app\/files\/src_[a-f0-9]{32}\?tab=original&scope=p1&kind=wiki$/));
  });

  it("says a changed document at the top and offers a quiet 重新整理", async () => {
    mocks.compile.mockResolvedValue({ ...statusCompiled, state: "compiling" });
    renderView(absent);
    const notice = await screen.findByText("来源已更改");
    expect(within(notice.closest("[data-knowledge-stale]") as HTMLElement).getByRole("link")).toHaveAttribute("href", expect.stringMatching(/^\/app\/files\/src_/));
    await userEvent.setup().click(await screen.findByRole("button", { name: "重新整理" }));
    expect(mocks.compile).toHaveBeenCalledWith("p1");
  });

  it("tells the person when their own paragraphs were put back after a compile dropped them", async () => {
    mocks.page.mockResolvedValue({ ...mine, restored: { at: "2026-10-13T04:29:00Z", count: 2, round: 3 } });
    renderView(mine);
    // The count is its own figure inside the sentence (a `Note`), so the sentence is read off the note and not off one text node.
    await waitFor(() => expect(document.querySelector("[data-note]")?.textContent).toMatch(/丢掉了你写的 2 处补充，已经放回原处/));
  });

  it("reports the page it read, with the documents it cites, for a conversation to take along", async () => {
    const onPage = vi.fn();
    renderView(mine, onPage);
    await screen.findByRole("heading", { name: "事实时间线" });
    expect(onPage).toHaveBeenCalledWith(expect.objectContaining({ sourceId: mine.sourceId, sources: expect.any(Array) }));
  });
});

describe("editing a page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.page.mockResolvedValue(mine);
    mocks.status.mockResolvedValue(statusCompiled as unknown as KnowledgeStatus);
  });

  it("edits the whole text and follows the new document the saved page is", async () => {
    const saved = { ...mine, sourceId: `src_${"9".repeat(32)}`, markdown: `${mine.markdown}\n补充一句。` };
    mocks.save.mockResolvedValue({ changed: true, writeBack: "written", userBlocks: 2, page: saved });
    renderView(mine);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "编辑" }));
    const field = await screen.findByLabelText("页面全文");
    // The engine's address is not shown in the editor; it goes back on when the page is saved.
    expect((field as HTMLTextAreaElement).value).not.toContain("viking://");
    expect((field as HTMLTextAreaElement).value).toContain("](sources/src_");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    await user.type(field, "\n补充一句。");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ sourceId: mine.sourceId, markdown: `${mine.markdown}\n补充一句。`, baseSha256: mine.sha256 }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/app/files/${saved.sourceId}?scope=p1&kind=wiki`));
  });

  it.each([409, 404])("preserves the draft and offers the newer version separately after status %i", async (status) => {
    const newer = { ...mine, sha256: "e".repeat(64), markdown: "---\ntype: analysis\ntitle: x\n---\n\n新的整理结果。" };
    mocks.save.mockRejectedValue(new WebApiError("changed", { status, code: status === 409 ? "knowledge_page_changed" : "source_not_found" }));
    mocks.pageAt.mockResolvedValue(newer);
    renderView(mine);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "编辑" }));
    await user.type(await screen.findByLabelText("页面全文"), "x");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/你的修改已保留/)).toBeInTheDocument();
    expect(mocks.pageAt).toHaveBeenCalledWith("p1", "wiki", mine.path);
    expect((screen.getByLabelText("页面全文") as HTMLTextAreaElement).value).toMatch(/x$/);
    expect(screen.getByLabelText("最新版本")).toHaveValue(newer.markdown);
    expect(screen.getByRole("button", { name: "复制我的修改" })).toBeInTheDocument();
  });
});
