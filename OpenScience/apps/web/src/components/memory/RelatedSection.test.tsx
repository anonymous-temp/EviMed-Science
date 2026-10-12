import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordLinks } from "@/lib/memoryMapClient";
import { RelatedSection } from "./RelatedSection";

const fetchRecordLinks = vi.fn();
vi.mock("@/lib/memoryMapClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/memoryMapClient")>("@/lib/memoryMapClient")),
  fetchRecordLinks: (...args: unknown[]) => fetchRecordLinks(...args),
}));

const empty: RecordLinks = { rests: [], replaced: [], replacedBy: null, conflicts: [], usedIn: [] };
const links: RecordLinks = {
  rests: [
    { type: "knowledge_source", id: "src_1", state: "changed", title: "GOLD 指南", href: "/app/files/src_1" },
    { type: "doi", id: "10.1056/nejmoa2034577", state: "retracted", title: "10.1056/nejmoa2034577", href: "https://doi.org/10.1056/nejmoa2034577" },
    { type: "evidence_card", id: "card_1", state: "unknown", title: null, href: null },
  ],
  replaced: [{ id: "old", kind: "decision", status: "superseded", sensitive: false, text: "纳入 ≥16 岁", from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" }],
  replacedBy: { id: "new", kind: "decision", status: "active", sensitive: false, text: "纳入 ≥18 岁", from: "2026-09-01T00:00:00.000Z", to: null },
  conflicts: [{ id: "foe", kind: "decision", status: "active", sensitive: true, text: "", from: null, to: null }],
  usedIn: [{ sessionId: "ses_1", projectId: "prj_a", title: "心衰指南", at: "2026-10-01T00:00:00.000Z" }],
};

const view = (props: Partial<Parameters<typeof RelatedSection>[0]> = {}) => render(<MemoryRouter><RelatedSection recordId="rec_1" {...props} /></MemoryRouter>);

beforeEach(() => fetchRecordLinks.mockReset().mockResolvedValue(links));
afterEach(cleanup);

describe("关联", () => {
  it("says what the memory rests on with what a check found, what it replaced and what replaced it, who it disagrees with, and where it was used", async () => {
    view();
    expect(await screen.findByText("关联")).toBeInTheDocument();
    expect(fetchRecordLinks).toHaveBeenCalledWith("rec_1");
    expect(screen.getByRole("link", { name: "依据：《GOLD 指南》（有更新）" })).toHaveAttribute("href", "/app/files/src_1");
    const doi = screen.getByRole("link", { name: "依据：论文 10.1056/nejmoa2034577（已撤回）" });
    expect(doi).toHaveAttribute("href", "https://doi.org/10.1056/nejmoa2034577");
    expect(doi).toHaveAttribute("target", "_blank");
    expect(screen.getByText("依据：一份证据卡")).toBeInTheDocument();
    expect(screen.getByText("替代了：“纳入 ≥16 岁”")).toBeInTheDocument();
    expect(screen.getByText("后来被替代为：“纳入 ≥18 岁”")).toBeInTheDocument();
    expect(screen.getByText("和它不一致：“这是一条敏感记忆”")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /用在对话：《心衰指南》/u })).toBeInTheDocument();
  });

  it("opens another memory in the drawer only where the page can, and never a sensitive one", async () => {
    const onOpenRecord = vi.fn();
    const user = userEvent.setup();
    view({ onOpenRecord, canOpen: (id) => id !== "old" });
    await user.click(await screen.findByRole("button", { name: "后来被替代为：“纳入 ≥18 岁”" }));
    expect(onOpenRecord).toHaveBeenCalledWith("new");
    expect(screen.queryByRole("button", { name: /替代了：/u })).toBeNull();
    expect(screen.getByText("替代了：“纳入 ≥16 岁”")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /和它不一致/u })).toBeNull();
  });

  it("is not there when there is nothing to say, or when it could not be read", async () => {
    fetchRecordLinks.mockResolvedValueOnce(empty);
    const first = view();
    await waitFor(() => expect(fetchRecordLinks).toHaveBeenCalled());
    expect(screen.queryByText("关联")).toBeNull();
    first.unmount();
    fetchRecordLinks.mockRejectedValueOnce(new Error("down"));
    view();
    await waitFor(() => expect(fetchRecordLinks).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("关联")).toBeNull();
  });

  it("says nothing about how often a memory was used", async () => {
    const { container } = view();
    await screen.findByText("关联");
    expect(container.textContent).not.toMatch(/用过\s*\d+\s*次|次数|来源未验证|推断/u);
  });
});
