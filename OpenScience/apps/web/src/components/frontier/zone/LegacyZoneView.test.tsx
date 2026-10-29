import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { EvidenceCard, EvidenceZone } from "@/lib/evidenceZoneClient";
import { Toaster } from "@/components/ui/Toaster";
import { LegacyZoneView } from "./LegacyZoneView";

const old = vi.hoisted(() => ({
  fetchEvidenceZoneDetail: vi.fn(), listZoneEvidence: vi.fn(), followEvidenceZone: vi.fn(), publishEvidenceZone: vi.fn(), setEvidenceZoneVisibility: vi.fn(),
}));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...old }));
vi.mock("@/components/capsule/ZoneSubscription", () => ({ ZoneSubscription: ({ zoneId }: { zoneId: string }) => <div data-testid="subscription">{zoneId}</div> }));

const zone = (over: Partial<EvidenceZone> = {}): EvidenceZone => ({
  id: "ez_result", revision: 2, state: "published", kind: "user", visibility: "platform", canEdit: false, title: "我的研究结果", description: "几次分析的结论",
  background: null, experts: [], following: false, canFollow: true, canFeedback: true, canResearch: true, evidenceCount: 2, creator: "李研究",
  createdAt: "2026-10-01T08:00:00.000Z", ...over,
});
const card = (id: string, over: Record<string, unknown> = {}) => ({
  id, revision: 1, state: "published", canEdit: false, zoneId: "ez_result", title: `卡片 ${id}`, summary: `${id} 的摘要`, claims: [], subtype: null, body: "",
  creator: null, reviewer: null, reviewedAt: null, ...over,
}) as unknown as EvidenceCard;

function Where() { const location = useLocation(); return <div data-testid="where">{location.pathname}</div>; }
function mount() {
  return render(
    <MemoryRouter initialEntries={["/app/frontier/zones/ez_result"]}>
      <Routes>
        <Route path="/app/frontier/zones/:zoneId" element={<LegacyZoneView zoneId="ez_result" back={<span>返回</span>} />} />
        <Route path="*" element={<Where />} />
      </Routes>
      <Toaster />
    </MemoryRouter>,
  );
}
const open = async () => { await userEvent.click(await screen.findByRole("button", { name: "更多操作" })); };

beforeEach(() => {
  vi.clearAllMocks();
  old.fetchEvidenceZoneDetail.mockResolvedValue({ zone: zone(), feedback: [] });
  old.listZoneEvidence.mockResolvedValue({ items: [card("c1"), card("c2", { state: "draft" })], total: 2, nextCursor: null });
});
afterEach(cleanup);

describe("the page of a zone that is not a topic zone", () => {
  it("shows the zone, what it says of itself and its cards, each opening on the reading page with the zone as the way back", async () => {
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "我的研究结果" })).toBeInTheDocument();
    expect(screen.getByText("几次分析的结论")).toBeInTheDocument();
    expect(screen.getByText(/李研究 · (10月1日|2026-10-01) · 平台内可见/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "专区证据" });
    const first = within(list).getByRole("link", { name: /卡片 c1/ });
    expect(first).toHaveAttribute("href", "/app/frontier/zones/ez_result/evidence/c1");
    expect(first.closest("li")).toHaveTextContent("c1 的摘要");
    expect(screen.getByTestId("subscription")).toHaveTextContent("ez_result");
    // A reader who does not own it reads its published cards and nothing else is offered but following.
    expect(old.listZoneEvidence).toHaveBeenCalledWith("ez_result", "", null, undefined);
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
  });

  it("follows and unfollows through the old zone client and takes its answer", async () => {
    old.followEvidenceZone.mockResolvedValueOnce(zone({ following: true, revision: 3 })).mockResolvedValueOnce(zone({ following: false, revision: 4 }));
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "关注" }));
    expect(old.followEvidenceZone).toHaveBeenLastCalledWith(expect.objectContaining({ id: "ez_result", revision: 2 }));
    await userEvent.click(await screen.findByRole("button", { name: "已关注" }));
    expect(old.followEvidenceZone).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 3 }));
    expect(await screen.findByRole("button", { name: "关注" })).toBeInTheDocument();
  });

  it("says a zone with no card yet is waiting for one, and tells its owner where cards come from", async () => {
    old.listZoneEvidence.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    mount();
    expect(await screen.findByText("这个专区还没有证据卡片")).toBeInTheDocument();
    expect(screen.queryByTestId("subscription")).toBeNull();
    cleanup();
    old.fetchEvidenceZoneDetail.mockResolvedValue({ zone: zone({ canEdit: true, canFollow: false }), feedback: [] });
    mount();
    expect(await screen.findByText(/在研究结果上选“发布为证据卡”/)).toBeInTheDocument();
    expect(old.listZoneEvidence).toHaveBeenLastCalledWith("ez_result", "", null, "owned");
  });

  it("reads on by the cursor and shows each card once", async () => {
    old.listZoneEvidence.mockResolvedValueOnce({ items: [card("c1")], total: 2, nextCursor: "n1" }).mockResolvedValueOnce({ items: [card("c2")], total: 2, nextCursor: null });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /显示更多/ }));
    expect(await screen.findByRole("link", { name: /卡片 c2/ })).toBeInTheDocument();
    expect(old.listZoneEvidence).toHaveBeenLastCalledWith("ez_result", "", "n1", undefined);
    expect(screen.getAllByRole("link", { name: /卡片 c1/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /显示更多/ })).toBeNull();
  });

  it("lets the owner withdraw and publish the zone, and open it to anyone or close it again — opening it after one confirmation", async () => {
    old.fetchEvidenceZoneDetail.mockResolvedValue({ zone: zone({ canEdit: true, canFollow: false }), feedback: [] });
    old.setEvidenceZoneVisibility.mockResolvedValueOnce(zone({ canEdit: true, visibility: "internet", revision: 3 })).mockResolvedValueOnce(zone({ canEdit: true, visibility: "platform", revision: 4 }));
    old.publishEvidenceZone.mockResolvedValue(zone({ canEdit: true, state: "draft", revision: 5 }));
    mount();
    await open();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["撤回专区", "公开到互联网"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "公开到互联网" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(old.setEvidenceZoneVisibility).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "公开" }));
    await waitFor(() => expect(old.setEvidenceZoneVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ id: "ez_result" }), "internet"));
    expect(await screen.findByText(/公开到互联网/, { selector: "span, p, div" })).toBeInTheDocument();
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "取消公开" }));
    await waitFor(() => expect(old.setEvidenceZoneVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 3 }), "platform"));
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "撤回专区" }));
    await waitFor(() => expect(old.publishEvidenceZone).toHaveBeenCalledWith(expect.objectContaining({ id: "ez_result" }), "draft"));
    await open();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["发布专区"]);
  });

  it("says in a sentence why it could not read the zone and reads again on 重试", async () => {
    old.fetchEvidenceZoneDetail.mockRejectedValueOnce(new WebApiError("gone", { status: 404, code: "evidence_not_found" }));
    mount();
    expect(await screen.findByText("这项内容已撤回或不存在，请返回专区查看。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { level: 1, name: "我的研究结果" })).toBeInTheDocument();
  });
});
