import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { TopicRequests } from "./TopicRequests";
import type { TopicRequest } from "@/lib/evidenceTopicRequestClient";

const client = vi.hoisted(() => ({ listTopicRequests: vi.fn(), fileTopicRequest: vi.fn(), secondTopicRequest: vi.fn() }));
vi.mock("@/lib/evidenceTopicRequestClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/evidenceTopicRequestClient")>()),
  ...client,
}));

const request = (over: Partial<TopicRequest> = {}): TopicRequest => ({
  id: "tr_1", title: "房颤合并肾功能不全的抗凝选择", zoneId: null, zoneTitle: null, requesters: 3, createdAt: "2026-10-05T00:00:00.000Z", ...over,
});
const list = (items: TopicRequest[], over: Record<string, unknown> = {}) => ({ items, seconded: [], remainingToday: 5, ...over });

describe("申请选题", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is the drawer's body: no section of its own, no second title, and a topic named elsewhere is written in the field and not sent", async () => {
    client.listTopicRequests.mockResolvedValue(list([]));
    const { container } = render(<TopicRequests initialTitle="乳腺癌" />);
    expect(await screen.findByRole("textbox", { name: "选题" })).toHaveValue("乳腺癌");
    expect(client.fileTopicRequest).not.toHaveBeenCalled();
    expect(container.querySelector("section")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    // A zone's name can be shorter than a request may be: the field says what is missing instead of leaving a dead button.
    expect(screen.getByText("再多写几个字，说清想看什么（至少 4 个字）。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交申请" })).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "选题" }), "的靶向治疗");
    expect(screen.queryByText(/再多写几个字/)).toBeNull();
    expect(screen.getByRole("button", { name: "提交申请" })).toBeEnabled();
  });

  it("lists the open requests in the server's order with how many asked, and what is left of today", async () => {
    client.listTopicRequests.mockResolvedValue(list([request({ id: "tr_a", title: "糖尿病新药", requesters: 9, zoneTitle: "2 型糖尿病" }), request({ id: "tr_b", title: "房颤抗凝", requesters: 2 })]));
    render(<TopicRequests />);
    const rows = within(await screen.findByRole("list", { name: "选题申请" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("糖尿病新药"), expect.stringContaining("房颤抗凝")]);
    expect(rows[0]).toHaveTextContent("9 人申请 · 2 型糖尿病");
    expect(screen.getByText(/今天还能申请或附议 5 次/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("files a request with the chosen official zone, keeps the list ordered by requesters and says what happened", async () => {
    client.listTopicRequests.mockResolvedValue(list([request({ id: "tr_a", title: "已有的申请", requesters: 2 })]));
    client.fileTopicRequest.mockResolvedValue({ request: request({ id: "tr_new", title: "新的申请", requesters: 1, zoneId: "ez_1", zoneTitle: "房颤抗凝" }), filed: true, seconded: true, alreadySeconded: false });
    render(<TopicRequests zones={[{ id: "ez_1", title: "房颤抗凝" }]} />);
    await screen.findByRole("list", { name: "选题申请" });
    const submit = screen.getByRole("button", { name: "提交申请" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "选题" }), "新的申请");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "关联专区（可选）" }), "ez_1");
    await userEvent.click(submit);
    expect(client.fileTopicRequest).toHaveBeenCalledWith("新的申请", "ez_1");
    expect(await screen.findByText("已提交申请。申请的人越多，越靠前。")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "选题申请" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("已有的申请"), expect.stringContaining("新的申请")]);
    expect(rows[1]).toHaveTextContent("房颤抗凝");
    expect(screen.getByRole("textbox", { name: "选题" })).toHaveValue("");
    expect(screen.getByText(/今天还能申请或附议 4 次/)).toBeInTheDocument();
  });

  it("seconds a request, shows it as seconded and moves it up when it now has more requesters", async () => {
    client.listTopicRequests.mockResolvedValue(list([request({ id: "tr_a", title: "第一条", requesters: 2 }), request({ id: "tr_b", title: "第二条", requesters: 2, createdAt: "2026-10-05T01:00:00.000Z" })]));
    client.secondTopicRequest.mockResolvedValue({ request: request({ id: "tr_b", title: "第二条", requesters: 3, createdAt: "2026-10-05T01:00:00.000Z" }), filed: false, seconded: true, alreadySeconded: false });
    render(<TopicRequests />);
    await userEvent.click(await screen.findByRole("button", { name: "附议：第二条" }));
    expect(client.secondTopicRequest).toHaveBeenCalledWith("tr_b");
    const rows = within(screen.getByRole("list", { name: "选题申请" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("第二条");
    expect(rows[0]).toHaveTextContent("3 人申请");
    expect(within(rows[0]).getByRole("button", { name: "已附议：第二条" })).toBeDisabled();
    expect(within(rows[1]).getByRole("button", { name: "附议：第一条" })).toBeEnabled();
  });

  it("shows a request the account already voted for as seconded, and filing the same words as a vote for the existing one", async () => {
    client.listTopicRequests.mockResolvedValue(list([request({ id: "tr_a", title: "已有的申请" })], { seconded: ["tr_a"] }));
    client.fileTopicRequest.mockResolvedValue({ request: request({ id: "tr_a", title: "已有的申请", requesters: 4 }), filed: false, seconded: true, alreadySeconded: false });
    render(<TopicRequests />);
    expect(await screen.findByRole("button", { name: "已附议：已有的申请" })).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "选题" }), "已有的申请");
    await userEvent.click(screen.getByRole("button", { name: "提交申请" }));
    expect(await screen.findByText("这个选题已经有人申请，已为你附议。")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows the daily limit's refusal in the registry's words and keeps what was written", async () => {
    client.listTopicRequests.mockResolvedValue(list([], { remainingToday: 0 }));
    client.fileTopicRequest.mockRejectedValue(new WebApiError("limit", { status: 429, code: "evidence_topic_request_limit", retryAfterSeconds: 3600 }));
    render(<TopicRequests />);
    await userEvent.type(await screen.findByRole("textbox", { name: "选题" }), "今天的第六条");
    await userEvent.click(screen.getByRole("button", { name: "提交申请" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("你今天申请和附议的选题已经到上限了，明天再来。");
    expect(screen.getByRole("textbox", { name: "选题" })).toHaveValue("今天的第六条");
    expect(screen.getByText("还没有人申请选题。")).toBeInTheDocument();
  });

  it("shows only the first few requests until asked for the rest, and a failed read can be retried", async () => {
    const many = Array.from({ length: 7 }, (_, index) => request({ id: `tr_${index}`, title: `申请 ${index}`, requesters: 10 - index }));
    client.listTopicRequests.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: "evidence_unavailable" })).mockResolvedValueOnce(list(many));
    render(<TopicRequests />);
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findAllByRole("listitem")).toHaveLength(5);
    await userEvent.click(screen.getByRole("button", { name: "显示全部 7 条" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    await userEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });
});
