import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResultComparison, ResultVersionInspector } from "./ResultVersionInspector";
import { WebApiError } from "@/lib/apiClient";
import type { ResultVersion } from "@/lib/resultProvenance";

const api = vi.hoisted(() => ({ list: vi.fn(), related: vi.fn(), get: vi.fn(), raw: vi.fn(), revision: vi.fn(), replay: vi.fn(), progress: vi.fn(), cancel: vi.fn(), export: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/resultProvenance", async (original) => ({ ...await original<typeof import("@/lib/resultProvenance")>(),
  listResultVersions: api.list, listRelatedResultVersions: api.related, getResultVersion: api.get, readResultBytes: api.raw,
  requestResultRevision: api.revision, replayResult: api.replay, getResultReplay: api.progress, cancelResultReplay: api.cancel,
  exportResult: api.export, saveResultBlob: api.save,
}));
vi.mock("@/components/report/ReportReader", () => ({ ReportReader: ({ text, immutableVersion }: { text: string; immutableVersion: ResultVersion }) => <p data-version={immutableVersion.versionId}>{text}</p> }));
vi.mock("./ResultImpactPanel", () => ({ ResultImpactPanel: ({ versionId }: { versionId: string }) => <p data-testid="impact" data-version={versionId} /> }));
vi.mock("./ResultLineagePanel", () => ({ ResultLineagePanel: ({ version }: { version: ResultVersion }) => <p data-testid="lineage" data-version={version.versionId} /> }));
vi.mock("./ResultCorrectionPanel", () => ({ ResultCorrectionPanel: ({ versionId }: { versionId: string }) => <p data-testid="corrections" data-version={versionId} /> }));
vi.mock("@/components/document/DocumentExportActions", () => ({ DocumentExportActions: ({ source, groupLabel }: { source: unknown; groupLabel?: string }) => <p data-testid="export" data-source={JSON.stringify(source)} data-label={groupLabel} /> }));
const old: ResultVersion = { artifactId: "a", versionId: "rv_old", projectId: "default", path: "report.md", digest: "a".repeat(64), size: 10, mimeType: "text/markdown", capturedAt: "2026-10-01T00:00:00Z",
  producer: { kind: "tool", sessionId: "ses_1", runId: "run_1" }, inputs: [], code: null, environment: null,
  findings: [{ id: "f_old", kind: "claim", status: "source_unavailable", message: "旧版本原文不可用" }], machineValues: [],
  coverage: { snapshot: "complete", producer: "bound", inputs: "unknown", code: "unknown", environment: "unknown", gaps: [] }, supersedesVersionId: null };
const latest: ResultVersion = { ...old, versionId: "rv_new", capturedAt: "2026-10-02T00:00:00Z", digest: "b".repeat(64), findings: [] };
function Probe() { const location = useLocation(); return <pre data-testid="state">{JSON.stringify({ pathname: location.pathname, search: location.search, state: location.state })}</pre>; }
function mount(initialVersionId?: string) { return render(<MemoryRouter><ResultVersionInspector path="report.md" initialVersionId={initialVersionId} /><Probe /></MemoryRouter>); }

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:result") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  api.list.mockResolvedValue({ items: [latest, old], nextCursor: null });
  api.related.mockResolvedValue({ items: [], nextCursor: null });
  api.get.mockImplementation(async (id: string) => id === old.versionId ? old : latest);
  api.raw.mockImplementation(async (value: ResultVersion) => ({ text: async () => value.versionId === old.versionId ? "旧结论" : "新结论" }));
});
vi.mock("@/components/frontier/PublishAsEvidenceCard", async (original) => ({ ...await original<typeof import("@/components/frontier/PublishAsEvidenceCard")>(),
  PublishAsEvidenceCard: ({ version, onClose }: { version: ResultVersion; onClose: () => void }) => <div role="dialog" aria-label="发布为证据卡"><p data-testid="publishing">{version.versionId}</p><button type="button" onClick={onClose}>关闭对话框</button></div> }));
describe("publishing a clinical result as an evidence card", () => {
  it("offers 发布为证据卡 only on a result whose capture recorded an evidence matrix, and opens the dialog for that version", async () => {
    api.get.mockImplementation(async () => ({ ...latest, review: { status: "available", matrixVersionId: `rv_${"c".repeat(64)}` } }));
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "发布为证据卡" }));
    expect(screen.getByTestId("publishing")).toHaveTextContent("rv_new");
    await userEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
    expect(screen.queryByRole("dialog", { name: "发布为证据卡" })).not.toBeInTheDocument();
  });
  it("does not offer it on a result that is not a clinical package", async () => {
    mount();
    await screen.findByText("新结论");
    expect(screen.queryByRole("button", { name: "发布为证据卡" })).not.toBeInTheDocument();
  });
});
describe("immutable result inspection", () => {
  it("keeps exactly one lineage and impact panel for the selected version after loading and switching", async () => {
    mount(old.versionId);
    await screen.findByText("旧结论");
    for (const target of [latest, old, latest]) {
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "结果版本" }), target.versionId);
      await screen.findByText(target.versionId === old.versionId ? "旧结论" : "新结论");
      for (const panel of ["lineage", "impact"]) {
        expect(screen.getAllByTestId(panel)).toHaveLength(1);
        expect(screen.getByTestId(panel)).toHaveAttribute("data-version", target.versionId);
      }
    }
  });
  it("opens a requested old version and its findings without reading current workspace bytes", async () => {
    mount(old.versionId);
    expect(await screen.findByText("旧结论")).toHaveAttribute("data-version", old.versionId);
    expect(api.raw).toHaveBeenCalledWith(old);
    expect(screen.getByText(/旧版本原文不可用/)).toBeInTheDocument();
    expect(screen.queryByText("新结论")).toBeNull();
  });
  it("offers Word and PDF of the selected version itself, and the corrections made to it, never of the path's current bytes", async () => {
    const { container } = mount(old.versionId); await screen.findByText("旧结论");
    const shown = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
    expect(shown("export")).toHaveAttribute("data-source", JSON.stringify({ versionId: old.versionId }));
    expect(shown("export")).toHaveAttribute("data-label", "导出此版本");
    expect(shown("corrections")).toHaveAttribute("data-version", old.versionId);
    await userEvent.selectOptions(within(container).getByRole("combobox", { name: "结果版本" }), latest.versionId);
    await within(container).findByText("新结论");
    expect(shown("export")).toHaveAttribute("data-source", JSON.stringify({ versionId: latest.versionId }));
    expect(shown("corrections")).toHaveAttribute("data-version", latest.versionId);
  });
  it("shows what the producing run found about a version, as warnings in the reader's words", async () => {
    const found: ResultVersion = { ...latest, findings: [
      { id: "run-finding-0", kind: "legacy_notice", status: "safety", message: "涉及临床安全，请核对：阿司匹林一级预防：出血风险" },
      { id: "run-finding-1", kind: "legacy_notice", status: "must-fix", message: "有一处依据需要核对：证据矩阵第 1 条结论" },
    ] };
    api.list.mockResolvedValue({ items: [found], nextCursor: null }); api.get.mockResolvedValue(found);
    mount(found.versionId);
    expect(await screen.findByText(/⚠ 涉及临床安全，请核对：阿司匹林一级预防：出血风险/)).toBeInTheDocument();
    expect(screen.getByText(/⚠ 有一处依据需要核对：证据矩阵第 1 条结论/)).toBeInTheDocument();
    expect(screen.queryByText(/尚未核实/)).toBeNull();
  });
  it("resets content and findings when a different immutable version is selected", async () => {
    mount(old.versionId); await screen.findByText("旧结论");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "结果版本" }), latest.versionId);
    expect(await screen.findByText("新结论")).toBeInTheDocument();
    expect(screen.queryByText(/旧版本原文不可用/)).toBeNull();
    expect(screen.getByText(/尚未核实/)).toBeInTheDocument();
  });
  it("shows read failures with retry and never presents them as a clean review", async () => {
    api.raw.mockRejectedValueOnce(new Error("保存的内容已删除")); mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("保存的内容已删除");
    expect(screen.queryByText("新结论")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("新结论")).toBeInTheDocument();
  });
  it("shows list failure separately from an empty version history", async () => {
    api.list.mockRejectedValueOnce(new Error("版本记录读取失败")); mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("版本记录读取失败");
    expect(screen.queryByText(/暂无保存/)).toBeNull();
  });
  it("refuses a server response for a newer version instead of silently replacing the requested snapshot", async () => {
    api.get.mockResolvedValue(latest); mount(old.versionId);
    expect(await screen.findByRole("alert")).toHaveTextContent("返回的结果与所选版本不一致");
    expect(api.raw).not.toHaveBeenCalled();
    expect(screen.queryByText("新结论")).toBeNull();
  });
  it("opens immutable text differences and source changes for two selected versions", async () => {
    mount(); await screen.findByText("新结论");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "比较版本" }), old.versionId);
    expect(await screen.findByRole("region", { name: "版本差异" })).toHaveTextContent("− 1 旧结论");
    expect(screen.getByRole("region", { name: "版本差异" })).toHaveTextContent("+ 1 新结论");
  });
  it("compares and opens a directly linked revision output at a different path", async () => {
    const successor = { ...latest, artifactId: "revision-output", versionId: "rv_revision", path: "artifacts/result-revisions/rr_1/output/revised.md", supersedesVersionId: old.versionId };
    api.related.mockResolvedValue({ items: [successor], nextCursor: null });
    api.get.mockImplementation(async (id: string) => id === successor.versionId ? successor : old);
    mount(old.versionId); await screen.findByText("旧结论");
    await waitFor(() => expect(api.related).toHaveBeenCalledWith(old.versionId));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "比较版本" }), successor.versionId);
    expect(await screen.findByRole("region", { name: "版本差异" })).toHaveTextContent("新结论");
    expect(api.raw).toHaveBeenCalledWith(successor);
    expect(screen.getByText("旧结论")).toHaveAttribute("data-version", old.versionId);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "结果版本" }), successor.versionId);
    const location = JSON.parse(screen.getByTestId("state").textContent!);
    expect(location.pathname).toBe("/app/runs/run_1/files/artifacts/result-revisions/rr_1/output/revised.md");
    expect(location.search).toBe("?version=rv_revision");
  });
  it("rejects unrelated cross-path versions even with the same artifact identifier", async () => {
    const unrelated = { ...latest, path: "another/report.md", versionId: "rv_unrelated" };
    api.related.mockResolvedValue({ items: [unrelated], nextCursor: null });
    mount(old.versionId); await screen.findByText("旧结论");
    expect(await screen.findByRole("alert")).toHaveTextContent("关联版本关系无法确认");
    expect(screen.queryByRole("option", { name: /another/ })).toBeNull();
    expect(api.raw).not.toHaveBeenCalledWith(unrelated);
  });
  it("rechecks the fetched comparison relation before reading cross-path bytes", async () => {
    const successor = { ...latest, artifactId: "revision-output", versionId: "rv_revision", path: "output/revised.md", supersedesVersionId: old.versionId };
    api.related.mockResolvedValue({ items: [successor], nextCursor: null });
    api.get.mockImplementation(async (id: string) => id === successor.versionId ? { ...successor, supersedesVersionId: null } : old);
    mount(old.versionId); await screen.findByText("旧结论");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "比较版本" })).toHaveTextContent("revised.md"));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "比较版本" }), successor.versionId);
    expect(await screen.findByRole("alert")).toHaveTextContent("不能比较没有关联的结果");
    expect(api.raw).not.toHaveBeenCalledWith(expect.objectContaining({ versionId: successor.versionId }));
  });
  it("keeps rerun and export disabled without eligibility", async () => {
    mount(); await screen.findByText("新结论");
    expect(screen.getByRole("button", { name: "重算此结果" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出研究包" })).toBeDisabled();
  });
  it("uses server eligibility and keeps the original after a successful rerun", async () => {
    const admitted = { ...latest, reuseEligibility: { replay: { status: "available", reasons: [] }, export: { status: "partial", reasons: ["部分来源不能导出"] } } };
    api.get.mockResolvedValue(admitted); api.replay.mockResolvedValue({ id: "job_1", state: "succeeded", versionId: latest.versionId, resultVersionId: "rv_successor" });
    api.export.mockResolvedValue(new Blob(["package"])); mount(); await screen.findByText("新结论");
    await userEvent.click(screen.getByRole("button", { name: "重算此结果" }));
    expect(await screen.findByRole("button", { name: "打开新结果" })).toBeInTheDocument();
    expect(api.replay).toHaveBeenCalledWith(admitted);
    expect(screen.getByText("新结论")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "导出研究包" }));
    expect(api.export).toHaveBeenCalledWith(admitted); expect(api.save).toHaveBeenCalled();
  });
  it("stages selected text with the exact version before opening the existing native composer", async () => {
    api.revision.mockResolvedValue({ referenceId: "ref_1", sessionId: "ses_1", draft: "修改要求：" });
    mount(old.versionId); const paragraph = await screen.findByText("旧结论");
    const range = document.createRange(); range.selectNodeContents(paragraph);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "在对话中修改所选内容" }));
    await waitFor(() => expect(api.revision).toHaveBeenCalledWith(old, expect.objectContaining({ kind: "text", selectedText: "旧结论", elementId: expect.any(String) }), "ses_1"));
    expect(JSON.parse(screen.getByTestId("state").textContent!).state.runtimeUiIntent.draft).toBe("修改要求：");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("does not open the original replay version as a successor and allows confirmed cancellation", async () => {
    const admitted = { ...latest, reuseEligibility: { replay: { status: "available", reasons: [] }, export: { status: "unavailable", reasons: [] } } };
    api.get.mockResolvedValue(admitted);
    api.replay.mockResolvedValue({ id: "job_pending", state: "queued", versionId: latest.versionId });
    api.cancel.mockResolvedValue({ id: "job_pending", state: "canceled", versionId: latest.versionId });
    mount(); await screen.findByText("新结论");
    await userEvent.click(screen.getByRole("button", { name: "重算此结果" }));
    expect(await screen.findByText("等待重算")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开新结果" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "取消重算" }));
    expect(await screen.findByText("重算已取消")).toBeInTheDocument();
    expect(api.cancel).toHaveBeenCalledWith("job_pending");
    expect(screen.getByText("新结论")).toBeInTheDocument();
  });
  it("shows structured replay failures without treating the original as completed", async () => {
    api.get.mockResolvedValue({ ...latest, reuseEligibility: { replay: { status: "available", reasons: [] }, export: { status: "unavailable", reasons: [] } } });
    api.replay.mockResolvedValue({ id: "job_failed", state: "failed", versionId: latest.versionId, error: { code: "recipe_failed" } });
    mount(); await screen.findByText("新结论");
    await userEvent.click(screen.getByRole("button", { name: "重算此结果" }));
    expect(await screen.findByText("重算失败")).toBeInTheDocument();
    expect(screen.getByText("计算未完成，请查看进度后重试")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开新结果" })).toBeNull();
  });
  it("says which part of the environment moved when a recalculation ran on another one, and never calls that the same environment", async () => {
    const admitted = { ...latest, reuseEligibility: { replay: { status: "available", reasons: [] }, export: { status: "unavailable", reasons: [] } } };
    api.get.mockResolvedValue(admitted);
    api.replay.mockResolvedValue({ id: "job_1", state: "succeeded", versionId: latest.versionId, resultVersionId: "rv_successor",
      comparison: { bytes: "identical", numbers: { status: "identical" }, environment: { status: "differs", changed: ["code", "environment"] } } });
    mount(); await screen.findByText("新结论");
    await userEvent.click(screen.getByRole("button", { name: "重算此结果" }));
    expect(await screen.findByText(/数值与原结果完全一致；/)).toBeInTheDocument();
    expect(screen.getByText("运行环境与原结果不同（代码、运行环境已变化），数值比较不是在同一环境下得到的")).toBeInTheDocument();
    expect(screen.queryByText(/运行环境与原结果相同/)).toBeNull();
    expect(screen.getByRole("button", { name: "打开新结果" })).toBeInTheDocument();
  });
  it("states the same environment only when the record says the engine did not move", async () => {
    const admitted = { ...latest, reuseEligibility: { replay: { status: "available", reasons: [] }, export: { status: "unavailable", reasons: [] } } };
    api.get.mockResolvedValue(admitted);
    api.replay.mockResolvedValue({ id: "job_1", state: "succeeded", versionId: latest.versionId, resultVersionId: "rv_successor",
      comparison: { numbers: { status: "within-tolerance" }, environment: { status: "same", changed: [] } } });
    mount(); await screen.findByText("新结论");
    await userEvent.click(screen.getByRole("button", { name: "重算此结果" }));
    expect(await screen.findByText(/数值与原结果在允许误差内一致；/)).toBeInTheDocument();
    expect(screen.getByText("运行环境与原结果相同")).toBeInTheDocument();
  });
  it("says plainly what is missing when a recalculation is refused or its output cannot be saved", async () => {
    const admitted = { ...latest, reuseEligibility: { replay: { status: "available", reasons: [] }, export: { status: "unavailable", reasons: [] } } };
    api.get.mockResolvedValue(admitted);
    api.replay.mockRejectedValueOnce(new WebApiError("This result has no recorded calculation recipe", { status: 409, code: "result_recipe_unavailable" }));
    mount(); await screen.findByText("新结论");
    await userEvent.click(screen.getByRole("button", { name: "重算此结果" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("这个结果没有保存可重新计算的配方（方法、输入和参数），所以不能重算；原结果仍可查看。");
    expect(screen.queryByText(/无法解析/)).toBeNull();
    api.replay.mockResolvedValueOnce({ id: "job_2", state: "failed", versionId: latest.versionId, error: { code: "result_replay_receipt_invalid" } });
    await userEvent.click(screen.getByRole("button", { name: "重算此结果" }));
    expect(await screen.findByText(/与计算引擎返回的字节记录对不上/)).toBeInTheDocument();
  });
  it("says in the comparison which part of the environment two related versions differ in", () => {
    const priorRan = { ...old, code: { kind: "code", id: "meta.dl", digest: "c".repeat(64), availability: "reference" }, environment: { kind: "code", id: "engine-environment", digest: "e".repeat(64), availability: "reference" } };
    const ranElsewhere = { ...latest, code: priorRan.code, environment: { ...priorRan.environment, digest: "f".repeat(64) } };
    const view = render(<ResultComparison current={ranElsewhere} prior={priorRan} before="a" after="a" />);
    expect(screen.getByText(/运行环境与所比较的版本不同（运行环境已变化）/)).toBeInTheDocument();
    view.unmount();
    render(<ResultComparison current={{ ...ranElsewhere, environment: priorRan.environment }} prior={priorRan} before="a" after="a" />);
    expect(screen.getByText("运行环境与所比较的版本相同")).toBeInTheDocument();
  });
  it("clears a prior version's replay state when another immutable version is selected", async () => {
    const admitted = { ...latest, reuseEligibility: { replay: { status: "available", reasons: [] }, export: { status: "unavailable", reasons: [] } } };
    api.get.mockImplementation(async (id: string) => id === old.versionId ? old : admitted);
    api.replay.mockResolvedValue({ id: "job_pending", state: "queued", versionId: latest.versionId });
    mount(); await screen.findByText("新结论");
    await userEvent.click(screen.getByRole("button", { name: "重算此结果" }));
    await screen.findByText("等待重算");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "结果版本" }), old.versionId);
    await screen.findByText("旧结论");
    expect(screen.queryByText("等待重算")).toBeNull();
    expect(screen.queryByRole("button", { name: "取消重算" })).toBeNull();
  });
  it("drops an old selection on version change instead of retargeting it", async () => {
    mount(old.versionId); const paragraph = await screen.findByText("旧结论");
    const range = document.createRange(); range.selectNodeContents(paragraph); const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range); fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("button", { name: "在对话中修改所选内容" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "结果版本" }), latest.versionId);
    await screen.findByText("新结论"); expect(screen.queryByRole("button", { name: "在对话中修改所选内容" })).toBeNull();
  });
  it.each(["history", "related"])("discards delayed %s pagination after changing the file", async kind => {
    let resolve!: (page: { items: ResultVersion[]; nextCursor: null }) => void;
    const delayed = new Promise<{ items: ResultVersion[]; nextCursor: null }>(done => { resolve = done; });
    if (kind === "history") api.list.mockResolvedValueOnce({ items: [latest, old], nextCursor: "older" });
    else api.related.mockResolvedValueOnce({ items: [], nextCursor: "related" });
    const view = mount(); await screen.findByText("新结论");
    if (kind === "history") api.list.mockReturnValueOnce(delayed);
    else api.related.mockReturnValueOnce(delayed);
    await userEvent.click(await screen.findByRole("button", { name: kind === "history" ? "更多版本" : "更多关联版本" }));
    const other = { ...latest, versionId: "rv_other", path: "other.md" };
    api.list.mockResolvedValue({ items: [other], nextCursor: null }); api.get.mockResolvedValue(other);
    view.rerender(<MemoryRouter><ResultVersionInspector path="other.md" /><Probe /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "结果版本" })).toHaveValue(other.versionId));
    await act(async () => resolve({ items: [old], nextCursor: null }));
    expect(screen.getByRole("combobox", { name: "结果版本" }).querySelectorAll("option")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("discards a delayed rerun reply after changing the file without retaining busy state", async () => {
    let resolve!: (reply: { id: string; state: string; resultVersionId: string }) => void;
    const admitted = { ...latest, reuseEligibility: { replay: { status: "available", reasons: [] }, export: { status: "available", reasons: [] } } };
    api.get.mockResolvedValue(admitted);
    api.replay.mockReturnValue(new Promise(done => { resolve = done; }));
    const view = mount(); await screen.findByText("新结论");
    await userEvent.click(screen.getByRole("button", { name: "重算此结果" }));
    const other = { ...admitted, versionId: "rv_other", path: "other.md" };
    api.list.mockResolvedValue({ items: [other], nextCursor: null }); api.get.mockResolvedValue(other);
    view.rerender(<MemoryRouter><ResultVersionInspector path="other.md" /><Probe /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "结果版本" })).toHaveValue(other.versionId));
    await act(async () => resolve({ id: "old_job", state: "succeeded", resultVersionId: "rv_successor" }));
    expect(screen.queryByRole("button", { name: "打开新结果" })).toBeNull();
    expect(screen.getByRole("button", { name: "重算此结果" })).toBeEnabled();
  });
  it("does not navigate from a delayed successor response after selecting another version", async () => {
    let resolve!: (version: ResultVersion) => void;
    const admitted = { ...latest, reuseEligibility: { replay: { status: "available", reasons: [] }, export: { status: "available", reasons: [] } } };
    api.get.mockImplementation(async (id: string) => id === old.versionId ? old : admitted);
    api.replay.mockResolvedValue({ id: "job_1", state: "succeeded", resultVersionId: "rv_successor" });
    mount(); await screen.findByText("新结论");
    await userEvent.click(screen.getByRole("button", { name: "重算此结果" }));
    api.get.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await userEvent.click(await screen.findByRole("button", { name: "打开新结果" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "结果版本" }), old.versionId);
    await screen.findByText("旧结论");
    await act(async () => resolve({ ...latest, versionId: "rv_successor", path: "output/new.md", supersedesVersionId: latest.versionId }));
    expect(JSON.parse(screen.getByTestId("state").textContent!).pathname).toBe("/");
    expect(screen.getByRole("combobox", { name: "结果版本" })).toHaveValue(old.versionId);
  });
  it("does not compare different numerical units as identical", () => {
    render(<ResultComparison current={{ ...latest, machineValues: [{ name: "dose", value: 1, unit: "g" }] }} prior={{ ...old, machineValues: [{ name: "dose", value: 1, unit: "mg" }] }} before={null} after={null} />);
    expect(screen.getByText(/无法比较单位/)).toBeInTheDocument();
  });
});
