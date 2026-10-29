import { useCallback, useEffect, useRef, useState } from "react";
import { WebApiError } from "@/lib/apiClient";
import { productErrorMessage } from "@/lib/productClient";
import { cn } from "@/lib/cn";
import { formatApproxCount, formatDay, formatClock } from "@/lib/format";
import { listResearchDatabases, listResearchDatabaseTables, removeResearchDatabase, saveResearchDatabase, snapshotResearchDatabase, type ResearchDatabaseLimits, type ResearchDatabaseRef, type ResearchDatabaseTable } from "@/lib/researchDatabaseClient";
import { importOutcome, tableImportNotes, tableLabel, type ImportOutcome } from "@/lib/researchDatabaseWording";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure } from "@/components/ui/Disclosure";
import { FormDialog } from "@/components/ui/FormDialog";
import { Input, Select } from "@/components/ui/Input";

const tableKey = (table: Pick<ResearchDatabaseTable, "schema" | "table">) => `${table.schema}.${table.table}`;
const savedAt = (value: string) => [formatDay(value), formatClock(value)].filter(Boolean).join(" ") || "时间未知";
/**
 * Refusals that come from opening the connection, before any table is read or anything is written: the certificate did not
 * verify, the login was refused, nothing answered. They are 502s, but this request did not happen, so it is forgotten like a 4xx.
 */
const CONNECTION_REFUSALS = new Set(["research_db_tls_failed", "research_db_login_failed", "research_db_unreachable"]);
// Every refusal below reads through `productErrorMessage`: the shared registry's sentence for its code (a certificate, a login, a network
// and a too-privileged login are four answers with four remedies there); this dialog keeps no wording of its own for them.
const refusedRequest = (caught: unknown) => caught instanceof WebApiError
  && ((caught.status >= 400 && caught.status < 500 && caught.status !== 408) || CONNECTION_REFUSALS.has(caught.code ?? ""));

/**
 * Anatomy: a saved PostgreSQL connection (or the form that adds one), the database's readable tables, the columns to
 * import, and one import that turns the table into a dataset of this research (a CSV in the knowledge base).
 * Variants: no connection yet; saved connections; a table chosen.
 * States: loading, unavailable, a connection that cannot be reached, an import whose result is not confirmed, an import that took only
 * part of the table (the confirmation stays in the dialog's footer until the dialog closes or the next import replaces it).
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
  const [tables, setTables] = useState<{ connection: string; items: ResearchDatabaseTable[]; truncated: boolean; limits: ResearchDatabaseLimits } | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [table, setTable] = useState("");
  const [columns, setColumns] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  // What the last import came to. Kept apart from `notice`, which the next operation clears: the person has to be able to read how much of
  // the table is in the research, and a connection being removed or a table being chosen is no reason for that to go.
  const [imported, setImported] = useState<ImportOutcome | null>(null);
  const lock = useRef(false); const alive = useRef(true); const reads = useRef(0); const tableReads = useRef(0);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const saveKey = `evimed.research-db.save.${projectId}`; const snapshotKey = `evimed.research-db.snapshot.${projectId}.${agendaId}`;
  const readRequest = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };
  const persistRequest = (key: string, value: string | null) => { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { setStorageAvailable(false); } };
  const saveRequest = useRef<string | null>(readRequest(saveKey)); const snapshotRequest = useRef<string | null>(readRequest(snapshotKey));
  const [savePending, setSavePending] = useState(!!saveRequest.current); const [snapshotPending, setSnapshotPending] = useState(!!snapshotRequest.current);
  const load = useCallback(async () => {
    const request = ++reads.current;
    try {
      const result = await listResearchDatabases(projectId);
      if (alive.current && request === reads.current) { setConnections(result.items); setError(null); setSelected(old => old && result.items.some(item => item.id === old) ? old : result.items[0]?.id ?? ""); }
    } catch (caught) { if (alive.current && request === reads.current) { setConnections(null); setError(productErrorMessage(caught)); } }
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
      if (alive.current && request === tableReads.current) setTables({ connection, items: result.tables, truncated: result.truncated, limits: result.limits });
    } catch (caught) { if (alive.current && request === tableReads.current) setTablesError(productErrorMessage(caught)); }
  }, [projectId]);
  useEffect(() => { if (selected) void loadTables(selected); else { setTables(null); setTablesError(null); } }, [selected, loadTables]);
  /**
   * Runs one request. A failure the server answered as a refusal of this request (a 4xx other than a timeout: invalid, forbidden, too
   * many, in conflict; or a connection that could not be opened: certificate, login, no answer) did not happen, so nothing is left to
   * confirm: the request id goes (`forget`) and the message does not say "if you are unsure". Any other failure — a network error, a
   * 5xx, a timeout — may have been carried out, and keeps both.
   */
  async function act(operation: () => Promise<void>, uncertainty: string, forget?: () => void) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null); setNotice(null);
    try { await operation(); } catch (caught) {
      if (alive.current) {
        const refused = refusedRequest(caught);
        if (refused) forget?.();
        setError(`${productErrorMessage(caught)}${refused ? "" : uncertainty}`);
      }
    }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const forgetSave = () => { saveRequest.current = null; persistRequest(saveKey, null); setSavePending(false); };
  const forgetSnapshot = () => { snapshotRequest.current = null; persistRequest(snapshotKey, null); setSnapshotPending(false); };
  const create = () => void act(async () => {
    saveRequest.current ??= crypto.randomUUID(); persistRequest(saveKey, saveRequest.current); setSavePending(true);
    const result = await saveResearchDatabase({ projectId, requestId: saveRequest.current, host: host.trim(), port: Number(port), database: database.trim(), username: username.trim(), password });
    if (!alive.current) return;
    forgetSave(); setPassword(""); setHost(""); setDatabase(""); setUsername(""); setAdding(false);
    await load(); if (alive.current) { setSelected(result.id); setNotice("连接已保存，正在读取数据库里的表。"); }
  }, "如果不确定是否已保存，请先看上方的连接列表。", forgetSave);
  const chosen = tables?.items.find(item => tableKey(item) === table) ?? null;
  const picked = columns ?? chosen?.columns.map(column => column.name) ?? [];
  const everyColumn = !!chosen && picked.length === chosen.columns.length;
  const capture = () => { if (!chosen) return; void act(async () => {
    const requested = everyColumn ? [] : picked;
    snapshotRequest.current ??= crypto.randomUUID(); persistRequest(snapshotKey, snapshotRequest.current); setSnapshotPending(true);
    const result = await snapshotResearchDatabase(selected, { projectId, requestId: snapshotRequest.current, agendaId, schema: chosen.schema, table: chosen.table, columns: requested });
    if (!alive.current) return;
    forgetSnapshot();
    setImported(importOutcome(result, tableLabel(chosen)));
    onCaptured();
  }, "如果不确定是否已导入，请先看研究资料列表。", forgetSnapshot); };
  const revoke = () => void act(async () => { await removeResearchDatabase(selected, projectId); if (alive.current) { setSelected(""); await load(); setNotice("连接已移除，导入过的数据仍在知识库。"); } }, "请重新查看连接列表。");
  const toggle = (name: string) => setColumns(picked.includes(name) ? picked.filter(item => item !== name) : [...picked, name]);
  const showForm = adding || (connections !== null && connections.length === 0);
  return <FormDialog title="从数据库导入" busy={busy} onClose={() => { if (!busy) onClose(); }} footer={imported && <ImportConfirmation outcome={imported} />}><div className="space-y-4">
    {error && <p role="alert" className="text-ui text-error">{error}</p>}
    {notice && <p role="status" className="text-ui text-text">{notice}</p>}
    {!storageAvailable && <p role="status" className="text-ui text-text">浏览器不能暂存这次提交，刷新或关闭后，请先看连接和研究资料，再决定是否重新提交。</p>}
    {connections === null ? <Button variant="secondary" disabled={busy} onClick={() => void load()}>重新读取</Button> : <fieldset disabled={busy} className="min-w-0 space-y-4">
      {savePending && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-ui text-text">上次保存的连接还没有确认结果，原样再提交一次不会重复保存。</p><Button variant="text" disabled={busy} onClick={forgetSave}>重新填写连接</Button></div>}
      {snapshotPending && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-ui text-text">上次导入还没有确认结果，原样再导入一次不会重复。</p><Button variant="text" disabled={busy} onClick={forgetSnapshot}>重新开始导入</Button></div>}
      {connections.length > 0 && !adding && <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1"><Select label="数据库连接" value={selected} onChange={event => setSelected(event.target.value)}>{connections.map((item, index) => <option key={item.id} value={item.id}>{item.label?.trim() || `连接 ${connections.length - index}`} · 保存于 {savedAt(item.createdAt)}</option>)}</Select></div>
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
            {tables.items.map(item => <option key={tableKey(item)} value={tableKey(item)}>{tableLabel(item)}{item.estimatedRows !== null ? ` · 约 ${formatApproxCount(item.estimatedRows)} 行` : ""} · {item.columns.length} 列</option>)}
          </Select>
          {chosen && <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-ui text-text">导入的列 · {picked.length}/{chosen.columns.length}</p>
              <Button variant="text" size="sm" onClick={() => setColumns(everyColumn ? [] : chosen.columns.map(column => column.name))}>{everyColumn ? "全部取消" : "全部选择"}</Button></div>
            <div className="grid max-h-56 grid-cols-1 gap-x-4 overflow-auto rounded-card border border-border px-3 sm:grid-cols-2">{chosen.columns.map(column => <Checkbox key={column.name} label={<span className="min-w-0 truncate">{column.name}</span>} checked={picked.includes(column.name)} onChange={() => toggle(column.name)} />)}</div>
            <TableImportNotes table={chosen} limits={tables.limits} />
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

/** What importing the chosen table will leave out, said before the person presses import: the row limit, the columns that are not read and why. */
function TableImportNotes({ table, limits }: { table: ResearchDatabaseTable; limits: ResearchDatabaseLimits }) {
  const notes = tableImportNotes(table, limits);
  return <div className="space-y-1 text-ui text-text">
    <p>{notes.limits}</p>
    {notes.rows && <p>{notes.rows}</p>}
    {notes.overLimit && <p>{notes.overLimit}</p>}
    {notes.unsupported && (notes.unsupported.fold
      ? <Disclosure summary={notes.unsupported.summary}><p className="break-words">{notes.unsupported.names}</p></Disclosure>
      : <p className="break-words">{notes.unsupported.summary}：{notes.unsupported.names}。</p>)}
  </div>;
}

/**
 * What the last import came to, kept in the dialog's footer so it stays in view however far the table list has scrolled. A complete
 * import is a plain line; one that took only part of the table sits on the warning ground (the ground says it, the text stays ink).
 */
function ImportConfirmation({ outcome }: { outcome: ImportOutcome }) {
  return <div role="status" className={cn("space-y-1 text-ui text-text", outcome.partial && "rounded bg-warn-soft px-3 py-2")}>
    <p>{outcome.text}</p>
    {outcome.notes.map(note => <p key={note} className="break-words">{note}</p>)}
  </div>;
}
