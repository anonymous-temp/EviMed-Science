import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_SESSION_ENDED_EVENT, WebApiError } from "@/lib/apiClient";
import { ResearchDatabaseDialog } from "./ResearchDatabaseDialog";

const mocks = vi.hoisted(() => ({ listResearchDatabases: vi.fn(), listResearchDatabaseTables: vi.fn(), saveResearchDatabase: vi.fn(), snapshotResearchDatabase: vi.fn(), removeResearchDatabase: vi.fn() }));
vi.mock("@/lib/researchDatabaseClient", () => ({ ...mocks, RESEARCH_DATABASE_ROW_LIMIT: 20000, RESEARCH_DATABASE_COLUMN_LIMIT: 64 }));
const saved = { items: [{ id: "conn-one", createdAt: "2026-10-28T02:00:00Z" }] };
const tables = { truncated: false, tables: [
  { schema: "public", table: "cohort", estimatedRows: 48000, columns: [{ name: "age", type: "integer" }, { name: "outcome", type: "text" }, { name: "admitted_at", type: "date" }] },
  { schema: "lab", table: "results", estimatedRows: null, columns: [{ name: "value", type: "numeric" }] },
] };
const show = () => { const onCaptured = vi.fn(), onClose = vi.fn(); const view = render(<ResearchDatabaseDialog projectId="p1" agendaId="a1" onClose={onClose} onCaptured={onCaptured} />); return { onCaptured, onClose, view }; };
const pickCohort = async (user: ReturnType<typeof userEvent.setup>) => { await user.selectOptions(await screen.findByLabelText("数据表"), "public.cohort"); };

describe("research database dialog", () => {
  beforeEach(() => {
    sessionStorage.clear(); Object.values(mocks).forEach(fn => fn.mockReset());
    mocks.listResearchDatabases.mockResolvedValue({ items: [] }); mocks.listResearchDatabaseTables.mockResolvedValue(tables);
  });
  it("says when the database cannot be reached without suggesting a connection", async () => {
    mocks.listResearchDatabases.mockRejectedValue(new WebApiError("disabled", { status: 503, code: "research_db_unavailable" }));
    show(); expect(await screen.findByRole("alert")).toHaveTextContent("数据库暂时连不上");
    expect(screen.queryByRole("button", { name: "保存并连接" })).not.toBeInTheDocument();
  });
  it("saves a connection, lists its tables and imports a whole table into the research", async () => {
    const user = userEvent.setup(); const callbacks = show();
    mocks.saveResearchDatabase.mockResolvedValue({ id: "conn-one" });
    mocks.snapshotResearchDatabase.mockResolvedValue({ sourceId: "src-one", capturedAt: "2026-10-28", rowCount: 20000, columns: 3, truncated: true, oversizedValuesWithheld: false });
    await user.type(await screen.findByRole("textbox", { name: "主机地址" }), "db.example.org"); await user.type(screen.getByRole("textbox", { name: "数据库名" }), "research");
    await user.type(screen.getByRole("textbox", { name: "用户名" }), "reader"); await user.type(screen.getByLabelText("密码"), "password-for-test");
    mocks.listResearchDatabases.mockResolvedValue(saved);
    await user.click(screen.getByRole("button", { name: "保存并连接" }));
    expect(mocks.saveResearchDatabase).toHaveBeenCalledWith(expect.objectContaining({ host: "db.example.org", port: 5432, database: "research", username: "reader" }));
    await waitFor(() => expect(mocks.listResearchDatabaseTables).toHaveBeenCalledWith("conn-one", "p1"));
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("数据表")).getByRole("option", { name: /cohort · 约 4.8万 行 · 3 列/ })).toBeInTheDocument();
    expect(within(screen.getByLabelText("数据表")).getByRole("option", { name: "lab.results · 1 列" })).toBeInTheDocument();
    await pickCohort(user);
    expect(screen.getByText("导入的列 · 3/3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    await waitFor(() => expect(mocks.snapshotResearchDatabase).toHaveBeenCalledWith("conn-one", { projectId: "p1", requestId: expect.any(String), agendaId: "a1", schema: "public", table: "cohort", columns: [] }));
    expect(await screen.findByText(/已导入 cohort：20,000 行 × 3 列（表更大，导入了前 20,000 行），已加入本研究/)).toBeInTheDocument();
    expect(callbacks.onCaptured).toHaveBeenCalledOnce();
  });
  it("imports only the columns left ticked", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.snapshotResearchDatabase.mockResolvedValue({ sourceId: "s", capturedAt: "", rowCount: 10, columns: 2, truncated: false, oversizedValuesWithheld: false });
    show(); await pickCohort(user);
    await user.click(screen.getByRole("checkbox", { name: "admitted_at" }));
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    await waitFor(() => expect(mocks.snapshotResearchDatabase.mock.calls[0][1].columns).toEqual(["age", "outcome"]));
    await user.click(screen.getByRole("button", { name: "全部选择" }));
    expect(screen.getByText("导入的列 · 3/3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "全部取消" }));
    expect(screen.getByRole("button", { name: "导入到本研究" })).toBeDisabled();
  });
  it("reuses the same import request id after an uncertain failure", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.snapshotResearchDatabase.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ sourceId: "src-one", rowCount: 1, truncated: false, oversizedValuesWithheld: false });
    show(); await pickCohort(user);
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("如果不确定是否已导入");
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    await waitFor(() => expect(mocks.snapshotResearchDatabase).toHaveBeenCalledTimes(2));
    expect(mocks.snapshotResearchDatabase.mock.calls[0]).toEqual(mocks.snapshotResearchDatabase.mock.calls[1]);
  });
  it("keeps a failed import's request id across a remount without storing what was asked", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.snapshotResearchDatabase.mockRejectedValue(new Error("network"));
    const first = show(); await pickCohort(user);
    await user.click(screen.getByRole("button", { name: "导入到本研究" })); await screen.findByRole("alert");
    const requestId = mocks.snapshotResearchDatabase.mock.calls[0][1].requestId;
    expect(sessionStorage.getItem("evimed.research-db.snapshot.p1.a1")).toBe(requestId);
    first.view.unmount(); show();
    expect(await screen.findByText(/上次导入还没有确认结果/)).toBeInTheDocument();
    await pickCohort(user);
    await user.click(screen.getByRole("button", { name: "导入到本研究" })); await waitFor(() => expect(mocks.snapshotResearchDatabase).toHaveBeenCalledTimes(2));
    expect(mocks.snapshotResearchDatabase.mock.calls[1][1].requestId).toBe(requestId);
    expect(JSON.stringify(sessionStorage)).not.toContain("cohort");
  });
  it("warns when a pending submission cannot survive a reload", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try { show(); expect(await screen.findByText(/浏览器不能暂存这次提交/)).toBeInTheDocument(); }
    finally { storage.mockRestore(); }
  });
  it("removes pending identifiers at sign out", async () => {
    sessionStorage.setItem("evimed.research-db.save.p1", "request-one"); show();
    await screen.findByRole("button", { name: "保存并连接" });
    window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT));
    expect(sessionStorage.getItem("evimed.research-db.save.p1")).toBeNull();
  });
  it("freezes the selection while an import runs", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    let release: (value: unknown) => void = () => {}; mocks.snapshotResearchDatabase.mockReturnValue(new Promise(resolve => { release = resolve; })); show();
    await pickCohort(user);
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    expect(screen.getByLabelText("数据表")).toBeDisabled(); expect(screen.getByLabelText("数据库连接")).toBeDisabled();
    release({ sourceId: "src-one", capturedAt: "2026-10-28", rowCount: 1, columns: 3, truncated: false, oversizedValuesWithheld: false });
    expect(await screen.findByText(/已导入 cohort：1 行 × 3 列，已加入本研究/)).toBeInTheDocument();
  });
  it("says when the account can read no table, and lets a table listing failure be retried", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.listResearchDatabaseTables.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: "research_db_unavailable" })).mockResolvedValueOnce({ tables: [], truncated: false });
    show(); expect(await screen.findByRole("alert")).toHaveTextContent("数据库暂时连不上");
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("这个账号在数据库里没有可读取的表。")).toBeInTheDocument();
  });
  it("removes a connection without claiming imported data was deleted", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved); mocks.removeResearchDatabase.mockResolvedValue({ removed: true }); show();
    await screen.findByLabelText("数据表");
    mocks.listResearchDatabases.mockResolvedValue({ items: [] });
    await user.click(screen.getByRole("button", { name: "移除这个连接" }));
    await waitFor(() => expect(mocks.removeResearchDatabase).toHaveBeenCalledWith("conn-one", "p1"));
    expect(await screen.findByText(/导入过的数据仍在知识库/)).toBeInTheDocument();
  });
});
