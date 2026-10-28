import { useCallback, useEffect, useRef, useState } from "react";
import { WebApiError } from "@/lib/apiClient";
import { productErrorMessage } from "@/lib/productClient";
import { formatApproxCount, formatDay, formatClock, formatNumber } from "@/lib/format";
import { listResearchDatabases, listResearchDatabaseTables, removeResearchDatabase, RESEARCH_DATABASE_COLUMN_LIMIT, RESEARCH_DATABASE_ROW_LIMIT, saveResearchDatabase, snapshotResearchDatabase, type ResearchDatabaseRef, type ResearchDatabaseTable } from "@/lib/researchDatabaseClient";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormDialog } from "@/components/ui/FormDialog";
import { Input, Select } from "@/components/ui/Input";

const tableKey = (table: Pick<ResearchDatabaseTable, "schema" | "table">) => `${table.schema}.${table.table}`;
const savedAt = (value: string) => [formatDay(value), formatClock(value)].filter(Boolean).join(" ") || "时间未知";

/**
 * Anatomy: a saved PostgreSQL connection (or the form that adds one), the database's readable tables, the columns to
 * import, and one import that turns the table into a dataset of this research (a CSV in the knowledge base).
 * Variants: no connection yet; saved connections; a table chosen.
 * States: loading, unavailable, a connection that cannot be reached, an import whose result is not confirmed.
 * Hit area: shared input, checkbox and button controls.
 * Keyboard: native form controls inside the shared dialog.
 * Long content: table and column lists scroll inside the dialog; entered values survive a failure.
 * Theme: shared semantic roles.
 * Responsive: fields stack inside the bounded dialog.
 * Verification: ResearchDatabaseDialog.test.tsx; a live connection needs the deployment's database settings.
 */
export function ResearchDatabaseDialog({ projectId, agendaId, onClose, onCaptured }: { projectId: string; agendaId: string; onClose: () => void; onCaptured: () => void }) {
  const [connections, setConnections] = useState<ResearchDatabaseRef[] | null>(null);
  const [selected, setSelected] = useState("");
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState(""); const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState(""); const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [tables, setTables] = useState<{ connection: string; items: ResearchDatabaseTable[]; truncated: boolean } | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [table, setTable] = useState("");
  const [columns, setColumns] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false); const alive = useRef(true); const reads = useRef(0); const tableReads = useRef(0);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const saveKey = `evimed.research-db.save.${projectId}`; const snapshotKey = `evimed.research-db.snapshot.${projectId}.${agendaId}`;
  const readRequest = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };
  const persistRequest = (key: string, value: string | null) => { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { setStorageAvailable(false); } };
  const saveRequest = useRef<string | null>(readRequest(saveKey)); const snapshotRequest = useRef<string | null>(readRequest(snapshotKey));
  const [savePending, setSavePending] = useState(!!saveRequest.current); const [snapshotPending, setSnapshotPending] = useState(!!snapshotRequest.current);
  const describe = (caught: unknown) => caught instanceof WebApiError && caught.code === "research_db_network_denied" ? "这个数据库地址还没有开通访问，请联系平台管理员开通。"
    : caught instanceof WebApiError && caught.code === "research_db_busy" ? "另一项数据导入正在进行，请稍后再试。"
    : caught instanceof WebApiError && caught.code === "research_db_selection_invalid" ? "这张表或这些列暂不支持导入，请换一张表或减少列。"
    : caught instanceof WebApiError && caught.status === 503 ? "数据库暂时连不上，请检查地址、账号和密码后重试。" : productErrorMessage(caught);
  const load = useCallback(async () => {
    const request = ++reads.current;
    try {
      const result = await listResearchDatabases(projectId);
      if (alive.current && request === reads.current) { setConnections(result.items); setError(null); setSelected(old => old && result.items.some(item => item.id === old) ? old : result.items[0]?.id ?? ""); }
    } catch (caught) { if (alive.current && request === reads.current) { setConnections(null); setError(describe(caught)); } }
  }, [projectId]);
  useEffect(() => {
    const pending = reads; alive.current = true;
    try { const key = `evimed.research-db.probe.${crypto.randomUUID()}`; sessionStorage.setItem(key, "1"); sessionStorage.removeItem(key); }
    catch { setStorageAvailable(false); }
    void load(); return () => { alive.current = false; pending.current++; };
  }, [load]);
  const loadTables = useCallback(async (connection: string) => {
    const request = ++tableReads.current;
    setTables(null); setTablesError(null); setTable(""); setColumns(null);
    try {
      const result = await listResearchDatabaseTables(connection, projectId);
      if (alive.current && request === tableReads.current) setTables({ connection, items: result.tables, truncated: result.truncated });
    } catch (caught) { if (alive.current && request === tableReads.current) setTablesError(describe(caught)); }
  }, [projectId]);
  useEffect(() => { if (selected) void loadTables(selected); else { setTables(null); setTablesError(null); } }, [selected, loadTables]);
  async function act(operation: () => Promise<void>, uncertainty: string) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null); setNotice(null);
    try { await operation(); } catch (caught) { if (alive.current) setError(`${describe(caught)}${uncertainty}`); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const create = () => void act(async () => {
    saveRequest.current ??= crypto.randomUUID(); persistRequest(saveKey, saveRequest.current); setSavePending(true);
    const result = await saveResearchDatabase({ projectId, requestId: saveRequest.current, host: host.trim(), port: Number(port), database: database.trim(), username: username.trim(), password });
    if (!alive.current) return;
    saveRequest.current = null; persistRequest(saveKey, null); setSavePending(false); setPassword(""); setHost(""); setDatabase(""); setUsername(""); setAdding(false);
    await load(); if (alive.current) { setSelected(result.id); setNotice("连接已保存，正在读取数据库里的表。"); }
  }, "如果不确定是否已保存，请先看上方的连接列表。");
  const chosen = tables?.items.find(item => tableKey(item) === table) ?? null;
  const picked = columns ?? chosen?.columns.map(column => column.name) ?? [];
  const everyColumn = !!chosen && picked.length === chosen.columns.length;
  const capture = () => { if (!chosen) return; void act(async () => {
    const requested = everyColumn ? [] : picked;
    snapshotRequest.current ??= crypto.randomUUID(); persistRequest(snapshotKey, snapshotRequest.current); setSnapshotPending(true);
    const result = await snapshotResearchDatabase(selected, { projectId, requestId: snapshotRequest.current, agendaId, schema: chosen.schema, table: chosen.table, columns: requested });
    if (!alive.current) return;
    snapshotRequest.current = null; persistRequest(snapshotKey, null); setSnapshotPending(false);
    setNotice(`已导入 ${chosen.table}：${formatNumber(result.rowCount)} 行${result.columns ? ` × ${result.columns} 列` : ""}${result.truncated ? `（表更大，导入了前 ${formatNumber(result.rowCount)} 行）` : ""}，已加入本研究。`);
    onCaptured();
  }, "如果不确定是否已导入，请先看研究资料列表。"); };
  const revoke = () => void act(async () => { await removeResearchDatabase(selected, projectId); if (alive.current) { setSelected(""); await load(); setNotice("连接已移除，导入过的数据仍在知识库。"); } }, "请重新查看连接列表。");
  const toggle = (name: string) => setColumns(picked.includes(name) ? picked.filter(item => item !== name) : [...picked, name]);
  const showForm = adding || (connections !== null && connections.length === 0);
  return <FormDialog title="从数据库导入" busy={busy} onClose={() => { if (!busy) onClose(); }}><div className="space-y-4">
    {error && <p role="alert" className="text-ui text-error">{error}</p>}
    {notice && <p role="status" className="text-ui text-text">{notice}</p>}
    {!storageAvailable && <p role="status" className="text-ui text-text">浏览器不能暂存这次提交，刷新或关闭后，请先看连接和研究资料，再决定是否重新提交。</p>}
    {connections === null ? <Button variant="secondary" disabled={busy} onClick={() => void load()}>重新读取</Button> : <fieldset disabled={busy} className="min-w-0 space-y-4">
      {savePending && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-ui text-text">上次保存的连接还没有确认结果，原样再提交一次不会重复保存。</p><Button variant="text" disabled={busy} onClick={() => { saveRequest.current = null; persistRequest(saveKey, null); setSavePending(false); }}>重新填写连接</Button></div>}
      {snapshotPending && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-ui text-text">上次导入还没有确认结果，原样再导入一次不会重复。</p><Button variant="text" disabled={busy} onClick={() => { snapshotRequest.current = null; persistRequest(snapshotKey, null); setSnapshotPending(false); }}>重新开始导入</Button></div>}
      {connections.length > 0 && !adding && <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1"><Select label="数据库连接" value={selected} onChange={event => setSelected(event.target.value)}>{connections.map((item, index) => <option key={item.id} value={item.id}>连接 {connections.length - index} · 保存于 {savedAt(item.createdAt)}</option>)}</Select></div>
        <Button variant="text" disabled={busy} onClick={() => setAdding(true)}>添加连接</Button>
      </div>}
      {showForm && <div className="space-y-3">
        <p className="text-ui font-semibold text-text">添加 PostgreSQL 连接</p>
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]"><Input label="主机地址" value={host} onChange={event => setHost(event.target.value)} autoComplete="off" /><Input label="端口" type="number" min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} /></div>
        <Input label="数据库名" value={database} onChange={event => setDatabase(event.target.value)} />
        <div className="grid gap-3 sm:grid-cols-2"><Input label="用户名" value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" /><Input label="密码" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" /></div>
        <div className="flex flex-wrap gap-2"><Button disabled={busy || !host.trim() || !database.trim() || !username.trim() || !password || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535} onClick={create}>保存并连接</Button>
          {connections.length > 0 && <Button variant="text" disabled={busy} onClick={() => setAdding(false)}>取消</Button>}</div>
      </div>}
      {selected && !adding && <section className="space-y-3" aria-label="选择要导入的表">
        {tablesError && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-ui text-error">{tablesError}</p><Button variant="text" onClick={() => void loadTables(selected)}>重试</Button></div>}
        {!tables && !tablesError && <p role="status" className="text-ui text-text-3">正在读取数据库里的表</p>}
        {tables && (tables.items.length === 0 ? <p className="text-ui text-text">这个账号在数据库里没有可读取的表。</p> : <>
          <Select label="数据表" value={table} onChange={event => { setTable(event.target.value); setColumns(null); }}>
            <option value="">选择一张表</option>
            {tables.items.map(item => <option key={tableKey(item)} value={tableKey(item)}>{item.schema === "public" ? item.table : tableKey(item)}{item.estimatedRows !== null ? ` · 约 ${formatApproxCount(item.estimatedRows)} 行` : ""} · {item.columns.length} 列</option>)}
          </Select>
          {chosen && <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-ui text-text">导入的列 · {picked.length}/{chosen.columns.length}</p>
              <Button variant="text" size="sm" onClick={() => setColumns(everyColumn ? [] : chosen.columns.map(column => column.name))}>{everyColumn ? "全部取消" : "全部选择"}</Button></div>
            <div className="grid max-h-56 grid-cols-1 gap-x-4 overflow-auto rounded-card border border-border px-3 sm:grid-cols-2">{chosen.columns.map(column => <Checkbox key={column.name} label={<span className="min-w-0 truncate">{column.name}</span>} checked={picked.includes(column.name)} onChange={() => toggle(column.name)} />)}</div>
            <p className="text-ui text-text">导入后存为知识库里的数据表，并加入本研究；单次最多 {formatNumber(RESEARCH_DATABASE_ROW_LIMIT)} 行、{RESEARCH_DATABASE_COLUMN_LIMIT} 列。</p>
          </div>}
        </>)}
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="text" disabled={busy} onClick={revoke}>移除这个连接</Button>
          <Button disabled={busy || !chosen || picked.length === 0} onClick={capture}>导入到本研究</Button>
        </div>
      </section>}
    </fieldset>}
  </div></FormDialog>;
}
