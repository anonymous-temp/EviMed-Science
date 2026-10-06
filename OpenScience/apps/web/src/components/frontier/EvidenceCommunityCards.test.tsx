import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { EvidenceCommunityCard } from "@/lib/evidenceCommunityClient";
import { EvidenceCommunityCards } from "./EvidenceCommunityCards";

const client = vi.hoisted(() => ({ fetchEvidenceCommunity: vi.fn() }));
vi.mock("@/lib/evidenceCommunityClient", () => client);

const card = (over: Partial<EvidenceCommunityCard> = {}): EvidenceCommunityCard => ({
  id: "ec_1", zoneId: "ez_user1", zoneTitle: "我的真实世界研究", title: "阿哌沙班在真实世界中的出血事件", summary: "单中心 1,200 例患者中，抗凝相关出血低于预期。",
  author: { id: "alice", name: "李医生" }, producer: { kind: "user", name: "李医生" }, originality: "original_research",
  claims: { total: 4, verified: 3 }, verifiedShare: 0.75, reviewScore: 4.5, reviews: 2, sharedKeys: ["drug:apixaban"], updatedAt: "2026-10-05T08:00:00Z", ...over,
});
/** Lets the read finish and the component act on it. */
const settled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const show = () => render(<MemoryRouter><EvidenceCommunityCards zoneId="ez_official" /></MemoryRouter>);

describe("the community cards of an official zone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists each card with a link to it and to its author, and what the check found, in a section the reader can find", async () => {
    client.fetchEvidenceCommunity.mockResolvedValue({ zoneId: "ez_official", entityKeys: ["drug:apixaban"], items: [card(), card({ id: "ec_2", title: "第二张卡", claims: { total: 0, verified: 0 }, reviewScore: null, reviews: 0, summary: "" })], limit: 20 });
    show();
    expect(await screen.findByRole("region", { name: "社区卡片" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "阿哌沙班在真实世界中的出血事件" })).toHaveAttribute("href", "/app/frontier/zones/ez_user1/evidence/ec_1");
    expect(screen.getAllByRole("link", { name: "李医生" })[0]).toHaveAttribute("href", "/app/frontier/authors/alice");
    expect(screen.getByText(/3\/4 条结论已在来源里核对到原文 · 读者评分 4.5（2 人）/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "第二张卡" })).toBeInTheDocument();
    expect(client.fetchEvidenceCommunity).toHaveBeenCalledWith("ez_official");
  });

  it("shows nothing for a zone with no such cards and for a deployment that has not switched the column on", async () => {
    client.fetchEvidenceCommunity.mockResolvedValueOnce({ zoneId: "z", entityKeys: [], items: [], limit: 20 });
    const first = show();
    await settled();
    expect(client.fetchEvidenceCommunity).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "社区卡片" })).toBeNull();
    first.unmount();
    client.fetchEvidenceCommunity.mockRejectedValueOnce(new WebApiError("off", { status: 404, code: "evidence_community_not_enabled" }));
    const second = show();
    await settled();
    expect(client.fetchEvidenceCommunity).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).toBeNull();
    expect(second.container).toBeEmptyDOMElement();
  });

  it("says once that a read that failed could not be read, and retries on request", async () => {
    client.fetchEvidenceCommunity.mockRejectedValueOnce(new WebApiError("down", { status: 502 })).mockResolvedValueOnce({ zoneId: "z", entityKeys: [], items: [card()], limit: 20 });
    show();
    expect(await screen.findByRole("status")).toHaveTextContent("社区卡片暂时读不出来");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("region", { name: "社区卡片" })).toBeInTheDocument();
  });
});
