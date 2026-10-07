import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { card, zone } from "@/components/frontier/__fixtures__/evidenceCards";
import { EvidenceReadingPage } from "./EvidenceReadingPage";

const client = vi.hoisted(() => ({
  fetchEvidenceZone: vi.fn(), fetchZoneEvidence: vi.fn(), fetchEvidenceCardLinks: vi.fn(), continueResearchFromCard: vi.fn(),
  prepareEvidenceResearch: vi.fn(), publishEvidenceCard: vi.fn(),
}));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));
vi.mock("@/lib/projects", () => ({ useProjectStore: { getState: () => ({ select: async (_id: string, land?: () => void) => { land?.(); } }) } }));

const mount = (search = "") => render(
  <MemoryRouter initialEntries={[`/app/frontier/zones/ez_1/evidence/${card.id}${search}`]}>
    <Routes><Route path="/app/frontier/zones/:zoneId/evidence/:cardId" element={<EvidenceReadingPage />} /></Routes>
  </MemoryRouter>,
);
beforeEach(() => {
  vi.clearAllMocks();
  client.fetchEvidenceZone.mockResolvedValue(zone);
  client.fetchZoneEvidence.mockResolvedValue(card);
  client.fetchEvidenceCardLinks.mockResolvedValue({ author: { id: "alice", name: "李研究" }, origin: null, previous: null, related: [] });
});

describe("reading an evidence card", () => {
  it("is headed by the way back to 前沿动态, with no row of the feed's views above the card", async () => {
    mount();
    await screen.findByTestId("evidence-card-header");
    expect(within(screen.getByRole("navigation", { name: "返回" })).getByRole("link", { name: "前沿动态" })).toHaveAttribute("href", "/app/frontier");
    expect(screen.queryByRole("navigation", { name: "前沿动态" })).toBeNull();
    expect(screen.getByRole("link", { name: /^返回/ })).toBeInTheDocument();
  });


  it("opens with who made it and the labels, then the two views, the claims with their marks, and the disclosure", async () => {
    mount();
    const header = await screen.findByTestId("evidence-card-header");
    expect(header).toHaveTextContent("出品方 李研究 · 用户 · 与所涉产品无利益关系");
    expect(screen.getByText("核验 1/2")).toBeInTheDocument();
    // The producer line is the first thing in the article.
    expect(header.closest("article")?.querySelector("header")?.firstElementChild).toBe(header);
    expect(screen.getByRole("radio", { name: "临床版" })).toBeChecked();
    expect(screen.getByRole("table", { name: "结局总结表" })).toBeInTheDocument();
    expect(screen.getByLabelText("已核验")).toBeInTheDocument();
    expect(screen.getByLabelText("未能核验")).toBeInTheDocument();
    expect(screen.getByText("披露")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "公众版" }));
    expect(screen.getByText("每 1000 人里")).toBeInTheDocument();
  });
  it("offers 用这张卡继续研究 beside 问这条证据, and the author's page", async () => {
    mount();
    expect(await screen.findByRole("button", { name: "用这张卡继续研究" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "问这条证据" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "李研究" })).toHaveAttribute("href", "/app/frontier/authors/alice");
  });
  it("does not offer continuing on a card that may not be researched", async () => {
    client.fetchZoneEvidence.mockResolvedValue({ ...card, canResearch: false });
    mount();
    await screen.findByTestId("evidence-card-header");
    expect(screen.queryByRole("button", { name: "用这张卡继续研究" })).not.toBeInTheDocument();
  });
  it("opens a draft made from a result straight in the card editor, for its owner only", async () => {
    client.fetchZoneEvidence.mockResolvedValue({ ...card, state: "draft", canEdit: true });
    const owner = mount("?edit=1");
    expect(await screen.findByLabelText("证据标题")).toBeInTheDocument();
    owner.unmount();
    client.fetchZoneEvidence.mockResolvedValue({ ...card, canEdit: false });
    mount("?edit=1");
    await screen.findByTestId("evidence-card-header");
    expect(screen.queryByLabelText("证据标题")).not.toBeInTheDocument();
  });
});
