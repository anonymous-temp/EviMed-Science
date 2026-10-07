import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontierDetails, frontierDetailsOffered } from "./FrontierDetails";
import { frontierItem } from "./__fixtures__/frontierItems";

const client = vi.hoisted(() => ({ fetchFrontierAbstractZh: vi.fn(), fetchFrontierItem: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), ...client }));

beforeEach(() => { client.fetchFrontierAbstractZh.mockReset(); client.fetchFrontierItem.mockReset(); });
const open = (overrides: Record<string, unknown> = {}) => render(<MemoryRouter><FrontierDetails item={frontierItem(overrides)} onClose={() => {}} /></MemoryRouter>);
const preprint = { sourceType: "preprint", evidenceType: "preprint", evidenceTypeLabel: "预印本", flags: [{ key: "preprint" }] };

describe("what the drawer says the item is", () => {
  it("is the card's own words first: 「性质 预印本 · 未经同行评议」", async () => {
    client.fetchFrontierAbstractZh.mockResolvedValue({ abstractZh: "中文摘要正文。", abstract: null, note: null });
    open(preprint);
    const rows = screen.getByRole("dialog").querySelectorAll("dl > div");
    expect(rows[0]).toHaveTextContent("性质预印本 · 未经同行评议");
    expect(await screen.findByText("中文摘要正文。")).toBeInTheDocument();
  });

  it("is the evidence type alone for a trial, and no row for an item that has neither a type nor a flag", async () => {
    client.fetchFrontierAbstractZh.mockResolvedValue({ abstractZh: null, abstract: null, note: null });
    const { unmount } = open();
    await act(async () => {});
    expect(screen.getByRole("dialog")).toHaveTextContent("性质RCT");
    unmount();
    open({ evidenceType: null, evidenceTypeLabel: null, flags: [] });
    await act(async () => {});
    expect(screen.getByRole("dialog")).not.toHaveTextContent("性质");
  });
});

describe("the abstract section", () => {
  it("has no heading and no 「无摘要」 when there is nothing to read", async () => {
    client.fetchFrontierAbstractZh.mockResolvedValue({ abstractZh: null, abstract: null, note: null });
    open(preprint);
    await act(async () => {});
    expect(client.fetchFrontierAbstractZh).toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "中文摘要" })).not.toBeInTheDocument();
    expect(screen.queryByText("无摘要")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "原文摘要" })).not.toBeInTheDocument();
  });

  it("is headed 「中文摘要」 when the shared Chinese abstract is there and 「原文摘要」 when only the original is", async () => {
    client.fetchFrontierAbstractZh.mockResolvedValue({ abstractZh: null, abstract: "Background: original.", note: null });
    open(preprint);
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("heading", { name: "原文摘要" })).toBeInTheDocument();
    expect(within(dialog).getByText("Background: original.")).toBeInTheDocument();
  });
});

describe("whether the card should offer the drawer", () => {
  const plain = { sourceType: "media", titleZh: null, doi: null, pmid: null, facts: {}, openAccess: null };
  it("is no for a report with nothing to add, and yes for each thing it could add", () => {
    expect(frontierDetailsOffered(frontierItem(plain))).toBe(false);
    expect(frontierDetailsOffered(frontierItem({ ...plain, sourceType: "preprint" }))).toBe(true);
    expect(frontierDetailsOffered(frontierItem({ ...plain, doi: "10.1/x" }))).toBe(true);
    expect(frontierDetailsOffered(frontierItem({ ...plain, facts: { journal: "NEJM" } }))).toBe(true);
    expect(frontierDetailsOffered(frontierItem({ ...plain, titleRaw: "Original", titleZh: "译名" }))).toBe(true);
    expect(frontierDetailsOffered(frontierItem({ ...plain, openAccess: { status: "gold", pdfUrl: "https://europepmc.org/x.pdf" } }))).toBe(true);
    // A paper that says it has no abstract has nothing to read.
    expect(frontierDetailsOffered(frontierItem({ ...plain, sourceType: "journal", flags: [{ key: "no-abstract", label: "无摘要" }] }))).toBe(false);
  });
});
