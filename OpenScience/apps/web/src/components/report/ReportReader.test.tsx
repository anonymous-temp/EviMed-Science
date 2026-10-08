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
  // Two dates above a report (2026-09-23 inventory §1.11): when the search
  // stopped — the run's own start when the package is silent — and when it
  // was written. No model name, no tally, no 「未注明」 rows.
  it("states the search cutoff and the date written above the report, and nothing else", async () => {
    renderReader();
    const facts = await screen.findByText("检索截止日");
    const list = facts.closest("dl")!;
    expect(within(list).getByText("检索截止日").nextElementSibling).toHaveTextContent(/\d{4}年\d+月\d+日$/);
    expect(within(list).getByText("生成日期").nextElementSibling).toHaveTextContent("2026年9月17日");
    expect(within(list).queryByText(/模型|来源范围|已知局限/)).toBeNull();
  });

  it("marks each sentence ✓ or ⚠, and says which quotation to check", async () => {
    renderReader();
    const ok = await screen.findByRole("button", { name: "查看这句话的依据（1 条结论，引文均已核对）" });
    expect(ok).toHaveTextContent("依据 ✓");
    const check = screen.getByRole("button", { name: "查看这句话的依据（1 条结论，其中有未核对上的引文）" });
    expect(check).toHaveTextContent("依据 ⚠");
    await userEvent.click(check);
    const guidance = await screen.findByText(/这段引文没有在保存的原文中找到：请打开原文核对措辞与数字。/);
    // The way to the preserved original. Scoped to the popover: the source
    // cards below the report offer the same way in, from the other direction.
    const popover = guidance.closest("[data-claim-id]")!;
    expect(within(popover as HTMLElement).getByRole("link", { name: /定位原文/ })).toHaveAttribute(
      "href",
      "/app/runs/run_1/files/.evimed-sources/aspree/fulltext.md?quote=higher%20risk%20of%20major%20hemorrhage",
    );
  });

  it("lists the report's sections, and says how much of it was checked", async () => {
    renderReader();
    const toc = await screen.findByRole("navigation", { name: "目录" });
    expect(within(toc).getAllByRole("button").map((button) => button.textContent)).toEqual(["摘要", "结果", "出血", "局限性"]);
    expect(await screen.findByRole("note")).toHaveTextContent("⚠ 1 条待核对");
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
    await userEvent.click(await screen.findByRole("tab", { name: "证据矩阵 2" }));
    const table = screen.getByRole("table", { name: "证据矩阵：2 条结论" });
    expect(within(table).getByRole("rowheader", { name: "CLM-002" })).toBeInTheDocument();
    expect(within(table).getByText("⚠ 引文未在原文中找到")).toBeInTheDocument();
  });

  // 「未核对」 once stood for three things: the checks still on their way, the checks that could not be read, and a claim nobody checked.
  // The column is ✓, ⚠ or blank now, and 核对中 only while they are on their way.
  it("reads 核对中 on the matrix tab while the checks are on their way, and the marks once they arrive", async () => {
    let arrive!: (value: unknown) => void;
    mocks.readClaimVerification.mockReturnValue(new Promise((resolve) => { arrive = resolve; }));
    renderReader();
    await userEvent.click(await screen.findByRole("tab", { name: "证据矩阵 2" }));
    const table = screen.getByRole("table", { name: "证据矩阵：2 条结论" });
    expect(within(table).getAllByText("核对中")).toHaveLength(2);
    expect(within(table).queryByText("未核对")).toBeNull();
    arrive({
      claims: [{ claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: ".evimed-sources/aspree/fulltext.md", status: "verified" }] }],
      counts: { verified: 1 },
    });
    // The checks were read and the second claim is not among them: its cell is blank, not 未核对.
    expect(await within(table).findByText("✓ 引文已核对")).toBeInTheDocument();
    expect(within(table).queryByText("未核对")).toBeNull();
    expect(within(table).queryByText("核对中")).toBeNull();
  });

  it("shows an error row with 重试, not 暂无核对结果, when the checks cannot be read — and reads them again from it", async () => {
    mocks.readClaimVerification.mockRejectedValueOnce(new Error("offline"));
    renderReader();
    await userEvent.click(await screen.findByRole("tab", { name: "证据矩阵 2" }));
    const table = screen.getByRole("table", { name: "证据矩阵：2 条结论" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("核对结果暂时读取不到");
    expect(within(table).queryByText(/暂无核对结果|未核对|核对中/)).toBeNull();
    mocks.readClaimVerification.mockResolvedValue({
      claims: [{ claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: ".evimed-sources/aspree/fulltext.md", status: "verified" }] }],
      counts: { verified: 1 },
    });
    await userEvent.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await within(screen.getByRole("table", { name: "证据矩阵：2 条结论" })).findByText("✓ 引文已核对")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens a claim of the matrix tab in a drawer beside the report, with its quotation and check", async () => {
    renderReader();
    await userEvent.click(await screen.findByRole("tab", { name: "证据矩阵 2" }));
    await userEvent.click(await screen.findByRole("button", { name: "CLM-002" }));
    const drawer = await screen.findByRole("dialog", { name: "CLM-002" });
    expect(within(drawer).getByText("“higher risk of major hemorrhage”")).toBeInTheDocument();
    expect(within(drawer).getByText("⚠ 引文未在原文中找到")).toBeInTheDocument();
    expect(within(drawer).getByText(/这段引文没有在保存的原文中找到/)).toBeInTheDocument();
  });

  // On a phone the two text buttons wrapped onto a second row; the words drawn there are short, the names read out stay whole.
  it("draws 下载 and 打印 as short words beside the tabs on a phone, and names the actions in full", async () => {
    renderReader();
    const download = await screen.findByRole("button", { name: "下载 Markdown" });
    const print = screen.getByRole("button", { name: "打印 / 存为 PDF" });
    expect(within(download).getByText("下载")).toHaveClass("sm:hidden");
    expect(within(download).getByText("下载 Markdown")).toHaveClass("max-sm:hidden");
    expect(within(print).getByText("打印")).toHaveClass("sm:hidden");
    expect(within(print).getByText("打印 / 存为 PDF")).toHaveClass("max-sm:hidden");
    // The same row as the views: one toolbar holds the tabs and both actions.
    const tabs = await screen.findByRole("tablist", { name: "查看" });
    expect(tabs.parentElement).toBe(download.parentElement);
    expect(tabs.parentElement).toBe(print.parentElement);
  });

  // Chromium focuses a scroller by itself; WebKit and Firefox on the Mac do not, so a wide table in the text says it is a region.
  it("lets a keyboard reader into a table in the report that is wider than the page", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    renderReader({ text: `${report}\n\n| 指标 | 数值 |\n| --- | --- |\n| 大出血 | 1.4 |\n` });
    // The text re-renders once the matrix and the checks arrive and replaces the table: read it after that.
    await screen.findByRole("button", { name: "查看这句话的依据（1 条结论，其中有未核对上的引文）" });
    await waitFor(() => {
      const region = screen.getByRole("region", { name: "表格" });
      expect(region).toHaveAttribute("tabindex", "0");
      expect(within(region).getByRole("table")).toBeInTheDocument();
    });
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
    // A located quotation is its own highlight; nothing is said about it.
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
    unmount();
    render(
      <MemoryRouter>
        <ReportReader path=".evimed-sources/aspree/fulltext.md" text={"The use of aspirin resulted in a higher risk."} layout="page" highlight="lower risk of stroke" />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("note")).toHaveTextContent("未找到这段引文");
  });
});

describe("version-bound report evidence", () => {
  function version(review?: import("@/lib/resultProvenance").ResultVersion["review"]): import("@/lib/resultProvenance").ResultVersion {
    return { artifactId: "a", versionId: "rv_old", projectId: "default", path: REPORT_PATH, digest: "a".repeat(64), size: 1,
      mimeType: "text/markdown", capturedAt: "2026-10-01T00:00:00Z", producer: { kind: "deliverable", runId: "run_1" },
      inputs: [{ kind: "source", id: "source", path: ".evimed-sources/aspree/fulltext.md", versionId: "rv_source", digest: "b".repeat(64), availability: "captured" }],
      code: null, environment: null, findings: [], machineValues: [], coverage: { snapshot: "complete", producer: "bound", inputs: "captured", code: "unknown", environment: "unknown", gaps: [] }, supersedesVersionId: null, review };
  }
  it("never borrows the current matrix or verification for old report bytes", () => {
    renderReader({ immutableVersion: version() });
    expect(mocks.readArtifact).not.toHaveBeenCalled();
    expect(mocks.readClaimVerification).not.toHaveBeenCalled();
    expect(screen.getByText(/此版本尚无可读取的逐句证据核对记录/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /引文均已核对/ })).toBeNull();
  });
  it("opens the quotation and the exact source version from a frozen review", async () => {
    renderReader({ immutableVersion: version({ status: "available", matrixText: JSON.stringify(matrix),
      verification: { claims: [{ claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: ".evimed-sources/aspree/fulltext.md", status: "verified" }] }], counts: { verified: 1 } } }) });
    await userEvent.click(screen.getByRole("button", { name: "查看这句话的依据（1 条结论，引文均已核对）" }));
    const quotes = await screen.findAllByText(/did not result in a significantly lower risk/, { selector: "mark" });
    const entry = quotes.map((quote) => quote.closest("[data-claim-id]")).find(Boolean)!;
    expect(within(entry as HTMLElement).getByRole("link", { name: /定位原文/ })).toHaveAttribute("href", "/app/runs/run_1/files/.evimed-sources/aspree/fulltext.md?quote=did%20not%20result%20in%20a%20significantly%20lower%20risk&version=rv_source");
    expect(mocks.readArtifact).not.toHaveBeenCalled();
    expect(mocks.readClaimVerification).not.toHaveBeenCalled();
  });
  it("leaves the check column of an old version blank where its checks are not there, instead of calling the claims unchecked", async () => {
    renderReader({ immutableVersion: version({ status: "available", matrixText: JSON.stringify(matrix) }) });
    await userEvent.click(await screen.findByRole("tab", { name: "证据矩阵 2" }));
    const table = screen.getByRole("table", { name: "证据矩阵：2 条结论" });
    expect(within(table).queryByText(/暂无核对结果|未核对|核对中/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("shows the frozen checks on the matrix tab of an old version", async () => {
    renderReader({ immutableVersion: version({ status: "available", matrixText: JSON.stringify(matrix),
      verification: { claims: [{ claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: ".evimed-sources/aspree/fulltext.md", status: "verified" }] }], counts: { verified: 1 } } }) });
    await userEvent.click(await screen.findByRole("tab", { name: "证据矩阵 2" }));
    const table = screen.getByRole("table", { name: "证据矩阵：2 条结论" });
    expect(within(table).getByText("✓ 引文已核对")).toBeInTheDocument();
    // Read, and the second claim is not in them: blank.
    expect(within(table).queryByText("未核对")).toBeNull();
  });
  it("does not offer a current-workspace source link when its old snapshot is absent", async () => {
    const selected = version({ status: "available", matrixText: JSON.stringify(matrix) }); selected.inputs = [];
    renderReader({ immutableVersion: selected });
    await userEvent.click(screen.getAllByRole("button", { name: /查看这句话的依据/ })[0]);
    const popover = (await screen.findAllByText(/did not result in a significantly lower risk/, { selector: "mark" })).map((quote) => quote.closest("[data-claim-id]")).find(Boolean)!;
    expect(within(popover as HTMLElement).queryByRole("link", { name: /定位原文/ })).toBeNull();
  });
});
