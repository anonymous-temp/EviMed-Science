import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { PluginDetailPage } from "./PluginDetailPage";
import { SkillDetailPage } from "./SkillDetailPage";
import { SkillsPage } from "./SkillsPage";
import { PluginsPage } from "./PluginsPage";
import type { ExtensionConnection } from "@/lib/extensionsClient";

// These are component regressions with explicitly mocked HTTP clients, not SaaS qualification probes.
const extensions = vi.hoisted(() => ({ extensionCatalogue: vi.fn(), extensionInstallation: vi.fn(), projectExtensions: vi.fn(), extensionHistory: vi.fn(), saveProjectExtensions: vi.fn(), updateExtension: vi.fn(), extensionConnections: vi.fn(), extensionInstallations: vi.fn() }));
const skills = vi.hoisted(() => ({ getPersonalSkill: vi.fn(), personalSkillHistory: vi.fn(), personalSkillDefaults: vi.fn(), projectSkills: vi.fn(), saveProjectSkills: vi.fn(), savePersonalSkillDefaults: vi.fn(), listPersonalSkills: vi.fn(), uploadPersonalSkill: vi.fn(), previewPersonalSkillImport: vi.fn(), importPersonalSkill: vi.fn() }));
vi.mock("@/lib/extensionsClient", async original => ({ ...(await original<object>()), ...extensions }));
vi.mock("@/lib/skillLibraryClient", async original => ({ ...(await original<object>()), ...skills }));
vi.mock("@/lib/apiClient", async original => ({ ...(await original<object>()), getWebProjectId: () => "project-1" }));
const coordinate = { kind: "github", repository: "example/table", commit: "a".repeat(40) };
const nextCoordinate = { ...coordinate, commit: "b".repeat(40) };
const descriptor = { id: "table-tool", title: "表格工具", coordinate, integrity: "sha256:old", executionClass: "isolated-tool", settingsSchema: { fraction: { type: "number", min: 0, max: 1 }, count: { type: "integer", min: 0 } }, evidenceState: "source-assessed", qualification: null };
const authorizedConnection: ExtensionConnection = { id: "connection:opaque", title: "资料账户", kind: "library", operations: ["read"], revision: `sha256:${"c".repeat(64)}` };
const installed = { id: "extension:one", revision: 3, catalogueId: descriptor.id, coordinate, integrity: descriptor.integrity, evidenceState: "source-assessed", qualification: null, phase: "waiting", effective: false };
const skill = { id: "skill:one", revision: 2, payload: { title: "检索方案", description: "检索", instructions: "Use sources.", nativeName: "search-plan", digest: "sha256:two", resources: [], prepared: true }, createdAt: "", updatedAt: "", deletedAt: null };
function openPlugin() { render(<MemoryRouter initialEntries={["/plugins/extension:one"]}><Routes><Route path="/plugins/:extensionId" element={<PluginDetailPage />} /></Routes></MemoryRouter>); }
function openSkill() { render(<MemoryRouter initialEntries={["/skills/skill:one"]}><Routes><Route path="/skills/:skillId" element={<SkillDetailPage />} /></Routes></MemoryRouter>); }
function openSkills() { render(<MemoryRouter><SkillsPage /></MemoryRouter>); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks();
  extensions.extensionCatalogue.mockResolvedValue({ items: [descriptor] });
  extensions.extensionInstallation.mockResolvedValue(installed);
  extensions.projectExtensions.mockResolvedValue({ revision: 4, selections: [], effectiveGeneration: null });
  extensions.extensionHistory.mockResolvedValue({ items: [], nextBeforeRevision: null });
  extensions.extensionConnections.mockResolvedValue({ items: [], supportedKinds: [] });
  extensions.extensionInstallations.mockResolvedValue({ items: [], nextCursor: null });
  extensions.saveProjectExtensions.mockResolvedValue({});
  extensions.updateExtension.mockResolvedValue({ installation: { ...installed, coordinate: nextCoordinate, revision: 4 } });
  skills.getPersonalSkill.mockResolvedValue(skill);
  skills.personalSkillHistory.mockResolvedValue([]);
  skills.personalSkillDefaults.mockResolvedValue({ revision: 5, payload: { skills: [{ skillId: skill.id, revision: 1 }] } });
  skills.projectSkills.mockResolvedValue({ revision: 6, payload: { skills: [{ skillId: skill.id, revision: 1 }] } });
  skills.saveProjectSkills.mockResolvedValue({});
  skills.savePersonalSkillDefaults.mockResolvedValue({});
  skills.listPersonalSkills.mockResolvedValue({ items: [], nextCursor: null });
  skills.uploadPersonalSkill.mockResolvedValue({ resourceId: "upload:fixture" });
  skills.previewPersonalSkillImport.mockResolvedValue({ description: "预览描述", instructions: "Preserve source uncertainty.", invocation: { userInvocable: true, modelInvocable: false }, metadata: {}, whenToUse: null, resources: [{ path: "scripts/check.py", size: 20, id: "resource:fixture", digest: "sha256:fixture" }], scripts: [{ path: "scripts/check.py", size: 20 }] });
  skills.importPersonalSkill.mockResolvedValue(skill);
});

it("previews native skill content and scripts before the explicit import action", async () => {
  const user = userEvent.setup(); openSkills();
  await screen.findByText("还没有个人技能");
  await user.click(screen.getByRole("button", { name: "导入" }));
  await user.type(screen.getByLabelText("技能名称"), "我的检查方法");
  await user.upload(screen.getByLabelText("技能文件"), new File(["fixture"], "SKILL.md", { type: "text/markdown" }));
  expect((screen.getByLabelText("技能文件") as HTMLInputElement).files).toHaveLength(1);
  // JSDOM does not implement native file-required validity like a browser.
  fireEvent.submit(screen.getByRole("button", { name: "预览" }).closest("form")!);
  expect(await screen.findByText("Preserve source uncertainty.")).toBeInTheDocument();
  expect(screen.getByText("scripts/check.py")).toBeInTheDocument();
  expect(skills.importPersonalSkill).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "确认导入" }));
  await waitFor(() => expect(skills.importPersonalSkill).toHaveBeenCalledWith("upload:fixture", "我的检查方法"));
});

it("failed preview creates no skill and a changed file invalidates the earlier preview", async () => {
  const user = userEvent.setup(); openSkills(); await screen.findByText("还没有个人技能");
  await user.click(screen.getByRole("button", { name: "导入" }));
  await user.type(screen.getByLabelText("技能名称"), "重试方法");
  await user.upload(screen.getByLabelText("技能文件"), new File(["one"], "first.md", { type: "text/markdown" }));
  skills.previewPersonalSkillImport.mockRejectedValueOnce(new Error("Preview unavailable"));
  fireEvent.submit(screen.getByRole("button", { name: "预览" }).closest("form")!);
  expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请重试。");
  expect(skills.importPersonalSkill).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "确认导入" })).not.toBeInTheDocument();
  fireEvent.submit(screen.getByRole("button", { name: "预览" }).closest("form")!);
  await screen.findByRole("button", { name: "确认导入" });
  await user.upload(screen.getByLabelText("技能文件"), new File(["two"], "second.md", { type: "text/markdown" }));
  expect(screen.queryByRole("button", { name: "确认导入" })).not.toBeInTheDocument();
});
it("shows the installed pin and evidence while a newer qualified catalogue schema stays unavailable", async () => {
  extensions.extensionCatalogue.mockResolvedValue({ items: [{ ...descriptor, coordinate: nextCoordinate, integrity: "sha256:new", evidenceState: "saas-qualified", settingsSchema: { newField: { type: "string" } } }] });
  openPlugin();
  expect(await screen.findByText(`版本 ${coordinate.commit.slice(0, 12)}`)).toBeInTheDocument();
  expect(screen.getByText("尚未完成兼容核验")).toBeInTheDocument();
  expect(screen.queryByText("兼容核验通过")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看来源" })).toHaveAttribute("href", `https://github.com/${coordinate.repository}/tree/${coordinate.commit}`);
  expect(screen.queryByRole("textbox", { name: "newField" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "用于当前项目" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /更新到版本/ }));
  await waitFor(() => expect(extensions.updateExtension).toHaveBeenCalledWith(installed.id, installed.revision, nextCoordinate));
});
it("fails closed when the same pin has a different artifact digest", async () => {
  extensions.extensionInstallation.mockResolvedValue({ ...installed, integrity: "sha256:different" });
  openPlugin();
  await screen.findByText(`版本 ${coordinate.commit.slice(0, 12)}`);
  expect(screen.queryByRole("spinbutton", { name: "fraction" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "用于当前项目" })).not.toBeInTheDocument();
});
it("accepts finite fractional settings while integer settings retain whole-number validation", async () => {
  openPlugin(); const fraction = await screen.findByRole("spinbutton", { name: "fraction" }) as HTMLInputElement;
  fireEvent.change(fraction, { target: { value: "0.75" } });
  expect(fraction.validity.stepMismatch).toBe(false);
  expect(fraction).toHaveAttribute("step", "any");
  const count = screen.getByRole("spinbutton", { name: "count" }) as HTMLInputElement;
  fireEvent.change(count, { target: { value: "0.75" } }); expect(count.validity.stepMismatch).toBe(true);
});
it("shows older project and default pins and removes them without silently upgrading", async () => {
  openSkill();
  expect(await screen.findByText("当前项目选用版本 1")).toBeInTheDocument();
  expect(screen.getByText("新项目默认版本 1")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "加入当前项目" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "移出当前项目" }));
  await waitFor(() => expect(skills.saveProjectSkills).toHaveBeenCalledWith("project-1", 6, []));
  await waitFor(() => expect(screen.getByRole("button", { name: "取消新项目默认选用" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "取消新项目默认选用" }));
  await waitFor(() => expect(skills.savePersonalSkillDefaults).toHaveBeenCalledWith(5, []));
});
it("updates old skill pins only through explicit update actions with selection CAS", async () => {
  openSkill();
  const update = await screen.findByRole("button", { name: "当前项目更新到版本 2" });
  await userEvent.click(update);
  await waitFor(() => expect(skills.saveProjectSkills).toHaveBeenCalledWith("project-1", 6, [{ skillId: skill.id, revision: 2 }]));
  await waitFor(() => expect(screen.getByRole("button", { name: "新项目默认更新到版本 2" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "新项目默认更新到版本 2" }));
  await waitFor(() => expect(skills.savePersonalSkillDefaults).toHaveBeenCalledWith(5, [{ skillId: skill.id, revision: 2 }]));
});
it("requests a skill cursor once while pending and deduplicates returned identities", async () => {
  const page = deferred<{ items: typeof skill[]; nextCursor: null }>();
  skills.listPersonalSkills.mockResolvedValueOnce({ items: [skill], nextCursor: "next" }).mockReturnValue(page.promise);
  openSkills(); const more = await screen.findByRole("button", { name: "加载更多" });
  fireEvent.click(more); fireEvent.click(more);
  expect(skills.listPersonalSkills).toHaveBeenCalledTimes(2); expect(more).toBeDisabled();
  await act(async () => page.resolve({ items: [skill, { ...skill, id: "skill:two", payload: { ...skill.payload, title: "另一方案" } }], nextCursor: null }));
  expect(screen.getAllByText(skill.payload.title)).toHaveLength(1);
});
it("discards a pending older page response after a refresh starts", async () => {
  const oldPage = deferred<{ items: typeof skill[]; nextCursor: null }>();
  skills.listPersonalSkills.mockResolvedValueOnce({ items: [skill], nextCursor: "next" }).mockReturnValueOnce(oldPage.promise).mockResolvedValueOnce({ items: [], nextCursor: null });
  openSkills(); fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
  fireEvent.click(screen.getByRole("button", { name: "刷新技能" }));
  await screen.findByText("还没有个人技能");
  await act(async () => oldPage.resolve({ items: [skill], nextCursor: null }));
  expect(screen.queryByText(skill.payload.title)).not.toBeInTheDocument();
});
it("binds only a selected authorized managed connection to the current project", async () => {
  extensions.extensionConnections.mockResolvedValue({ items: [authorizedConnection], supportedKinds: ["library"] });
  openPlugin(); const connection = await screen.findByRole("checkbox", { name: "资料账户" });
  expect(extensions.extensionConnections).toHaveBeenCalledWith(descriptor.id, "project-1");
  await userEvent.click(connection); await userEvent.click(screen.getByRole("button", { name: "用于当前项目" }));
  await waitFor(() => expect(extensions.saveProjectExtensions).toHaveBeenCalledWith("project-1", 4, [{ installationId: installed.id, enabled: true, settings: {}, connectionRefs: ["connection:opaque"] }]));
});
it("loads older installation revisions once using the server cursor", async () => {
  const oldPage = deferred<{ items: { revision: number; coordinate: typeof coordinate; removed: boolean }[]; nextBeforeRevision: null }>();
  extensions.extensionHistory.mockResolvedValueOnce({ items: [{ revision: 3, coordinate, removed: false }], nextBeforeRevision: 3 }).mockReturnValueOnce(oldPage.promise);
  openPlugin(); const more = await screen.findByRole("button", { name: "更早的版本记录" });
  fireEvent.click(more); fireEvent.click(more);
  expect(extensions.extensionHistory).toHaveBeenCalledTimes(2); expect(more).toBeDisabled();
  expect(extensions.extensionHistory).toHaveBeenLastCalledWith(installed.id, 3);
  await act(async () => oldPage.resolve({ items: [{ revision: 2, coordinate: nextCoordinate, removed: false }], nextBeforeRevision: null }));
  expect(within(screen.getByRole("region", { name: "插件版本" })).getAllByText(/版本 /)).toHaveLength(2);
});
it("does not claim an empty skill library on initial retrieval failure", async () => {
  skills.listPersonalSkills.mockRejectedValueOnce(new Error("Unavailable")); openSkills();
  await screen.findByRole("alert"); expect(screen.queryByText("还没有个人技能")).not.toBeInTheDocument();
});
it("does not claim an empty plugin catalogue on initial retrieval failure", async () => {
  extensions.extensionCatalogue.mockRejectedValueOnce(new Error("Unavailable"));
  render(<MemoryRouter><PluginsPage /></MemoryRouter>);
  await screen.findByRole("alert"); expect(screen.queryByText("暂无可添加的插件")).not.toBeInTheDocument();
});

it("preserves old project configuration and requires explicit removal before using a changed installation schema", async () => {
  extensions.projectExtensions.mockResolvedValue({ revision: 4, selections: [{ installationId: installed.id, enabled: true, coordinate: nextCoordinate, integrity: "sha256:previous", settings: { oldField: "preserve me" }, connectionRefs: [] }] });
  openPlugin();
  const save = await screen.findByRole("button", { name: "保存配置" }); expect(save).toBeDisabled();
  expect(screen.getByText(/当前项目选用版本 bbbbbbbbbbbb/)).toBeInTheDocument();
  expect(extensions.saveProjectExtensions).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "移出当前项目" }));
  await waitFor(() => expect(extensions.saveProjectExtensions).toHaveBeenCalledWith("project-1", 4, []));
});
it("keeps an installation readable when its descriptor is no longer catalogued", async () => {
  extensions.extensionCatalogue.mockResolvedValue({ items: [] }); openPlugin();
  expect(await screen.findByText(`版本 ${coordinate.commit.slice(0, 12)}`)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "移除插件" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "用于当前项目" })).not.toBeInTheDocument();
});
it("does not overwrite existing settings or connection refs when authorized connections cannot be loaded", async () => {
  extensions.projectExtensions.mockResolvedValue({ revision: 4, selections: [{ installationId: installed.id, enabled: true, settings: { fraction: 0.25 }, connectionRefs: ["connection:existing"] }] });
  extensions.extensionConnections.mockRejectedValue(new Error("Unavailable")); openPlugin();
  await screen.findByRole("alert");
  expect(screen.getByRole("spinbutton", { name: "fraction" })).toHaveValue(0.25);
  expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  expect(extensions.saveProjectExtensions).not.toHaveBeenCalled();
});
it("reports unavailable history and retries it without hiding the installed artifact", async () => {
  extensions.extensionHistory.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce({ items: [{ revision: 3, coordinate, removed: false }], nextBeforeRevision: null });
  openPlugin(); const retry = await screen.findByRole("button", { name: "重试版本记录" });
  expect(screen.getByRole("link", { name: "查看来源" })).toBeInTheDocument();
  await userEvent.click(retry);
  await waitFor(() => expect(within(screen.getByRole("region", { name: "插件版本" })).getByText(`版本 ${coordinate.commit.slice(0, 12)}`)).toBeInTheDocument());
  expect(extensions.extensionHistory).toHaveBeenLastCalledWith(installed.id, null);
});

it("clears unavailable references only on explicit request and preserves settings and other selections when saving", async () => {
  const other = { installationId: "extension:other", enabled: false, settings: { preserved: "keep" }, connectionRefs: ["connection:other"] };
  const selected = { installationId: installed.id, enabled: true, settings: { fraction: 0.25 }, connectionRefs: ["connection:revoked", authorizedConnection.id] };
  extensions.projectExtensions.mockResolvedValue({ revision: 4, selections: [other, selected] });
  extensions.extensionConnections.mockResolvedValue({ items: [authorizedConnection], supportedKinds: ["library"] });
  openPlugin();
  const clear = await screen.findByRole("button", { name: "移除不可用连接" });
  expect(extensions.saveProjectExtensions).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  await userEvent.click(clear);
  expect(extensions.saveProjectExtensions).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: authorizedConnection.title })).toBeChecked();
  expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
  fireEvent.change(screen.getByRole("spinbutton", { name: "fraction" }), { target: { value: "0.75" } });
  await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() => expect(extensions.saveProjectExtensions).toHaveBeenCalledWith("project-1", 4, [other, { ...selected, settings: { fraction: 0.75 }, connectionRefs: [authorizedConnection.id] }]));
});
it("removes a project selection with unavailable connections through CAS while preserving every other selection", async () => {
  const other = { installationId: "extension:other", enabled: false, settings: { preserved: "keep" }, connectionRefs: ["connection:other"] };
  extensions.projectExtensions.mockResolvedValue({ revision: 8, selections: [other, { installationId: installed.id, enabled: true, settings: { fraction: 0.25 }, connectionRefs: ["connection:revoked"] }] });
  openPlugin();
  const remove = await screen.findByRole("button", { name: "移出当前项目" });
  expect(extensions.saveProjectExtensions).not.toHaveBeenCalled();
  await userEvent.click(remove);
  await waitFor(() => expect(extensions.saveProjectExtensions).toHaveBeenCalledWith("project-1", 8, [other]));
});
it("treats connection retrieval failure as unknown and recovers the persisted refs unchanged on retry", async () => {
  const selected = { installationId: installed.id, enabled: true, settings: { fraction: 0.25 }, connectionRefs: [authorizedConnection.id] };
  extensions.projectExtensions.mockResolvedValue({ revision: 4, selections: [selected] });
  extensions.extensionConnections.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce({ items: [authorizedConnection], supportedKinds: ["library"] });
  openPlugin();
  const retry = await screen.findByRole("button", { name: "重试账户连接" });
  expect(screen.queryByRole("button", { name: "移除不可用连接" })).not.toBeInTheDocument();
  expect(screen.queryByText(/原有账户连接暂不可用/)).not.toBeInTheDocument();
  expect(screen.getByRole("spinbutton", { name: "fraction" })).toHaveValue(0.25);
  expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  expect(extensions.saveProjectExtensions).not.toHaveBeenCalled();
  await userEvent.click(retry);
  expect(await screen.findByRole("checkbox", { name: authorizedConnection.title })).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() => expect(extensions.saveProjectExtensions).toHaveBeenCalledWith("project-1", 4, [selected]));
});
