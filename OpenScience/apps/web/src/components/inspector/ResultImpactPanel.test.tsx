import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ResultImpactPanel } from "./ResultImpactPanel";
import type { ResultImpact } from "@/lib/resultImpactClient";

const api = vi.hoisted(() => ({ list: vi.fn(), check: vi.fn() }));
vi.mock("@/lib/resultImpactClient", () => ({ listResultImpacts: api.list, checkResultSourceUpdates: api.check }));
const changed: ResultImpact = { id: "impact_1", revision: 4, createdAt: "", updatedAt: "", deletedAt: null, payload: {
  versionId: "rv_old", source: { id: "source_1", doi: "10.1234/paper" },
  sourceStatus: { state: "changed", checkedAt: "2026-10-02T00:00:00Z", updates: [{ kind: "correction", noticeDoi: "10.1234/correction", date: null, source: "publisher" }] },
  effect: "potentially_affected", claimIds: ["C1"], historicalResultPreserved: true, recomputed: false
} };
function mount(versionId = "rv_old") { return render(<ResultImpactPanel key={versionId} projectId="p" versionId={versionId} digest="selected_digest" />); }
beforeEach(() => {
  vi.clearAllMocks(); api.list.mockResolvedValue({ items: [changed], nextCursor: null });
  api.check.mockResolvedValue({ versionId: "rv_old", digest: "selected_digest", statuses: [{ source: { id: "source_1" }, doi: null, updateStatus: { state: "no_update", checkedAt: null, updates: [] } }], impacts: { items: [] } });
});
it("shows current corrections for the exact historical version and keeps the result as it was", async () => {
  mount();
  expect(await screen.findByText("文献有更新")).toBeInTheDocument();
  expect(api.list).toHaveBeenCalledWith("p", "rv_old");
  expect(screen.getByText(/历史结果已保留/)).toBeInTheDocument();
  expect(screen.queryByRole("combobox")).toBeNull();
});
it("keeps unknown and unavailable checks visible without recomputation", async () => {
  api.list.mockResolvedValue({ items: ["unknown", "unavailable"].map((state, index) => ({ ...changed, id: `gap_${index}`, payload: { ...changed.payload, effect: "source_gap", sourceStatus: { state, checkedAt: null, updates: [] } } })), nextCursor: null });
  mount(); expect(await screen.findByText("更新状态未知")).toBeInTheDocument();
  expect(screen.getByText("更新查询不可用")).toBeInTheDocument();
});
it("reports missing records as unknown and retries failed reads", async () => {
  api.list.mockRejectedValueOnce(new Error("offline")); api.list.mockResolvedValue({ items: [], nextCursor: null });
  mount(); expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByText(/暂无此版本/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "重试来源更新" }));
  expect(await screen.findByText(/更新状态尚未确认/)).toBeInTheDocument();
});
it("ignores records for another version instead of retargeting the selected result", async () => {
  mount("rv_new"); expect(await screen.findByText(/暂无此版本/)).toBeInTheDocument();
  expect(api.list).toHaveBeenCalledWith("p", "rv_new");
  expect(screen.queryByText("文献有更新")).toBeNull();
});
it("checks only the selected version after explicit click and then refreshes its impact records", async () => {
  api.list.mockResolvedValue({ items: [], nextCursor: null }); mount();
  await screen.findByText(/暂无此版本/); expect(api.check).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(api.check).toHaveBeenCalledWith("p", "rv_old");
  expect(await screen.findByText("未发现更新")).toBeInTheDocument();
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
 
});
it("does not show a failed or wrong-version source check as clean", async () => {
  api.list.mockResolvedValue({ items: [], nextCursor: null });
  api.check.mockRejectedValueOnce(new Error("unavailable")); mount(); await screen.findByText(/暂无此版本/);
  await userEvent.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.queryByText("未发现更新")).toBeNull();
  api.check.mockResolvedValueOnce({ versionId: "rv_new", digest: "different", statuses: [], impacts: { items: [] } });
  await userEvent.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.queryByText("未发现更新")).toBeNull();
});
it("shows a revoked source as unavailable without exposing its old identity", async () => {
  api.list.mockResolvedValue({ items: [], nextCursor: null });
  api.check.mockResolvedValue({ versionId: "rv_old", digest: "selected_digest", statuses: [{ source: { id: "unavailable-source" }, doi: null,
    updateStatus: { state: "unavailable", checkedAt: null, reason: "restricted", updates: [] } }], impacts: { items: [] } });
  mount(); await screen.findByText(/暂无此版本/);
  await userEvent.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText("原来源已不可用")).toBeInTheDocument();
  expect(screen.getByText("更新查询不可用")).toBeInTheDocument();
  expect(screen.queryByText("unavailable-source")).toBeNull();
});
const found = <Item,>(items: Item[], total = items.length) => ({ status: "found" as const, reason: null, total, items });
const none = { status: "none" as const, reason: null, total: 0, items: [] };
const unknown = { status: "unknown" as const, reason: "lookup_failed", total: 0, items: [] };
const bound = { versionId: "rv_calc", path: "results/pool.json", boundValues: 3, keys: ["pooled"] };
it("lists the calculations, memories and methods that rest on the changed source, and says a change is not an error", async () => {
  api.list.mockResolvedValue({ items: [{ ...changed, payload: { ...changed.payload, affected: { schemaVersion: 1, via: "calculation", calculations: found([bound]),
    dependents: found([{ ...bound, versionId: "rv_other" }, { ...bound, versionId: "rv_third" }]),
    memories: found([{ recordId: "m1", scope: "project", kind: "project_fact", state: "changed" }]),
    methods: found([{ id: "learned-pooling", title: "合并效应量", relation: "learnt_from", versionId: "rv_old" }]) } } }], nextCursor: null });
  mount();
  const list = await screen.findByRole("list", { name: "依赖该来源的内容" });
  expect(list).toHaveTextContent("本版本里有 3 处数值来自 1 个依赖该来源的计算");
  expect(list).toHaveTextContent("2 个结果的数值引用了这个计算");
  expect(list).toHaveTextContent("1 条记忆依赖该来源，已标注“来源有变化”，记忆本身没有改动");
  expect(list).toHaveTextContent("1 个学到的方法与此结果相关，已标注“来源有变化”，方法本身没有改动");
  expect(screen.getByText(/这不说明原来的结论有误，尚未重新计算/)).toBeInTheDocument();
  expect(screen.getByText(/历史结果已保留/)).toBeInTheDocument();
});
it("says a lookup that could not be made is not none, and says none only for an answered lookup", async () => {
  api.list.mockResolvedValue({ items: [
    { ...changed, id: "a", payload: { ...changed.payload, affected: { schemaVersion: 1, via: "input", calculations: none, dependents: none, memories: unknown, methods: unknown } } },
    { ...changed, id: "b", payload: { ...changed.payload, affected: { schemaVersion: 1, via: "input", calculations: none, dependents: none, memories: none, methods: none } } },
  ], nextCursor: null });
  mount();
  expect(await screen.findByText("依赖该来源的记忆、方法暂时查不到，不能当作没有")).toBeInTheDocument();
  expect(screen.getByText("未发现依赖该来源的其他计算、记忆或方法")).toBeInTheDocument();
});
it("tells a knowledge-base file that has new bytes from a publisher's notice and shows nothing for an impact recorded before the lookup", async () => {
  api.list.mockResolvedValue({ items: [
    { ...changed, id: "kb", payload: { ...changed.payload, source: { id: `src_${"a".repeat(32)}`, contentDigest: "b".repeat(64), replacedBy: `src_${"c".repeat(32)}` },
      sourceStatus: { state: "changed", checkedAt: null, updates: [{ kind: "replaced", noticeDoi: null, date: "2026-10-04", source: null }] } } },
    { ...changed, id: "old", payload: { ...changed.payload, source: { id: "source_old" } } },
  ], nextCursor: null });
  mount();
  expect(await screen.findByText("资料库文件已有新版本")).toBeInTheDocument();
  expect(screen.getByText("资料库中的文件")).toBeInTheDocument();
  expect(screen.queryByText(`src_${"a".repeat(32)}`)).toBeNull();
  expect(screen.queryAllByRole("list", { name: "依赖该来源的内容" })).toHaveLength(0);
});
it("says which sources a check reached through the calculations a result's numbers are bound to", async () => {
  api.list.mockResolvedValue({ items: [], nextCursor: null });
  api.check.mockResolvedValue({ versionId: "rv_old", digest: "selected_digest", impacts: { items: [] }, statuses: [
    { source: { id: "10.1/own" }, doi: "10.1/own", updateStatus: { state: "no_update", checkedAt: null, updates: [] } },
    { source: { id: "10.1/behind" }, doi: "10.1/behind", viaCalculation: "rv_calc", updateStatus: { state: "no_update", checkedAt: null, updates: [] } },
  ] });
  mount(); await screen.findByText(/暂无此版本/);
  await userEvent.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText("10.1/behind（来自所依据的计算）")).toBeInTheDocument();
  expect(screen.getByText("10.1/own")).toBeInTheDocument();
});
