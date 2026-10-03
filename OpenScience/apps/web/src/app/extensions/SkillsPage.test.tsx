import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { SkillsPage } from "./SkillsPage";
import { useProjectStore } from "@/lib/projects";

const api = vi.hoisted(() => ({ pendingPersonalSkillTransfers: vi.fn(), uploadPersonalSkillTransfer: vi.fn(), previewPersonalSkillTransfer: vi.fn(), confirmPersonalSkillTransfer: vi.fn(), listPersonalSkills: vi.fn(), effectiveSkills: vi.fn(), effectiveSkill: vi.fn(), duplicateEffectiveSkill: vi.fn(), previewPersonalSkillRepository: vi.fn(), importPersonalSkill: vi.fn(), listWebResearchSessions: vi.fn(), listWebAgentRuns: vi.fn() }));
vi.mock("@/lib/skillLibraryClient", async original => ({ ...(await original<object>()), pendingPersonalSkillTransfers: api.pendingPersonalSkillTransfers, uploadPersonalSkillTransfer: api.uploadPersonalSkillTransfer, previewPersonalSkillTransfer: api.previewPersonalSkillTransfer, confirmPersonalSkillTransfer: api.confirmPersonalSkillTransfer, listPersonalSkills: api.listPersonalSkills, effectiveSkills: api.effectiveSkills, effectiveSkill: api.effectiveSkill, duplicateEffectiveSkill: api.duplicateEffectiveSkill, previewPersonalSkillRepository: api.previewPersonalSkillRepository, importPersonalSkill: api.importPersonalSkill }));
vi.mock("@/lib/apiClient", async original => ({ ...(await original<object>()), listWebResearchSessions: api.listWebResearchSessions, listWebAgentRuns: api.listWebAgentRuns }));
const item = { key: "opaque-builtin", name: "evidence-check", description: "核对保留来源", source: "builtin", canDuplicate: true, invocation: { userInvocable: true, modelInvocable: false } };
const catalogue = { state: "available", runtimeGeneration: "generation-one", sessionId: "session-one", items: [item], learnedMethods: [{ id: "method:owned", title: "已学核对方法", href: "/app/memory?method=method%3Aowned" }], findings: [] };
const detail = { ...catalogue, skill: { ...item, instructions: "Preserve actual source quotations.", metadata: {}, whenToUse: "需要核对来源时", resources: [{ path: "参考/证据.csv", size: 12, digest: "sha256:fixture" }], scripts: [{ path: "scripts/check.py", size: 8 }], digest: "sha256:fixture" } };
const personal = { id: "skill:fresh", revision: 1, payload: { title: "我的核对方法", description: "核对", instructions: "Preserve sources.", nativeName: "personal-fresh", digest: "sha256:fresh", resources: [], prepared: true }, createdAt: "", updatedAt: "", deletedAt: null };
function open() { return render(<MemoryRouter initialEntries={["/skills"]}><Routes><Route path="/skills" element={<SkillsPage />} /><Route path="/app/extensions/skills/:id" element={<p>新技能详情</p>} /></Routes></MemoryRouter>); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.resetAllMocks(); useProjectStore.setState({ currentId: "project-one", projects: [{ id: "project-one", name: "当前项目" }] }); api.pendingPersonalSkillTransfers.mockResolvedValue({ items: [] }); api.listPersonalSkills.mockResolvedValue({ items: [personal], nextCursor: null }); api.listWebResearchSessions.mockResolvedValue([{ sessionId: "session-one", mode: "open-domain", updatedAt: "2026-10-02" }]); api.listWebAgentRuns.mockResolvedValue([{ sessionId: "session-one", title: "来源核对会话" }]); api.effectiveSkills.mockResolvedValue(catalogue); api.effectiveSkill.mockResolvedValue(detail); api.duplicateEffectiveSkill.mockResolvedValue(personal); });

it("reads the selected project's actual session catalogue and preserves the personal library", async () => { open(); expect(await screen.findByText("我的核对方法")).toBeInTheDocument(); expect(await screen.findByText("evidence-check")).toBeInTheDocument(); expect(api.effectiveSkills).toHaveBeenCalledWith("project-one", "session-one"); expect(screen.getByRole("combobox", { name: "科研会话" })).toHaveValue("session-one"); expect(screen.getByRole("option", { name: "来源核对会话" })).toBeInTheDocument(); expect(screen.getByRole("link", { name: "已学核对方法" })).toHaveAttribute("href", "/app/memory?method=method%3Aowned"); expect(api.duplicateEffectiveSkill).not.toHaveBeenCalled(); });
it("keeps loading, unavailable and unknown distinct rather than treating snapshots as effective", async () => { const pending = deferred<typeof catalogue>(); api.effectiveSkills.mockReturnValueOnce(pending.promise); open(); await waitFor(() => expect(api.effectiveSkills).toHaveBeenCalled()); expect(screen.getByText("正在读取当前会话技能")).toBeInTheDocument(); await act(async () => pending.resolve({ ...catalogue, state: "unavailable", items: [], runtimeGeneration: null } as unknown as typeof catalogue)); expect(await screen.findByText("当前会话技能暂不可用")).toBeInTheDocument(); api.effectiveSkills.mockResolvedValueOnce({ ...catalogue, state: "unknown", items: [], runtimeGeneration: null }); await userEvent.click(screen.getByRole("button", { name: "刷新当前会话技能" })); expect(await screen.findByText("当前会话技能状态尚未确认")).toBeInTheDocument(); expect(screen.queryByText("evidence-check")).not.toBeInTheDocument(); });
it("requires preview and explicit confirmation before a fresh duplicate, without selecting it automatically", async () => { const user = userEvent.setup(); open(); await user.click(await screen.findByRole("button", { name: "预览 evidence-check" })); expect(await screen.findByText(detail.skill.instructions)).toBeInTheDocument(); expect(screen.getByText("scripts/check.py")).toBeInTheDocument(); expect(api.duplicateEffectiveSkill).not.toHaveBeenCalled(); await user.clear(screen.getByLabelText("复制后的技能名称")); await user.type(screen.getByLabelText("复制后的技能名称"), "我的核对方法"); await user.click(screen.getByRole("button", { name: "确认复制" })); await screen.findByText("新技能详情"); expect(api.duplicateEffectiveSkill).toHaveBeenCalledWith("project-one", { sessionId: "session-one", key: "opaque-builtin", title: "我的核对方法", idempotencyKey: expect.any(String), expectedRuntimeGeneration: "generation-one" }); });
it("does not expose a duplicate action for unsupported definitions or personal rows", async () => { api.effectiveSkills.mockResolvedValue({ ...catalogue, items: [{ ...item, canDuplicate: false, source: "unknown" }] }); open(); await userEvent.click(await screen.findByRole("button", { name: "预览 evidence-check" })); api.effectiveSkill.mockResolvedValueOnce({ ...detail, skill: { ...detail.skill, canDuplicate: false } }); expect(screen.queryByRole("button", { name: "确认复制" })).not.toBeInTheDocument(); });
it("discarded project/session responses cannot restore an old preview or duplicate authority", async () => { const old = deferred<typeof detail>(); api.effectiveSkill.mockReturnValueOnce(old.promise); open(); await userEvent.click(await screen.findByRole("button", { name: "预览 evidence-check" })); await act(async () => { useProjectStore.setState({ currentId: "project-two" }); }); api.effectiveSkills.mockResolvedValue({ ...catalogue, state: "unavailable", items: [] }); await act(async () => old.resolve(detail)); expect(screen.queryByText(detail.skill.instructions)).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "确认复制" })).not.toBeInTheDocument(); });
it("a failed duplicate retries with the same key and prevents concurrent confirmations", async () => { const request = deferred<typeof personal>(); api.duplicateEffectiveSkill.mockRejectedValueOnce(new Error("temporary")).mockReturnValueOnce(request.promise); open(); await userEvent.click(await screen.findByRole("button", { name: "预览 evidence-check" })); await screen.findByRole("button", { name: "确认复制" }); fireEvent.click(screen.getByRole("button", { name: "确认复制" })); await waitFor(() => expect(api.duplicateEffectiveSkill).toHaveBeenCalledTimes(1)); await userEvent.click(screen.getByRole("button", { name: "确认复制" })); fireEvent.click(screen.getByRole("button", { name: "确认复制" })); expect(api.duplicateEffectiveSkill).toHaveBeenCalledTimes(2); expect(api.duplicateEffectiveSkill.mock.calls[1][1].idempotencyKey).toEqual(api.duplicateEffectiveSkill.mock.calls[0][1].idempotencyKey); await act(async () => request.resolve(personal)); await screen.findByText("新技能详情"); });
it("an owned session must be selected and failure can retry without a fabricated catalogue", async () => { api.listWebResearchSessions.mockResolvedValueOnce([]); open(); expect(await screen.findByText("请先在科研工作台建立会话，再选择查看技能。")).toBeInTheDocument(); expect(api.effectiveSkills).not.toHaveBeenCalled(); expect(screen.getByRole("link", { name: "打开科研工作台" })).toHaveAttribute("href", "/app/chat"); });

it("previews an exact repository commit/subtree and imports only after explicit confirmation", async () => {
  api.previewPersonalSkillRepository.mockResolvedValue({ resourceId: "owned-repo", immutableSource: { repository: "example/skills", commit: "a".repeat(40), subdirectory: "skills/check" }, preview: { ...detail.skill, resources: [], scripts: [] }, findings: [] });
  api.importPersonalSkill.mockResolvedValue(personal);
  const user = userEvent.setup(); open(); await user.click(screen.getByRole("button", { name: "导入" })); await user.click(screen.getByRole("button", { name: "公开仓库" }));
  await user.type(screen.getByLabelText("技能名称"), "仓库核对技能"); await user.type(screen.getByLabelText("公开仓库"), "example/skills"); await user.type(screen.getByLabelText("固定提交"), "a".repeat(40)); await user.type(screen.getByLabelText("技能子目录"), "skills/check");
  await user.click(screen.getByRole("button", { name: "预览" })); expect(await screen.findByText("example/skills")).toBeInTheDocument(); expect(screen.getByText("a".repeat(40))).toBeInTheDocument();
  expect(api.previewPersonalSkillRepository).toHaveBeenCalledWith({ repository: "example/skills", commit: "a".repeat(40), subdirectory: "skills/check" }); expect(api.importPersonalSkill).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "确认导入" })); await waitFor(() => expect(api.importPersonalSkill).toHaveBeenCalledWith("owned-repo", "仓库核对技能"));
});
it("branches cannot replace commit pins and changing a subtree invalidates the earlier preview", async () => {
  api.previewPersonalSkillRepository.mockResolvedValue({ resourceId: "owned-repo", immutableSource: { repository: "example/skills", commit: "a".repeat(40), subdirectory: "" }, preview: { ...detail.skill, resources: [], scripts: [] }, findings: [] });
  const user = userEvent.setup(); open(); await user.click(screen.getByRole("button", { name: "导入" })); await user.click(screen.getByRole("button", { name: "公开仓库" }));
  await user.type(screen.getByLabelText("技能名称"), "仓库技能"); await user.type(screen.getByLabelText("公开仓库"), "example/skills"); await user.type(screen.getByLabelText("固定提交"), "main");
  fireEvent.submit(screen.getByRole("button", { name: "预览" }).closest("form")!); expect(api.previewPersonalSkillRepository).not.toHaveBeenCalled();
  await user.clear(screen.getByLabelText("固定提交")); await user.type(screen.getByLabelText("固定提交"), "a".repeat(40)); await user.click(screen.getByRole("button", { name: "预览" }));
  await screen.findByRole("button", { name: "确认导入" }); await user.type(screen.getByLabelText("技能子目录"), "another"); expect(screen.queryByRole("button", { name: "确认导入" })).not.toBeInTheDocument();
});

const transferPreview = { reference: "transfer:owned", sourceDigest: "sha256:fixture", format: "account", nativeValidation: "pending", activation: false, skills: [{ sourceId: "skill:source", title: "迁移核对技能", revisions: 2, resources: [], invocation: { userInvocable: true, modelInvocable: false } }] };
const partialTransfer = { reference: "transfer:owned", status: "in-progress", activation: false, mappings: [{ sourceId: "skill:source", targetId: "skill:new", imported: 1, revisions: [{ sourceRevision: 1, targetRevision: 1 }] }] };
async function previewTransfer() {
  api.uploadPersonalSkillTransfer.mockResolvedValue({ reference: "transfer:owned", sourceDigest: "sha256:fixture", format: "account", sourceSkills: [{ sourceId: "skill:source", title: "迁移核对技能", revision: 2 }] });
  api.previewPersonalSkillTransfer.mockResolvedValue(transferPreview);
  open(); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "导入" })); await user.click(screen.getByRole("button", { name: "历史与账户数据" }));
  await user.selectOptions(screen.getByLabelText("数据格式"), "account");
  await user.upload(screen.getByLabelText("迁移文件"), new File(['{}'], "account.json", { type: "application/json" }));
  await user.click(screen.getByRole("button", { name: "上传迁移文件" })); await user.click(await screen.findByRole("checkbox", { name: "迁移核对技能" })); await user.click(screen.getByRole("button", { name: "预览迁移" }));
  await screen.findByText("尚未完成原生验证，确认导入后逐个版本验证并保存。"); return user;
}
it("requires explicit account record selection and data preview before a single confirmation", async () => {
  await previewTransfer(); expect(api.uploadPersonalSkillTransfer).toHaveBeenCalledWith(expect.any(File), "account");
  expect(api.previewPersonalSkillTransfer).toHaveBeenCalledWith({ reference: "transfer:owned", sourceSkillIds: ["skill:source"] }); expect(api.confirmPersonalSkillTransfer).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "确认迁移" })).toBeEnabled();
});
it("imports one revision at a time with a stable key and only reports complete on the final receipt", async () => {
  api.confirmPersonalSkillTransfer.mockResolvedValueOnce(partialTransfer).mockResolvedValueOnce({ ...partialTransfer, status: "complete", mappings: [{ ...partialTransfer.mappings[0], imported: 2 }] });
  const user = await previewTransfer(); await user.click(screen.getByRole("button", { name: "确认迁移" })); await screen.findByText("迁移完成；技能已保存，尚未启用。");
  expect(api.confirmPersonalSkillTransfer).toHaveBeenCalledTimes(2); expect(api.confirmPersonalSkillTransfer.mock.calls[0][0]).toEqual(api.confirmPersonalSkillTransfer.mock.calls[1][0]);
  expect(api.confirmPersonalSkillTransfer.mock.calls[0][0]).toEqual({ reference: "transfer:owned", sourceSkillIds: ["skill:source"], idempotencyKey: expect.any(String) });
});
it("pause lets the current call finish, then resumes the same intent without losing adopted rows", async () => {
  const current = deferred<typeof partialTransfer>(); api.confirmPersonalSkillTransfer.mockReturnValueOnce(current.promise).mockResolvedValueOnce({ ...partialTransfer, status: "complete" });
  const user = await previewTransfer(); await user.click(screen.getByRole("button", { name: "确认迁移" })); await waitFor(() => expect(api.confirmPersonalSkillTransfer).toHaveBeenCalledTimes(1)); await user.click(screen.getByRole("button", { name: "暂停迁移" }));
  await act(async () => current.resolve(partialTransfer)); expect(await screen.findByText("已保存 1 个版本")).toBeInTheDocument(); expect(api.confirmPersonalSkillTransfer).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "继续迁移" })); await screen.findByText("迁移完成；技能已保存，尚未启用。"); expect(api.confirmPersonalSkillTransfer.mock.calls[0][0]).toEqual(api.confirmPersonalSkillTransfer.mock.calls[1][0]);
});
it("transport failure keeps partial progress and the same retry key", async () => {
  api.confirmPersonalSkillTransfer.mockResolvedValueOnce(partialTransfer).mockRejectedValueOnce(new Error("transport")).mockResolvedValueOnce({ ...partialTransfer, status: "complete" });
  const user = await previewTransfer(); await user.click(screen.getByRole("button", { name: "确认迁移" })); await screen.findByRole("button", { name: "继续迁移" }); expect(screen.getByText("已保存 1 个版本")).toBeInTheDocument(); expect(screen.queryByText("迁移完成；技能已保存，尚未启用。")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "继续迁移" })); await screen.findByText("迁移完成；技能已保存，尚未启用。"); expect(api.confirmPersonalSkillTransfer.mock.calls[0][0]).toEqual(api.confirmPersonalSkillTransfer.mock.calls[2][0]);
});
it("exports authored history through the authenticated portable endpoint", async () => { open(); expect(await screen.findByRole("link", { name: "导出 我的核对方法 的历史" })).toHaveAttribute("href", expect.stringContaining("/skills/skill%3Afresh/portable")); });
it("changing account selection invalidates the preview, and unknown receipts cannot report completion", async () => {
  const user = await previewTransfer(); await user.click(screen.getByRole("checkbox", { name: "迁移核对技能" })); expect(screen.queryByRole("button", { name: "确认迁移" })).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "预览迁移" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: "迁移核对技能" })); await user.click(screen.getByRole("button", { name: "预览迁移" })); await screen.findByRole("button", { name: "确认迁移" });
  api.confirmPersonalSkillTransfer.mockResolvedValue({ ...partialTransfer, reference: "transfer:foreign", status: "complete" }); await user.click(screen.getByRole("button", { name: "确认迁移" })); await screen.findByRole("button", { name: "继续迁移" }); expect(screen.queryByText("迁移完成；技能已保存，尚未启用。")).not.toBeInTheDocument();
});
it("a finite continuation batch pauses while retaining the original key", async () => {
  api.confirmPersonalSkillTransfer.mockResolvedValue(partialTransfer); const user = await previewTransfer(); await user.click(screen.getByRole("button", { name: "确认迁移" })); await screen.findByRole("button", { name: "继续迁移" });
  expect(api.confirmPersonalSkillTransfer).toHaveBeenCalledTimes(64); expect(new Set(api.confirmPersonalSkillTransfer.mock.calls.map(call => call[0].idempotencyKey)).size).toBe(1); expect(screen.getByText("已保存 1 个版本")).toBeInTheDocument();
});
const recoveredTransfer = { ...partialTransfer, format: "account", sourceSkillIds: ["skill:source"], idempotencyKey: "original-confirmation", mappings: [{ ...partialTransfer.mappings[0], total: 2 }] };
it("hard reload recovers unfinished adoption from the owned journal with the original confirmation key", async () => {
  api.pendingPersonalSkillTransfers.mockResolvedValue({ items: [recoveredTransfer] }); api.previewPersonalSkillTransfer.mockResolvedValue(transferPreview); api.confirmPersonalSkillTransfer.mockResolvedValue({ ...partialTransfer, status: "complete" });
  const first = open(); await screen.findByRole("button", { name: "继续未完成的迁移" }); first.unmount(); open(); await userEvent.click(await screen.findByRole("button", { name: "继续未完成的迁移" }));
  await screen.findByText("已保存 1 个版本"); expect(api.confirmPersonalSkillTransfer).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "确认迁移" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "继续迁移" })); await screen.findByText("迁移完成；技能已保存，尚未启用。");
  expect(api.confirmPersonalSkillTransfer).toHaveBeenCalledWith({ reference: recoveredTransfer.reference, sourceSkillIds: recoveredTransfer.sourceSkillIds, idempotencyKey: "original-confirmation" });
});
it("late pending journal and preview responses cannot cross a project/account page lifecycle", async () => {
  const old = deferred<{ items: typeof recoveredTransfer[] }>(); api.pendingPersonalSkillTransfers.mockReturnValueOnce(old.promise).mockResolvedValue({ items: [] }); open();
  await act(async () => useProjectStore.setState({ currentId: "project-two" })); await waitFor(() => expect(api.pendingPersonalSkillTransfers).toHaveBeenCalledTimes(2)); await act(async () => old.resolve({ items: [recoveredTransfer] }));
  expect(screen.queryByRole("button", { name: "继续未完成的迁移" })).not.toBeInTheDocument();
});
it("journal lookup failure offers retry without inventing a resumable import", async () => {
  api.pendingPersonalSkillTransfers.mockRejectedValueOnce(new Error("lookup transport")).mockResolvedValueOnce({ items: [recoveredTransfer] }); open();
  await userEvent.click(await screen.findByRole("button", { name: "重试读取迁移记录" })); expect(await screen.findByRole("button", { name: "继续未完成的迁移" })).toBeInTheDocument(); expect(api.confirmPersonalSkillTransfer).not.toHaveBeenCalled();
});
it("an unmounted account's recovery preview never appears in the next authenticated page", async () => {
  const late = deferred<typeof transferPreview>(); api.pendingPersonalSkillTransfers.mockResolvedValueOnce({ items: [recoveredTransfer] }).mockResolvedValue({ items: [] }); api.previewPersonalSkillTransfer.mockReturnValueOnce(late.promise);
  const page = open(); await userEvent.click(await screen.findByRole("button", { name: "继续未完成的迁移" })); await waitFor(() => expect(api.previewPersonalSkillTransfer).toHaveBeenCalled()); page.unmount(); open();
  await act(async () => late.resolve(transferPreview)); expect(screen.queryByText("迁移核对技能")).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "继续迁移" })).not.toBeInTheDocument(); expect(api.confirmPersonalSkillTransfer).not.toHaveBeenCalled();
});
it("recovery preview failure cannot dispatch and retries the same owned selection before continuing", async () => {
  api.pendingPersonalSkillTransfers.mockResolvedValue({ items: [recoveredTransfer, { ...recoveredTransfer, status: "complete", idempotencyKey: "completed" }] }); api.previewPersonalSkillTransfer.mockRejectedValueOnce(new Error("preview unavailable")).mockResolvedValueOnce(transferPreview);
  open(); expect(await screen.findAllByRole("button", { name: "继续未完成的迁移" })).toHaveLength(1); await userEvent.click(screen.getByRole("button", { name: "继续未完成的迁移" }));
  await screen.findByRole("button", { name: "重试恢复预览" }); expect(screen.getByRole("button", { name: "继续迁移" })).toBeDisabled(); expect(api.confirmPersonalSkillTransfer).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "重试恢复预览" })); await waitFor(() => expect(screen.getByRole("button", { name: "继续迁移" })).toBeEnabled()); expect(api.previewPersonalSkillTransfer.mock.calls[0][0]).toEqual(api.previewPersonalSkillTransfer.mock.calls[1][0]);
});
it("recovers beyond50 journals with bounded pages, de-duplicates identities and resumes the older journal", async () => {
  const first = Array.from({ length: 50 }, (_, index) => ({ ...recoveredTransfer, idempotencyKey: `confirmed-${index}` }));
  const older = { ...recoveredTransfer, idempotencyKey: "confirmed-50" };
  api.pendingPersonalSkillTransfers.mockResolvedValueOnce({ items: first, nextCursor: "page:older" }).mockResolvedValueOnce({ items: [first[49], older], nextCursor: null }); api.previewPersonalSkillTransfer.mockResolvedValue(transferPreview); api.confirmPersonalSkillTransfer.mockResolvedValue({ ...partialTransfer, status: "complete" });
  open(); await waitFor(() => expect(screen.getAllByRole("button", { name: "继续未完成的迁移" })).toHaveLength(50)); await userEvent.click(screen.getByRole("button", { name: "加载更多迁移记录" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "继续未完成的迁移" })).toHaveLength(51)); expect(api.pendingPersonalSkillTransfers).toHaveBeenLastCalledWith("page:older"); expect(screen.queryByRole("button", { name: "加载更多迁移记录" })).not.toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: "继续未完成的迁移" })[50]); await waitFor(() => expect(screen.getByRole("button", { name: "继续迁移" })).toBeEnabled()); await userEvent.click(screen.getByRole("button", { name: "继续迁移" })); await screen.findByText("迁移完成；技能已保存，尚未启用。"); expect(api.confirmPersonalSkillTransfer.mock.calls[0][0].idempotencyKey).toBe("confirmed-50");
});
it("failed load-more retains recovered records and retries the same cursor without duplicate requests", async () => {
  const pending = deferred<{ items: typeof recoveredTransfer[]; nextCursor: null }>(); api.pendingPersonalSkillTransfers.mockResolvedValueOnce({ items: [recoveredTransfer], nextCursor: "older" }).mockRejectedValueOnce(new Error("transport"));
  open(); await screen.findByRole("button", { name: "继续未完成的迁移" }); await userEvent.click(screen.getByRole("button", { name: "加载更多迁移记录" }));
  await screen.findByRole("button", { name: "重试读取迁移记录" }); expect(screen.getByRole("button", { name: "继续未完成的迁移" })).toBeInTheDocument();
  api.pendingPersonalSkillTransfers.mockReturnValueOnce(pending.promise); fireEvent.click(screen.getByRole("button", { name: "重试读取迁移记录" })); fireEvent.click(screen.getByRole("button", { name: "加载更多迁移记录" })); expect(api.pendingPersonalSkillTransfers).toHaveBeenCalledTimes(3); expect(api.pendingPersonalSkillTransfers).toHaveBeenLastCalledWith("older");
  await act(async () => pending.resolve({ items: [], nextCursor: null })); expect(screen.getByRole("button", { name: "继续未完成的迁移" })).toBeInTheDocument();
});
it("a reloaded first-validation failure shows a reserved target as pending without a false saved link", async () => {
  api.pendingPersonalSkillTransfers.mockResolvedValue({ items: [{ ...recoveredTransfer, mappings: [{ ...recoveredTransfer.mappings[0], imported: 0, revisions: [] }] }], nextCursor: null }); api.previewPersonalSkillTransfer.mockResolvedValue(transferPreview);
  open(); await userEvent.click(await screen.findByRole("button", { name: "继续未完成的迁移" })); await screen.findByText("尚未完成原生验证，确认导入后逐个版本验证并保存。");
  expect(screen.queryByRole("link", { name: "迁移核对技能" })).not.toBeInTheDocument(); expect(screen.queryByText("已保存 0 个版本")).not.toBeInTheDocument(); expect(screen.getByText("待验证，尚未保存")).toBeInTheDocument(); expect(api.confirmPersonalSkillTransfer).not.toHaveBeenCalled();
});
it("account import accepts the exported tar-gzip without expanding it in the browser, while portable stays JSON", async () => {
  api.uploadPersonalSkillTransfer.mockResolvedValue({ reference: "transfer:owned", sourceDigest: "sha256:fixture", format: "account", sourceSkills: [] });
  open(); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "导入" })); await user.click(screen.getByRole("button", { name: "历史与账户数据" })); expect(screen.getByLabelText("迁移文件")).toHaveAttribute("accept", ".json");
  await user.selectOptions(screen.getByLabelText("数据格式"), "account"); expect(screen.getByLabelText("迁移文件")).toHaveAttribute("accept", ".json,.tar.gz,.tgz");
  const file = new File(['bounded fixture bytes'], "account.tar.gz", { type: "application/gzip" }); await user.upload(screen.getByLabelText("迁移文件"), file); await user.click(screen.getByRole("button", { name: "上传迁移文件" })); await waitFor(() => expect(api.uploadPersonalSkillTransfer).toHaveBeenCalledWith(file, "account")); expect(api.confirmPersonalSkillTransfer).not.toHaveBeenCalled();
});
