import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { FrontierTagsCard } from "./FrontierTagsCard";

const client = vi.hoisted(() => ({ fetchFrontierOpsTags: vi.fn(), undoFrontierTagChange: vi.fn() }));
vi.mock("@/lib/frontierClient", async (original) => ({ ...(await original<typeof import("@/lib/frontierClient")>()), ...client }));

const tree = () => ({
  specialties: [
    { key: "oncology", label: "肿瘤", tags: [{ slug: "hcc", name: "肝细胞癌", state: "active", count30d: 34, origin: "seed" }, { slug: "nsclc", name: "非小细胞肺癌", state: "candidate", count30d: 5, origin: "model" }] },
    { key: "pediatrics", label: "儿科", tags: [] },
  ],
  candidates: [{ slug: "car-t", name: "CAR-T 细胞治疗", count30d: 5, sources30d: 3, firstSeen: "2026-10-20T02:00:00Z" }],
  changes: [
    { id: "7", at: "2026-10-22T02:00:00Z", action: "merge", tag: { slug: "liver-cell-cancer", name: "肝细胞性肝癌" }, other: { slug: "hcc", name: "肝细胞癌" }, reason: "同义", undoable: true },
    { id: "8", at: "2026-10-22T03:00:00Z", action: "no-such-action", tag: { slug: "some-tag", name: "某标签" }, other: null, reason: null, undoable: false },
  ],
});

beforeEach(() => {
  client.fetchFrontierOpsTags.mockReset();
  client.undoFrontierTagChange.mockReset();
});

describe("「前沿标签」 in 运维", () => {
  it("lists each specialty's tags with their 30-day counts, the tags not in use yet, and the recent changes in words", async () => {
    client.fetchFrontierOpsTags.mockResolvedValue(tree());
    render(<FrontierTagsCard />);
    const specialties = await screen.findByRole("list", { name: "各专科的标签" });
    const rows = within(specialties).getAllByRole("listitem");
    // A specialty with no tags has no row.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("肿瘤肝细胞癌 34、非小细胞肺癌（待启用） 5");
    expect(within(screen.getByRole("list", { name: "待启用的标签" })).getByRole("listitem")).toHaveTextContent("CAR-T 细胞治疗5 条 · 3 个来源");
    const changes = within(screen.getByRole("list", { name: "最近的调整" })).getAllByRole("listitem");
    expect(changes[0]).toHaveTextContent("合并 肝细胞性肝癌 → 肝细胞癌");
    // An action this build does not know is said in a word, never as its code.
    expect(changes[1]).toHaveTextContent("调整 某标签");
    expect(changes[1]).not.toHaveTextContent("no-such-action");
    expect(within(changes[1]).queryByRole("button", { name: "撤回" })).not.toBeInTheDocument();
  });

  it("takes a change back with 撤回 and reads the tree again", async () => {
    client.fetchFrontierOpsTags.mockResolvedValue(tree());
    client.undoFrontierTagChange.mockResolvedValue(undefined);
    render(<FrontierTagsCard />);
    const changes = await screen.findByRole("list", { name: "最近的调整" });
    await userEvent.click(within(changes).getByRole("button", { name: "撤回" }));
    expect(client.undoFrontierTagChange).toHaveBeenCalledWith("7");
    await waitFor(() => expect(client.fetchFrontierOpsTags).toHaveBeenCalledTimes(2));
  });

  it.each(["frontier_not_enabled", "not_found", "frontier_tags_unavailable"])("is not there where the server answers %s", async (code) => {
    client.fetchFrontierOpsTags.mockRejectedValue(new WebApiError("absent", { status: 404, code }));
    const { container } = render(<FrontierTagsCard />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
