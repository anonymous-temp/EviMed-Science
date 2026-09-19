import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { ReportReader } from "./ReportReader";

const mocks = vi.hoisted(() => ({
  readArtifact: vi.fn(),
  readClaimVerification: vi.fn(),
  downloadArtifact: vi.fn(),
}));

vi.mock("@/lib/artifactFile", () => ({
  readArtifact: mocks.readArtifact,
  readClaimVerification: mocks.readClaimVerification,
  downloadArtifact: mocks.downloadArtifact,
}));

const REPORT_PATH = "deliverables/d1/clinical-evidence-report.md";
const MATRIX_PATH = "deliverables/d1/clinical-evidence-matrix.json";

const report = [
  "## 摘要",
  "阿司匹林一级预防在 ≥70 岁人群中不降低主要心血管事件 [1]<!-- claim:CLM-001 -->。",
  "## 结果",
  "### 出血",
  "大出血风险增加 [1]<!-- claim:CLM-002 -->。",
  "## 局限性",
  "纳入试验以欧美人群为主。",
].join("\n\n");

const matrix = {
  claims: [
    { claimId: "CLM-001", claim: "不降低主要心血管事件。", claimType: "direct", referenceNumber: 1, sourceType: "rct",
      sourceTitle: "ASPREE", artifactPath: ".evimed-sources/aspree/fulltext.md", supportQuote: "did not result in a significantly lower risk" },
    { claimId: "CLM-002", claim: "大出血风险增加。", claimType: "direct", referenceNumber: 1, sourceType: "rct",
      sourceTitle: "ASPREE", artifactPath: ".evimed-sources/aspree/fulltext.md", supportQuote: "higher risk of major hemorrhage" },
  ],
};

function run(over: Partial<WebAgentRun> = {}): WebAgentRun {
  return { id: "run_1", sessionId: "ses_1", status: "succeeded", model: "deepseek-flash", startedAt: "2026-09-17T02:00:00Z",
    finishedAt: "2026-09-17T02:30:00Z", artifacts: [REPORT_PATH, MATRIX_PATH], qualityNotices: [], ...over } as WebAgentRun;
}

function renderReader(props: Partial<Parameters<typeof ReportReader>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ReportReader path={REPORT_PATH} text={report} layout="page" run={run()} runId="run_1" {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readArtifact.mockImplementation(async (path: string) =>
    path === MATRIX_PATH ? { path, mime: "application/json", encoding: "utf8", size: 1, data: JSON.stringify(matrix) } : null);
  mocks.readClaimVerification.mockResolvedValue({
    claims: [
      { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: ".evimed-sources/aspree/fulltext.md", status: "verified" }] },
      { claimId: "CLM-002", claimType: "direct", status: "quote_not_found", sources: [{ artifactPath: ".evimed-sources/aspree/fulltext.md", status: "quote_not_found" }] },
    ],
    counts: { verified: 1, quote_not_found: 1 },
  });
});

describe("ReportReader", () => {
  // Plan §5 act 4: the four facts a clinical reader weighs before reading,
  // 「未注明」 where the package is silent — never a date read out of prose.
  it("states the report's facts above it, dating a silent package's search by its run", async () => {
    renderReader();
    const facts = await screen.findByText("检索截止日");
    const list = facts.closest("dl")!;
    expect(within(list).getByText("检索截止日").nextElementSibling).toHaveTextContent(/年.*月.*日（按检索执行日）/);
    await waitFor(() => expect(within(list).getByText("来源范围").nextElementSibling).toHaveTextContent("RCT 1（共 1 个来源）"));
    expect(within(list).getByText("模型").nextElementSibling).toHaveTextContent("DeepSeek · deepseek-flash");
    expect(within(list).getByRole("button", { name: "见正文「局限性」一节" })).toBeInTheDocument();
    expect(within(list).getByText("生成日期").nextElementSibling).toHaveTextContent("2026年9月17日");
  });

  it("marks each sentence ✓ or ⚠, and says which quotation to check", async () => {
    renderReader();
    const ok = await screen.findByRole("button", { name: "查看这句话的依据（1 条主张，引文均已核对）" });
    expect(ok).toHaveTextContent("依据 ✓");
    const check = screen.getByRole("button", { name: "查看这句话的依据（1 条主张，其中有未核对上的引文）" });
    expect(check).toHaveTextContent("依据 ⚠");
    await userEvent.click(check);
    expect(await screen.findByText(/这段引文没有在保存的原文中找到：请打开原文核对措辞与数字。/)).toBeInTheDocument();
    // The kind of source, and the way to the preserved original.
    expect(screen.getAllByText("RCT").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /在保存的原文中定位这段引文/ })).toHaveAttribute(
      "href",
      "/app/runs/run_1/files/.evimed-sources/aspree/fulltext.md?quote=higher%20risk%20of%20major%20hemorrhage",
    );
  });

  it("lists the report's sections, and says how much of it was checked", async () => {
    renderReader();
    const toc = await screen.findByRole("navigation", { name: "目录" });
    expect(within(toc).getAllByRole("button").map((button) => button.textContent)).toEqual(["摘要", "结果", "出血", "局限性"]);
    expect(await screen.findByRole("note")).toHaveTextContent("本报告 2 条主张");
  });

  // One table of contents at a time: a column beside a wide page, folded
  // above the report on a phone or a tablet, where the column has no room.
  it("puts the contents beside a wide page and folds them above the report on a narrow one", async () => {
    const wide = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query === "(min-width: 1024px)", media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    }) as unknown as MediaQueryList);
    const first = renderReader();
    const column = await screen.findByRole("navigation", { name: "目录" });
    expect(column.closest("aside")).not.toBeNull();
    expect(screen.getByRole("button", { name: "回到顶部" })).toBeInTheDocument();
    first.unmount();
    wide.mockRestore();

    renderReader();
    const folded = await screen.findByRole("navigation", { name: "目录" });
    expect(folded.closest("details")).not.toBeNull();
    expect(screen.getByText("目录 · 4 节")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回到顶部" })).toBeNull();
  });

  it("shows the evidence matrix as a table on its own tab", async () => {
    renderReader();
    await userEvent.click(await screen.findByRole("radio", { name: "证据矩阵（2）" }));
    const table = screen.getByRole("table", { name: "证据矩阵：2 条主张" });
    expect(within(table).getByRole("rowheader", { name: "CLM-002" })).toBeInTheDocument();
    expect(within(table).getByText("⚠ 原文中未找到")).toBeInTheDocument();
  });

  // C2: a clinical-safety finding's claim has its evidence open, above the text.
  it("opens the evidence of a claim a clinical-safety finding names", async () => {
    renderReader({ run: run({ qualityNotices: [{ code: "clinical_safety_rule", severity: "safety", title: "临床安全", claimId: "CLM-002", text: "SAFETY — x" }] }) });
    const safety = await screen.findByRole("heading", { name: /涉及临床安全的结论 · 1 条/ });
    const section = safety.closest("section")!;
    expect(within(section).getByText("大出血风险增加。")).toBeInTheDocument();
    expect(within(section).getByText("“higher risk of major hemorrhage”")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /，涉及临床安全）$/ })).toBeInTheDocument();
  });

  it("brings a claim named from outside into view and opens it", async () => {
    renderReader({ focusClaim: "CLM-002" });
    // The evidence opens as a dialog beside the sentence, focus inside it.
    const evidence = await screen.findByRole("dialog");
    expect(within(evidence).getByText("大出血风险增加。")).toBeInTheDocument();
    expect(evidence.contains(document.activeElement)).toBe(true);
  });

  it("downloads the Markdown and prints from a print copy", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    renderReader();
    await userEvent.click(await screen.findByRole("button", { name: "下载 Markdown" }));
    expect(mocks.downloadArtifact).toHaveBeenCalledWith(REPORT_PATH, undefined, "clinical-evidence-report.md");
    await userEvent.click(screen.getByRole("button", { name: "打印 / 存为 PDF" }));
    expect(print).toHaveBeenCalled();
  });

  it("gives a Markdown file that is not a report no report facts", async () => {
    render(<MemoryRouter><ReportReader path="notes/README.md" text={"## 说明\n\n文字。"} layout="pane" /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "说明" })).toBeInTheDocument();
    expect(screen.queryByText("检索截止日")).not.toBeInTheDocument();
  });

  it("marks where a quotation is in a preserved source, or says it is not there", async () => {
    const { unmount } = render(
      <MemoryRouter>
        <ReportReader path=".evimed-sources/aspree/fulltext.md" text={"The use of aspirin resulted in a higher risk of major hemorrhage."} layout="page" highlight="higher risk of major hemorrhage" />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("已在这份保存的原文里定位到引文");
    unmount();
    render(
      <MemoryRouter>
        <ReportReader path=".evimed-sources/aspree/fulltext.md" text={"The use of aspirin resulted in a higher risk."} layout="page" highlight="lower risk of stroke" />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("note")).toHaveTextContent("这段引文没有在这份保存的原文里找到");
  });
});
