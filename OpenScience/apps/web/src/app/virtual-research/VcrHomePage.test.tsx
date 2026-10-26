import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { VcrHomePage, studyStateOf } from "./VcrHomePage";
import { fixture, installVcrServer } from "@/components/vcr/__fixtures__/serverFixtures";

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const me = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock("@/lib/apiClient", async original => ({ ...(await original<typeof import("@/lib/apiClient")>()), fetchWebMe: me.fetchWebMe }));
const store = vi.hoisted(() => ({ currentId: "geo-project", select: vi.fn(async (_id: string, land?: () => void) => land?.()) }));
vi.mock("@/lib/projects", () => ({ useProjectStore: (selector: (state: typeof store) => unknown) => selector(store) }));
function Probe() { const location = useLocation(); return <pre data-testid="location">{JSON.stringify({ path: location.pathname, state: location.state })}</pre>; }
function draw(path = "/app/virtual-research") { return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/app/virtual-research" element={<VcrHomePage />} /><Route path="*" element={<Probe />} /></Routes></MemoryRouter>); }
let server: ReturnType<typeof installVcrServer>;
beforeEach(() => { server = installVcrServer(network.productRequest); me.fetchWebMe.mockResolvedValue({ features: { vcr: true } }); store.select.mockClear(); });
afterEach(cleanup);
it.each(["患者匹配", "人群与患者", "合成对照", "虚拟试验"])("opens %s as an unsent native conversation draft without creating a study", async label => {
  draw(); await userEvent.click(await screen.findByRole("button", { name: label }));
  const location = JSON.parse(screen.getByTestId("location").textContent!);
  expect(location.path).toBe("/app/chat");
  expect(location.state.globalAssistant).toBe(true);
  expect(location.state.conversationProjectId).toBe("default");
  expect(location.state.runtimeUiIntent.projectId).toBe("default");
  expect(location.state.runtimeUiIntent.draft).toBeTruthy();
  expect(location.state.capabilityId).toBeUndefined();
  expect(server.calls.filter(call => call.method === "POST")).toEqual([]);
  expect(store.select).toHaveBeenCalledWith("default", expect.any(Function));
});
it("keeps per-task input requirements visible on an empty account", async () => {
  server = installVcrServer(network.productRequest, { "GET /vcr/studies": { studies: [], reviews: [] } }); draw();
  await screen.findByText("研究结果会保留在这里");
  expect(document.querySelectorAll("[data-vcr-data-requirement]")).toHaveLength(4);
  expect(screen.getByText(/文献驱动的合成人群无需患者数据集/)).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();
});
it.each(["?new=1"])("does not reopen an old creation form or method catalogue at %s", async query => {
  draw(`/app/virtual-research${query}`); await screen.findByRole("button", { name: "患者匹配" });
  expect(screen.queryByText("方法库")).toBeNull(); expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();
  expect(server.calls.filter(call => call.method === "POST")).toEqual([]);
});
it("keeps study search and evidence-backed attention while ignoring historical recruitment todos", async () => {
  draw(); await screen.findByRole("link", { name: /EV-201 二线/ });
  expect(document.querySelector("[data-step-rail]")).toBeNull(); expect(document.querySelector("[data-vcr-todo]")).toBeNull();
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索研究" }), "GLP-1");
  expect(screen.queryByRole("link", { name: /EV-201 二线/ })).toBeNull(); expect(screen.getByRole("link", { name: /GLP-1 周制剂/ })).toBeInTheDocument();
});
it("honors the feature flag and preserves a retry for read failures", async () => {
  me.fetchWebMe.mockResolvedValueOnce({ features: { vcr: false } }); const first = draw();
  await screen.findByText("虚拟临床研究还没有在这个工作空间开放。"); expect(server.calls).toEqual([]); first.unmount();
  server = installVcrServer(network.productRequest, { "GET /vcr/studies": () => { throw new WebApiError("offline", { status: 503 }); } }); draw();
  await screen.findByRole("button", { name: "重试" }); await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
});
it("counts completion against requested tasks rather than all seven methods", () => {
  expect(studyStateOf({ steps: { matching: { status: "done", requested: true }, trial: { status: "none", requested: false } }, attention: [] })).toBe("done");
  expect(studyStateOf({ steps: {}, attention: [] })).toBe("other");
  expect(studyStateOf({ steps: { matching: { status: "running" } }, attention: [] })).toBe("running");
});

it("keeps legacy calculations in a disclosure and preserves their addressed history link", async () => {
  const home = fixture("ev201/home.json");
  home.studies.push({ ...home.studies[0], id: "legacy_calc", name: "Saved calculation", purpose: "calculation" });
  installVcrServer(network.productRequest, { "GET /vcr/studies": home });
  draw();
  await screen.findByRole("list", { name: "研究" });
  expect(screen.getByRole("link", { name: "Saved calculation" }).closest("details")).not.toHaveAttribute("open");
  await userEvent.click(screen.getByText("历史独立计算 · 1"));
  expect(screen.getByRole("link", { name: "Saved calculation" })).toHaveAttribute("href", "/app/capabilities/calculations/legacy_calc");
  expect(screen.getByRole("searchbox", { name: "搜索研究" })).toBeInTheDocument();
});

it("opens saved models at the compatible address without a calculator catalogue", async () => {
  draw("/app/virtual-research?tab=models");
  expect(await screen.findByRole("list", { name: "保存的模型与参数" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "患者匹配" })).toBeNull();
  expect(document.querySelector("[data-vcr-method-catalogue]")).toBeNull();
});
it("keeps task entry above list filters when search changes and opens minimum fields by keyboard", async () => {
  draw(); await screen.findByRole("link", { name: /EV-201 二线/ });
  const introduction = document.querySelector("[data-page-introduction]")!;
  const toolbar = document.querySelector("[data-toolbar]")!;
  expect(introduction.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索研究" }), "none");
  expect(screen.getByRole("button", { name: "患者匹配" })).toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: "查看最低字段与材料形式" })[0]);
  expect(screen.getByRole("dialog", { name: "患者匹配需要的材料" })).toHaveTextContent("记忆胶囊");
});
