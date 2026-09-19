import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapsuleOverview } from "./CapsuleOverview";

const api = vi.hoisted(() => ({
  fetchMemoryProfile: vi.fn(),
  updateStructuredMemory: vi.fn(),
  fetchMemorySettings: vi.fn(),
  updateMemorySettings: vi.fn(),
  resetMemory: vi.fn(),
}));
vi.mock("@/lib/apiClient", () => ({
  ...api,
  getWebProjectId: () => "project-a",
  webErrorMessage: (_error: unknown, overrides?: { fallback?: string }) => overrides?.fallback ?? "操作未完成，请重试。",
}));
const client = vi.hoisted(() => ({
  MEMORY_CHANGED_EVENT: "evimed.memory.changed",
  announceMemoryChanged: vi.fn(),
  archiveMemoryRecord: vi.fn(),
  fetchMyCapsule: vi.fn(),
  undoMemoryRecord: vi.fn(),
}));
vi.mock("@/lib/memoryClient", () => client);
const methods = vi.hoisted(() => ({ listMethods: vi.fn() }));
vi.mock("@/lib/methodsClient", () => methods);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

function record(id: string, kind: string, summary: string, basis = "stated", extra: Record<string, unknown> = {}) {
  return {
    id, scope: "user", scopeId: "", kind, key: `${kind}.${id}`, value: summary, summary, status: "active", origin: "explicit",
    confidence: 1, importance: 0.5, sensitive: false, evidenceCount: 1, evidence: [], revisions: [], version: 1,
    createdAt: null, updatedAt: null, lastConfirmedAt: null, expiresAt: null,
    provenance: { basis, observations: 3, runs: 4, conversations: 2 }, ...extra,
  };
}

function profile(records: unknown[]) {
  return { records, groups: {}, activeCount: records.length, pendingCount: 0 };
}

function renderOverview(library: number | null = null) {
  return render(<MemoryRouter><CapsuleOverview library={library} /></MemoryRouter>);
}

describe("总览: one page of prose in place of a board of cards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchMemorySettings.mockResolvedValue({ learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null });
    api.updateMemorySettings.mockImplementation(async (patch: object) => ({ learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null, ...patch }));
    api.resetMemory.mockResolvedValue({ structured: 3, manual: 1 });
    client.fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [] });
    methods.listMethods.mockResolvedValue({ items: [], nextCursor: null });
  });
  afterEach(cleanup);

  it("writes the portrait from the stored sentences, who first, each with where it came from", async () => {
    api.fetchMemoryProfile.mockResolvedValue(profile([
      record("p1", "preference", "要中文，结论先行"),
      record("r1", "profile", "我是临床药师，主要做心血管用药的循证评价。"),
      record("s1", "preference", "我在服用某种药物", "stated", { sensitive: true }),
      record("f1", "project_fact", "队列 500 人", "tool", { scope: "project", scopeId: "project-a" }),
      record("i1", "behavior", "选证据时坚持 RCT 优先", "inferred"),
    ]));
    renderOverview();
    const portrait = await screen.findByRole("region", { name: "EviMed 眼中的你" });
    expect(portrait).toHaveTextContent("我是临床药师，主要做心血管用药的循证评价。1选证据时坚持 RCT 优先。2要中文，结论先行。3");
    // Never a sensitive record, never a project fact: the portrait is the person.
    expect(portrait).not.toHaveTextContent("服用某种药物");
    expect(portrait).not.toHaveTextContent("队列 500 人");
    expect(within(portrait).getByText("推断")).toBeInTheDocument();
    expect(within(portrait).getByText(/在 4 次任务中观察到/)).toBeInTheDocument();
    // Counts are counts, from the same records.
    expect(screen.getByText("你说的 2 · 观察到 1")).toBeInTheDocument();
  });

  it("drops a sentence at once, with the undo in the toast, and says what the capsule still lacks", async () => {
    api.fetchMemoryProfile.mockResolvedValue(profile([record("p1", "preference", "要中文，结论先行")]));
    client.archiveMemoryRecord.mockResolvedValue({ id: "p1", version: 2 });
    client.undoMemoryRecord.mockResolvedValue({ undone: "restored", record: null, restored: [] });
    renderOverview(0);
    await userEvent.click(await screen.findByRole("button", { name: "不要再提这条" }));
    expect(client.archiveMemoryRecord).toHaveBeenCalledWith("p1", 1);
    const [, options] = toasts.success.mock.calls.at(-1)!;
    options.action.onClick();
    await waitFor(() => expect(client.undoMemoryRecord).toHaveBeenCalledWith("p1", 2));

    const missing = screen.getByRole("region", { name: "还缺" });
    expect(missing).toHaveTextContent("还不知道你的身份和研究方向");
    expect(missing).toHaveTextContent("还没有方法");
    expect(missing).toHaveTextContent("资料库还是空的");
    expect(missing).not.toHaveTextContent("还不知道你偏好的回答方式");
  });

  it("an empty capsule says so plainly instead of drawing an empty chart", async () => {
    api.fetchMemoryProfile.mockResolvedValue(profile([]));
    renderOverview();
    expect(await screen.findByText(/EviMed 还不了解你/)).toBeInTheDocument();
  });

  it("pauses learning, recall and this project without deleting anything, and resets only after saying what goes", async () => {
    // 2026-09-16 review, M4④: pause and reset are different acts.
    api.fetchMemoryProfile.mockResolvedValue(profile([]));
    renderOverview();
    const learning = await screen.findByRole("switch", { name: "从对话中学习新记忆" });
    expect(learning).toHaveAttribute("aria-checked", "true");
    await userEvent.click(learning);
    expect(api.updateMemorySettings).toHaveBeenLastCalledWith({ learningPaused: true });
    await waitFor(() => expect(screen.getByRole("switch", { name: "从对话中学习新记忆" })).toHaveAttribute("aria-checked", "false"));
    await userEvent.click(screen.getByRole("switch", { name: "当前项目使用记忆" }));
    expect(api.updateMemorySettings).toHaveBeenLastCalledWith({ pausedProjects: ["project-a"] });
    expect(api.resetMemory).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "重置全部记忆" }));
    expect(await screen.findByText(/不会删除对话与运行记录、交付文件、知识库来源和方法胶囊/)).toBeInTheDocument();
    expect(api.resetMemory).not.toHaveBeenCalled();
    const loadsBefore = api.fetchMemoryProfile.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "全部删除" }));
    await waitFor(() => expect(api.resetMemory).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.fetchMemoryProfile.mock.calls.length).toBeGreaterThan(loadsBefore));
  });

  it("a failed read offers the way to try again", async () => {
    api.fetchMemoryProfile.mockRejectedValueOnce(new Error("down")).mockResolvedValue(profile([]));
    renderOverview();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText(/EviMed 还不了解你/)).toBeInTheDocument();
  });
});
