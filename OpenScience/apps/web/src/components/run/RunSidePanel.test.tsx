import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { webRunOutcome } from "@/lib/runPresentation";
import { RunSidePanel } from "./RunSidePanel";

const mocks = vi.hoisted(() => ({
  runs: [] as WebAgentRun[],
  listWebAgentRuns: vi.fn(),
  downloadArtifact: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  listWebAgentRuns: mocks.listWebAgentRuns,
}));
vi.mock("@/lib/artifactFile", () => ({
  downloadArtifact: (path: string, root?: string) => mocks.downloadArtifact(path, root),
}));

/** `unverifiedArtifacts` is the ledger field that lists what a refused run
 *  wrote. It is landing on the server in parallel and is not on `WebAgentRun`
 *  yet, so the fixture carries it alongside — which is also the shape the
 *  panel has to survive in production while older records lack it. */
function run(overrides: Partial<WebAgentRun> & { id: string; unverifiedArtifacts?: string[] }): WebAgentRun {
  return {
    dispatchId: null,
    question: null,
    dispatchStatus: "accepted",
    sessionId: `ses-${overrides.id}`,
    mode: "specialist",
    agentId: null,
    agentVersion: null,
    runtimeAgent: null,
    model: "deepseek",
    status: "succeeded",
    createdAt: "2026-09-04T00:00:00.000Z",
    startedAt: "2026-09-04T00:00:00.000Z",
    finishedAt: "2026-09-04T00:01:00.000Z",
    durationMs: 60_000,
    errorCode: null,
    artifacts: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runs = [];
  mocks.listWebAgentRuns.mockImplementation(async () => mocks.runs);
});

describe("RunSidePanel", () => {
  it("opens the newest run and downloads its deliverables the way the ledger does", async () => {
    mocks.runs = [
      run({ id: "r1", question: "阿司匹林的证据", artifacts: ["reports/aspirin.md"] }),
      run({ id: "r2", question: "更早的运行" }),
    ];
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText("阿司匹林的证据")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "aspirin.md" }));
    expect(mocks.downloadArtifact).toHaveBeenCalledWith("reports/aspirin.md", "workspace");
    // The older run is listed but collapsed, so only one card's body is open.
    expect(screen.getByText("更早的运行")).toBeInTheDocument();
  });

  // The reason this panel sits beside the conversation: a transcript cannot
  // say that a finished package still has an open gate issue.
  it("states an unresolved gate verdict on a run that did deliver", async () => {
    mocks.runs = [
      run({
        id: "r1",
        question: "有待复核的运行",
        verification: "unverified",
        qualityNotices: ["两条 derived 结论没有列出敏感性分析"],
        artifacts: ["reports/x.md"],
      }),
    ];
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText(/已交付，但未完成核验/)).toBeInTheDocument();
    expect(screen.getByText("两条 derived 结论没有列出敏感性分析")).toBeInTheDocument();
  });

  it("distinguishes a layer that never ran from a clean pass", async () => {
    mocks.runs = [run({ id: "r1", question: "没查过的运行", verification: "unchecked" })];
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText(/有一层门禁没有检查过/)).toBeInTheDocument();
  });

  // The unverified path can finish with no files at all — an open-domain answer
  // has none by design — and the card used to print "交付物可用" six lines above
  // "暂无交付物。", which reads as the product losing the researcher's work.
  it("does not promise downloadable deliverables on a run that produced none", async () => {
    mocks.runs = [
      run({ id: "r1", question: "开放域回答", verification: "unverified", artifacts: [], unverifiedArtifacts: [] }),
    ];
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText(/本次没有文件产出/)).toBeInTheDocument();
    expect(screen.queryByText(/交付物可以照常下载/)).not.toBeInTheDocument();
  });

  /**
   * This test used to be called "names the failure code on a failed run" and
   * asserted that the raw string `credits_exhausted` reached the DOM. It was
   * wrong twice over. It pinned the defect — a server identifier, in English,
   * shown as the reason to a reader of a Simplified-Chinese interface — so
   * fixing the product would have looked like breaking the suite. And its
   * input was fictional: `credits_exhausted` is emitted nowhere in
   * apps/server/src; it is named only in a comment explaining why it is not
   * used. The input here is a code the monitor really does write.
   */
  it("says what happened in the reader's language and keeps the code for support", async () => {
    const failed = run({
      id: "r1",
      question: "被计时器中断的运行",
      status: "failed",
      errorCode: "runtime_monitor_timeout",
    });
    mocks.runs = [failed];
    render(<RunSidePanel onClose={vi.fn()} />);

    const verdict = await screen.findByTitle("错误码：runtime_monitor_timeout");
    // One sentence, from the one dictionary, via the one projection.
    expect(verdict).toHaveTextContent(webRunOutcome(failed).headline);
    // Not the identifier: a raw code is a bug report, not a message.
    expect(verdict.textContent).not.toMatch(/runtime_monitor_timeout/);
    expect(verdict.textContent).toMatch(/[一-鿿]/);
    // And never a quality-control verdict on a run killed by a timer. This is
    // the sentence the deleted RunsPage table answered for every code it did
    // not know, including this one.
    expect(verdict.textContent).not.toMatch(/核验/);
    expect(screen.queryByText("运行未通过核验。")).not.toBeInTheDocument();
  });

  // Nothing deletes a refused run's files; they were only unreachable. 28 of
  // 179 finished runs on the host ended with an empty artifact list while a
  // complete package sat on disk, and the panel answered "暂无交付物。"
  it("hands back the files a refused run wrote instead of reporting none", async () => {
    mocks.runs = [
      run({
        id: "r1",
        question: "被退回的九文件包",
        status: "failed",
        errorCode: "specialist_deliverable_not_accepted",
        artifacts: [],
        unverifiedArtifacts: ["deliverables/clinical-evidence-report.md", "deliverables/citation-ledger.csv"],
      }),
    ];
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText("未通过核验的文件（2）")).toBeInTheDocument();
    expect(screen.queryByText("暂无交付物。")).not.toBeInTheDocument();
    // Handed back labelled, never dressed as accepted work.
    expect(screen.getAllByText("未经核验")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /clinical-evidence-report\.md/ }));
    expect(mocks.downloadArtifact).toHaveBeenCalledWith("deliverables/clinical-evidence-report.md", "workspace");
  });

  // An absent field is "unknown", not "none". The server field is landing in
  // parallel, and until it does the panel must not claim the run produced
  // nothing — that would be the same untruth in the other direction.
  it("does not claim a refused run produced nothing when the ledger does not say", async () => {
    mocks.runs = [run({ id: "r1", question: "旧账本记录", status: "failed", errorCode: "runtime_monitor_stalled" })];
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText(/仍留在工作区/)).toBeInTheDocument();
    expect(screen.queryByText("本次运行没有留下任何文件。")).not.toBeInTheDocument();
  });

  // A gate verdict is a return value the run repairs in place, so it has to be
  // complete. The panel used to `.slice(0, 4)` silently: a researcher fixed
  // four findings, resubmitted, and was refused for a fifth never shown.
  it("never hides gate findings without counting them", async () => {
    const notices = Array.from(
      { length: 9 },
      (_, index) =>
        `Report line ${index + 10} numeric facts 1.${index} are not present in the cited claim evidence.`
        + " Cite the claim that carries them.",
    );
    mocks.runs = [run({ id: "r1", question: "九条意见的运行", verification: "unverified", qualityNotices: notices })];
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText(/必须修正 0 项 · 建议修正 9 项/)).toBeInTheDocument();
    expect(screen.queryByText(notices[8])).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开全部 9 条明细" }));
    expect(screen.getByText(notices[8])).toBeInTheDocument();
  });

  // A run still working owes no verdict yet, and its files are not missing —
  // they have not been written. Both used to read as a finished failure.
  it("does not pass judgement on a run that is still working", async () => {
    mocks.runs = [run({ id: "r1", question: "还在跑的运行", status: "running", durationMs: null, finishedAt: null })];
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText("运行进行中，尚未产出交付物。")).toBeInTheDocument();
    expect(screen.queryByText(/这次没有完成/)).not.toBeInTheDocument();
  });

  it("invites the first run when the project has none", async () => {
    render(<RunSidePanel onClose={vi.fn()} />);
    expect(await screen.findByText(/这个项目还没有运行记录/)).toBeInTheDocument();
  });

  it("reports a ledger it could not read instead of showing an empty one", async () => {
    mocks.listWebAgentRuns.mockRejectedValue(new Error("gateway down"));
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText("gateway down")).toBeInTheDocument();
  });

  it("closes on request", async () => {
    const onClose = vi.fn();
    render(<RunSidePanel onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "关闭运行面板" }));
    expect(onClose).toHaveBeenCalled();
  });
});
