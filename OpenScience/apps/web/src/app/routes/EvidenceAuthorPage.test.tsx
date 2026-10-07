import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { EvidenceAuthorPage } from "./EvidenceAuthorPage";

const client = vi.hoisted(() => ({ fetchEvidenceAuthor: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));

const author = {
  author: { id: "au_0123456789abcdef", name: "李研究", platform: false },
  zones: [{ id: "ez_1", title: "卒中研究", description: "", kind: "user" as const, visibility: "platform" as const, evidenceCount: 2, follows: 3, updatedAt: "2026-10-04T00:00:00Z" }],
  cards: [{ id: "ec_1", zoneId: "ez_1", title: "试验药能预防卒中吗", summary: "试验显示卒中减少。", creator: "李研究", producer: null, originality: "synthesis" as const, claimCount: 3, updatedAt: "2026-10-04T00:00:00Z" }],
  totals: { cards: 2, followers: 3, runsFromCards: 5 },
};
const mount = (state?: unknown) => render(<MemoryRouter initialEntries={[{ pathname: "/app/frontier/authors/au_0123456789abcdef", state }]}><Routes><Route path="/app/frontier/authors/:authorId" element={<EvidenceAuthorPage />} /></Routes></MemoryRouter>);
const manyCards = (count: number) => Array.from({ length: count }, (_, index) => ({ ...author.cards[0], id: `ec_${index}`, title: index === 3 ? "房颤抗凝的剂量" : `第 ${index} 张证据卡`, summary: "" }));
beforeEach(() => vi.clearAllMocks());

describe("an author's page", () => {
  it("is titled by the author's name, with the way back to 前沿动态 and no row of the feed's views", async () => {
    client.fetchEvidenceAuthor.mockResolvedValue(author);
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "李研究" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "返回" })).getByRole("link", { name: "前沿动态" })).toHaveAttribute("href", "/app/frontier");
    expect(screen.queryByRole("navigation", { name: "前沿动态" })).toBeNull();
    expect(screen.getAllByRole("heading", { name: "李研究" })).toHaveLength(1);
  });

  it("goes back to the card the reader came from, by name, when the link says so", async () => {
    client.fetchEvidenceAuthor.mockResolvedValue(author);
    mount({ evidenceFrom: { to: "/app/frontier/zones/ez_1/evidence/ec_1", label: "试验药能预防卒中吗" } });
    await screen.findByRole("heading", { level: 1, name: "李研究" });
    const links = within(screen.getByRole("navigation", { name: "返回" })).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["试验药能预防卒中吗", "/app/frontier/zones/ez_1/evidence/ec_1"]]);
  });

  it("falls back to 前沿动态 for a state it cannot trust", async () => {
    client.fetchEvidenceAuthor.mockResolvedValue(author);
    mount({ evidenceFrom: { to: "https://example.org/", label: "试验药能预防卒中吗" } });
    await screen.findByRole("heading", { level: 1, name: "李研究" });
    expect(within(screen.getByRole("navigation", { name: "返回" })).getByRole("link")).toHaveAttribute("href", "/app/frontier");
  });

  it("says what the author has to show in one line, leaving out every number that is zero", async () => {
    client.fetchEvidenceAuthor.mockResolvedValue(author);
    const full = mount();
    expect(await screen.findByText("2 张证据卡 · 3 人关注 · 5 次研究从这里开始")).toBeInTheDocument();
    full.unmount();
    client.fetchEvidenceAuthor.mockResolvedValue({ ...author, totals: { cards: 1, followers: 0, runsFromCards: 0 } });
    const one = mount();
    expect(await screen.findByText("1 张证据卡")).toBeInTheDocument();
    expect(screen.queryByText(/0 人|0 次/)).toBeNull();
    one.unmount();
    client.fetchEvidenceAuthor.mockResolvedValue({ ...author, totals: { cards: 0, followers: 0, runsFromCards: 0 } });
    mount();
    await screen.findByRole("heading", { level: 1, name: "李研究" });
    expect(screen.queryByText(/张证据卡|人关注|次研究/)).toBeNull();
  });

  it("opens on the cards, the zones one tab away and the change log only where there is one", async () => {
    client.fetchEvidenceAuthor.mockResolvedValue(author);
    const plain = mount();
    expect(await screen.findByRole("link", { name: "试验药能预防卒中吗" })).toHaveAttribute("href", "/app/frontier/zones/ez_1/evidence/ec_1");
    const tabs = screen.getByRole("tablist", { name: "作者的内容" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["证据卡1", "专区1"]);
    expect(within(tabs).getByRole("tab", { name: /证据卡/ })).toHaveAttribute("aria-selected", "true");
    // One kind of thing at a time: the zones are not on the page until their tab is chosen.
    expect(screen.queryByRole("link", { name: "卒中研究" })).toBeNull();
    expect(screen.getByText(/3 条结论 · 更新于 2026\/10\/4/)).toBeInTheDocument();
    await userEvent.click(within(tabs).getByRole("tab", { name: /专区/ }));
    expect(screen.getByRole("link", { name: "卒中研究" })).toHaveAttribute("href", "/app/frontier/zones/ez_1");
    expect(screen.getByText("用户专区 · 2 条证据 · 3 人关注")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "试验药能预防卒中吗" })).toBeNull();
    expect(screen.queryByText(/排名|排行/)).not.toBeInTheDocument();
    plain.unmount();
    client.fetchEvidenceAuthor.mockResolvedValue({ ...author, changes: [{ id: "c1", summary: "更正了一处数字", occurredAt: "2026-10-05T12:00:00Z" }] });
    mount();
    await userEvent.click(await screen.findByRole("tab", { name: "最近变更" }));
    expect(screen.getByText(/更正了一处数字/)).toBeInTheDocument();
  });

  it("marks the platform publisher after the name", async () => {
    client.fetchEvidenceAuthor.mockResolvedValue({ ...author, author: { id: "evimed-evidence-center", name: "EviMed 证据中心", platform: true } });
    mount();
    expect(await screen.findByText("平台出版方")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "EviMed 证据中心" })).toBeInTheDocument();
  });

  it("offers a title filter only over a longer list, and says when nothing matches", async () => {
    client.fetchEvidenceAuthor.mockResolvedValue({ ...author, cards: manyCards(8), totals: { cards: 8, followers: 0, runsFromCards: 0 } });
    const short = mount();
    await screen.findByRole("link", { name: "第 0 张证据卡" });
    expect(screen.queryByRole("searchbox", { name: "搜索证据卡" })).toBeNull();
    short.unmount();
    client.fetchEvidenceAuthor.mockResolvedValue({ ...author, cards: manyCards(9), totals: { cards: 30, followers: 0, runsFromCards: 0 } });
    mount();
    await screen.findByRole("link", { name: "第 0 张证据卡" });
    expect(screen.getByText("共 30 张，这里列出最近的 9 张。")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索证据卡" }), "房颤");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "房颤抗凝的剂量" })).toBeInTheDocument();
    expect(screen.queryByText(/共 30 张/)).toBeNull();
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索证据卡" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索证据卡" }), "没有这个");
    expect(screen.getByText("没有找到匹配的证据卡。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(9);
    // The filter belongs to the cards: on the zones' tab there is no box.
    await userEvent.click(screen.getByRole("tab", { name: /专区/ }));
    expect(screen.queryByRole("searchbox", { name: "搜索证据卡" })).toBeNull();
  });

  it("shows a doctor's or a company's producer and the people their cards name, with affiliation and title, and nothing for an account that set none", async () => {
    client.fetchEvidenceAuthor.mockResolvedValue({
      ...author,
      producer: { kind: "enterprise", name: "Acme Pharma", relation: "own_product", products: ["Drug A"] },
      people: [{ name: "李医生", affiliation: "协和医院 心内科", title: "主任医师 · 心血管" }, { name: "王药师", affiliation: null, title: "药师" }],
    });
    const shown = mount();
    expect(await screen.findByText(/出品方：企业 Acme Pharma/)).toHaveTextContent("Drug A");
    expect(screen.getByText("卡片里署名的作者和审核人：李医生，协和医院 心内科，主任医师 · 心血管；王药师，药师")).toBeInTheDocument();
    shown.unmount();
    client.fetchEvidenceAuthor.mockResolvedValue(author);
    mount();
    await screen.findByRole("heading", { level: 1, name: "李研究" });
    expect(screen.queryByText(/出品方/)).not.toBeInTheDocument();
    expect(screen.queryByText(/署名的作者和审核人/)).not.toBeInTheDocument();
  });
  it("says an author with nothing published has no page, by the server's own code", async () => {
    client.fetchEvidenceAuthor.mockRejectedValue(new WebApiError("none", { status: 404, code: "evidence_author_not_found" }));
    mount();
    expect(await screen.findByText("这位作者还没有公开的内容")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });
  it("shows a failed read with a retry, and the skeleton while it loads", async () => {
    client.fetchEvidenceAuthor.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(author);
    const { container } = mount();
    expect(container.querySelector("[aria-busy], .animate-pulse")).not.toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { level: 1, name: "李研究" })).toBeInTheDocument();
  });
  it("says an empty card list plainly", async () => {
    client.fetchEvidenceAuthor.mockResolvedValue({ ...author, cards: [] });
    mount();
    expect(await screen.findByText("暂无已发布的证据卡。")).toBeInTheDocument();
  });
});
