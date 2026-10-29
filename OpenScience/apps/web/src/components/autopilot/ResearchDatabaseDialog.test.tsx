import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { errorCodeMessage } from "@evimed/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_SESSION_ENDED_EVENT, WebApiError } from "@/lib/apiClient";
import type { ResearchDatabaseSnapshot } from "@/lib/researchDatabaseClient";
import { ResearchDatabaseDialog } from "./ResearchDatabaseDialog";

const mocks = vi.hoisted(() => ({ listResearchDatabases: vi.fn(), listResearchDatabaseTables: vi.fn(), saveResearchDatabase: vi.fn(), snapshotResearchDatabase: vi.fn(), removeResearchDatabase: vi.fn() }));
vi.mock("@/lib/researchDatabaseClient", () => mocks);
const saved = { items: [{ id: "conn-one", createdAt: "2026-10-28T02:00:00Z" }] };
const whole = { omittedColumnCount: 0, unsupportedColumns: [], unsupportedColumnCount: 0 };
const tables = { truncated: false, limits: { rows: 20000, columns: 64, cellBytes: 32768 }, tables: [
  { schema: "public", table: "cohort", estimatedRows: 48000, ...whole, columns: [{ name: "age", type: "integer" }, { name: "outcome", type: "text" }, { name: "admitted_at", type: "date" }] },
  { schema: "lab", table: "results", estimatedRows: null, ...whole, columns: [{ name: "value", type: "numeric" }] },
  { schema: "lab", table: "small", estimatedRows: 300, ...whole, columns: [{ name: "id", type: "integer" }] },
  { schema: "lab", table: "wide", estimatedRows: 900, omittedColumnCount: 36, unsupportedColumnCount: 2,
    unsupportedColumns: [{ name: "notes", type: "jsonb" }, { name: "stay", type: "interval" }], columns: [{ name: "id", type: "integer" }] },
  { schema: "lab", table: "documents", estimatedRows: 900, omittedColumnCount: 0, unsupportedColumnCount: 8,
    unsupportedColumns: ["a", "b", "c", "d", "e", "f", "g", "h"].map(name => ({ name, type: "jsonb" })), columns: [{ name: "id", type: "integer" }] },
] };
/** What the service answers for an import: every field the dialog may read, a whole table unless the test says otherwise. */
const imported = (patch: Partial<ResearchDatabaseSnapshot> = {}): ResearchDatabaseSnapshot => ({
  sourceId: "src-one", capturedAt: "2026-10-28T08:00:00Z", title: "public.cohort", rowCount: 1, columns: 3, truncated: false, oversizedValuesWithheld: false, partial: false,
  totalRows: 1, totalRowsExact: true, stoppedBy: null, withheldCells: 0, droppedColumnCount: 0, droppedColumns: [], sidecar: "knowledge-base/databases/cohort.import.json", version: 1, ...patch,
});
const show = () => { const onCaptured = vi.fn(), onClose = vi.fn(); const view = render(<ResearchDatabaseDialog projectId="p1" agendaId="a1" onClose={onClose} onCaptured={onCaptured} />); return { onCaptured, onClose, view }; };
const pickCohort = async (user: ReturnType<typeof userEvent.setup>) => { await user.selectOptions(await screen.findByLabelText("数据表"), "public.cohort"); };

describe("research database dialog", () => {
  beforeEach(() => {
    sessionStorage.clear(); Object.values(mocks).forEach(fn => fn.mockReset());
    mocks.listResearchDatabases.mockResolvedValue({ items: [] }); mocks.listResearchDatabaseTables.mockResolvedValue(tables);
  });
  it("says when the database cannot be reached without suggesting a connection", async () => {
    mocks.listResearchDatabases.mockRejectedValue(new WebApiError("disabled", { status: 503, code: "research_db_unavailable" }));
    show(); expect(await screen.findByRole("alert")).toHaveTextContent(errorCodeMessage("research_db_unavailable"));
    expect(screen.queryByRole("button", { name: "保存并连接" })).not.toBeInTheDocument();
  });
  it("saves a connection, lists its tables and imports a whole table into the research", async () => {
    const user = userEvent.setup(); const callbacks = show();
    mocks.saveResearchDatabase.mockResolvedValue({ id: "conn-one" });
    mocks.snapshotResearchDatabase.mockResolvedValue(imported({ rowCount: 20000, truncated: true, partial: true, totalRows: 52340, stoppedBy: "rows", withheldCells: 3, droppedColumnCount: 2,
      droppedColumns: [{ name: "notes", type: "jsonb", reason: "unsupported_type" }, { name: "stay", type: "interval", reason: "unsupported_type" }] }));
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
    expect(await screen.findByText("已导入 cohort，只导入了一部分：前 20,000 行（共 52,340 行） × 3 列；3 个单元格过大未导入；2 列类型不支持未导入。已加入本研究。")).toBeInTheDocument();
    expect(callbacks.onCaptured).toHaveBeenCalledOnce();
  });
  it("imports only the columns left ticked", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.snapshotResearchDatabase.mockResolvedValue(imported({ rowCount: 10, columns: 2 }));
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
    mocks.snapshotResearchDatabase.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(imported());
    show(); await pickCohort(user);
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("如果不确定是否已导入");
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    await waitFor(() => expect(mocks.snapshotResearchDatabase).toHaveBeenCalledTimes(2));
    expect(mocks.snapshotResearchDatabase.mock.calls[0]).toEqual(mocks.snapshotResearchDatabase.mock.calls[1]);
  });
  it.each([400, 403, 409, 429])("forgets the request id after a definite %s and does not tell the person to wonder whether it happened", async status => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.snapshotResearchDatabase.mockRejectedValueOnce(new WebApiError("refused", { status, code: "research_db_selection_invalid" })).mockResolvedValueOnce(imported());
    const first = show(); await pickCohort(user);
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("暂不支持导入");
    expect(alert).not.toHaveTextContent("如果不确定");
    expect(screen.queryByText(/上次导入还没有确认结果/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem("evimed.research-db.snapshot.p1.a1")).toBeNull();
    // Nothing is left to carry over a reload, and the next attempt is a new request.
    first.view.unmount(); show(); await pickCohort(user);
    expect(screen.queryByText(/上次导入还没有确认结果/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    await waitFor(() => expect(mocks.snapshotResearchDatabase).toHaveBeenCalledTimes(2));
    expect(mocks.snapshotResearchDatabase.mock.calls[1][1].requestId).not.toBe(mocks.snapshotResearchDatabase.mock.calls[0][1].requestId);
  });
  it("forgets a saved-connection request the same way after a definite refusal, and keeps it after a failure that may have been carried out", async () => {
    const user = userEvent.setup();
    mocks.saveResearchDatabase.mockRejectedValueOnce(new WebApiError("invalid", { status: 400, code: "research_db_invalid" })).mockRejectedValueOnce(new WebApiError("down", { status: 502 }));
    show();
    await user.type(await screen.findByRole("textbox", { name: "主机地址" }), "db.example.org"); await user.type(screen.getByRole("textbox", { name: "数据库名" }), "research");
    await user.type(screen.getByRole("textbox", { name: "用户名" }), "reader"); await user.type(screen.getByLabelText("密码"), "password-for-test");
    await user.click(screen.getByRole("button", { name: "保存并连接" }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent("如果不确定");
    expect(screen.queryByText(/上次保存的连接还没有确认结果/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem("evimed.research-db.save.p1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "保存并连接" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("如果不确定是否已保存"));
    expect(screen.getByText(/上次保存的连接还没有确认结果/)).toBeInTheDocument();
    expect(sessionStorage.getItem("evimed.research-db.save.p1")).toBe(mocks.saveResearchDatabase.mock.calls[1][0].requestId);
  });
  it("tells saved connections apart by the label the service gives them, and falls back to their number", async () => {
    mocks.listResearchDatabases.mockResolvedValue({ items: [
      { id: "conn-two", createdAt: "2026-10-28T03:00:00Z", label: "db.example.org/research" },
      { id: "conn-one", createdAt: "2026-10-28T02:00:00Z" },
    ] });
    show();
    const options = within(await screen.findByLabelText("数据库连接")).getAllByRole("option").map(option => option.textContent ?? "");
    expect(options[0]).toMatch(/^db\.example\.org\/research · 保存于 /);
    expect(options[1]).toMatch(/^连接 1 · 保存于 /);
    expect(options.join(" ")).not.toMatch(/password|username/i);
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
    release(imported({ rowCount: 1, columns: 3 }));
    expect(await screen.findByText("已导入 cohort：1 行 × 3 列，已加入本研究。")).toBeInTheDocument();
  });
  it("says when the account can read no table, and lets a table listing failure be retried", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.listResearchDatabaseTables.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: "research_db_unavailable" })).mockResolvedValueOnce({ tables: [], truncated: false });
    show(); expect(await screen.findByRole("alert")).toHaveTextContent(errorCodeMessage("research_db_unavailable"));
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("这个账号在数据库里没有可读取的表。")).toBeInTheDocument();
  });
  it("tells the person before importing what the table will lose: the row limit, the columns of a type that is not read, the columns past the limit", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved); show();
    await user.selectOptions(await screen.findByLabelText("数据表"), "lab.wide");
    expect(screen.getByText("导入后存为知识库里的数据表，并加入本研究。单次最多导入 20,000 行、64 列；单个单元格超过 32 KB 的内容不会导入。")).toBeInTheDocument();
    expect(screen.getByText("2 列的类型暂不支持，不会导入：notes（jsonb）、stay（interval）。")).toBeInTheDocument();
    expect(screen.getByText("另有 36 列超出 64 列的上限，不会导入。")).toBeInTheDocument();
    expect(screen.queryByText(/只会导入表里靠前的/)).not.toBeInTheDocument();
    // The columns that are not read are not offered to tick.
    expect(screen.getByText("导入的列 · 1/1")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "notes" })).not.toBeInTheDocument();
  });

  it("says that a larger table comes over as its first rows only, and says nothing of the kind for a table that fits", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved); show();
    await pickCohort(user);
    expect(screen.getByText("这张表约有 4.8万 行，只会导入表里靠前的 20,000 行（按存放顺序，不是随机抽样）。")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("数据表"), "lab.results");
    expect(screen.getByText("这张表的行数还没有统计；超过 20,000 行时，只会导入表里靠前的 20,000 行（按存放顺序，不是随机抽样）。")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("数据表"), "lab.small");
    expect(screen.queryByText(/只会导入表里靠前的/)).not.toBeInTheDocument();
    expect(screen.queryByText(/类型暂不支持/)).not.toBeInTheDocument();
    expect(screen.queryByText(/超出 64 列的上限/)).not.toBeInTheDocument();
  });

  it("states the limits the deployment is configured with, not a fixed number", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.listResearchDatabaseTables.mockResolvedValue({ ...tables, limits: { rows: 5000, columns: 12, cellBytes: 1048576 } }); show();
    await user.selectOptions(await screen.findByLabelText("数据表"), "lab.small");
    expect(screen.getByText(/单次最多导入 5,000 行、12 列；单个单元格超过 1 MB 的内容不会导入/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("数据表"), "lab.wide");
    expect(screen.getByText("另有 36 列超出 12 列的上限，不会导入。")).toBeInTheDocument();
  });

  it("folds a long list of unsupported columns behind its count, with every name inside", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved); show();
    await user.selectOptions(await screen.findByLabelText("数据表"), "lab.documents");
    const summary = screen.getByText("8 列的类型暂不支持，不会导入");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    await user.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(within(summary.closest("details") as HTMLElement).getByText(/^a（jsonb）、b（jsonb）.*h（jsonb）$/)).toBeInTheDocument();
  });

  it.each([
    [502, "research_db_tls_failed"], [502, "research_db_login_failed"], [502, "research_db_unreachable"], [400, "research_db_login_too_privileged"],
  ])("answers a %s %s with the registry's sentence, and forgets the request: this attempt did not happen", async (status, code) => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.snapshotResearchDatabase.mockRejectedValueOnce(new WebApiError("refused", { status, code })); show(); await pickCohort(user);
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorCodeMessage(code));
    expect(alert).not.toHaveTextContent("如果不确定"); expect(alert).not.toHaveTextContent(code);
    expect(screen.queryByText(/上次导入还没有确认结果/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem("evimed.research-db.snapshot.p1.a1")).toBeNull();
  });

  it("reads the table listing's refusals the same way, so a certificate, a login and a network are not one sentence", async () => {
    mocks.listResearchDatabases.mockResolvedValue(saved);
    const sentences = new Set<string>();
    for (const code of ["research_db_tls_failed", "research_db_login_failed", "research_db_unreachable"]) {
      mocks.listResearchDatabaseTables.mockRejectedValueOnce(new WebApiError("down", { status: 502, code }));
      const view = show(); const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(errorCodeMessage(code)); sentences.add(alert.textContent ?? "");
      view.view.unmount();
    }
    expect(sentences.size).toBe(3);
  });

  it("keeps the request of an import the service failed on its own side, and says the person may need to look", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.snapshotResearchDatabase.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: "research_db_unavailable" })); show(); await pickCohort(user);
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorCodeMessage("research_db_unavailable")); expect(alert).toHaveTextContent("如果不确定是否已导入");
    expect(screen.getByText(/上次导入还没有确认结果/)).toBeInTheDocument();
    expect(sessionStorage.getItem("evimed.research-db.snapshot.p1.a1")).toBe(mocks.snapshotResearchDatabase.mock.calls[0][1].requestId);
  });

  it("keeps the confirmation of a partial import in the dialog's footer through the next things the person does, until another import replaces it", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.snapshotResearchDatabase.mockResolvedValueOnce(imported({ rowCount: 20000, truncated: true, partial: true, totalRows: 52340, totalRowsExact: false, stoppedBy: "rows" }))
      .mockResolvedValueOnce(imported({ rowCount: 300, columns: 1 }));
    show(); await pickCohort(user);
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    const text = "已导入 cohort，只导入了一部分：前 20,000 行（共约 52,340 行） × 3 列。已加入本研究。";
    const confirmation = await screen.findByText(text);
    expect(screen.getByRole("dialog").querySelector("footer")).toContainElement(confirmation);
    expect(screen.getByText("取的是表里靠前的行（按存放顺序，不是随机抽样），不能代表整张表。")).toBeInTheDocument();
    // Choosing another table and removing the connection each clear the transient notice; the confirmation stays.
    await user.selectOptions(screen.getByLabelText("数据表"), "lab.small");
    expect(screen.getByText(text)).toBeInTheDocument();
    mocks.removeResearchDatabase.mockResolvedValue({ removed: true }); mocks.listResearchDatabases.mockResolvedValue({ items: [] });
    await user.click(screen.getByRole("button", { name: "移除这个连接" }));
    expect(await screen.findByText(/导入过的数据仍在知识库/)).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("replaces the confirmation with the next import's, and says when it is a new version of a table imported before", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.snapshotResearchDatabase.mockResolvedValueOnce(imported({ rowCount: 20000, truncated: true, partial: true, totalRows: 52340, stoppedBy: "rows" }))
      .mockResolvedValueOnce(imported({ rowCount: 20000, truncated: true, partial: true, totalRows: 52340, stoppedBy: "rows", version: 2 }))
      .mockResolvedValueOnce(imported({ rowCount: 300, columns: 1 }));
    show(); await pickCohort(user);
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    await screen.findByText(/已导入 cohort，只导入了一部分/);
    expect(screen.queryByText(/第 2 版/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    expect(await screen.findByText("这是 cohort 的第 2 版，本研究里已改用这一版。")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("数据表"), "lab.small");
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    expect(await screen.findByText("已导入 lab.small：300 行 × 1 列，已加入本研究。")).toBeInTheDocument();
    expect(screen.queryByText(/只导入了一部分/)).not.toBeInTheDocument(); expect(screen.queryByText(/第 2 版/)).not.toBeInTheDocument();
  });

  it("does not draw a complete import as a warning", async () => {
    const user = userEvent.setup(); mocks.listResearchDatabases.mockResolvedValue(saved);
    mocks.snapshotResearchDatabase.mockResolvedValue(imported({ rowCount: 1200, totalRows: 1200 })); show(); await pickCohort(user);
    await user.click(screen.getByRole("button", { name: "导入到本研究" }));
    const status = (await screen.findByText("已导入 cohort：1,200 行 × 3 列，已加入本研究。")).closest("[role=status]") as HTMLElement;
    expect(status.className).not.toMatch(/warn/);
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
