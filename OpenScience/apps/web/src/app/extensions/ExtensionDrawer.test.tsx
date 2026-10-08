import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { ExtensionConnection } from "@/lib/extensionsClient";
import { ExtensionDrawer, extensionState } from "./ExtensionDrawer";

// Component regressions with explicitly mocked HTTP clients — the project-configuration rules (compare-and-set on the
// selection, connection references that are only ever dropped on request) the old detail page held, now in the drawer.
const extensions = vi.hoisted(() => ({
  extensionCatalogue: vi.fn(), extensionInstallation: vi.fn(), projectExtensions: vi.fn(), extensionHistory: vi.fn(), saveProjectExtensions: vi.fn(),
  updateExtension: vi.fn(), extensionConnections: vi.fn(), installExtension: vi.fn(), removeExtension: vi.fn(),
}));
vi.mock("@/lib/extensionsClient", async original => ({ ...(await original<object>()), ...extensions }));

const coordinate = { kind: "github", repository: "example/table", commit: "a".repeat(40) };
const nextCoordinate = { ...coordinate, commit: "b".repeat(40) };
const descriptor = { id: "table-tool", title: "表格工具", coordinate, integrity: "sha256:old", executionClass: "isolated-tool", settingsSchema: { timeoutSeconds: { type: "number", min: 0, max: 1 }, maxResults: { type: "integer", min: 0 } }, evidenceState: "source-assessed", qualification: null };
const authorizedConnection: ExtensionConnection = { id: "connection:opaque", title: "资料账户", kind: "library", operations: ["read"], revision: `sha256:${"c".repeat(64)}` };
const installed = { id: "extension:one", revision: 3, catalogueId: descriptor.id, coordinate, integrity: descriptor.integrity, evidenceState: "source-assessed", qualification: null, phase: "waiting", effective: false };
const handlers = { onClose: vi.fn(), onChanged: vi.fn() };
function show(id = "extension:one") { return render(<MemoryRouter><ExtensionDrawer extensionId={id} projectId="project-1" {...handlers} /></MemoryRouter>); }
const label = (name: string) => screen.getByRole("spinbutton", { name });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks();
  extensions.extensionCatalogue.mockResolvedValue({ items: [descriptor] });
  extensions.extensionInstallation.mockResolvedValue(installed);
  extensions.projectExtensions.mockResolvedValue({ revision: 4, selections: [], effectiveGeneration: null });
  extensions.extensionHistory.mockResolvedValue({ items: [], nextBeforeRevision: null });
  extensions.extensionConnections.mockResolvedValue({ items: [], supportedKinds: [] });
  extensions.saveProjectExtensions.mockResolvedValue({});
  extensions.updateExtension.mockResolvedValue({ installation: { ...installed, coordinate: nextCoordinate, revision: 4 } });
});

it("says a package's state in three words, never the lifecycle's", () => {
  expect(extensionState({ phase: "waiting", effective: true } as never)).toBe("可用");
  for (const phase of ["preparing", "saved", "applying", "waiting"]) expect(extensionState({ phase, effective: false } as never)).toBe("准备中");
  for (const phase of ["failed", "unsupported", "connection-needed"]) expect(extensionState({ phase, effective: false } as never)).toBe("需处理");
  expect(extensionState({ phase: "removed", effective: false } as never)).toBe("已移除");
});

it("labels the package's settings in Chinese, and a key it has no word for is 其他设置 — never the program's name", async () => {
  extensions.extensionCatalogue.mockResolvedValue({ items: [{ ...descriptor, settingsSchema: { timeoutMs: { type: "integer" }, wholeNewKey: { type: "string" } } }] });
  show();
  expect(await screen.findByRole("spinbutton", { name: "请求超时（毫秒）" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "其他设置" })).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/timeoutMs|wholeNewKey/);
});

it("a newer catalogue schema does not make the installed version's settings editable, and updating is explicit", async () => {
  extensions.extensionCatalogue.mockResolvedValue({ items: [{ ...descriptor, coordinate: nextCoordinate, integrity: "sha256:new", evidenceState: "saas-qualified", settingsSchema: { newField: { type: "string" } } }] });
  show();
  await screen.findByRole("button", { name: "更新到最新版" });
  expect(screen.queryByRole("textbox", { name: "其他设置" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "用于当前项目" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "更新到最新版" }));
  await waitFor(() => expect(extensions.updateExtension).toHaveBeenCalledWith(installed.id, installed.revision, nextCoordinate));
});

it("the platform's qualification record is a label nobody sees on the drawer, and decides no control", async () => {
  for (const state of ["qualification-stale", "qualification-incomplete", "saas-qualified"]) {
    extensions.extensionInstallation.mockResolvedValue({ ...installed, evidenceState: state });
    extensions.extensionCatalogue.mockResolvedValue({ items: [{ ...descriptor, evidenceState: state }] });
    const view = show();
    expect(await screen.findByRole("button", { name: "用于当前项目" })).toBeEnabled();
    expect(document.body.textContent).not.toMatch(/兼容核[验对]|验证已过期|验证未完成|尚未验证/);
    view.unmount();
  }
});

it("fails closed when the same pin has a different artifact digest", async () => {
  extensions.extensionInstallation.mockResolvedValue({ ...installed, integrity: "sha256:different" });
  show();
  await screen.findByText(/当前安装版本的配置暂不可编辑/);
  expect(screen.queryByRole("button", { name: "用于当前项目" })).not.toBeInTheDocument();
});

it("accepts finite fractional settings while integer settings keep whole-number validation", async () => {
  show();
  const fraction = await screen.findByRole("spinbutton", { name: "请求超时（秒）" }) as HTMLInputElement;
  fireEvent.change(fraction, { target: { value: "0.75" } });
  expect(fraction.validity.stepMismatch).toBe(false);
  expect(fraction).toHaveAttribute("step", "any");
  const count = label("返回条数上限") as HTMLInputElement;
  fireEvent.change(count, { target: { value: "0.75" } });
  expect(count.validity.stepMismatch).toBe(true);
});

it("binds only a selected authorized managed connection to the current project", async () => {
  extensions.extensionConnections.mockResolvedValue({ items: [authorizedConnection], supportedKinds: ["library"] });
  show();
  const connection = await screen.findByRole("checkbox", { name: "资料账户" });
  expect(extensions.extensionConnections).toHaveBeenCalledWith(descriptor.id, "project-1");
  await userEvent.click(connection);
  await userEvent.click(screen.getByRole("button", { name: "用于当前项目" }));
  await waitFor(() => expect(extensions.saveProjectExtensions).toHaveBeenCalledWith("project-1", 4, [{ installationId: installed.id, enabled: true, settings: {}, connectionRefs: ["connection:opaque"] }]));
});

it("loads older installation records once using the server cursor, and lists them by day and time", async () => {
  const oldPage = deferred<{ items: { revision: number; coordinate: typeof coordinate; removed: boolean; recordedAt: string }[]; nextBeforeRevision: null }>();
  extensions.extensionHistory.mockResolvedValueOnce({ items: [{ revision: 3, coordinate, removed: false, recordedAt: "2026-10-06T09:45:00.000Z" }], nextBeforeRevision: 3 }).mockReturnValueOnce(oldPage.promise);
  show();
  const more = await screen.findByRole("button", { name: "更早的记录" });
  fireEvent.click(more); fireEvent.click(more);
  expect(extensions.extensionHistory).toHaveBeenCalledTimes(2); expect(more).toBeDisabled();
  expect(extensions.extensionHistory).toHaveBeenLastCalledWith(installed.id, 3);
  await act(async () => oldPage.resolve({ items: [{ revision: 2, coordinate: nextCoordinate, removed: false, recordedAt: "2026-10-05T08:30:00.000Z" }], nextBeforeRevision: null }));
  expect(screen.getAllByText(/ · 版本 /)).toHaveLength(2);
});

it("preserves old project configuration and requires explicit removal before using a changed installation schema", async () => {
  extensions.projectExtensions.mockResolvedValue({ revision: 4, selections: [{ installationId: installed.id, enabled: true, coordinate: nextCoordinate, integrity: "sha256:previous", settings: { oldField: "preserve me" }, connectionRefs: [] }] });
  show();
  const save = await screen.findByRole("button", { name: "保存" }); expect(save).toBeDisabled();
  expect(screen.getByText(/当前项目用的是这个插件的另一个版本/)).toBeInTheDocument();
  expect(extensions.saveProjectExtensions).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "移出当前项目" }));
  await waitFor(() => expect(extensions.saveProjectExtensions).toHaveBeenCalledWith("project-1", 4, []));
});

it("keeps an installation readable when its descriptor is no longer catalogued", async () => {
  extensions.extensionCatalogue.mockResolvedValue({ items: [] });
  show();
  expect(await screen.findByRole("button", { name: "移除插件" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "用于当前项目" })).not.toBeInTheDocument();
});

it("does not overwrite existing settings or connection refs when authorized connections cannot be loaded", async () => {
  extensions.projectExtensions.mockResolvedValue({ revision: 4, selections: [{ installationId: installed.id, enabled: true, settings: { timeoutSeconds: 0.25 }, connectionRefs: ["connection:existing"] }] });
  extensions.extensionConnections.mockRejectedValue(new Error("Unavailable"));
  show();
  await screen.findByRole("alert");
  expect(label("请求超时（秒）")).toHaveValue(0.25);
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  expect(extensions.saveProjectExtensions).not.toHaveBeenCalled();
});

it("reports unavailable records and retries them without hiding the installed package", async () => {
  extensions.extensionHistory.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce({ items: [{ revision: 3, coordinate, removed: false, recordedAt: "2026-10-06T09:45:00.000Z" }], nextBeforeRevision: null });
  show();
  const retry = await screen.findByRole("button", { name: "重试读取" });
  expect(screen.getByRole("link", { name: /查看来源/ })).toHaveAttribute("href", `https://github.com/${coordinate.repository}/tree/${coordinate.commit}`);
  await userEvent.click(retry);
  await waitFor(() => expect(screen.getByText(new RegExp(`版本 ${coordinate.commit.slice(0, 12)}`, "u"), { selector: "p" })).toBeInTheDocument());
  expect(extensions.extensionHistory).toHaveBeenLastCalledWith(installed.id, null);
});

it("clears unavailable references only on explicit request and preserves settings and other selections when saving", async () => {
  const other = { installationId: "extension:other", enabled: false, settings: { preserved: "keep" }, connectionRefs: ["connection:other"] };
  const selected = { installationId: installed.id, enabled: true, settings: { timeoutSeconds: 0.25 }, connectionRefs: ["connection:revoked", authorizedConnection.id] };
  extensions.projectExtensions.mockResolvedValue({ revision: 4, selections: [other, selected] });
  extensions.extensionConnections.mockResolvedValue({ items: [authorizedConnection], supportedKinds: ["library"] });
  show();
  const clear = await screen.findByRole("button", { name: "移除不可用连接" });
  expect(extensions.saveProjectExtensions).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  await userEvent.click(clear);
  expect(extensions.saveProjectExtensions).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: authorizedConnection.title })).toBeChecked();
  expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  fireEvent.change(label("请求超时（秒）"), { target: { value: "0.75" } });
  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(extensions.saveProjectExtensions).toHaveBeenCalledWith("project-1", 4, [other, { ...selected, settings: { timeoutSeconds: 0.75 }, connectionRefs: [authorizedConnection.id] }]));
});

it("removes a project selection with unavailable connections through CAS while preserving every other selection", async () => {
  const other = { installationId: "extension:other", enabled: false, settings: { preserved: "keep" }, connectionRefs: ["connection:other"] };
  extensions.projectExtensions.mockResolvedValue({ revision: 8, selections: [other, { installationId: installed.id, enabled: true, settings: { timeoutSeconds: 0.25 }, connectionRefs: ["connection:revoked"] }] });
  show();
  const remove = await screen.findByRole("button", { name: "移出当前项目" });
  expect(extensions.saveProjectExtensions).not.toHaveBeenCalled();
  await userEvent.click(remove);
  await waitFor(() => expect(extensions.saveProjectExtensions).toHaveBeenCalledWith("project-1", 8, [other]));
});

it("treats connection retrieval failure as unknown and recovers the persisted refs unchanged on retry", async () => {
  const selected = { installationId: installed.id, enabled: true, settings: { timeoutSeconds: 0.25 }, connectionRefs: [authorizedConnection.id] };
  extensions.projectExtensions.mockResolvedValue({ revision: 4, selections: [selected] });
  extensions.extensionConnections.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce({ items: [authorizedConnection], supportedKinds: ["library"] });
  show();
  const retry = await screen.findByRole("button", { name: "重试账户连接" });
  expect(screen.queryByRole("button", { name: "移除不可用连接" })).not.toBeInTheDocument();
  expect(label("请求超时（秒）")).toHaveValue(0.25);
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  expect(extensions.saveProjectExtensions).not.toHaveBeenCalled();
  await userEvent.click(retry);
  expect(await screen.findByRole("checkbox", { name: authorizedConnection.title })).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(extensions.saveProjectExtensions).toHaveBeenCalledWith("project-1", 4, [selected]));
});

it("adds a catalogue package to the reader's own, and tells the page which installation it became", async () => {
  extensions.extensionInstallation.mockResolvedValue(null);
  extensions.installExtension.mockResolvedValue({ installation: { ...installed, id: "extension:added" }, job: null });
  show(descriptor.id);
  await userEvent.click(await screen.findByRole("button", { name: "添加到我的插件" }));
  await waitFor(() => expect(extensions.installExtension).toHaveBeenCalledWith(coordinate, expect.any(String)));
  await waitFor(() => expect(handlers.onChanged).toHaveBeenCalledWith("extension:added"));
});

it("removing is confirmed first and closes the drawer when it is done", async () => {
  extensions.removeExtension.mockResolvedValue({});
  show();
  await userEvent.click(await screen.findByRole("button", { name: "移除插件" }));
  expect(extensions.removeExtension).not.toHaveBeenCalled();
  await userEvent.click(within(screen.getByRole("alertdialog", { name: "移除插件" })).getByRole("button", { name: "移除" }));
  await waitFor(() => expect(extensions.removeExtension).toHaveBeenCalledWith(installed.id, installed.revision));
  await waitFor(() => expect(handlers.onClose).toHaveBeenCalled());
});

it.each([
  ["a package the catalogue does not list", "no-such-package", () => {}],
  ["an installation the server no longer has", "extension:gone", () => extensions.extensionInstallation.mockRejectedValue(new WebApiError("gone", { status: 404 }))],
])("%s says it cannot be found and goes back to the list in one click, offering nothing to add or refresh", async (_, id, arrange) => {
  arrange();
  show(id);
  const drawer = await screen.findByRole("dialog", { name: "插件" });
  expect(within(drawer).getByText("找不到这个插件，它可能已被移除。")).toBeInTheDocument();
  expect(within(drawer).queryByRole("button", { name: "刷新" })).not.toBeInTheDocument();
  expect(within(drawer).queryByRole("alert")).not.toBeInTheDocument();
  expect(within(drawer).queryByText("可以添加")).not.toBeInTheDocument();
  expect(within(drawer).queryByRole("button", { name: "添加到我的插件" })).not.toBeInTheDocument();
  await userEvent.click(within(drawer).getByRole("button", { name: "回到插件列表" }));
  expect(handlers.onClose).toHaveBeenCalledTimes(1);
});

it("a read about the project that fails is not a missing package, and keeps the line and 刷新", async () => {
  extensions.projectExtensions.mockRejectedValueOnce(new WebApiError("gone", { status: 404 })).mockResolvedValue({ revision: 4, selections: [], effectiveGeneration: null });
  show();
  const alert = await screen.findByRole("alert");
  expect(screen.queryByText("找不到这个插件，它可能已被移除。")).not.toBeInTheDocument();
  await userEvent.click(within(alert).getByRole("button", { name: "刷新" }));
  expect(await screen.findByRole("button", { name: "用于当前项目" })).toBeInTheDocument();
});

it("a failure other than a missing package keeps the red line and 刷新", async () => {
  extensions.extensionInstallation.mockRejectedValueOnce(new WebApiError("down", { status: 500 })).mockResolvedValue(installed);
  show();
  const alert = await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "回到插件列表" })).not.toBeInTheDocument();
  await userEvent.click(within(alert).getByRole("button", { name: "刷新" }));
  expect(await screen.findByRole("button", { name: "用于当前项目" })).toBeInTheDocument();
});
