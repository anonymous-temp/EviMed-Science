import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MethodRow, methodHistory } from "./MethodRow";

vi.mock("@/lib/memoryClient", () => ({ announceMemoryChanged: vi.fn() }));
const methods = vi.hoisted(() => ({ retireMethod: vi.fn(), rollbackMethod: vi.fn() }));
vi.mock("@/lib/methodsClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/methodsClient")>("@/lib/methodsClient")),
  ...methods,
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));
vi.mock("@/components/markdown-viewer/MarkdownViewer", () => ({ MarkdownViewer: ({ children }: { children: string }) => <div>{children}</div> }));

/** A learned method with only the fields a row reads. */
function method(overrides: Record<string, unknown> = {}) {
  return {
    id: "method:learned:pre-submission-freeze-check", projectId: null, revision: 1,
    name: "pre-submission-freeze-check",
    description: "Runs the last guards on a finished, source-grounded deliverable before its bytes are frozen.",
    whenToUse: "When a finished deliverable is one step away from submission.",
    status: "approved", statusReason: null, origin: "inferred", counts: { eligible: 0, loaded: 0, invoked: 0, succeeded: 0, validated: 0, read: 0 },
    evaluations: [], promotion: { status: "approved", reasons: [], missing: [] }, body: "1. 固定每个附件的副本。",
    statusChangedAt: "2026-09-22T06:00:00Z", createdAt: "2026-09-21T06:00:00Z", updatedAt: "2026-09-21T06:00:00Z",
    ...overrides,
  } as never;
}

function row(overrides: Record<string, unknown> = {}) {
  const onChanged = vi.fn();
  render(<ul><MethodRow method={method(overrides)} onChanged={onChanged} /></ul>);
  return onChanged;
}

describe("one learned method, as a row of 做法", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  it("reads the researcher's own line, never the model's English name, when it has one", () => {
    // 2026-09-21: the page printed 「claim-verdict-audit：Re-verifies the
    // statements of…」 to a Chinese reader.
    row({ title: "定稿前的冻结检查", summary: "提交前先固定每个附件的副本，再在要冻结的那一版上跑最后几道检查。" });
    expect(screen.getByText(/定稿前的冻结检查：提交前先固定每个附件的副本/)).toBeInTheDocument();
    expect(screen.queryByText(/pre-submission-freeze-check/)).not.toBeInTheDocument();
  });

  it("falls back to the method's own name and description until it has a line", () => {
    row();
    expect(screen.getByText(/pre-submission-freeze-check：Runs the last guards/)).toBeInTheDocument();
  });

  it("says 做法 and 推断, and nothing else: no 新, no 起生效, no 用过 N 次", () => {
    row();
    const item = screen.getByRole("listitem");
    expect(within(item).getByText("做法")).toBeInTheDocument();
    expect(within(item).getByText("推断")).toBeInTheDocument();
    expect(item.textContent).not.toMatch(/新|起生效|用过|我的做法|看看具体怎么做/);
    cleanup();
    row({ origin: "explicit" });
    expect(screen.queryByText("推断")).not.toBeInTheDocument();
  });

  it("opens its full steps from the row", async () => {
    row();
    expect(screen.queryByText("1. 固定每个附件的副本。")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /pre-submission-freeze-check/ }));
    expect(screen.getByText("1. 固定每个附件的副本。")).toBeInTheDocument();
  });

  it("keeps 历史版本, 回到上一版 and 停用 in its 「⋯」", async () => {
    methods.rollbackMethod.mockResolvedValue({});
    const onChanged = row({ revision: 3, updatedAt: "2026-09-23T06:00:00Z" });
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["历史版本", "回到上一版", "停用"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "回到上一版" }));
    await waitFor(() => expect(methods.rollbackMethod).toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }), 2));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("stops at once, and the toast's 撤销 takes the method back", async () => {
    methods.retireMethod.mockResolvedValue(method({ status: "retired", revision: 2 }));
    methods.rollbackMethod.mockResolvedValue({});
    row();
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "停用" }));
    await waitFor(() => expect(methods.retireMethod).toHaveBeenCalled());
    const [, options] = toasts.success.mock.calls.at(-1)!;
    options.action.onClick();
    await waitFor(() => expect(methods.rollbackMethod).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }), 1));
  });

  it("a stopped method offers only 恢复", async () => {
    methods.rollbackMethod.mockResolvedValue({});
    row({ status: "retired", revision: 2 });
    expect(screen.queryByRole("button", { name: "更多" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(methods.rollbackMethod).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }), 1));
  });
});

describe("a method's history", () => {
  it("is what happened to it, newest first, learning and taking effect said once", () => {
    const stopped = methodHistory(method({ status: "retired", revision: 2, statusChangedAt: "2026-09-23T06:00:00Z", statusReason: "在记忆页里停用" }));
    expect(stopped).toEqual(["9月23日 停用：在记忆页里停用", "9月21日 学到"]);
    expect(methodHistory(method({ revision: 3, updatedAt: "2026-09-22T06:00:00Z" }))).toEqual(["9月22日 更新为第 3 版", "9月21日 学到"]);
    expect(methodHistory(method({ origin: "explicit" }))).toEqual(["9月21日 记下"]);
  });
});
