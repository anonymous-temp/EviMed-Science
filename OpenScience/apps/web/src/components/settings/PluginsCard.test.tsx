import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError, type WebPluginState } from "@/lib/apiClient";
import { PluginsCard } from "./PluginsCard";

const api = vi.hoisted(() => ({ listWebPlugins: vi.fn(), saveWebPlugin: vi.fn(), listWebPluginRevisions: vi.fn(), rollbackWebPlugin: vi.fn(), retryWebPlugin: vi.fn(), removeWebPlugin: vi.fn() }));
vi.mock("@/lib/apiClient", async (original) => ({ ...await original<typeof import("@/lib/apiClient")>(), ...api }));

const config = (revision = 0, timeoutMs = 15000, enabled = true) => ({ revision, enabled, settings: { timeoutMs } });
function plugin(overrides: Partial<WebPluginState> = {}): WebPluginState {
  return {
    id: "dsh-cite", binaryVersion: "0.3.2", tools: ["cite_lookup", "cite_check"],
    settingsSchema: { timeoutMs: { min: 2000, max: 15000 } },
    availableUpdate: null, availability: { state: "unknown", checkedAt: null, reason: "no-record" },
    desired: config(), effective: config(), phase: "effective", error: null, removed: false,
    limits: { minTimeoutMs: 2000, maxTimeoutMs: 15000 }, ...overrides,
  };
}
/** A second registered plugin that declares no settings of its own. */
function notes(overrides: Partial<WebPluginState> = {}): WebPluginState {
  return plugin({
    id: "dsh-notes", binaryVersion: "1.0.0", tools: [], settingsSchema: {},
    desired: { revision: 0, enabled: true, settings: {} }, effective: null, phase: "saved", ...overrides,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function ready() { return screen.findByRole("spinbutton", { name: "请求超时（毫秒）" }); }
const panel = (id: string) => screen.getByRole("region", { name: `插件 ${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  api.listWebPlugins.mockResolvedValue([plugin()]);
  api.listWebPluginRevisions.mockResolvedValue([config()]);
});
afterEach(() => { vi.useRealTimers(); });

describe("PluginsCard", () => {
  it("shows loading, a retryable load error, and the approved installed binary", async () => {
    const request = deferred<WebPluginState[]>();
    api.listWebPlugins.mockReturnValueOnce(request.promise);
    const view = render(<PluginsCard projectId="alpha" />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取插件");
    await act(async () => request.resolve([plugin()]));
    expect(await ready()).toHaveValue(15000);
    expect(screen.getByText("已安装版本 0.3.2")).toBeInTheDocument();
    expect(screen.getByText(/cite_lookup/)).toBeInTheDocument();
    view.unmount();
    api.listWebPlugins.mockRejectedValueOnce(new Error("network"));
    render(<PluginsCard projectId="alpha" />);
    expect(await screen.findByText("无法读取插件配置")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await ready()).toHaveValue(15000);
  });

  it("shows an empty approved catalog without fabricating installed plugins", async () => {
    api.listWebPlugins.mockResolvedValue([]);
    render(<PluginsCard projectId="alpha" />);
    expect(await screen.findByText("暂无可配置的插件")).toBeInTheDocument();
    expect(screen.queryByText("dsh-cite")).not.toBeInTheDocument();
  });

  // (a) Discovery: whatever the control plane registered is what the card shows.
  it("lists every discovered plugin and configures one without touching the other", async () => {
    api.listWebPlugins.mockResolvedValue([plugin(), notes()]);
    api.saveWebPlugin.mockResolvedValue(notes({ desired: { revision: 1, enabled: false, settings: {} }, phase: "pending" }));
    render(<PluginsCard projectId="alpha" />);
    await ready();
    expect(screen.getByRole("heading", { name: "dsh-cite" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "dsh-notes" })).toBeInTheDocument();
    expect(within(panel("dsh-notes")).getByText("已安装版本 1.0.0")).toBeInTheDocument();
    // A plugin with no settings of its own gets no settings form, only its switch.
    expect(within(panel("dsh-notes")).queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(within(panel("dsh-cite")).getByRole("spinbutton")).toBeInTheDocument();
    fireEvent.click(within(panel("dsh-notes")).getByRole("switch"));
    fireEvent.click(within(panel("dsh-notes")).getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(api.saveWebPlugin).toHaveBeenCalledTimes(1));
    expect(api.saveWebPlugin.mock.calls[0].slice(0, 3)).toEqual(["alpha", "dsh-notes", { expectedRevision: 0, enabled: false, settings: {} }]);
    expect(within(panel("dsh-notes")).getByLabelText("已保存配置")).toHaveTextContent("版本 1 · 已禁用");
    expect(within(panel("dsh-cite")).getByLabelText("已保存配置")).toHaveTextContent("版本 0 · 已启用 · 15000 毫秒");
  });

  // (b) Upgrade: an unrecorded availability must never read as "up to date".
  it("reports an unknown availability as unknown and offers an update only when one is recorded", async () => {
    render(<PluginsCard projectId="alpha" />);
    await ready();
    expect(screen.getByText("更新信息暂不可用，尚未记录检查结果")).toBeInTheDocument();
    expect(screen.queryByText(/暂无可用的程序版本更新|已是最新|已是记录中的最新版本/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看更新" })).not.toBeInTheDocument();

    api.listWebPlugins.mockResolvedValue([plugin({ availability: { state: "current", checkedAt: "2026-09-06T02:00:00.000Z", reason: "recorded" } })]);
    fireEvent.click(screen.getByRole("button", { name: "刷新插件状态" }));
    expect(await screen.findByText("已是记录中的最新版本（检查于 2026-09-06）")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看更新" })).not.toBeInTheDocument();

    api.listWebPlugins.mockResolvedValue([plugin({
      availability: { state: "update-available", checkedAt: "2026-09-06T02:00:00.000Z", reason: "recorded" },
      availableUpdate: { version: "0.3.4", recordedAt: "2026-09-06T02:00:00.000Z", source: "npm" },
    })]);
    fireEvent.click(screen.getByRole("button", { name: "刷新插件状态" }));
    expect(await screen.findByText("可更新至 0.3.4（记录于 2026-09-06）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看更新" }));
    // Honest about what the action can do: the binary ships in the runtime image.
    expect(screen.getByText(/随运行时镜像发布/)).toBeInTheDocument();
  });

  // (c)/(e) Removal is a state change the user confirms; history keeps it undoable.
  // The plugin removed here is the second one, at a revision of its own, so a
  // panel that removed a name or a revision it did not read would be caught.
  it("removes the panel's own plugin at its own revision, only through the confirmation dialog", async () => {
    const configured = notes({ desired: { revision: 3, enabled: true, settings: {} } });
    api.listWebPlugins.mockResolvedValue([plugin(), configured]);
    api.removeWebPlugin.mockResolvedValue(notes({ desired: { revision: 4, enabled: false, settings: {} }, removed: true, phase: "pending" }));
    render(<PluginsCard projectId="alpha" />);
    await ready();
    fireEvent.click(within(panel("dsh-notes")).getByRole("button", { name: "移除插件" }));
    const cancelled = screen.getByRole("alertdialog");
    expect(cancelled).toHaveTextContent("移除 dsh-notes");
    expect(cancelled).toHaveTextContent("恢复为默认值");
    expect(cancelled).toHaveTextContent("可随时重新启用");
    fireEvent.click(within(cancelled).getByRole("button", { name: "取消" }));
    expect(api.removeWebPlugin).not.toHaveBeenCalled();
    fireEvent.click(within(panel("dsh-notes")).getByRole("button", { name: "移除插件" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "移除插件" }));
    await waitFor(() => expect(api.removeWebPlugin).toHaveBeenCalledTimes(1));
    expect(api.removeWebPlugin.mock.calls[0].slice(0, 3)).toEqual(["alpha", "dsh-notes", { expectedRevision: 3 }]);
    expect(await screen.findByText("此项目已移除该插件：已停用并恢复默认配置，配置历史保留。")).toBeInTheDocument();
    expect(within(panel("dsh-notes")).getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(within(panel("dsh-notes")).queryByRole("button", { name: "移除插件" })).not.toBeInTheDocument();
    // The other plugin was neither removed nor touched.
    expect(within(panel("dsh-cite")).getByRole("button", { name: "移除插件" })).toBeEnabled();
    expect(within(panel("dsh-cite")).getByLabelText("已保存配置")).toHaveTextContent("版本 0 · 已启用 · 15000 毫秒");
  });

  // A read that starts while a save is in flight lands its pre-save answer on
  // top of the save's own reply, and the card then reports a version conflict
  // the user never caused. Nothing may start one until the mutation settles.
  it("locks the whole card while one plugin is mutating", async () => {
    api.listWebPlugins.mockResolvedValue([plugin(), notes()]);
    const save = deferred<WebPluginState>();
    api.saveWebPlugin.mockReturnValue(save.promise);
    render(<PluginsCard projectId="alpha" />);
    await ready();
    fireEvent.click(within(panel("dsh-notes")).getByRole("switch"));
    fireEvent.click(within(panel("dsh-notes")).getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(api.saveWebPlugin).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "刷新插件状态" })).toBeDisabled();
    expect(within(panel("dsh-cite")).getByRole("switch")).toBeDisabled();
    expect(within(panel("dsh-cite")).getByRole("spinbutton")).toBeDisabled();
    expect(within(panel("dsh-cite")).getByRole("button", { name: "移除插件" })).toBeDisabled();
    const reads = api.listWebPlugins.mock.calls.length;
    await act(async () => save.resolve(notes({ desired: { revision: 1, enabled: false, settings: {} }, phase: "pending" })));
    expect(api.listWebPlugins.mock.calls.length).toBe(reads);
    expect(screen.getByRole("button", { name: "刷新插件状态" })).toBeEnabled();
    expect(within(panel("dsh-cite")).getByRole("switch")).toBeEnabled();
  });

  it("saves once and distinguishes desired configuration from the old effective configuration", async () => {
    const saved = plugin({ desired: config(1, 4000, false), phase: "pending" });
    api.saveWebPlugin.mockResolvedValue(saved);
    render(<PluginsCard projectId="alpha" />);
    fireEvent.change(await ready(), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("switch", { name: "启用插件 dsh-cite" }));
    expect(api.saveWebPlugin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(api.saveWebPlugin).toHaveBeenCalledTimes(1));
    expect(api.saveWebPlugin.mock.calls[0].slice(0, 3)).toEqual(["alpha", "dsh-cite", { expectedRevision: 0, enabled: false, settings: { timeoutMs: 4000 } }]);
    expect(await screen.findByText("等待应用")).toBeInTheDocument();
    expect(screen.getByLabelText("已保存配置")).toHaveTextContent("版本 1 · 已禁用 · 4000 毫秒");
    expect(screen.getByLabelText("已验证生效配置")).toHaveTextContent("版本 0 · 已启用 · 15000 毫秒");
    expect(screen.getByText(/进行中的任务不会被中断/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  });

  it.each(["", "1999", "15001", "2000.5", "-3000"])("rejects invalid timeout %s before sending", async (value) => {
    render(<PluginsCard projectId="alpha" />);
    fireEvent.change(await ready(), { target: { value } });
    expect(screen.getByRole("alert")).toHaveTextContent("请输入 2000–15000 之间的整数");
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    expect(api.saveWebPlugin).not.toHaveBeenCalled();
  });

  it("honors the lower deployment timeout maximum", async () => {
    api.listWebPlugins.mockResolvedValue([plugin({ desired: config(0, 6000), settingsSchema: { timeoutMs: { min: 2000, max: 6000 } }, limits: { minTimeoutMs: 2000, maxTimeoutMs: 6000 } })]);
    render(<PluginsCard projectId="alpha" />);
    fireEvent.change(await ready(), { target: { value: "6001" } });
    expect(screen.getByRole("alert")).toHaveTextContent("请输入 2000–6000 之间的整数");
  });

  it("refuses configuration controls for settings this version cannot render", async () => {
    api.listWebPlugins.mockResolvedValue([plugin({ binaryVersion: "0.4.0", settingsSchema: { timeoutMs: { min: 2000, max: 15000 }, retries: { min: 0, max: 5 } } })]);
    render(<PluginsCard projectId="alpha" />);
    expect(await ready()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("当前程序版本不支持配置");
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "移除插件" })).toBeDisabled();
  });

  it("keeps edits and allows an explicit retry after a failed save", async () => {
    api.saveWebPlugin.mockRejectedValueOnce(new Error("network"));
    render(<PluginsCard projectId="alpha" />);
    fireEvent.change(await ready(), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("操作未完成，请重试。你的输入已保留。")).toBeInTheDocument();
    expect(await ready()).toHaveValue(4000);
    api.saveWebPlugin.mockResolvedValue(plugin({ desired: config(1, 4000), effective: config(1, 4000) }));
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(screen.getByLabelText("已验证生效配置")).toHaveTextContent("版本 1"));
  });

  it("retains unsaved input on an unrelated manual status refresh", async () => {
    render(<PluginsCard projectId="alpha" />);
    fireEvent.change(await ready(), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: "刷新插件状态" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新插件状态" })).toBeEnabled());
    expect(await ready()).toHaveValue(4000);
    fireEvent.click(screen.getByRole("button", { name: "撤销未保存修改" }));
    expect(await ready()).toHaveValue(15000);
    expect(api.saveWebPlugin).not.toHaveBeenCalled();
  });

  it.each([
    ["saved", "已保存，首次启动后验证生效", false],
    ["rolled_back", "应用失败，已恢复上次有效配置", true],
    ["unavailable", "插件暂不可用，尚未确认恢复成功", true],
    ["failed", "应用失败，尚未确认恢复成功", true],
  ] as const)("reports %s truthfully and only retries failed application", async (phase, label, retry) => {
    api.listWebPlugins.mockResolvedValue([plugin({ phase, effective: phase === "saved" ? null : config() })]);
    api.retryWebPlugin.mockResolvedValue(plugin({ phase: "pending" }));
    render(<PluginsCard projectId="alpha" />);
    expect(await screen.findByText(label)).toBeInTheDocument();
    if (retry) {
      fireEvent.click(screen.getByRole("button", { name: "重试应用" }));
      expect(await screen.findByText("等待应用")).toBeInTheDocument();
      expect(api.retryWebPlugin.mock.calls[0].slice(0, 2)).toEqual(["alpha", "dsh-cite"]);
    } else {
      expect(screen.getByLabelText("已验证生效配置")).toHaveTextContent("尚未验证生效");
      expect(screen.queryByRole("button", { name: "重试应用" })).not.toBeInTheDocument();
    }
  });

  it("loads history and restores a configuration as a new revision without claiming binary rollback", async () => {
    api.listWebPlugins.mockResolvedValue([plugin({ desired: config(2, 8000), effective: config(2, 8000) })]);
    api.listWebPluginRevisions.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([config(2, 8000), config(1, 4000)]);
    api.rollbackWebPlugin.mockResolvedValue(plugin({ desired: config(3, 4000), effective: config(2, 8000), phase: "pending" }));
    render(<PluginsCard projectId="alpha" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "配置历史" }));
    expect(await screen.findByText("无法读取配置历史")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试读取历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复配置版本 1" }));
    const confirmation = screen.getByRole("alertdialog");
    expect(confirmation).toHaveTextContent("创建新的配置版本");
    expect(confirmation).toHaveTextContent("0.3.2");
    fireEvent.click(within(confirmation).getByRole("button", { name: "恢复配置" }));
    expect(await screen.findByText("等待应用")).toBeInTheDocument();
    expect(api.rollbackWebPlugin.mock.calls[0].slice(0, 3)).toEqual(["alpha", "dsh-cite", { expectedRevision: 2, targetRevision: 1 }]);
    expect(screen.getByLabelText("已保存配置")).toHaveTextContent("版本 3");
    expect(screen.queryByText("应用失败，已恢复上次有效配置")).not.toBeInTheDocument();
  });

  it("preserves unsaved input after refresh and requires review of a conflicting revision", async () => {
    api.saveWebPlugin.mockRejectedValueOnce(new WebApiError("conflict", { status: 409, code: "product_revision_conflict" }));
    render(<PluginsCard projectId="alpha" />);
    fireEvent.change(await ready(), { target: { value: "4000" } });
    api.listWebPlugins.mockResolvedValue([plugin({ desired: config(1, 6000) })]);
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText(/你的未保存输入已保留/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("已保存配置")).toHaveTextContent("版本 1"));
    expect(await ready()).toHaveValue(4000);
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保留输入并采用最新版本" }));
    api.saveWebPlugin.mockResolvedValue(plugin({ desired: config(2, 4000), phase: "pending" }));
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(api.saveWebPlugin).toHaveBeenCalledTimes(2));
    expect(api.saveWebPlugin.mock.calls[1][2].expectedRevision).toBe(1);
  });

  it("isolates project switches and ignores late old-project reads and writes", async () => {
    const oldRead = deferred<WebPluginState[]>();
    api.listWebPlugins.mockReturnValueOnce(oldRead.promise);
    const view = render(<PluginsCard projectId="alpha" />);
    view.rerender(<PluginsCard projectId="beta" />);
    expect(await ready()).toHaveValue(15000);
    await act(async () => oldRead.resolve([plugin({ desired: config(99, 2000) })]));
    expect(await ready()).toHaveValue(15000);
    const oldSave = deferred<WebPluginState>();
    api.saveWebPlugin.mockReturnValueOnce(oldSave.promise);
    fireEvent.change(await ready(), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    view.rerender(<PluginsCard projectId="gamma" />);
    expect(await ready()).toHaveValue(15000);
    await act(async () => oldSave.resolve(plugin({ desired: config(22, 4000) })));
    expect(screen.getByLabelText("已保存配置")).toHaveTextContent("版本 0");
    expect(api.saveWebPlugin.mock.calls[0][0]).toBe("beta");
    expect(api.saveWebPlugin.mock.calls[0][3].aborted).toBe(true);
  });

  it("ignores an old project's history after switching projects", async () => {
    const history = deferred<ReturnType<typeof config>[]>();
    api.listWebPluginRevisions.mockReturnValueOnce(history.promise);
    const view = render(<PluginsCard projectId="alpha" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "配置历史" }));
    view.rerender(<PluginsCard projectId="beta" />);
    await ready();
    await act(async () => history.resolve([config(88)]));
    expect(screen.queryByRole("button", { name: "恢复配置版本 88" })).not.toBeInTheDocument();
    expect(api.listWebPluginRevisions.mock.calls[0][2].aborted).toBe(true);
  });

  it("polls only pending/application phases, preserves edits, and stops at effective", async () => {
    vi.useFakeTimers();
    api.listWebPlugins.mockResolvedValue([plugin({ phase: "pending" })]);
    render(<PluginsCard projectId="alpha" />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "4000" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.listWebPlugins).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("spinbutton")).toHaveValue(4000);
    api.listWebPlugins.mockResolvedValue([plugin()]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const count = api.listWebPlugins.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(api.listWebPlugins).toHaveBeenCalledTimes(count);
  });

  it("bounds applying-state polling and resumes only after manual refresh", async () => {
    vi.useFakeTimers();
    api.listWebPlugins.mockResolvedValue([plugin({ phase: "applying" })]);
    const view = render(<PluginsCard projectId="alpha" />);
    await act(async () => { await Promise.resolve(); });
    for (let index = 0; index < 24; index++) await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.listWebPlugins).toHaveBeenCalledTimes(25);
    expect(screen.getByText(/自动刷新已暂停/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(api.listWebPlugins).toHaveBeenCalledTimes(25);
    fireEvent.click(screen.getByRole("button", { name: "刷新插件状态" }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.listWebPlugins).toHaveBeenCalledTimes(27);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(api.listWebPlugins).toHaveBeenCalledTimes(27);
  });
});
