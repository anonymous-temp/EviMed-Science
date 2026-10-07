import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HandbookDrawer, MethodDrawer } from "./PracticeDrawer";

vi.mock("@/lib/memoryClient", () => ({ announceMemoryChanged: vi.fn() }));
const methods = vi.hoisted(() => ({ retireMethod: vi.fn(), rollbackMethod: vi.fn(), methodVersions: vi.fn(), methodSources: vi.fn() }));
vi.mock("@/lib/methodsClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/methodsClient")>("@/lib/methodsClient")),
  ...methods,
}));
const handbooks = vi.hoisted(() => ({ handbookDetail: vi.fn(), handbookVersions: vi.fn(), retireHandbook: vi.fn(), rollbackHandbook: vi.fn() }));
vi.mock("@/lib/handbooksClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/handbooksClient")>("@/lib/handbooksClient")),
  ...handbooks,
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));
vi.mock("@/lib/projects", () => ({ useProjectStore: { getState: () => ({ select: vi.fn().mockResolvedValue(undefined) }) } }));
vi.mock("@/components/markdown-viewer/MarkdownViewer", () => ({ MarkdownViewer: ({ children }: { children: string }) => <div>{children}</div> }));

/** A learned method with only the fields a drawer reads. */
function method(overrides: Record<string, unknown> = {}) {
  return {
    id: "method:learned:pre-submission-freeze-check", projectId: null, revision: 3, version: 2,
    name: "pre-submission-freeze-check", title: "定稿前的冻结检查", summary: "提交前先固定每个附件的副本。",
    description: "Runs the last guards on a finished, source-grounded deliverable before its bytes are frozen.",
    whenToUse: "When a finished deliverable is one step away from submission.",
    status: "approved", statusReason: null, origin: "inferred", counts: { eligible: 0, loaded: 0, invoked: 0, succeeded: 0, validated: 0, read: 0 },
    evaluations: [], promotion: { status: "approved", reasons: [], missing: [] }, body: "## Purpose\nA deliverable that reports a study…", steps: "1. 固定每个附件的副本。",
    bodyUpdatedAt: "2026-09-26T03:52:00Z", statusChangedAt: "2026-09-22T06:00:00Z", createdAt: "2026-09-21T06:00:00Z", updatedAt: "2026-09-23T06:00:00Z",
    ...overrides,
  } as never;
}

const twoVersions = [
  { version: 2, revision: 77, at: "2026-09-26T03:52:00Z", title: null, current: true },
  { version: 1, revision: 1, at: "2026-09-21T06:00:00Z", title: null, current: false, summary: "最初的一句话。", steps: "1. 最初的步骤。", whenToUse: "写报告时" },
];

function open(overrides: Record<string, unknown> = {}) {
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(<MemoryRouter><MethodDrawer method={method(overrides)} onClose={onClose} onChanged={onChanged} /></MemoryRouter>);
  return { onChanged, onClose };
}

describe("one learned method, opened from its row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    methods.methodVersions.mockResolvedValue({ items: twoVersions });
    methods.methodSources.mockResolvedValue({ items: [] });
  });
  afterEach(cleanup);

  it("reads the researcher's own title and steps, never the model's English name or its SKILL.md, when it has them", async () => {
    // 2026-09-21: the page printed 「claim-verdict-audit：Re-verifies the statements of…」 to a Chinese reader (and the SKILL.md, M-5).
    open();
    const drawer = screen.getByRole("dialog", { name: "定稿前的冻结检查" });
    expect(within(drawer).getByText("1. 固定每个附件的副本。")).toBeInTheDocument();
    expect(drawer.textContent).not.toMatch(/pre-submission-freeze-check|Purpose/);
    // What it is, whose it is, which body, since when: one line.
    expect(within(drawer).getByText("做法 · 从你的对话中学到 · 第 2 版 · 9月26日")).toBeInTheDocument();
    expect(await within(drawer).findByText("第 1 版 · 9月21日 ·")).toBeInTheDocument();
  });

  it("falls back to the method's own name and text until it has a title and steps", () => {
    open({ title: null, summary: null, steps: null });
    const drawer = screen.getByRole("dialog", { name: "pre-submission-freeze-check" });
    expect(within(drawer).getByText(/A deliverable that reports a study/)).toBeInTheDocument();
  });

  it("says a method the researcher set is theirs", () => {
    open({ origin: "explicit" });
    expect(screen.getByText(/做法 · 你定下的/)).toBeInTheDocument();
  });

  it("says when it is used: the situation it declared, else its routing hint", () => {
    open({ scope: { applicability: "写需要参考文献表的报告时", counterexamples: [], current: true } });
    expect(screen.getByText("什么时候用")).toBeInTheDocument();
    expect(screen.getByText("写需要参考文献表的报告时")).toBeInTheDocument();
    cleanup();
    open({ scope: null });
    expect(screen.getByText("When a finished deliverable is one step away from submission.")).toBeInTheDocument();
  });

  it("links the conversations it was learned from, newest lesson first — and says nothing when none can be found", async () => {
    methods.methodSources.mockResolvedValue({ items: [
      { projectId: "prj_1", sessionId: "ses_2", title: "疳证 Meta 论文第二轮修改", at: "2026-09-26T08:00:00Z" },
      { projectId: "prj_1", sessionId: "ses_1", title: "儿童疳证中医药新证据", at: "2026-09-22T08:00:00Z" },
    ] });
    open();
    expect(await screen.findByText("从哪里学到的")).toBeInTheDocument();
    expect(screen.getAllByRole("button").filter((button) => /疳证/.test(button.textContent ?? "")).map((button) => button.textContent)).toEqual([
      "疳证 Meta 论文第二轮修改 · 9月26日", "儿童疳证中医药新证据 · 9月22日",
    ]);
    cleanup();
    methods.methodSources.mockResolvedValue({ items: [] });
    open();
    await screen.findByText("第 1 版 · 9月21日 ·");
    expect(screen.queryByText("从哪里学到的")).not.toBeInTheDocument();
  });

  it("reads an earlier version in place: its sentence, its steps and when it applied — and 收起 puts it away", async () => {
    open();
    await userEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect(screen.getByText("最初的一句话。")).toBeInTheDocument();
    expect(screen.getByText("1. 最初的步骤。")).toBeInTheDocument();
    expect(screen.getByText("什么时候用：写报告时")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByText("最初的一句话。")).not.toBeInTheDocument();
  });

  it("has no form: a method is learned, never typed — only 回到上一版 and 不再使用", async () => {
    open();
    await screen.findByText("第 1 版 · 9月21日 ·");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /编辑|保存|新建/ })).not.toBeInTheDocument();
    const footer = screen.getByRole("button", { name: "不再使用" }).parentElement!;
    expect([...footer.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["回到上一版", "不再使用"]);
  });

  it("offers 回到上一版 only when there is an earlier body, whatever the counter says", async () => {
    methods.methodVersions.mockResolvedValue({ items: [{ version: 1, revision: 1, at: "2026-09-21T06:00:00Z", title: null, current: true }] });
    open({ revision: 77, version: 1 });
    await waitFor(() => expect(methods.methodVersions).toHaveBeenCalled());
    await screen.findByRole("button", { name: "不再使用" });
    expect(screen.queryByRole("button", { name: "回到上一版" })).not.toBeInTheDocument();
    expect(screen.queryByText("以前的版本")).not.toBeInTheDocument();
  });

  it("goes back to the previous body: the server decides which from the record", async () => {
    methods.rollbackMethod.mockResolvedValue({});
    const { onChanged, onClose } = open();
    await userEvent.click(await screen.findByRole("button", { name: "回到上一版" }));
    await waitFor(() => expect(methods.rollbackMethod).toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }), 2));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledWith("“定稿前的冻结检查”已回到上一版");
  });

  it("says plainly that there is no earlier version when the server says so", async () => {
    const { WebApiError } = await import("@/lib/apiClient");
    methods.rollbackMethod.mockRejectedValue(new WebApiError("This method has no earlier version to go back to.", { status: 409, code: "method_no_earlier_version" }));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "回到上一版" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("这个做法没有更早的版本。"));
  });

  it("stops at once, and the toast's 撤销 takes the method back", async () => {
    methods.retireMethod.mockResolvedValue(method({ status: "retired", revision: 4 }));
    methods.rollbackMethod.mockResolvedValue({});
    const { onClose } = open();
    await userEvent.click(await screen.findByRole("button", { name: "不再使用" }));
    await waitFor(() => expect(methods.retireMethod).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    const [message, options] = toasts.success.mock.calls.at(-1)!;
    expect(message).toBe("已停用“定稿前的冻结检查”");
    options.action.onClick();
    await waitFor(() => expect(methods.rollbackMethod).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }), 3));
  });

  it("says a version could not be read, and still opens", async () => {
    methods.methodVersions.mockRejectedValue(new Error("down"));
    open();
    expect(await screen.findByText("暂时读不到以前的版本。")).toBeInTheDocument();
    expect(screen.getByText("1. 固定每个附件的副本。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回到上一版" })).not.toBeInTheDocument();
  });
});

const handbook = {
  id: "method:capability-handbook:meta-analysis:citations", revision: 5, capabilityId: "meta-analysis", status: "active",
  title: "每一句结论落回来源", summary: "写结论时同时写出它出自哪篇、哪一句。", whenToUse: "写综述结论时", appliedAt: "2026-09-23T02:00:00Z",
  source: { projectId: "prj_1", sessionId: "ses_9" }, createdAt: "2026-09-20T02:00:00Z", updatedAt: "2026-09-23T02:00:00Z",
} as never;

function openHandbook() {
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(<MemoryRouter><HandbookDrawer handbook={handbook} tool="综合药品评价" onClose={onClose} onChanged={onChanged} /></MemoryRouter>);
  return { onChanged, onClose };
}

describe("one capability handbook, opened from its row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handbooks.handbookDetail.mockResolvedValue({ ...(handbook as object), body: "model text", steps: "1. 对应每个引用。", sources: [{ projectId: "prj_1", sessionId: "ses_9", title: "儿童疳证中医药新证据", at: "2026-09-22T08:00:00Z" }] });
    handbooks.handbookVersions.mockResolvedValue({ items: [
      { version: 2, revision: 9, at: "2026-09-23T02:00:00Z", title: null, current: true },
      { version: 1, revision: 5, at: "2026-09-20T02:00:00Z", title: null, current: false, steps: "1. 旧的步骤。" },
    ] });
  });
  afterEach(cleanup);

  it("names the research tool it is used in, and reads its steps once they have arrived", async () => {
    openHandbook();
    const drawer = screen.getByRole("dialog", { name: "每一句结论落回来源" });
    expect(within(drawer).getByRole("status")).toHaveTextContent("正在读取");
    expect(await within(drawer).findByText("1. 对应每个引用。")).toBeInTheDocument();
    expect(within(drawer).getByText("用在综合药品评价 · 从你的对话中学到 · 第 2 版 · 9月23日")).toBeInTheDocument();
    expect(within(drawer).getByText("写综述结论时")).toBeInTheDocument();
    expect(await within(drawer).findByText("儿童疳证中医药新证据 · 9月22日")).toBeInTheDocument();
    // Never the model's own text when there are steps, and no state of whether it was measured.
    expect(drawer.textContent).not.toMatch(/model text|效果待观察|对照评估/);
  });

  it("falls back to the text written for the model when there are no steps", async () => {
    handbooks.handbookDetail.mockResolvedValue({ ...(handbook as object), body: "model text", steps: null, sources: [] });
    openHandbook();
    expect(await screen.findByText("model text")).toBeInTheDocument();
  });

  it("goes back to the version before, by naming it", async () => {
    handbooks.rollbackHandbook.mockResolvedValue({});
    const { onClose, onChanged } = openHandbook();
    await userEvent.click(await screen.findByRole("button", { name: "回到上一版" }));
    await waitFor(() => expect(handbooks.rollbackHandbook).toHaveBeenCalledWith(expect.objectContaining({ id: (handbook as { id: string }).id, revision: 5 }), 5));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("stops being used at once, and the toast's 撤销 restores the state before", async () => {
    handbooks.retireHandbook.mockResolvedValue({ ...(handbook as object), status: "retired", revision: 6 });
    handbooks.rollbackHandbook.mockResolvedValue({});
    openHandbook();
    await userEvent.click(await screen.findByRole("button", { name: "不再使用" }));
    await waitFor(() => expect(handbooks.retireHandbook).toHaveBeenCalled());
    const [, options] = toasts.success.mock.calls.at(-1)!;
    options.action.onClick();
    await waitFor(() => expect(handbooks.rollbackHandbook).toHaveBeenCalledWith(expect.objectContaining({ revision: 6 }), 5));
  });

  it("reads an earlier version in place", async () => {
    openHandbook();
    await userEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect(screen.getByText("1. 旧的步骤。")).toBeInTheDocument();
  });

  it("says it could not read the handbook, and still lets it be stopped", async () => {
    handbooks.handbookDetail.mockRejectedValue(new Error("down"));
    openHandbook();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "不再使用" })).toBeInTheDocument();
  });
});
