import { useEffect, useRef, useState } from "react";
import { CapsuleSharePanel } from "@/components/capsule/CapsuleSharePanel";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { CAPSULE_SCAN_REASONS, capsuleEntryLabel, fromSender } from "@/lib/capsuleText";
import { Input, inputClasses } from "@/components/ui/Input";
import { takeDownSnapshot } from "@/lib/capsuleShareClient";
import { formatDateTime } from "@/lib/format";
import { labelFor } from "@/lib/statusLabel";
import {
  downloadCapsuleExport, exportCapsule, importCapsule, listCapsuleExports, previewCapsuleExport, previewCapsuleImport,
  productErrorMessage, revokeCapsuleExport, saveCapsuleDownload,
  type CapsuleExportPreview, type CapsuleExportSnapshot, type CapsuleRecord, type CapsuleTransferPreview,
} from "@/lib/productClient";

const SCOPE_LABELS: Record<string, string> = { workstyle: "工作方式", "+profile": "个人背景", "+knowledge": "知识与项目事实" };

function stamp(value: string) {
  return formatDateTime(value, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * 分享与导入, the body of its drawer: export the researcher's own capsule as
 * an encrypted file, import someone else's, and the snapshots already handed
 * out. No card inside the drawer and no paragraph about how snapshots work
 * (2026-09-23 inventory §1.7): what cannot be taken back is said in the one
 * place it matters, the confirmation of 撤销.
 */
export function CapsuleTransferPanel({ capsule, onImported }: { capsule: CapsuleRecord | null; onImported: (capsule: CapsuleRecord) => void }) {
  const [exportPassword, setExportPassword] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [profile, setProfile] = useState(false);
  const [knowledge, setKnowledge] = useState(false);
  const [archive, setArchive] = useState("");
  const [importTitle, setImportTitle] = useState("收到的研究胶囊");
  const [preview, setPreview] = useState<CapsuleTransferPreview | null>(null);
  /** 「对方会看到什么」 for the scopes chosen; null until read, or when it cannot be. */
  const [outgoing, setOutgoing] = useState<CapsuleExportPreview | null>(null);
  const [history, setHistory] = useState<CapsuleExportSnapshot[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  /** The snapshot a researcher asked to revoke, held until they confirm.
   *  Revoking is permanent — every copy already handed out stops importing —
   *  and it was one click with no confirmation (2026-09-16 review, U11). */
  const [revoking, setRevoking] = useState<CapsuleExportSnapshot | null>(null);
  /** The snapshot an author asked to take down: it also switches off every recipient's copy, so it asks first (flywheel F17). */
  const [takingDown, setTakingDown] = useState<CapsuleExportSnapshot | null>(null);
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

  // What a pack of the chosen scopes would carry, read before any password is
  // typed: an account with nothing to share is told so here, not by a refused
  // export (2026-09-26 audit, M-6).
  useEffect(() => {
    let active = true;
    setOutgoing(null);
    if (!capsuleId) return;
    const scopes = ["workstyle", ...(profile ? ["+profile"] : []), ...(knowledge ? ["+knowledge"] : [])];
    void (async () => {
      try {
        const result = await previewCapsuleExport(capsuleId, { scopes });
        if (active) setOutgoing(result ?? null);
      } catch { /* the export itself still says why it cannot run */ }
    })();
    return () => { active = false; };
  }, [capsuleId, profile, knowledge, refresh]);

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
    if (mounted.current) { setExportPassword(""); setRefresh(value => value + 1); setNotice("已下载"); }
  });

  const upgrading = preview?.upgrades ?? null;
  const status = preview ? [
    preview.issuerTrust === "verified" ? "已验证" : "未验证",
    `${preview.entries.length} 条`,
    ...(preview.hostedStatus === "revoked" ? ["已撤销"] : []),
    ...(preview.newerSnapshotId ? ["有更新版本"] : []),
    ...(preview.scan?.dropped.length ? [`会剔除 ${preview.scan.dropped.length} 条`] : []),
  ].join(" · ") : "";

  return <div className="space-y-8">
    {revoking && <ConfirmDialog
      title="撤销这份快照？"
      body={`撤销后它在本服务上不能再被导入，无法恢复；已下载的离线副本无法收回。${stamp(revoking.createdAt)} · ${revoking.entryCount} 条。`}
      confirmLabel="撤销快照"
      onCancel={() => setRevoking(null)}
      onConfirm={() => {
        const snapshot = revoking;
        const owner = capsuleId;
        setRevoking(null);
        // The button that opened this dialog only exists inside `capsuleId &&`,
        // so `owner` is a string here; narrowing it keeps that true rather than
        // asserting it.
        if (!owner) return;
        void perform(async () => { await revokeCapsuleExport(owner, snapshot); setRefresh(value => value + 1); });
      }}
    />}
    {takingDown && <ConfirmDialog
      title="下架这份分享？"
      body="下架后收到的人那份副本会被停用，并收到一条说明；它不能再被收下。对方自己的记忆和对话不受影响。已下载的离线文件无法收回。"
      confirmLabel="下架并停用副本"
      onCancel={() => setTakingDown(null)}
      onConfirm={() => {
        const snapshot = takingDown;
        const owner = capsuleId;
        setTakingDown(null);
        if (!owner) return;
        void perform(async () => { const done = await takeDownSnapshot(owner, snapshot.id, ""); setRefresh(value => value + 1); setNotice(`已下架，停用了 ${done.copies} 份副本`); });
      }}
    />}
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-ui text-error">
      <span>{error}</span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setError(null); setRefresh(value => value + 1); }}>刷新记录</Button>
    </div>}
    {notice && <p role="status" className="text-ui text-text-2">{notice}</p>}

    <section className="space-y-3" aria-label="加密导出">
      <h3 className="text-ui font-semibold text-text">导出</h3>
      <Input label="导出口令" type="password" autoComplete="new-password" value={exportPassword} disabled={busy || !capsuleId} onChange={event => setExportPassword(event.target.value)} maxLength={1024} />
      <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui text-text">
        <legend className="sr-only">包含</legend>
        <span className="text-text-2">包含：工作方式</span>
        <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={profile} disabled={busy} onChange={event => setProfile(event.target.checked)} />个人背景</label>
        <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={knowledge} disabled={busy} onChange={event => setKnowledge(event.target.checked)} />知识与项目事实</label>
      </fieldset>
      {outgoing?.empty ? (
        <p className="text-ui text-text-2">还没有可以分享的内容：学到做法，或在对话里说明你的工作方式之后，就可以分享了。</p>
      ) : outgoing?.card?.summary ? (
        <Disclosure summary={`对方会看到：${outgoing.card.summary}`}>
          <ul className="space-y-2">
            {outgoing.entries.map((entry, index) => (
              <li key={index} className="text-ui">
                <span className="text-text-3">{capsuleEntryLabel(entry.factKind)}</span>
                <p className="max-w-measure whitespace-pre-wrap text-text">{entry.content}</p>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
      <Button disabled={busy || !capsuleId || !exportPassword || outgoing?.empty === true} loading={busy} onClick={() => void createExport()}>加密导出</Button>
    </section>

    <CapsuleSharePanel capsuleId={capsuleId ?? null} />

    <section className="space-y-3" aria-label="胶囊导入">
      <h3 className="text-ui font-semibold text-text">导入</h3>
      <label className="block space-y-2 text-ui font-medium text-text">选择胶囊文件<input type="file" accept=".evimedcap" className={inputClasses({ className: "font-normal" })} disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; setArchive(""); setPreview(null);
        if (!file) return;
        if (!file.name.endsWith(".evimedcap") || file.size > 2 * 1024 * 1024) { setError("请选择不超过 2 MiB 的 .evimedcap 文件。"); return; }
        void perform(async () => { const content = await file.text(); if (mounted.current) setArchive(content); });
      }} /></label>
      <Input label="导入口令" type="password" autoComplete="off" disabled={busy} maxLength={1024} value={importPassword} onChange={event => { setImportPassword(event.target.value); setPreview(null); }} />
      {/* A pack sealed for this account opens without a password. */}
      <Button variant="secondary" disabled={busy || !archive} onClick={() => void perform(async () => {
        const result = await previewCapsuleImport({ archive, ...(importPassword ? { password: importPassword } : {}) });
        if (mounted.current) { setPreview(result); if (result?.card?.title) setImportTitle(result.card.title); }
      })}>解密并预览</Button>
      {preview && <div className="space-y-3 pt-2">
        {/* The card its sender signed: what it is, who sent it, what it holds. */}
        {preview.card && <div className="space-y-1">
          {preview.card.title && <p className="text-ui font-semibold text-text">{preview.card.title}</p>}
          {(preview.card.author || preview.card.summary) && <p className="text-ui text-text-2">
            {[preview.card.author ? fromSender(preview.card.author) : null, preview.card.summary ?? null].filter(Boolean).join(" · ")}
          </p>}
        </div>}
        {upgrading && <p className="text-ui text-text">
          会更新你已收下的“{upgrading.title}”：{preview.card?.changelog ?? `新增 ${upgrading.added} 条、移除 ${upgrading.removed} 条`}
        </p>}
        <p className="text-ui text-text">{status}</p>
        {/* Whole-pack trust (plan §3.3 #4): what the scan would drop is part
            of what is previewed, entry by entry. */}
        <ul className="space-y-1">
          {preview.entries.map(entry => {
            const dropped = preview.scan?.dropped.find(item => item.id === entry.id);
            return <li key={entry.id}>
              <Disclosure summary={`${capsuleEntryLabel(entry.factKind)}${dropped ? ` · 会被剔除：${CAPSULE_SCAN_REASONS[dropped.code] ?? "没有通过自动检查"}` : ""}`}>
                <p className="max-w-measure whitespace-pre-wrap text-ui text-text">{entry.content}</p>
                {dropped?.source === "model" && dropped.reason && <p className="mt-1 text-caption text-text-3">{dropped.reason}</p>}
              </Disclosure>
            </li>;
          })}
        </ul>
        {!upgrading && <Input label="收下后的胶囊名称" value={importTitle} disabled={busy} maxLength={150} onChange={event => setImportTitle(event.target.value)} />}
        <Button disabled={busy || !preview.canImport || (!upgrading && !importTitle.trim())} onClick={() => void perform(async () => {
          const result = await importCapsule({ archive, ...(importPassword ? { password: importPassword } : {}), expectedDigest: preview.archiveSha256, confirmed: true,
            ...(upgrading ? {} : { title: importTitle.trim() }) });
          if (mounted.current) {
            setPreview(null); setArchive(""); setImportPassword("");
            setNotice(upgrading ? `已更新“${result.payload.title}”` : `已收下“${result.payload.title}”`); onImported(result);
          }
        })}>{upgrading ? "更新这个胶囊" : "收下这个胶囊"}</Button>
      </div>}
    </section>

    {capsuleId && <Disclosure summary="导出记录" summaryClassName="font-semibold text-text">
      {loading ? <p role="status" className="text-ui text-text-3">正在读取</p> : history.length === 0 ? <p className="text-ui text-text-3">还没有导出过。</p> : (
        <ul className="divide-y divide-border">
          {history.map(snapshot => <li key={snapshot.id} className="space-y-1 py-3">
            <p className="text-ui text-text">
              {stamp(snapshot.createdAt)} · {snapshot.entryCount} 条 · {snapshot.scopes.map(scope => labelFor(SCOPE_LABELS, scope, "其他范围")).join("、")}
              {snapshot.status === "revoked" ? " · 已撤销" : ""}
            </p>
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="text" disabled={busy || snapshot.status === "revoked"} onClick={() => void perform(() => downloadCapsuleExport(capsuleId, snapshot.id))}>再次下载</Button>
              <Button size="sm" variant="text" disabled={busy || !exportPassword} onClick={() => void createExport(snapshot.id, snapshot.scopes)}>更新快照</Button>
              <Button size="sm" variant="text" destructive disabled={busy || snapshot.status === "revoked"} onClick={() => setRevoking(snapshot)}>撤销此快照</Button>
              <Button size="sm" variant="text" destructive disabled={busy} onClick={() => setTakingDown(snapshot)}>下架并停用副本</Button>
            </div>
          </li>)}
        </ul>
      )}
      {historyCursor && <Button size="sm" variant="secondary" className="mt-2" disabled={busy} onClick={() => void perform(async () => { const page = await listCapsuleExports(capsuleId, historyCursor); if (currentCapsuleId.current === capsuleId) { setHistory(items => [...items, ...page.items]); setHistoryCursor(page.nextCursor); } })}>更多导出记录</Button>}
    </Disclosure>}
  </div>;
}
