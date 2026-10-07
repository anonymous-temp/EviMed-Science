import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { CitationDrawer } from "./PluginDrawers";
import { useCitationPlugin } from "./useCitationPlugin";

const api = vi.hoisted(() => ({ listWebPlugins: vi.fn(), saveWebPlugin: vi.fn(), listWebPluginRevisions: vi.fn(), retryWebPlugin: vi.fn(), rollbackWebPlugin: vi.fn() }));
vi.mock("@/lib/apiClient", async original => ({ ...(await original<object>()), ...api }));

const plugin = (over: object = {}) => ({
  id: "dsh-cite", binaryVersion: "0.3.2", tools: ["cite_lookup", "cite_bibtex", "cite_health"], settingsSchema: { timeoutMs: { min: 2000, max: 15000 } },
  desired: { revision: 2, enabled: true, settings: { timeoutMs: 15000 } }, effective: { revision: 2, enabled: true, settings: { timeoutMs: 15000 } },
  phase: "effective", error: null, removed: false, limits: { minTimeoutMs: 2000, maxTimeoutMs: 15000 }, ...over,
});
function Harness() {
  const citation = useCitationPlugin("project-1");
  return <CitationDrawer citation={citation} projectName="我的研究" onClose={() => {}} />;
}
const show = async () => { render(<Harness />); return screen.findByRole("dialog", { name: "文献引用核对" }); };
beforeEach(() => {
  vi.resetAllMocks();
  api.listWebPlugins.mockResolvedValue([plugin()]);
  api.listWebPluginRevisions.mockResolvedValue([
    { revision: 2, enabled: true, settings: { timeoutMs: 15000 }, recordedAt: "2026-10-06T09:45:00.000Z" },
    { revision: 1, enabled: false, settings: { timeoutMs: 8000 }, recordedAt: "2026-10-05T08:30:00.000Z" },
  ]);
});

it("opens on the switch for this project, what the plugin does and the tools it brings — in sentences, never names", async () => {
  const drawer = await show();
  await waitFor(() => expect(within(drawer).getByRole("switch", { name: "在“我的研究”里使用" })).toBeChecked());
  expect(within(drawer).getByText(/按 DOI、PMID 查回原始书目记录/)).toBeInTheDocument();
  const tools = within(drawer).getByText("提供的工具").parentElement!;
  expect(within(tools).getAllByRole("listitem").map(item => item.textContent)).toEqual(["按标题、DOI 或 PMID 查找文献书目", "导出 BibTeX"]);
  expect(drawer.textContent).not.toMatch(/dsh-cite|cite_lookup|cite_health|版本 \d|毫秒|15000|已验证生效|技术标识/);
});

it("flipping the switch saves for this project against the saved state, and a waiting save says when it takes effect", async () => {
  api.saveWebPlugin.mockResolvedValue(plugin({ desired: { revision: 3, enabled: false, settings: { timeoutMs: 15000 } }, effective: null, phase: "pending" }));
  const drawer = await show();
  expect(within(drawer).queryByText("保存后在下次对话生效")).not.toBeInTheDocument();
  const toggle = await within(drawer).findByRole("switch", { name: "在“我的研究”里使用" });
  await waitFor(() => expect(toggle).toBeEnabled());
  await userEvent.click(toggle);
  await waitFor(() => expect(api.saveWebPlugin).toHaveBeenCalledWith("project-1", "dsh-cite", { expectedRevision: 2, enabled: false, settings: { timeoutMs: 15000 } }, expect.anything()));
  expect(await within(drawer).findByText("保存后在下次对话生效")).toBeInTheDocument();
  expect(within(drawer).getByRole("switch", { name: "在“我的研究”里使用" })).not.toBeChecked();
});

it("the timeout is set in seconds under 高级设置 and saved as the milliseconds the plugin takes; a value out of range is not sent", async () => {
  api.saveWebPlugin.mockResolvedValue(plugin({ desired: { revision: 3, enabled: true, settings: { timeoutMs: 8000 } } }));
  const drawer = await show();
  const field = await within(drawer).findByRole("spinbutton", { name: "请求超时（秒）" });
  expect(field).toHaveValue(15);
  const save = within(drawer).getByRole("button", { name: "保存" });
  expect(save).toBeDisabled();
  await userEvent.clear(field); await userEvent.type(field, "99");
  expect(await within(drawer).findByText("请输入 2–15 之间的整数。")).toBeInTheDocument();
  expect(save).toBeDisabled();
  await userEvent.clear(field); await userEvent.type(field, "8");
  await userEvent.click(save);
  await waitFor(() => expect(api.saveWebPlugin).toHaveBeenCalledWith("project-1", "dsh-cite", { expectedRevision: 2, enabled: true, settings: { timeoutMs: 8000 } }, expect.anything()));
});

it("earlier settings are listed by the day and time they were saved, and one is restored against the current state", async () => {
  api.rollbackWebPlugin.mockResolvedValue(plugin({ desired: { revision: 3, enabled: false, settings: { timeoutMs: 8000 } } }));
  const drawer = await show();
  const history = await within(drawer).findByRole("list", { name: "配置历史" });
  expect(within(history).getAllByRole("listitem")).toHaveLength(2);
  expect(within(history).getByText("已启用 · 请求超时 15 秒")).toBeInTheDocument();
  expect(within(history).getByText("已停用 · 请求超时 8 秒")).toBeInTheDocument();
  expect(within(history).getAllByRole("button", { name: "恢复这一项" })).toHaveLength(1);
  await userEvent.click(within(history).getByRole("button", { name: "恢复这一项" }));
  await waitFor(() => expect(api.rollbackWebPlugin).toHaveBeenCalledWith("project-1", "dsh-cite", { expectedRevision: 2, targetRevision: 1 }, expect.anything()));
});

it("a setting that did not take says so once and offers to try again", async () => {
  api.listWebPlugins.mockResolvedValue([plugin({ phase: "failed", effective: null })]);
  api.retryWebPlugin.mockResolvedValue(plugin());
  const drawer = await show();
  expect(await within(drawer).findByText(/这项设置没能生效/)).toBeInTheDocument();
  await userEvent.click(within(drawer).getByRole("button", { name: "重试" }));
  await waitFor(() => expect(api.retryWebPlugin).toHaveBeenCalledWith("project-1", "dsh-cite", expect.anything()));
  await waitFor(() => expect(within(drawer).queryByText(/这项设置没能生效/)).not.toBeInTheDocument());
});

it("a change made elsewhere first is not overwritten: the state is read again and the reader is told", async () => {
  api.saveWebPlugin.mockRejectedValue(new WebApiError("conflict", { status: 409 }));
  const drawer = await show();
  const toggle = await within(drawer).findByRole("switch", { name: "在“我的研究”里使用" });
  await waitFor(() => expect(toggle).toBeEnabled());
  api.listWebPlugins.mockResolvedValue([plugin({ desired: { revision: 3, enabled: false, settings: { timeoutMs: 15000 } } })]);
  await userEvent.click(toggle);
  expect(await within(drawer).findByRole("alert")).toHaveTextContent("刚在别处改过");
  await waitFor(() => expect(within(drawer).getByRole("switch", { name: "在“我的研究”里使用" })).not.toBeChecked());
});

it("a plugin that cannot be read leaves the switch off and says why, once", async () => {
  api.listWebPlugins.mockRejectedValue(new Error("down"));
  const drawer = await show();
  expect(await within(drawer).findByRole("alert")).toHaveTextContent("插件状态暂时读不到");
  expect(within(drawer).getByRole("switch", { name: "在“我的研究”里使用" })).toBeDisabled();
});
