import { render, screen } from "@testing-library/react";
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
const mount = () => render(<MemoryRouter initialEntries={["/app/frontier/authors/au_0123456789abcdef"]}><Routes><Route path="/app/frontier/authors/:authorId" element={<EvidenceAuthorPage />} /></Routes></MemoryRouter>);
beforeEach(() => vi.clearAllMocks());

describe("an author's page", () => {
  it("shows the author's zones and cards and names the one citation signal for what it is", async () => {
    client.fetchEvidenceAuthor.mockResolvedValue(author);
    mount();
    expect(await screen.findByRole("heading", { name: "李研究" })).toBeInTheDocument();
    expect(client.fetchEvidenceAuthor).toHaveBeenCalledWith("au_0123456789abcdef");
    expect(screen.getByText("2 张已发布证据卡 · 3 位关注者 · 别人的研究由这位作者的卡片发起了 5 次")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "卒中研究" })).toHaveAttribute("href", "/app/frontier/zones/ez_1");
    expect(screen.getByText("用户专区 · 2 条证据 · 3 人关注")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "试验药能预防卒中吗" })).toHaveAttribute("href", "/app/frontier/zones/ez_1/evidence/ec_1");
    expect(screen.getByText(/3 条结论/)).toBeInTheDocument();
    expect(screen.queryByText("最近的变更")).not.toBeInTheDocument();
    expect(screen.queryByText(/排名|排行/)).not.toBeInTheDocument();
  });
  it("marks the platform publisher and lists the change log when the deployment keeps one", async () => {
    client.fetchEvidenceAuthor.mockResolvedValue({ ...author, author: { id: "evimed-evidence-center", name: "EviMed 证据中心", platform: true }, changes: [{ id: "c1", summary: "更正了一处数字", occurredAt: "2026-10-05T00:00:00Z" }] });
    mount();
    expect(await screen.findByText("平台出版方")).toBeInTheDocument();
    expect(screen.getByText("最近的变更")).toBeInTheDocument();
    expect(screen.getByText(/更正了一处数字/)).toBeInTheDocument();
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
    await screen.findByRole("heading", { name: "李研究" });
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
    expect(await screen.findByRole("heading", { name: "李研究" })).toBeInTheDocument();
  });
  it("says an empty card list plainly", async () => {
    client.fetchEvidenceAuthor.mockResolvedValue({ ...author, cards: [] });
    mount();
    expect(await screen.findByText("暂无已发布的证据卡。")).toBeInTheDocument();
  });
});
