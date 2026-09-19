import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { WebReadPage } from "@/lib/apiClient";
import { pageForSource, readPagesSummary, snapshotHref } from "@/lib/readPages";
import { parseClaimMatrix } from "@/lib/claimCitations";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { ReadPageCard, ReadPagesList } from "./ReadPages";

const nmpaSnapshot = `.evimed-sources/web-pages/${"a".repeat(16)}/${"c".repeat(64)}/page.md`;
const nmpa: WebReadPage = {
  url: "https://www.nmpa.gov.cn/xxgk/ggtg/index.html",
  finalUrl: "https://www.nmpa.gov.cn/xxgk/ggtg/index.html",
  title: "国家药监局关于修订二甲双胍说明书的公告（2026年第91号）",
  site: "www.nmpa.gov.cn",
  fetchedAt: "2026-09-20T02:00:00.000Z",
  official: true,
  rendered: true,
  snapshotPath: nmpaSnapshot,
  sha256: "a".repeat(64),
};
const blog: WebReadPage = {
  url: "http://short.example.org/r",
  finalUrl: "https://blog.example.org/a-very-long-path/that/wraps/on/a/phone",
  title: "A blog post",
  site: "blog.example.org",
  fetchedAt: "2026-09-20T02:05:00.000Z",
  official: false,
  rendered: false,
  sha256: "b".repeat(64),
};

describe("the pages a run read", () => {
  it("each card links the original, names the site and time, labels an authority, and opens the snapshot", () => {
    render(<MemoryRouter><ReadPageCard page={nmpa} runId="run_1" /></MemoryRouter>);
    const original = screen.getByRole("link", { name: /国家药监局关于修订二甲双胍说明书的公告/ });
    expect(original).toHaveAttribute("href", nmpa.finalUrl);
    expect(original).toHaveAttribute("target", "_blank");
    expect(screen.getByText("官方来源")).toBeInTheDocument();
    expect(screen.getByText("www.nmpa.gov.cn")).toBeInTheDocument();
    expect(screen.getByText("页面由浏览器打开后读取")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看保存的快照" })).toHaveAttribute("href", snapshotHref("run_1", nmpaSnapshot));
    expect(document.querySelector("time")).toHaveAttribute("dateTime", nmpa.fetchedAt);
  });

  it("a page that is not an authority's carries no label, and one without a snapshot offers none", () => {
    render(<MemoryRouter><ReadPageCard page={blog} runId="run_1" /></MemoryRouter>);
    expect(screen.queryByText("官方来源")).toBeNull();
    expect(screen.queryByText("页面由浏览器打开后读取")).toBeNull();
    expect(screen.queryByRole("link", { name: "查看保存的快照" })).toBeNull();
    // The link goes where the bytes came from, not where the run asked.
    expect(screen.getByRole("link", { name: /A blog post/ })).toHaveAttribute("href", blog.finalUrl);
  });

  it("an address that is not http(s) is shown, never linked", () => {
    render(<MemoryRouter><ReadPageCard page={{ ...blog, url: "javascript:alert(1)", finalUrl: "javascript:alert(1)" }} runId="run_1" /></MemoryRouter>);
    expect(screen.getByText("A blog post")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /A blog post/ })).toBeNull();
  });

  it("the list says how many more were read than it shows", () => {
    render(<MemoryRouter><ReadPagesList pages={[nmpa, blog]} total={30} runId="run_1" /></MemoryRouter>);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("另有 28 个网页未列出，完整记录在本次运行的对话记录里。")).toBeInTheDocument();
  });

  it("the summary counts authorities only over a complete list", () => {
    expect(readPagesSummary([nmpa, blog])).toBe("已阅读的网页 2 个（官方来源 1 个）");
    expect(readPagesSummary([nmpa, blog], 30)).toBe("已阅读的网页 30 个");
    expect(readPagesSummary([blog])).toBe("已阅读的网页 1 个");
  });

  it("a claim's source is matched to the page by its snapshot, else by its address", () => {
    expect(pageForSource([nmpa, blog], { artifactPath: nmpaSnapshot })).toBe(nmpa);
    expect(pageForSource([nmpa, blog], { sourceUrl: "https://blog.example.org/a-very-long-path/that/wraps/on/a/phone" })).toBe(blog);
    expect(pageForSource([nmpa, blog], { sourceUrl: "http://short.example.org/r" })).toBe(blog);
    expect(pageForSource([nmpa, blog], { artifactPath: ".evimed-sources/PMC1/fulltext.md", sourceUrl: "https://europepmc.org/x" })).toBeNull();
    expect(pageForSource(undefined, { artifactPath: nmpaSnapshot })).toBeNull();
  });
});

describe("the 依据 popover shows the page a quotation was read from", () => {
  it("names the page, its site and its authority beside the quotation, without a second snapshot link", async () => {
    const claims = parseClaimMatrix(JSON.stringify({ claims: [{
      claimId: "CLM-001", claim: "二甲双胍说明书已修订乳酸酸中毒警示。", claimType: "direct", accessLevel: "official_page",
      sourceTitle: "国家药监局公告", sourceUrl: nmpa.finalUrl, artifactPath: nmpaSnapshot, supportQuote: "修订乳酸酸中毒警示",
    }] }));
    render(
      <MemoryRouter>
        <MarkdownViewer variant="document" claims={claims} reading={{ runId: "run_1", pagesRead: [nmpa, blog] }}>
          {"说明书已修订 [1]<!-- claim:CLM-001 -->。"}
        </MarkdownViewer>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: /查看这句话的依据/ }));
    const dialog = await screen.findByText("二甲双胍说明书已修订乳酸酸中毒警示。");
    const popover = dialog.closest("[data-radix-popper-content-wrapper]") ?? document.body;
    expect(within(popover as HTMLElement).getByText("官方来源")).toBeInTheDocument();
    expect(within(popover as HTMLElement).getByText("页面由浏览器打开后读取")).toBeInTheDocument();
    // The quotation's own link opens the same snapshot at the quote.
    expect(within(popover as HTMLElement).getByRole("link", { name: /在保存的原文中定位这段引文/ })).toBeInTheDocument();
    expect(within(popover as HTMLElement).queryByRole("link", { name: "查看保存的快照" })).toBeNull();
  });
});
