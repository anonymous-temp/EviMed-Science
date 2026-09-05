import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, inputClasses } from "@/components/ui/Input";
import {
  downloadCapsuleExport, exportCapsule, importCapsule, listCapsuleExports, previewCapsuleImport,
  productErrorMessage, revokeCapsuleExport, saveCapsuleDownload,
  type CapsuleExportSnapshot, type CapsuleRecord, type CapsuleTransferPreview,
} from "@/lib/productClient";

export function CapsuleTransferPanel({ capsule, onImported }: { capsule: CapsuleRecord | null; onImported: (capsule: CapsuleRecord) => void }) {
  const [exportPassword, setExportPassword] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [profile, setProfile] = useState(false);
  const [knowledge, setKnowledge] = useState(false);
  const [archive, setArchive] = useState("");
  const [importTitle, setImportTitle] = useState("导入的研究胶囊");
  const [preview, setPreview] = useState<CapsuleTransferPreview | null>(null);
  const [history, setHistory] = useState<CapsuleExportSnapshot[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const capsuleId = capsule?.deletedAt ? null : capsule?.id;
  const currentCapsuleId = useRef(capsuleId);
  currentCapsuleId.current = capsuleId;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setHistory([]); setHistoryCursor(null);
    if (!capsuleId) { setLoading(false); return; }
    setLoading(true);
    void listCapsuleExports(capsuleId).then(page => { if (active) { setHistory(page.items); setHistoryCursor(page.nextCursor); } })
      .catch(caught => { if (active) setError(productErrorMessage(caught)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [capsuleId, refresh]);

  const perform = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError(null); setNotice(null);
    try { await action(); } catch (caught) { if (mounted.current) setError(productErrorMessage(caught)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const createExport = (supersedes?: string, savedScopes?: string[]) => perform(async () => {
    if (!capsuleId || !exportPassword) return;
    const result = await exportCapsule(capsuleId, { password: exportPassword,
      scopes: savedScopes ?? ["workstyle", ...(profile ? ["+profile"] : []), ...(knowledge ? ["+knowledge"] : [])], ...(supersedes ? { supersedes } : {}) });
    saveCapsuleDownload(result.archive, result.filename);
    if (mounted.current) { setExportPassword(""); setRefresh(value => value + 1); setNotice("加密快照已下载。请通过其他渠道告知接收者口令。"); }
  });

  return <Card title="分享与导入" hint="默认只分享已采用的研究方法与工作偏好。原始来源文档、账户标识和运行记录不会随包导出。">
    <div className="space-y-5">
      <p className="text-ui-sm text-muted">撤销仅对本服务上的快照生效，已下载的离线副本无法收回。更新会生成新的独立快照。</p>
      {error && <div role="alert" className="space-y-2 text-ui-sm text-error"><p>{error}</p><Button variant="ghost" disabled={busy} onClick={() => { setError(null); setRefresh(value => value + 1); }}>刷新记录</Button></div>}
      {notice && <p role="status" className="text-ui-sm text-ok">{notice}</p>}
      <section className="space-y-3" aria-label="加密导出">
        <h3 className="text-ui font-medium text-text">导出{capsule ? `「${capsule.payload.title}」` : "胶囊"}</h3>
        <Input label="导出口令" type="password" autoComplete="new-password" value={exportPassword} disabled={busy || !capsuleId} onChange={event => setExportPassword(event.target.value)} maxLength={1024} />
        <div className="flex flex-wrap gap-4 text-ui-sm text-text">
          <span>✓ 工作方式（默认）</span>
          <label><input type="checkbox" checked={profile} disabled={busy} onChange={event => setProfile(event.target.checked)} /> 额外分享个人背景</label>
          <label><input type="checkbox" checked={knowledge} disabled={busy} onChange={event => setKnowledge(event.target.checked)} /> 额外分享知识与项目事实</label>
        </div>
        <Button disabled={busy || !capsuleId || !exportPassword} loading={busy} onClick={() => void createExport()}>加密导出当前版本</Button>
        {!capsuleId && <p className="text-caption text-muted">选择一个未删除的胶囊后可导出；下方仍可导入文件。</p>}
      </section>
      <section className="space-y-3 border-t border-border pt-4" aria-label="胶囊导入">
        <h3 className="text-ui font-medium text-text">导入加密胶囊</h3>
        <label className="block space-y-1 text-ui-sm text-text">选择胶囊文件<input type="file" accept=".evimedcap" className={inputClasses()} disabled={busy} onChange={event => {
          const file = event.target.files?.[0]; setArchive(""); setPreview(null);
          if (!file) return;
          if (!file.name.endsWith(".evimedcap") || file.size > 2 * 1024 * 1024) { setError("请选择不超过 2 MiB 的 .evimedcap 文件。"); return; }
          void perform(async () => { const content = await file.text(); if (mounted.current) setArchive(content); });
        }} /></label>
        <Input label="导入口令" type="password" autoComplete="off" disabled={busy} maxLength={1024} value={importPassword} onChange={event => { setImportPassword(event.target.value); setPreview(null); }} />
        <Button disabled={busy || !archive || !importPassword} onClick={() => void perform(async () => {
          const result = await previewCapsuleImport({ archive, password: importPassword }); if (mounted.current) setPreview(result);
        })}>解密并预览</Button>
        {preview && <div className="space-y-3 rounded-card border border-border p-3">
          <p className="text-ui-sm text-text">{preview.issuerTrust === "verified" ? "来源身份已由本服务验证" : "作者身份未验证（外部自签名）"}</p>
          <p className="text-ui-sm text-muted">在线状态：{preview.hostedStatus === "revoked" ? "已撤销，无法导入" : preview.hostedStatus === "active" ? "有效" : "未知，无法核验外部撤销状态"} · {preview.entries.length} 条内容</p>
          {preview.newerSnapshotId && <p className="text-ui-sm text-warn">发布者已有更新快照，可向发布者索取新版本。</p>}
          {preview.entries.map(entry => <details key={entry.id} className="text-ui-sm"><summary>{entry.factKind} · 来源版本 {entry.version}</summary><p className="mt-2 whitespace-pre-wrap text-text">{entry.content}</p></details>)}
          <Input label="导入后的胶囊名称" value={importTitle} disabled={busy} maxLength={150} onChange={event => setImportTitle(event.target.value)} />
          <p className="text-caption text-muted">将新建胶囊；条目全部待确认，不自动启用，也不会执行包内方法。</p>
          <Button disabled={busy || !preview.canImport || !importTitle.trim()} onClick={() => void perform(async () => {
            const result = await importCapsule({ archive, password: importPassword, expectedDigest: preview.archiveSha256, confirmed: true, title: importTitle.trim() });
            if (mounted.current) { setPreview(null); setArchive(""); setImportPassword(""); setNotice("胶囊已导入，请逐条确认后使用。"); onImported(result); }
          })}>确认导入为待确认条目</Button>
        </div>}
      </section>
      {capsuleId && <section className="space-y-2 border-t border-border pt-4" aria-label="导出历史"><h3 className="text-ui font-medium text-text">导出历史</h3>
        {loading ? <p role="status" className="text-ui-sm text-muted">正在读取导出记录…</p> : history.length === 0 ? <p className="text-ui-sm text-muted">尚无导出快照。</p> : history.map(snapshot => <div key={snapshot.id} className="space-y-2 rounded-card border border-border p-3">
          <p className="text-ui-sm text-text">{new Date(snapshot.createdAt).toLocaleString()} · 胶囊版本 {snapshot.capsuleRevision} · {snapshot.entryCount} 条 · {snapshot.status === "revoked" ? "已撤销" : "有效"}</p>
          <details className="text-caption text-muted"><summary>快照校验信息</summary><p className="break-all">{snapshot.id} · {snapshot.archiveSha256}</p><p>条目版本：{snapshot.entryVersions.map(entry => entry.version).join("、")}</p></details>
          <p className="text-caption text-muted">分享范围：{snapshot.scopes.map(scope => ({ workstyle: "工作方式", "+profile": "个人背景", "+knowledge": "知识与项目事实" })[scope] ?? scope).join("、")}</p>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={busy || snapshot.status === "revoked"} onClick={() => void perform(() => downloadCapsuleExport(capsuleId, snapshot.id))}>再次下载</Button>
            <Button size="sm" variant="ghost" disabled={busy || !exportPassword} onClick={() => void createExport(snapshot.id, snapshot.scopes)}>更新快照</Button>
            <Button size="sm" variant="ghost" disabled={busy || snapshot.status === "revoked"} onClick={() => void perform(async () => { await revokeCapsuleExport(capsuleId, snapshot); setRefresh(value => value + 1); })}>撤销此快照</Button></div>
        </div>)}
        {historyCursor && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform(async () => { const page = await listCapsuleExports(capsuleId, historyCursor); if (currentCapsuleId.current === capsuleId) { setHistory(items => [...items, ...page.items]); setHistoryCursor(page.nextCursor); } })}>更多导出记录</Button>}
      </section>}
    </div>
  </Card>;
}
