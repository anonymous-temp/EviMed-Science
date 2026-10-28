import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_SESSION_ENDED_EVENT, WebApiError } from "@/lib/apiClient";
import { ResearchDatabaseDialog } from "./ResearchDatabaseDialog";

const mocks = vi.hoisted(() => ({ listResearchDatabases: vi.fn(), saveResearchDatabase: vi.fn(), snapshotResearchDatabase: vi.fn(), removeResearchDatabase: vi.fn() }));
vi.mock("@/lib/researchDatabaseClient", () => mocks);
const show = () => { const onCaptured = vi.fn(), onClose = vi.fn(); render(<ResearchDatabaseDialog projectId="p1" agendaId="a1" onClose={onClose} onCaptured={onCaptured} />); return { onCaptured, onClose }; };
describe("research database dialog", () => {
  beforeEach(() => { sessionStorage.clear(); Object.values(mocks).forEach(fn => fn.mockReset()); mocks.listResearchDatabases.mockResolvedValue({ items: [] }); });
  it("shows unavailable without suggesting a successful connection", async () => {
    mocks.listResearchDatabases.mockRejectedValue(new WebApiError("disabled", { status: 503, code: "research_db_unavailable" }));
    show(); expect(await screen.findByRole("alert")).toHaveTextContent("暂不可用或连接未成功");
    expect(screen.queryByRole("button", { name: "保存连接凭据" })).not.toBeInTheDocument();
  });
  it("saves a credential separately from an explicit, scoped snapshot", async () => {
    const user = userEvent.setup(); const callbacks = show();
    mocks.saveResearchDatabase.mockResolvedValue({ id: "conn-one" });
    mocks.snapshotResearchDatabase.mockResolvedValue({ sourceId: "src-one", capturedAt: "2026-10-28", rowCount: 200, truncated: true, oversizedValuesWithheld: true });
    const host = await screen.findByRole("textbox", { name: "主机名" });
    await user.type(host, "db.example.org"); await user.type(screen.getByRole("textbox", { name: "数据库" }), "research");
    await user.type(screen.getByRole("textbox", { name: "用户名" }), "reader"); await user.type(screen.getByLabelText("密码"), "password-for-test");
    mocks.listResearchDatabases.mockResolvedValue({ items: [{ id: "conn-one", createdAt: "2026-10-28" }] });
    await user.click(screen.getByRole("button", { name: "保存连接凭据" }));
    expect(await screen.findByText(/仍需测试数据库连接/)).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(mocks.snapshotResearchDatabase).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: "表名" }), "cohort");
    await user.type(screen.getByRole("textbox", { name: "列名（用英文逗号分隔）" }), "age, outcome");
    await user.click(screen.getByRole("button", { name: "生成快照并添加" }));
    await waitFor(() => expect(mocks.snapshotResearchDatabase).toHaveBeenCalledWith("conn-one", { projectId: "p1", requestId: expect.any(String), agendaId: "a1", schema: "public", table: "cohort", columns: ["age", "outcome"] }));
    expect(await screen.findByText(/有数据未纳入/)).toHaveTextContent("超长字段已省略"); expect(callbacks.onCaptured).toHaveBeenCalledOnce();
  });
  it("reuses the same snapshot request id after an uncertain failure", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue({ items: [{ id: "conn-one", createdAt: "2026-10-28" }] });
    mocks.snapshotResearchDatabase.mockRejectedValueOnce(new Error("network"));
    mocks.snapshotResearchDatabase.mockResolvedValueOnce({ sourceId: "src-one", rowCount: 1, truncated: false, oversizedValuesWithheld: false });
    show(); await user.selectOptions(await screen.findByLabelText("已保存的连接"), "conn-one");
    await user.type(screen.getByRole("textbox", { name: "表名" }), "cohort");
    await user.type(screen.getByRole("textbox", { name: "列名（用英文逗号分隔）" }), "age");
    await user.click(screen.getByRole("button", { name: "生成快照并添加" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("快照结果不确定");
    await user.click(screen.getByRole("button", { name: "生成快照并添加" }));
    await waitFor(() => expect(mocks.snapshotResearchDatabase).toHaveBeenCalledTimes(2));
    expect(mocks.snapshotResearchDatabase.mock.calls[0]).toEqual(mocks.snapshotResearchDatabase.mock.calls[1]);
  });
  it("keeps a failed snapshot request id across dialog remount without storing credentials", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue({ items: [{ id: "conn-one", createdAt: "2026-10-28" }] });
    mocks.snapshotResearchDatabase.mockRejectedValue(new Error("network"));
    const first = render(<ResearchDatabaseDialog projectId="p1" agendaId="a1" onClose={() => {}} onCaptured={() => {}} />);
    await user.selectOptions(await screen.findByLabelText("已保存的连接"), "conn-one");
    await user.type(screen.getByRole("textbox", { name: "表名" }), "cohort"); await user.type(screen.getByRole("textbox", { name: "列名（用英文逗号分隔）" }), "age");
    await user.click(screen.getByRole("button", { name: "生成快照并添加" })); await screen.findByRole("alert");
    const requestId = mocks.snapshotResearchDatabase.mock.calls[0][1].requestId;
    expect(sessionStorage.getItem("evimed.research-db.snapshot.p1.a1")).toBe(requestId);
    first.unmount(); show();
    expect(await screen.findByText(/上次快照结果待确认/)).toBeInTheDocument();
    await user.selectOptions(await screen.findByLabelText("已保存的连接"), "conn-one");
    await user.type(screen.getByRole("textbox", { name: "表名" }), "cohort"); await user.type(screen.getByRole("textbox", { name: "列名（用英文逗号分隔）" }), "age");
    await user.click(screen.getByRole("button", { name: "生成快照并添加" })); await waitFor(() => expect(mocks.snapshotResearchDatabase).toHaveBeenCalledTimes(2));
    expect(mocks.snapshotResearchDatabase.mock.calls[1][1].requestId).toBe(requestId);
    expect(JSON.stringify(sessionStorage)).not.toContain("cohort");
  });
  it("warns when pending request identifiers cannot survive a reload", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try { show(); expect(await screen.findByText(/浏览器无法保存待确认的请求标识/)).toBeInTheDocument(); }
    finally { storage.mockRestore(); }
  });
  it("removes pending identifiers at sign out", async () => {
    sessionStorage.setItem("evimed.research-db.save.p1", "request-one"); show();
    await screen.findByRole("button", { name: "保存连接凭据" });
    window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT));
    expect(sessionStorage.getItem("evimed.research-db.save.p1")).toBeNull();
  });
  it("freezes the selected table and columns during a snapshot", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue({ items: [{ id: "conn-one", createdAt: "2026-10-28" }] });
    let release: (value: unknown) => void = () => {}; mocks.snapshotResearchDatabase.mockReturnValue(new Promise(resolve => { release = resolve; })); show();
    await user.selectOptions(await screen.findByLabelText("已保存的连接"), "conn-one");
    await user.type(screen.getByRole("textbox", { name: "表名" }), "cohort");
    await user.type(screen.getByRole("textbox", { name: "列名（用英文逗号分隔）" }), "age");
    await user.click(screen.getByRole("button", { name: "生成快照并添加" }));
    expect(screen.getByRole("textbox", { name: "表名" })).toBeDisabled(); expect(screen.getByLabelText("已保存的连接")).toBeDisabled();
    release({ sourceId: "src-one", capturedAt: "2026-10-28", rowCount: 1, truncated: false, oversizedValuesWithheld: false });
    expect(await screen.findByText(/已生成 1 行数据快照/)).toBeInTheDocument();
  });
  it("revokes a connection without claiming existing data was deleted", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue({ items: [{ id: "conn-one", createdAt: "2026-10-28" }] }); mocks.removeResearchDatabase.mockResolvedValue({ removed: true }); show();
    await user.selectOptions(await screen.findByLabelText("已保存的连接"), "conn-one");
    await user.click(screen.getByRole("button", { name: "撤销连接" }));
    await waitFor(() => expect(mocks.removeResearchDatabase).toHaveBeenCalledWith("conn-one", "p1"));
    expect(await screen.findByText(/已有快照仍保留/)).toBeInTheDocument();
  });
});
