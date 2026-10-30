// The memory page for an account whose memory is kept as files, beside the same page for the older kind of account. The two look
// the same: the same navigation, the same rows, the same drawer, and not a word of which engine holds the memory.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { nativeProfile, nativeSettings } from "@/components/memory/__fixtures__/memoryProfiles";
import { MemoryHubPage } from "./MemoryHubPage";

const api = vi.hoisted(() => ({
  fetchMemoryProfile: vi.fn(), searchMemories: vi.fn(), fetchMemorySettings: vi.fn(), updateMemorySettings: vi.fn(), resetMemory: vi.fn(),
}));
const memory = vi.hoisted(() => ({ fetchMyCapsule: vi.fn(), rememberMemory: vi.fn(), fetchMemoryGrowth: vi.fn(), fetchMemoryLearned: vi.fn() }));
const practice = vi.hoisted(() => ({ listAllMethods: vi.fn() }));

vi.mock("@/lib/apiClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient")), getWebProjectId: () => "prj_1", ...api }));
vi.mock("@/lib/memoryClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/memoryClient")>("@/lib/memoryClient")), ...memory }));
vi.mock("@/lib/methodsClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/methodsClient")>("@/lib/methodsClient")), listAllMethods: practice.listAllMethods }));
vi.mock("@/lib/geoClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/geoClient")>("@/lib/geoClient")), useGeoFeature: () => "off", listGeoProjects: () => Promise.resolve([]) }));
vi.mock("@/lib/vcrClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/vcrClient")>("@/lib/vcrClient")), useVcrFeature: () => "off", getVcrHome: () => Promise.resolve({ studies: [] }) }));
vi.mock("@/components/memory/useMemoryWritePrompt", () => ({ useMemoryWritePrompt: () => {} }));
vi.mock("@/components/memory/RelatedSection", () => ({ RelatedSection: () => null }));
vi.mock("@/lib/sourceClient", () => ({ getSource: vi.fn() }));
vi.mock("./CapsuleTransferPanel", () => ({ ShareDrawer: () => null }));
vi.mock("@/components/markdown-viewer/MarkdownViewer", () => ({ MarkdownViewer: ({ children }: { children: string }) => <div>{children}</div> }));

function open(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/app/memory${search}`]}>
      <Routes><Route path="/app/memory" element={<MemoryHubPage />} /></Routes>
    </MemoryRouter>,
  );
}
const BACK_OFFICE = /viking|\.md\b|native|legacy|OpenViking|engine|nm_[0-9a-f]{6}|memories\//i;

beforeEach(() => {
  useProjectStore.setState({ projects: [{ id: "prj_1", name: "订单服务" }], currentId: "prj_1" });
  api.fetchMemoryProfile.mockResolvedValue(nativeProfile);
  api.fetchMemorySettings.mockResolvedValue(nativeSettings);
  api.searchMemories.mockResolvedValue({ items: [], query: "", semantic: 0, conversations: {}, usage: {} });
  memory.fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [], forgotten: [] });
  memory.fetchMemoryGrowth.mockResolvedValue({ unit: null, first: null, fromStart: false, points: [], moments: [], timeZone: "Asia/Shanghai" });
  memory.fetchMemoryLearned.mockResolvedValue({ days: [], timeZone: "Asia/Shanghai" });
  practice.listAllMethods.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); useProjectStore.setState({ projects: [], currentId: "default" }); });

describe("the memory page of an account whose memory is kept as files", () => {
  it("lists the profile as the sentences it is made of, and the other files by topic with what they say under it", async () => {
    open();
    const list = await screen.findByRole("list", { name: "背景" });
    expect(within(list).getByText("所在科室是临床药学部。")).toBeInTheDocument();
    expect(within(list).getByText("常用 R 做统计分析。")).toBeInTheDocument();
    const preferences = screen.getByRole("list", { name: "偏好" });
    const row = within(preferences).getByText("回答结构").closest("li")!;
    expect(row).toHaveTextContent("先给结论，再给依据；表格不超过五列");
    expect(within(preferences).getByText("meta analysis method")).toBeInTheDocument();
    // The list counts every row of the capsule that is about the person (five) and the project's two, which are its last group.
    expect(screen.getByRole("link", { name: /关于你/ })).toHaveTextContent("7");
  });

  it("lists the project's files as the last group of 关于你, each row naming its project in plain text", async () => {
    open();
    const list = await screen.findByRole("list", { name: "项目记忆" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toHaveTextContent("订单服务");
    expect(within(list).getByText("订单服务重构")).toBeInTheDocument();
    expect(within(list).getByText("发布窗口")).toBeInTheDocument();
    // A name, not a control: the row is the one target, and what it says of its project is not another.
    expect(within(list).queryByRole("link")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 }).at(-1)).toHaveTextContent("项目记忆");
  });

  it("says nothing of the engine, a file or an address anywhere on the page or in a drawer", async () => {
    open();
    await screen.findByRole("list", { name: "背景" });
    expect(document.body.textContent).not.toMatch(BACK_OFFICE);
    await userEvent.click(screen.getByText("回答结构"));
    expect(await screen.findByRole("dialog", { name: "偏好" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(BACK_OFFICE);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭" }));
    await userEvent.click(screen.getByText("所在科室是临床药学部。"));
    expect(await screen.findByRole("dialog", { name: "背景" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(BACK_OFFICE);
  });

  it("offers 记住这一条", async () => {
    open();
    expect(await screen.findByRole("button", { name: "记住这一条" })).toBeInTheDocument();
  });

  it("offers 从其他 AI 导入 in the 「⋯」, which opens the import and reads the list again once something is saved", async () => {
    open();
    await screen.findByRole("list", { name: "背景" });
    await userEvent.click(screen.getByRole("button", { name: "记忆设置" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "从其他 AI 导入" }));
    expect(await screen.findByRole("dialog", { name: "从其他 AI 导入" })).toBeInTheDocument();
  });

  it("hands the words over, closes, and shows them as 正在记住 until the memory has written them", async () => {
    const asked = { id: "p1", text: "以后报告先给结论，再给依据。", at: new Date().toISOString(), state: "pending" as const };
    memory.rememberMemory.mockResolvedValue({ pending: asked });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "记住这一条" }));
    const dialog = screen.getByRole("dialog", { name: "记住这一条" });
    expect(within(dialog).getByRole("button", { name: "记住" })).toBeDisabled();
    api.fetchMemoryProfile.mockResolvedValue({ ...nativeProfile, pending: [asked] });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "要记住的内容" }), asked.text);
    await userEvent.click(within(dialog).getByRole("button", { name: "记住" }));
    await waitFor(() => expect(memory.rememberMemory).toHaveBeenCalledWith(asked.text, null));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "记住这一条" })).not.toBeInTheDocument());
    const waiting = await screen.findByRole("list", { name: "正在记住的内容" });
    expect(within(waiting).getByText(asked.text)).toBeInTheDocument();
    expect(within(waiting).getByText("正在记住")).toBeInTheDocument();
    // The files stay where they were under it.
    expect(screen.getByRole("list", { name: "偏好" })).toBeInTheDocument();
  });

  it("says a refusal in the registry's sentence and keeps the words", async () => {
    memory.rememberMemory.mockRejectedValue(new WebApiError("refused", { status: 400, code: "memory_content_refused" }));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "记住这一条" }));
    const dialog = screen.getByRole("dialog", { name: "记住这一条" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "要记住的内容" }), "我的手机号是 13800138000");
    await userEvent.click(within(dialog).getByRole("button", { name: "记住" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("没有记下");
    expect(within(dialog).getByRole("textbox", { name: "要记住的内容" })).toHaveValue("我的手机号是 13800138000");
  });

  it("says a memory that is taking long is taking long, instead of spinning", async () => {
    const old = { id: "p3", text: "以后写英文摘要", at: new Date(Date.now() - 5 * 60_000).toISOString(), state: "retrying" as const };
    api.fetchMemoryProfile.mockResolvedValue({ ...nativeProfile, pending: [old] });
    open();
    const waiting = await screen.findByRole("list", { name: "正在记住的内容" });
    expect(within(waiting).getByText("还在记，比平时慢一些")).toBeInTheDocument();
    expect(within(waiting).queryByText("正在记住")).not.toBeInTheDocument();
  });

  it("reads 记忆服务暂时不可用 in place of the list when the memory service cannot be reached, and breaks nothing else", async () => {
    api.fetchMemoryProfile.mockRejectedValue(new WebApiError("down", { status: 503, code: "memory_engine_unavailable" }));
    open();
    expect(await screen.findByText(/记忆服务暂时不可用/)).toBeInTheDocument();
    expect(screen.queryByText("没有读到全部记忆。")).not.toBeInTheDocument();
    expect(screen.queryByText("还没有关于你的记忆")).not.toBeInTheDocument();
    // The other lists still answer for themselves.
    await userEvent.click(screen.getByRole("link", { name: /做法/ }));
    expect(await screen.findByText("还没有学到的做法")).toBeInTheDocument();
    expect(screen.queryByText(/记忆服务暂时不可用/)).not.toBeInTheDocument();
  });
});
