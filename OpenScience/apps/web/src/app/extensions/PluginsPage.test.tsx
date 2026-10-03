import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/projects";
import { PluginsPage } from "./PluginsPage";

const mocks = vi.hoisted(() => ({ productRequest: vi.fn(), extensionCatalogue: vi.fn(), extensionInstallations: vi.fn(), installExtension: vi.fn() }));
vi.mock("@/lib/extensionsClient", async original => ({ ...(await original<object>()), ...mocks }));
vi.mock("@/lib/productClient", async original => ({ ...(await original<object>()), productRequest: mocks.productRequest }));
vi.mock("@/components/settings/PluginsCard", () => ({ PluginsCard: ({ projectId }: { projectId: string }) => <p>原有引用设置 {projectId}</p> }));
const first = { id: "table-tool", title: "表格工具", coordinate: { kind: "npm", name: "table-tool", version: "1.0.0" }, executionClass: "isolated-tool", settingsSchema: {}, evidenceState: "source-assessed", qualification: null };
const second = { ...first, id: "figure-tool", title: "图表工具", coordinate: { kind: "npm", name: "figure-tool", version: "2.0.0" } };
function Location() { return <p data-testid="location">{useLocation().pathname}</p>; }
function open() { render(<MemoryRouter initialEntries={["/app/extensions/plugins"]}><PluginsPage /><Location /></MemoryRouter>); }
beforeEach(() => {
  vi.resetAllMocks();
  useProjectStore.setState({ currentId: "owned-project", projects: [{ id: "owned-project", name: "当前项目" }] });
  mocks.productRequest.mockResolvedValue(inventory);
  mocks.extensionCatalogue.mockResolvedValue({ items: [first, second], generatedAt: "2026-10-02T00:00:00Z" });
  mocks.extensionInstallations.mockResolvedValue({ items: [], nextCursor: null });
});

it("keeps saved preparation separate from actual availability and offers ordinary-user installation", async () => {
  mocks.extensionInstallations.mockResolvedValue({ items: [{ id: "extension:pending", catalogueId: first.id, phase: "preparing", effective: false }], nextCursor: null });
  mocks.installExtension.mockResolvedValue({ installation: { id: "extension:added" }, job: { id: "prepare1", status: "pending" } });
  const user = userEvent.setup(); open();
  expect(await screen.findByText("准备中")).toBeInTheDocument();
  expect(screen.queryByText("可使用")).not.toBeInTheDocument();
  const discovery = screen.getByRole("region", { name: "发现插件" });
  expect(within(discovery).getAllByText("尚未验证")).toHaveLength(2);
  await user.click(within(discovery).getAllByRole("button", { name: "添加" })[0]);
  await waitFor(() => expect(mocks.installExtension).toHaveBeenCalledWith(first.coordinate, expect.any(String)));
  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/extensions/plugins/extension%3Aadded"));
});
it("reuses an uncertain request key only for the same exact package coordinate", async () => {
  mocks.installExtension.mockRejectedValue(new Error("Connection lost after submission."));
  const user = userEvent.setup(); open();
  const discovery = await screen.findByRole("region", { name: "发现插件" });
  await user.click(within(discovery).getAllByRole("button", { name: "添加" })[0]);
  await screen.findByRole("alert");
  await waitFor(() => expect(within(discovery).getAllByRole("button", { name: "添加" })[1]).toBeEnabled());
  await user.click(within(discovery).getAllByRole("button", { name: "添加" })[1]);
  await waitFor(() => expect(mocks.installExtension).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(within(discovery).getAllByRole("button", { name: "添加" })[0]).toBeEnabled());
  await user.click(within(discovery).getAllByRole("button", { name: "添加" })[0]);
  await waitFor(() => expect(mocks.installExtension).toHaveBeenCalledTimes(3));
  const calls = mocks.installExtension.mock.calls;
  expect(calls[0][1]).toBe(calls[2][1]); expect(calls[0][1]).not.toBe(calls[1][1]);
  expect(calls[0][0]).toEqual(first.coordinate); expect(calls[1][0]).toEqual(second.coordinate);
});

const inventory = { projectId: "owned-project", items: [
  { id: "dsh-cite", version: "0.3.2", kind: "tool", management: "project", configuredEnabled: true, configurationPhase: "pending", observation: "unknown" },
  { id: "dsh-annotation", version: "1.4.10", kind: "client", management: "deployment", configuredEnabled: true, configurationPhase: "configured", observation: "unknown" },
  { id: "dsh-mermaid", version: "0.4.0", kind: "client", management: "deployment", configuredEnabled: false, configurationPhase: "disabled", observation: "unknown" },
] };
it("marketplace failure preserves built-in citation settings and honest configured client states", async () => {
  mocks.extensionCatalogue.mockRejectedValue(new Error("marketplace offline")); open();
  const builtin = await screen.findByRole("region", { name: "内置能力" }); expect(within(builtin).getByText("批注")).toBeInTheDocument(); expect(within(builtin).getByText("Mermaid 图表")).toBeInTheDocument();
  expect(within(builtin).getByText("部署已配置 · 运行状态尚未确认")).toBeInTheDocument(); expect(within(builtin).getByText("部署已关闭")).toBeInTheDocument(); expect(within(builtin).getByText("原有引用设置 owned-project")).toBeInTheDocument(); expect(within(builtin).queryByText("运行就绪")).not.toBeInTheDocument();
});
it("late builtin inventory responses cannot label a newly selected project", async () => {
  let resolve!: (value: typeof inventory) => void; mocks.productRequest.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue({ ...inventory, projectId: "new-project", items: [] }); open();
  await waitFor(() => expect(mocks.productRequest).toHaveBeenCalled()); await act(async () => useProjectStore.setState({ currentId: "new-project" })); await act(async () => resolve(inventory));
  expect(screen.queryByText("批注")).not.toBeInTheDocument(); expect(mocks.productRequest).toHaveBeenLastCalledWith("/projects/new-project/plugin-inventory");
});
it("builtin read failure retries separately from ordinary marketplace discovery", async () => {
  mocks.productRequest.mockRejectedValueOnce(new Error("inventory offline")).mockResolvedValueOnce(inventory); open(); await userEvent.click(await screen.findByRole("button", { name: "重试读取内置能力" })); expect(await screen.findByText("批注")).toBeInTheDocument(); expect(screen.getByRole("region", { name: "发现插件" })).toBeInTheDocument();
});
