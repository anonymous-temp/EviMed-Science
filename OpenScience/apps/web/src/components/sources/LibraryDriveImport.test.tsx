import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryDriveImport } from "./LibraryDriveImport";
const mocks = vi.hoisted(() => ({ status: vi.fn(), upload: vi.fn(), operator: false }));
vi.mock("@/lib/sourceClient", () => ({ getOpenListStatus: mocks.status }));
vi.mock("@/lib/useOperator", () => ({ useOperator: () => mocks.operator }));
vi.mock("./DriveImport", () => ({ DriveImportDrawerBody: ({ projectId }: { projectId: string }) => <div>导入到{projectId}</div> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); mocks.operator = false; });
function view() { render(<MemoryRouter><LibraryDriveImport projectId={null} destinations={[{ id: "p1", label: "项目一" }]} refreshToken={0} onUpload={mocks.upload} onImported={() => {}} onFolderRegistered={() => {}} /></MemoryRouter>); }
it("keeps loading distinct, retries a failure and requires an explicit project before browsing", async () => {
 let settle!: (value: { state: string }) => void;
 mocks.status.mockReturnValueOnce(new Promise(resolve => { settle = resolve; })).mockResolvedValueOnce({ state: "ready" });
 view(); expect(screen.getByRole("status")).toHaveTextContent("正在检查");
 settle({ state: "unavailable" }); expect(await screen.findByText(/暂时无法连接网盘/)).toBeInTheDocument();
 await userEvent.click(screen.getByRole("button", { name: "重试连接" }));
 expect(await screen.findByText("请先选择保存资料的项目。" )).toBeInTheDocument();
 await userEvent.click(screen.getByRole("combobox", { name: "保存位置" }));
 await userEvent.click(screen.getByRole("button", { name: "项目一" }));
 expect(screen.getByText("导入到p1")).toBeInTheDocument();
});
it.each([["unconfigured", "尚未连接网盘"], ["storage_missing", "尚未添加可用的存储空间"], ["permission_denied", "没有访问网盘的权限"]])("names %s honestly", async (state, text) => {
 mocks.status.mockResolvedValue({ state }); view(); expect(await screen.findByText(new RegExp(text))).toBeInTheDocument(); expect(screen.queryByRole("combobox")).toBeNull();
});

it("offers local upload as a working alternative when the drive is not configured", async () => {
 mocks.status.mockResolvedValue({ state: "unconfigured" }); view();
 await userEvent.click(await screen.findByRole("button", { name: "上传文件" }));
 expect(mocks.upload).toHaveBeenCalledOnce();
});
it("names the operator destination as an access-status check", async () => {
 mocks.operator = true; mocks.status.mockResolvedValue({ state: "unconfigured" }); view();
 expect(await screen.findByRole("link", { name: "查看网盘接入状态" })).toHaveAttribute("href", "/app/ops");
 expect(screen.queryByRole("link", { name: /设置/ })).toBeNull();
});
