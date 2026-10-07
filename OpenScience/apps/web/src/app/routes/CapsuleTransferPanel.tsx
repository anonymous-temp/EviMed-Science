import { useEffect, useRef, useState } from "react";
import { CapsuleSharePanel } from "@/components/capsule/CapsuleSharePanel";
import { ReceivedShelf } from "@/components/capsule/ReceivedShelf";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { Input, inputClasses } from "@/components/ui/Input";
import { Tabs } from "@/components/ui/Tabs";
import { CAPSULE_SCAN_REASONS, capsuleEntryLabel, fromSender } from "@/lib/capsuleText";
import { takeDownSnapshot } from "@/lib/capsuleShareClient";
import { useCapsuleShareFeature } from "@/lib/capsuleShareFeature";
import { formatDateTime } from "@/lib/format";
import { announceMemoryChanged, ensureMyCapsule } from "@/lib/memoryClient";
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
 * One action at a time with its own error and notice: the busy state that keeps
 * a second click from racing the first, and a result that is said where the
 * button is. Both tabs of the drawer use it, each with its own copy.
 */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await action(); } catch (caught) { if (mounted.current) setError(productErrorMessage(caught)); }
    finally { if (mounted.current) setBusy(false); }
  };
  return { busy, error, notice, setError, setNotice, perform, mounted };
}

/**
 * 导出, the first tab of 分享与导入: hand the researcher's own capsule to
 * someone as an encrypted file, to people of this platform, or as a folder of
 * methods — and the versions already handed out.
 *
 * One column, and each password sits next to the button that needs it
 * (2026-10-07 plan §3.2 item 7): 更新 used to be disabled by a field a page
 * above, which read as a click that did nothing. A version that was handed out
 * is 撤回 in one action with one confirmation that says what happens — it was
 * two red buttons, 撤销 and 下架并停用副本, side by side, that did different
 * irreversible things. What cannot be taken back is said in that confirmation,
 * and nowhere else.
 */
export function ExportPanel({ capsule }: { capsule: CapsuleRecord | null }) {
  const [password, setPassword] = useState("");
  const [profile, setProfile] = useState(false);
  const [knowledge, setKnowledge] = useState(false);
  /** 「对方会看到什么」 for the scopes chosen; null until read, or when it cannot be. */
  const [outgoing, setOutgoing] = useState<CapsuleExportPreview | null>(null);
  const [history, setHistory] = useState<CapsuleExportSnapshot[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  /** The version being updated, and the password typed beside its button. */
  const [updating, setUpdating] = useState<{ id: string; password: string } | null>(null);
  /** The version a researcher asked to withdraw, held until they confirm. */
  const [withdrawing, setWithdrawing] = useState<CapsuleExportSnapshot | null>(null);
  // Sharing between accounts has its own switch: its panel, and the copies a withdrawal also stops, exist only where the server says so.
  const sharing = useCapsuleShareFeature() === "on";
  const [loading, setLoading] = useState(false);
  const { busy, error, notice, setError, setNotice, perform, mounted } = useAction();
  const capsuleId = capsule?.deletedAt ? null : capsule?.id;
  const currentCapsuleId = useRef(capsuleId);
  currentCapsuleId.current = capsuleId;
  const scopes = ["workstyle", ...(profile ? ["+profile"] : []), ...(knowledge ? ["+knowledge"] : [])];

  useEffect(() => {
    let active = true; setHistory([]); setHistoryCursor(null);
    if (!capsuleId) { setLoading(false); return; }
    setLoading(true);
    void listCapsuleExports(capsuleId).then(page => { if (active) { setHistory(page.items); setHistoryCursor(page.nextCursor); } })
      .catch(caught => { if (active) setError(productErrorMessage(caught)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [capsuleId, refresh, setError]);

  // What a file of the chosen scopes would carry, read before any password is typed: an account with nothing to share is told so
  // here, not by a refused export (2026-09-26 audit, M-6).
  useEffect(() => {
    let active = true;
    setOutgoing(null);
    if (!capsuleId) return;
    void (async () => {
      try {
        const result = await previewCapsuleExport(capsuleId, { scopes: ["workstyle", ...(profile ? ["+profile"] : []), ...(knowledge ? ["+knowledge"] : [])] });
        if (active) setOutgoing(result ?? null);
      } catch { /* the export itself still says why it cannot run */ }
    })();
    return () => { active = false; };
  }, [capsuleId, profile, knowledge, refresh]);

  const createExport = (secret: string, supersedes?: string, savedScopes?: string[]) => perform(async () => {
    if (!capsuleId || !secret) return;
    const result = await exportCapsule(capsuleId, { password: secret, scopes: savedScopes ?? scopes, ...(supersedes ? { supersedes } : {}) });
    saveCapsuleDownload(result.archive, result.filename);
    if (mounted.current) { setPassword(""); setUpdating(null); setRefresh(value => value + 1); setNotice("已下载"); }
  });

  /** 撤回: the version stops being importable here and, where sharing is on, the copies others took stop working. */
  const withdraw = (snapshot: CapsuleExportSnapshot) => perform(async () => {
    if (!capsuleId) return;
    if (snapshot.status !== "revoked") await revokeCapsuleExport(capsuleId, snapshot);
    const done = sharing ? await takeDownSnapshot(capsuleId, snapshot.id, "") : null;
    if (mounted.current) {
      setRefresh(value => value + 1);
      setNotice(done && done.copies > 0 ? `已撤回，别人收下的 ${done.copies} 份副本已停用` : "已撤回");
    }
  });

  return <div className="space-y-8">
    {withdrawing && <ConfirmDialog
      title="撤回这个版本？"
      body={sharing
        ? `撤回后它不能再被导入，别人已经收下的副本会停用并收到一条说明，无法恢复；已下载的离线文件无法收回。${stamp(withdrawing.createdAt)} · ${withdrawing.entryCount} 条。`
        : `撤回后它不能再被导入，无法恢复；已下载的离线文件无法收回。${stamp(withdrawing.createdAt)} · ${withdrawing.entryCount} 条。`}
      confirmLabel="撤回"
      onCancel={() => setWithdrawing(null)}
      onConfirm={() => {
        const snapshot = withdrawing;
        setWithdrawing(null);
        void withdraw(snapshot);
      }}
    />}
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-ui text-error">
      <span>{error}</span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setError(null); setRefresh(value => value + 1); }}>刷新记录</Button>
    </div>}
    {notice && <p role="status" className="text-ui text-text-2">{notice}</p>}

    <section className="space-y-3" aria-label="加密导出">
      <h3 className="text-ui font-semibold text-text">导出为加密文件</h3>
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
      {/* The password and the button that needs it, in one row. */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <Input label="文件密码" type="password" autoComplete="new-password" value={password} disabled={busy || !capsuleId} onChange={event => setPassword(event.target.value)} maxLength={1024} />
        </div>
        <Button disabled={busy || !capsuleId || !password || outgoing?.empty === true} loading={busy} onClick={() => void createExport(password)}>加密导出</Button>
      </div>
    </section>

    {sharing && <CapsuleSharePanel capsuleId={capsuleId ?? null} />}

    {capsuleId && <section className="space-y-2" aria-label="导出的版本">
      <h3 className="text-ui font-semibold text-text">导出的版本</h3>
      {loading ? <p role="status" className="text-ui text-text-3">正在读取</p> : history.length === 0 ? <p className="text-ui text-text-3">还没有导出过。</p> : (
        <ul className="divide-y divide-border">
          {history.map(snapshot => <li key={snapshot.id} className="space-y-2 py-3">
            <p className="text-ui text-text">
              {stamp(snapshot.createdAt)} · {snapshot.entryCount} 条 · {snapshot.scopes.map(scope => labelFor(SCOPE_LABELS, scope, "其他范围")).join("、")}
              {snapshot.status === "revoked" ? " · 已撤回" : ""}
            </p>
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="text" disabled={busy || snapshot.status === "revoked"} onClick={() => void perform(() => downloadCapsuleExport(capsuleId, snapshot.id))}>再次下载</Button>
              <Button size="sm" variant="text" disabled={busy || snapshot.status === "revoked"} aria-expanded={updating?.id === snapshot.id}
                onClick={() => setUpdating(updating?.id === snapshot.id ? null : { id: snapshot.id, password: "" })}>更新</Button>
              <Button size="sm" variant="text" destructive disabled={busy || (snapshot.status === "revoked" && !sharing)} onClick={() => setWithdrawing(snapshot)}>撤回</Button>
            </div>
            {updating?.id === snapshot.id && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1">
                  <Input label="文件密码" type="password" autoComplete="new-password" value={updating.password} disabled={busy} maxLength={1024}
                    onChange={event => setUpdating({ id: snapshot.id, password: event.target.value })} />
                </div>
                <Button disabled={busy || !updating.password} loading={busy} onClick={() => void createExport(updating.password, snapshot.id, snapshot.scopes)}>更新并下载</Button>
              </div>
            )}
          </li>)}
        </ul>
      )}
      {historyCursor && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void perform(async () => { const page = await listCapsuleExports(capsuleId, historyCursor); if (currentCapsuleId.current === capsuleId) { setHistory(items => [...items, ...page.items]); setHistoryCursor(page.nextCursor); } })}>更多</Button>}
    </section>}
  </div>;
}

/**
 * 导入, the second tab: open a file someone gave the researcher, preview what
 * it holds and what will not be taken, and take it whole — then what is waiting
 * to be taken and what was taken.
 *
 * A file made for this account opens with no password. What the automatic check
 * will leave out is part of what is previewed, entry by entry, with its reason
 * in the researcher's words: 「不会带上」.
 */
export function ImportPanel({ onImported }: { onImported: (capsule: CapsuleRecord) => void }) {
  const [password, setPassword] = useState("");
  const [archive, setArchive] = useState("");
  const [title, setTitle] = useState("收到的研究胶囊");
  const [preview, setPreview] = useState<CapsuleTransferPreview | null>(null);
  const { busy, error, notice, setError, setNotice, perform, mounted } = useAction();

  const upgrading = preview?.upgrades ?? null;
  const status = preview ? [
    preview.issuerTrust === "verified" ? "已验证" : "来源未验证",
    `${preview.entries.length} 条`,
    ...(preview.hostedStatus === "revoked" ? ["已撤回"] : []),
    ...(preview.newerSnapshotId ? ["有更新版本"] : []),
    ...(preview.scan?.dropped.length ? [`不会带上 ${preview.scan.dropped.length} 条`] : []),
  ].join(" · ") : "";

  return <div className="space-y-8">
    {error && <p role="alert" className="text-ui text-error">{error}</p>}
    {notice && <p role="status" className="text-ui text-text-2">{notice}</p>}

    <section className="space-y-3" aria-label="导入文件">
      <label className="block space-y-2 text-ui font-medium text-text">选择胶囊文件<input type="file" accept=".evimedcap" className={inputClasses({ className: "font-normal" })} disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; setArchive(""); setPreview(null);
        if (!file) return;
        if (!file.name.endsWith(".evimedcap") || file.size > 2 * 1024 * 1024) { setError("请选择不超过 2 MiB 的胶囊文件。"); return; }
        void perform(async () => { const content = await file.text(); if (mounted.current) setArchive(content); });
      }} /></label>
      <p className="text-caption text-text-3">别人分享给你的记忆胶囊，不超过 2 MiB。预览不会改变你的记忆。</p>
      {/* A file made for this account opens without a password. */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <Input label="文件密码" type="password" autoComplete="off" disabled={busy} maxLength={1024} value={password} onChange={event => { setPassword(event.target.value); setPreview(null); }} />
        </div>
        <Button variant="secondary" disabled={busy || !archive} onClick={() => void perform(async () => {
          const result = await previewCapsuleImport({ archive, ...(password ? { password } : {}) });
          if (mounted.current) { setPreview(result); if (result?.card?.title) setTitle(result.card.title); }
        })}>预览</Button>
      </div>
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
        <ul className="space-y-1">
          {preview.entries.map(entry => {
            const dropped = preview.scan?.dropped.find(item => item.id === entry.id);
            return <li key={entry.id}>
              <Disclosure summary={`${capsuleEntryLabel(entry.factKind)}${dropped ? ` · 不会带上：${CAPSULE_SCAN_REASONS[dropped.code] ?? "没有通过自动检查"}` : ""}`}>
                <p className="max-w-measure whitespace-pre-wrap text-ui text-text">{entry.content}</p>
                {dropped?.source === "model" && dropped.reason && <p className="mt-1 text-caption text-text-3">{dropped.reason}</p>}
              </Disclosure>
            </li>;
          })}
        </ul>
        {!upgrading && <Input label="收下后的胶囊名称" value={title} disabled={busy} maxLength={150} onChange={event => setTitle(event.target.value)} />}
        <Button disabled={busy || !preview.canImport || (!upgrading && !title.trim())} onClick={() => void perform(async () => {
          const result = await importCapsule({ archive, ...(password ? { password } : {}), expectedDigest: preview.archiveSha256, confirmed: true,
            ...(upgrading ? {} : { title: title.trim() }) });
          if (mounted.current) {
            setPreview(null); setArchive(""); setPassword("");
            setNotice(upgrading ? `已更新“${result.payload.title}”` : `已收下“${result.payload.title}”`); onImported(result);
          }
        })}>{upgrading ? "更新这个胶囊" : "收下这个胶囊"}</Button>
      </div>}
    </section>

    <ReceivedShelf />
  </div>;
}

type ShareTab = "export" | "import";

/**
 * 「分享与导入」, the drawer from the memory page's 「⋯」: two tabs, 导出 and
 * 导入, each one column (2026-10-07 plan §3.2 item 7) — five to seven sections
 * stacked in one scroll was the page's second page. Every function it had is in
 * one of them.
 *
 * The researcher's own capsule is made when this opens, not when the memory
 * page does: reading the page used to write (2026-10-07 walk, D-P2-8). The
 * import tab does not need it, so a capsule that cannot be made costs the
 * export and nothing else.
 */
export function ShareDrawer({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [tab, setTab] = useState<ShareTab>("export");
  const [capsule, setCapsule] = useState<CapsuleRecord | null>(null);
  useEffect(() => {
    let active = true;
    void ensureMyCapsule().then((own) => { if (active) setCapsule(own); }, () => { /* export waits; import still works */ });
    return () => { active = false; };
  }, []);
  return (
    <Drawer title="分享与导入" onClose={onClose}>
      <div className="space-y-6">
        <Tabs<ShareTab> label="分享与导入" items={[{ value: "export", label: "导出" }, { value: "import", label: "导入" }]} value={tab} onChange={setTab} />
        {tab === "export" ? <ExportPanel capsule={capsule} /> : <ImportPanel onImported={() => { announceMemoryChanged(); onImported(); }} />}
      </div>
    </Drawer>
  );
}
