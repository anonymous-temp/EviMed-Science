import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { PluginsPage } from "./PluginsPage";

const mocks = vi.hoisted(() => ({ extensionCatalogue: vi.fn(), extensionInstallations: vi.fn(), installExtension: vi.fn() }));
vi.mock("@/lib/extensionsClient", async original => ({ ...(await original<object>()), ...mocks }));
const first = { id: "table-tool", title: "表格工具", coordinate: { kind: "npm", name: "table-tool", version: "1.0.0" }, executionClass: "isolated-tool", settingsSchema: {}, evidenceState: "source-assessed", qualification: null };
const second = { ...first, id: "figure-tool", title: "图表工具", coordinate: { kind: "npm", name: "figure-tool", version: "2.0.0" } };
function Location() { return <p data-testid="location">{useLocation().pathname}</p>; }
function open() { render(<MemoryRouter initialEntries={["/app/extensions/plugins"]}><PluginsPage /><Location /></MemoryRouter>); }
beforeEach(() => {
  vi.clearAllMocks();
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
