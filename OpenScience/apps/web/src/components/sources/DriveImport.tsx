import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CornerLeftUp, FileText, Folder, FolderSync, RefreshCw } from "lucide-react";
import { baseName, formatClock, formatDay } from "@/lib/format";
import { productErrorMessage } from "@/lib/productClient";
import { browseOpenList, importOpenListSource, listSourceFolders, registerSourceFolder, setSourceFolderStatus, sourceFailureMessage, syncSourceFolder,
  type OpenListEntry, type SourceFolderRecord } from "@/lib/sourceClient";
import { toast } from "@/lib/toast";
import { useOperator } from "@/lib/useOperator";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import { Switch } from "@/components/ui/Switch";
import { Tooltip } from "@/components/ui/Tooltip";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";

/** A synced folder's path as the researcher typed it: the tenant namespace the
 *  gateway prefixes is the platform's, not theirs (review B, SourcesPage). */
function displayPath(path: string) {
  return path.replace(/^\/tenants\/[^/]+/, "") || "/";
}

/**
 * The researcher's own cloud drive, browsed a folder at a time: a folder
 * opens, a file is imported, and a folder can be registered to sync. A file the
 * drive gives no content fingerprint for cannot be imported from here.
 */
export function OpenListBrowser({ projectId, onImported, onFolderRegistered }: { projectId: string;
  onImported: () => Promise<void> | void; onFolderRegistered: () => void }) {
  const [remotePath, setRemotePath] = useState("/");
  const [entries, setEntries] = useState<OpenListEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  /** One drive request at a time; a late answer for a page the reader left is dropped. */
  const run = async (operation: (valid: () => boolean) => Promise<void>) => {
    const current = ++request.current;
    const valid = () => request.current === current;
    setBusy(true);
    try { await operation(valid); }
    catch (error) { if (valid()) toast.error(productErrorMessage(error)); }
    finally { if (valid()) setBusy(false); }
  };
  const browse = (selected = remotePath) => run(async (valid) => {
    try { const page = await browseOpenList(projectId, selected); if (valid()) { setRemotePath(selected); setEntries(page.entries); } }
    catch (error) { if (valid()) setEntries([]); throw error; }
  });
  const importFile = (selected: string) => run(async (valid) => { await importOpenListSource(projectId, selected); if (valid()) await onImported(); });
  const registerFolder = (selected: string) => run(async (valid) => { await registerSourceFolder(projectId, selected); if (valid()) onFolderRegistered(); });
  const parent = remotePath === "/" ? "/" : remotePath.split("/").slice(0, -1).join("/") || "/";
  return <section aria-labelledby={headingId}>
    <h3 id={headingId} className="mb-3 text-ui font-semibold text-text">网盘资料</h3>
    <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void browse(); }}>
      <div className="min-w-0 flex-1"><Input label="网盘路径" value={remotePath} onChange={(event) => setRemotePath(event.target.value)} /></div>
      <Button type="submit" loading={busy}>浏览</Button>
      <Button variant="secondary" disabled={busy} onClick={() => void registerFolder(remotePath)}><FolderSync size={16} aria-hidden="true" />同步此文件夹</Button>
    </form>
    {entries && <List className="mt-3">
      {remotePath !== "/" && <ListRow leading={<CornerLeftUp size={16} className="text-text-3" aria-hidden="true" />} title="返回上级" chevron={false} onOpen={() => void browse(parent)} />}
      {entries.length === 0 ? <li className="px-2 py-3 text-ui text-text-3">这里没有可导入的资料。</li> : entries.map((entry) => entry.entryType === "dir"
        ? <ListRow key={entry.path} leading={<Folder size={16} className="text-text-3" aria-hidden="true" />} title={entry.name} onOpen={() => void browse(entry.path)}
          actions={<Button variant="text" size="sm" disabled={busy} onClick={() => void registerFolder(entry.path)}><FolderSync size={16} aria-hidden="true" />同步</Button>} />
        : <ListRow key={entry.path} leading={<FileText size={16} className="text-text-3" aria-hidden="true" />} title={entry.name}
          trailing={entry.providerHash?.startsWith("sha256:")
            ? <Button variant="text" size="sm" disabled={busy} onClick={() => void importFile(entry.path)}>导入</Button>
            : <span>不支持此文件</span>} />)}
    </List>}
  </section>;
}

// Every code the folder sync can record as a skip reason. `openlist_sha256_required`
// is not one of them: the sync filters on the SHA-256 pattern before it ever
// builds a manifest, so that code cannot reach this list.
const SKIP_REASONS: Record<string, string> = {
  provider_hash_unsupported: "网盘无法提供内容指纹",
  entry_budget_exhausted: "超出本文件夹的跟踪上限",
  source_scope_conflict: "同样内容已属于其他项目",
  source_payload_invalid: "文件路径或属性不合规",
  source_path_invalid: "文件路径或属性不合规",
  source_digest_invalid: "网盘给出的内容指纹不合规",
  source_size_invalid: "文件大小超出可入库范围",
  source_connector_invalid: "网盘条目无法映射成资料",
  source_format_unsupported: "知识库不支持这种文件格式",
  source_media_unsupported: "音视频暂不支持解析",
};

/** A researcher reads Chinese. An unmapped code is a sentence here, not a token
 * copied out of the server. */
function skipReason(code: string) { return SKIP_REASONS[code] ?? "这一项无法入库"; }

/**
 * The folders registered to sync, one row each: its name, how its last sync
 * went, a switch that pauses and resumes it, and 「立即同步」 on hover. Syncing
 * runs when the researcher registers, resumes or asks for it; nothing polls.
 */
export function SyncedFolders({ projectId, refreshToken }: { projectId: string; refreshToken: number }) {
  const operator = useOperator();
  const [folders, setFolders] = useState<SourceFolderRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const request = useRef(0);
  const load = useCallback(async () => {
    const current = ++request.current;
    setLoadError(null);
    try {
      const page = await listSourceFolders(projectId);
      if (request.current === current) setFolders(page.items);
    } catch (error) {
      if (request.current === current) { setFolders([]); setLoadError(productErrorMessage(error)); }
    }
  }, [projectId]);
  useEffect(() => { void load(); return () => { request.current += 1; }; }, [load, refreshToken]);
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); await load(); }
    catch (error) { toast.error(productErrorMessage(error)); }
    finally { setBusy(false); }
  };
  return <section aria-labelledby={headingId}>
    <h3 id={headingId} className="mb-1 text-ui font-semibold text-text">同步文件夹</h3>
    {loadError ? <LoadError message={loadError} onRetry={() => void load()} />
      : folders === null ? <FilesSkeleton />
        : folders.length === 0 ? <p className="py-2 text-ui text-text-3">还没有同步文件夹</p>
          : <List>{folders.map((folder) => {
            // The folder's own name, not the connector id it is stored under
            // (which is the gateway path, tenant namespace and all).
            const path = displayPath(folder.payload.connector.id);
            const name = baseName(path);
            const active = folder.payload.status === "active";
            return <ListRow
              key={folder.id}
              leading={<Folder size={20} className="text-text-3" aria-hidden="true" />}
              title={<Tooltip content={path}><span>{name}</span></Tooltip>}
              meta={<FolderSyncLine folder={folder} operator={operator} />}
              actions={<IconButton icon={RefreshCw} label="立即同步" size="sm" disabled={busy || !active}
                onClick={() => void mutate(() => syncSourceFolder(folder.id, folder.revision))} />}
              trailing={<Switch checked={active} label={`同步“${name}”`} disabled={busy}
                onChange={(on) => void mutate(() => setSourceFolderStatus(folder.id, folder.revision, on ? "active" : "paused"))} />}
            />;
          })}</List>}
  </section>;
}

/**
 * How a folder's last sync went. `lastSync` is written only on the success
 * path, so on its own it says a folder that has been failing for a week is
 * healthy; `lastError`, when present, is what is said instead. What a run
 * skipped is folded under its count — the list holds examples, the count is
 * the total.
 */
function FolderSyncLine({ folder, operator }: { folder: SourceFolderRecord; operator: boolean }) {
  const sync = folder.payload.lastSync;
  const lastError = folder.payload.lastError;
  return <div className="space-y-0.5">
    {lastError
      ? operator
        ? <Tooltip content={lastError.code}><p className="text-danger">上次无法同步：{sourceFailureMessage(lastError)}</p></Tooltip>
        : <p className="text-danger">上次无法同步：{sourceFailureMessage(lastError)}</p>
      : <p>{sync ? `上次同步${sync.at ? ` ${formatDay(sync.at)} ${formatClock(sync.at)}` : ""} · 新增 ${sync.registered}` : "尚未同步"}</p>}
    {sync && sync.skippedCount > 0 && <Disclosure summary={`跳过 ${sync.skippedCount} 项`} summaryClassName="text-caption">
      <ul className="space-y-0.5">
        {sync.skipped.slice(0, 5).map((item) => <li key={item.path}>{baseName(item.path)}（{skipReason(item.reason)}）</li>)}
      </ul>
    </Disclosure>}
  </div>;
}


/**
 * What 「从网盘导入」 opens: the drive browsed a folder at a time, and the folders registered to sync under it. The two
 * were one drawer under 「连接网盘」 before the knowledge base's header held one 「添加」 menu.
 */
export function DriveImportDrawerBody({ projectId, refreshToken, onImported, onFolderRegistered }: {
  projectId: string; refreshToken: number; onImported: () => Promise<void> | void; onFolderRegistered: () => void;
}) {
  return (
    <div className="space-y-8">
      <OpenListBrowser projectId={projectId} onImported={onImported} onFolderRegistered={onFolderRegistered} />
      <SyncedFolders projectId={projectId} refreshToken={refreshToken} />
    </div>
  );
}
