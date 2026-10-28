import { useCallback, useEffect, useRef, useState } from "react";
import { WebApiError } from "@/lib/apiClient";
import { productErrorMessage } from "@/lib/productClient";
import { formatDay, formatClock } from "@/lib/format";
import { listResearchDatabases, removeResearchDatabase, saveResearchDatabase, snapshotResearchDatabase, type ResearchDatabaseRef } from "@/lib/researchDatabaseClient";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Input, Select } from "@/components/ui/Input";

/**
 * Anatomy: connection credentials, a saved reference, and an explicit table snapshot.
 * Variants: loading, unavailable, new or previously saved connections.
 * States: a saved credential is not a verified connection; a snapshot is a separate operation.
 * Hit area: shared input and button controls.
 * Keyboard: native form controls inside the shared dialog.
 * Long content: identifiers wrap and fields retain entered values on failure.
 * Theme: shared semantic roles.
 * Responsive: fields stack inside the bounded dialog.
 * Verification: ResearchDatabaseDialog.test.tsx; live connections require enabled deployment and authorized database access.
 */
export function ResearchDatabaseDialog({ projectId, agendaId, onClose, onCaptured }: { projectId: string; agendaId: string; onClose: () => void; onCaptured: () => void }) {
  const [connections, setConnections] = useState<ResearchDatabaseRef[] | null>(null);
  const [selected, setSelected] = useState("");
  const [host, setHost] = useState(""); const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState(""); const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [schema, setSchema] = useState("public"); const [table, setTable] = useState(""); const [columns, setColumns] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false); const alive = useRef(true); const reads = useRef(0);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const saveKey = `evimed.research-db.save.${projectId}`; const snapshotKey = `evimed.research-db.snapshot.${projectId}.${agendaId}`;
  const readRequest = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };
  const persistRequest = (key: string, value: string | null) => { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { setStorageAvailable(false); } };
  const saveRequest = useRef<string | null>(readRequest(saveKey)); const snapshotRequest = useRef<string | null>(readRequest(snapshotKey));
  const [savePending, setSavePending] = useState(!!saveRequest.current); const [snapshotPending, setSnapshotPending] = useState(!!snapshotRequest.current);
  const describe = (caught: unknown) => caught instanceof WebApiError && caught.status === 503 ? "数据库服务暂不可用或连接未成功，请检查配置后重试。" : caught instanceof WebApiError && caught.code === "research_db_network_denied" ? "数据库地址未获管理员允许，请检查配置。" : productErrorMessage(caught);
  const load = useCallback(async () => {
    const request = ++reads.current;
    try { const result = await listResearchDatabases(projectId); if (alive.current && request === reads.current) { setConnections(result.items); setError(null); } }
    catch (caught) { if (alive.current && request === reads.current) { setConnections(null); setError(describe(caught)); } }
  }, [projectId]);
  useEffect(() => {
    const pending = reads; alive.current = true;
    try { const key = `evimed.research-db.probe.${crypto.randomUUID()}`; sessionStorage.setItem(key, "1"); sessionStorage.removeItem(key); }
    catch { setStorageAvailable(false); }
    void load(); return () => { alive.current = false; pending.current++; };
  }, [load]);
  async function act(operation: () => Promise<void>, uncertainty: string) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null); setNotice(null);
    try { await operation(); } catch (caught) { if (alive.current) setError(`${describe(caught)}${uncertainty}`); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const create = () => void act(async () => {
    saveRequest.current ??= crypto.randomUUID(); persistRequest(saveKey, saveRequest.current); setSavePending(true);
    const result = await saveResearchDatabase({ projectId, requestId: saveRequest.current, host: host.trim(), port: Number(port), database: database.trim(), username: username.trim(), password });
    if (!alive.current) return;
    saveRequest.current = null; persistRequest(saveKey, null); setSavePending(false); setPassword(""); setHost(""); setDatabase(""); setUsername("");
    await load(); if (alive.current) { setSelected(result.id); setNotice("连接凭据已保存；仍需测试数据库连接。"); }
  }, "保存结果不确定时，请先重新检查连接列表。");
  const selectedColumns = columns.split(",").map(value => value.trim()).filter(Boolean);
  const capture = () => void act(async () => {
    const requested = selectedColumns;
    snapshotRequest.current ??= crypto.randomUUID(); persistRequest(snapshotKey, snapshotRequest.current); setSnapshotPending(true);
    const result = await snapshotResearchDatabase(selected, { projectId, requestId: snapshotRequest.current, agendaId, schema: schema.trim(), table: table.trim(), columns: requested });
    if (!alive.current) return;
    snapshotRequest.current = null; persistRequest(snapshotKey, null); setSnapshotPending(false); setNotice(`已生成 ${result.rowCount} 行数据快照${result.truncated ? "（有数据未纳入）" : ""}${result.oversizedValuesWithheld ? "，超长字段已省略" : ""}，并关联到本研究。`); onCaptured();
  }, "快照结果不确定时，请先检查本研究的资料列表。");
  const revoke = () => void act(async () => { await removeResearchDatabase(selected, projectId); if (alive.current) { setSelected(""); await load(); setNotice("连接已撤销；已有快照仍保留在知识库。"); } }, "请重新检查连接列表。");
  return <FormDialog title="连接研究数据库" busy={busy} onClose={() => { if (!busy) onClose(); }}><div className="space-y-4">
    {error && <p role="alert" className="text-ui text-error">{error}</p>}
    {notice && <p role="status" className="text-ui text-text">{notice}</p>}
    {!storageAvailable && <p role="status" className="text-ui text-text">浏览器无法保存待确认的请求标识。关闭或刷新后，请先检查连接和资料，再重新提交。</p>}
    {connections === null ? <Button variant="secondary" disabled={busy} onClick={() => void load()}>重新检查</Button> : <fieldset disabled={busy} className="min-w-0 space-y-4">
      {connections.length > 0 && <Select label="已保存的连接" value={selected} onChange={event => setSelected(event.target.value)}><option value="">选择连接</option>{connections.map(item => <option key={item.id} value={item.id}>{item.id.slice(0, 8)} · {[formatDay(item.createdAt), formatClock(item.createdAt)].filter(Boolean).join(" ") || "时间未知"}</option>)}</Select>}
      <p className="text-ui text-text">仅支持管理员允许的数据库地址，连接凭据保存后仍需生成快照验证。</p>
      {savePending && <div className="space-y-2"><p className="text-ui text-text">上次保存结果待确认。本标签页重填相同内容可安全重试；退出登录或关闭标签页后，请先检查连接列表。</p><Button variant="text" disabled={busy} onClick={() => { saveRequest.current = null; persistRequest(saveKey, null); setSavePending(false); }}>开始新的连接请求</Button></div>}
      {snapshotPending && <div className="space-y-2"><p className="text-ui text-text">上次快照结果待确认。本标签页重填相同内容可安全重试；退出登录或关闭标签页后，请先检查研究资料。</p><Button variant="text" disabled={busy} onClick={() => { snapshotRequest.current = null; persistRequest(snapshotKey, null); setSnapshotPending(false); }}>开始新的快照请求</Button></div>}<details open={connections.length === 0}><summary className="cursor-pointer text-ui text-accent">添加 PostgreSQL 连接</summary><div className="mt-3 space-y-3">
        <Input label="主机名" value={host} onChange={event => setHost(event.target.value)} autoComplete="off" />
        <Input label="端口" type="number" min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} />
        <Input label="数据库" value={database} onChange={event => setDatabase(event.target.value)} />
        <Input label="用户名" value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" />
        <Input label="密码" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" />
        <Button variant="secondary" disabled={busy || !host.trim() || !database.trim() || !username.trim() || !password || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535} onClick={create}>保存连接凭据</Button>
      </div></details>
      {selected && <section className="space-y-3" aria-label="导入数据库快照"><p className="text-ui text-text">快照会存入项目知识库，可能用于分析和模型处理。仅支持普通表，最多 200 行、24 列，行顺序不保证；超长字段可能被省略。</p>
        <Input label="Schema" value={schema} onChange={event => setSchema(event.target.value)} />
        <Input label="表名" value={table} onChange={event => setTable(event.target.value)} />
        <Input label="列名（用英文逗号分隔）" value={columns} onChange={event => setColumns(event.target.value)} />
        <div className="flex flex-wrap gap-2"><Button disabled={busy || !schema.trim() || !table.trim() || selectedColumns.length === 0 || selectedColumns.length > 24} onClick={capture}>生成快照并添加</Button><Button variant="text" disabled={busy} onClick={revoke}>撤销连接</Button></div>
      </section>}
    </fieldset>}
  </div></FormDialog>;
}
