import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Download, Quote, Star } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Select, Textarea } from "@/components/ui/Input";
import { Menu } from "@/components/ui/Menu";
import { Note } from "@/components/ui/Note";
import { WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT, WEB_SESSION_SYNC_STORAGE_KEY, WebApiError, webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import {
  downloadEvimedFullText, evimedSearchFailure, exportEvimedSearchRecords, readEvimedFullTextOffer, readEvimedFullTextStatus,
  readEvimedSearchCitations, requestEvimedFullText, setEvimedSearchCollection,
  type EvimedSearchCategory,
} from "@/lib/evimedSearchClient";

export interface EvimedSearchActionItem { id: string; title: string; actionRef?: string | null; collected?: boolean | null }
type ExportFormat = 1 | 2 | 3;
type CitationFormat = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type FullTextStatus = Awaited<ReturnType<typeof readEvimedFullTextStatus>>;
type FullTextOffer = Awaited<ReturnType<typeof readEvimedFullTextOffer>>;
const SearchActionRefresh = createContext<(() => void) | undefined>(undefined);
const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [{ value: 1, label: "Excel" }, { value: 2, label: "PDF" }, { value: 3, label: "XML" }];
const CITATION_FORMATS: { value: CitationFormat; label: string }[] = [
  { value: 0, label: "GB/T 7714" }, { value: 1, label: "查新格式" }, { value: 2, label: "Refworks" }, { value: 3, label: "EndNote" },
  { value: 4, label: "NoteFirst" }, { value: 5, label: "Bibtex" }, { value: 6, label: "NoteExpress" },
];

function useActionSessionValid(identity: string): boolean {
  const [invalidIdentity, setInvalidIdentity] = useState<string | null>(null);
  useEffect(() => {
    const invalidate = () => setInvalidIdentity(identity);
    const sync = (event: StorageEvent) => { if (event.key === WEB_SESSION_SYNC_STORAGE_KEY || event.key === null) invalidate(); };
    window.addEventListener(WEB_SESSION_STARTED_EVENT, invalidate);
    window.addEventListener(WEB_SESSION_ENDED_EVENT, invalidate);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(WEB_SESSION_STARTED_EVENT, invalidate);
      window.removeEventListener(WEB_SESSION_ENDED_EVENT, invalidate);
      window.removeEventListener("storage", sync);
    };
  }, [identity]);
  return invalidIdentity !== identity;
}

function actionMessage(error: unknown, fallback: string): string {
  if (error instanceof WebApiError && error.code?.startsWith("evimed_search_")) return evimedSearchFailure(error).message;
  return webErrorMessage(error, { fallback });
}

function isCancelled(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }

/** Save only a response already admitted by its action endpoint; no account credential enters the file URL. */
function saveFile(blob: Blob, filename: string) {
  if (!blob.size) throw new Error("Empty download");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/[\\/:*?"<>|\p{Cc}]/gu, "_").replace(/[.\s]+$/g, "").slice(0, 220) || "download";
  anchor.hidden = true;
  document.body.appendChild(anchor);
  try { anchor.click(); } finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
}

function ActionFailure({ error, fallback, onRetry }: { error: unknown; fallback: string; onRetry?: () => void }) {
  const refresh = useContext(SearchActionRefresh);
  const login = error instanceof WebApiError && (error.status === 401 || ["evimed_search_login_required", "evimed_search_credential_expired"].includes(error.code ?? ""));
  const expired = error instanceof WebApiError && error.code === "evimed_search_reference_invalid";
  const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
  const search = new URL(window.location.href); search.searchParams.delete("detail");
  return <div role="alert" className="space-y-2 text-ui text-error">
    <div>{actionMessage(error, fallback)}</div>
    {login ? <a href={`/login?reauth=evimed&next=${next}`} className={buttonClasses({ variant: "secondary", size: "sm" })}>重新登录</a>
      : expired ? refresh ? <Button variant="secondary" size="sm" onClick={refresh}>重新检索</Button>
        : <a href={`${search.pathname}${search.search}`} className={buttonClasses({ variant: "secondary", size: "sm" })}>重新检索</a>
      : onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>重试</Button>}
  </div>;
}

function ExportMenu({ category, actionRefs, label = "题录导出", compact = true }: {
  category: EvimedSearchCategory; actionRefs: string[]; label?: string; compact?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  const run = async (format: ExportFormat) => {
    if (active.current || !actionRefs.length || actionRefs.length > 20) return;
    const controller = new AbortController(); active.current = controller;
    setPending(true); setError(null);
    try {
      const answer = await exportEvimedSearchRecords(category, actionRefs, format, controller.signal);
      if (controller.signal.aborted) return;
      const bytes = Uint8Array.from(atob(answer.base64), (value) => value.charCodeAt(0));
      saveFile(new Blob([bytes], { type: answer.contentType }), answer.filename);
      toast.success("题录已开始下载。");
    } catch (caught) { if (!controller.signal.aborted && !isCancelled(caught)) setError(caught); }
    finally { if (!controller.signal.aborted) { active.current = null; setPending(false); } }
  };
  return <div className="min-w-0">
    <Menu label={label} items={EXPORT_FORMATS.map((format) => ({ label: format.label, disabled: pending, onSelect: () => { void run(format.value); } }))}>
      <Button variant={compact ? "text" : "secondary"} size="sm" loading={pending} disabled={!actionRefs.length || actionRefs.length > 20}>
        <Download size={16} aria-hidden="true" />{label}<ChevronDown size={16} aria-hidden="true" />
      </Button>
    </Menu>
    {error !== null && <ActionFailure error={error} fallback="题录导出失败，请重新选择格式重试。" />}
  </div>;
}

function CitationDialog({ category, item, onClose }: { category: EvimedSearchCategory; item: EvimedSearchActionItem; onClose(): void }) {
  const [format, setFormat] = useState<CitationFormat>(0);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [quotes, setQuotes] = useState<{ label: string; text: string }[]>([]);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setPending(true); setError(null); setQuotes([]); setCopied(false); setCopyError("");
    void readEvimedSearchCitations(category, [item.actionRef!], format, controller.signal).then((answer) => {
      if (!controller.signal.aborted) setQuotes(answer.quotes);
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(caught); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [category, item.actionRef, format, revision]);
  const content = quotes.map((quote) => quote.text).filter(Boolean).join("\n\n");
  const copy = async () => {
    try { await navigator.clipboard.writeText(content); setCopied(true); setCopyError(""); }
    catch { setCopyError("复制失败，请选中下方引用内容后手动复制。"); }
  };
  return <FormDialog title="引用文献" onClose={onClose}>
    <div className="space-y-4">
      <div className="text-ui font-semibold text-text">{item.title}</div>
      <Select label="引用格式" value={format} onChange={(event) => setFormat(Number(event.target.value) as CitationFormat)}>
        {CITATION_FORMATS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
      {pending ? <div role="status" className="py-4 text-ui text-text-2">正在读取引用格式</div>
        : error !== null ? <ActionFailure error={error} fallback="引用读取失败，请重试。" onRetry={() => setRevision((value) => value + 1)} />
          : content ? <Textarea label="引用内容" readOnly rows={6} value={content} className="text-ui" />
            : <Note action={<Button variant="text" size="sm" onClick={() => setRevision((value) => value + 1)}>重新读取</Button>}>暂无可用的引用格式。</Note>}
      {copyError && <div role="alert" className="text-ui text-error">{copyError}</div>}
      <div className="flex justify-end gap-2"><Button variant="text" onClick={onClose}>关闭</Button>
        <Button disabled={pending || !content} onClick={() => { void copy(); }}>{copied ? "已复制" : "复制引用"}</Button></div>
    </div>
  </FormDialog>;
}

function OfferDetails({ offer }: { offer: FullTextOffer }) {
  const message = offer.kind === "owned" ? "已获取该原文，再次下载不消耗次数或灵豆。"
    : offer.kind === "unlimited" ? "当前权益不限下载次数。"
      : offer.kind === "beans" ? `免费次数已用完，本次下载消耗 ${offer.amount} 灵豆。`
        : `本次下载消耗 1 次${offer.daily > 0 ? "每日免费" : "奖励"}次数。`;
  return <div className="space-y-2 rounded bg-surface-2 p-3 text-ui text-text">
    {!offer.unlimited && offer.kind !== "owned" && <dl className="flex flex-wrap gap-x-4 gap-y-1 text-text-2">
      <div className="flex gap-2"><dt>今日免费</dt><dd className="tabular-nums">{offer.daily} 次</dd></div>
      {offer.permanent > 0 && <div className="flex gap-2"><dt>奖励次数</dt><dd className="tabular-nums">{offer.permanent} 次</dd></div>}
    </dl>}
    <div className={offer.amount > 0 ? "font-semibold" : undefined}>{message}</div>
  </div>;
}

function FullTextDialog({ category, item, onClose }: { category: EvimedSearchCategory; item: EvimedSearchActionItem; onClose(): void }) {
  const [status, setStatus] = useState<FullTextStatus | null>(null);
  const [offer, setOffer] = useState<FullTextOffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const read = useCallback(async (quiet = false) => {
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    if (!quiet) { setLoading(true); setError(null); setNotice(""); }
    try {
      const next = await readEvimedFullTextStatus(category, item.actionRef!, controller.signal);
      if (controller.signal.aborted) return;
      setStatus(next);
      if (next.canDownload) {
        const currentOffer = await readEvimedFullTextOffer(category, item.actionRef!, controller.signal);
        if (!controller.signal.aborted) setOffer(currentOffer);
      } else setOffer(null);
      if (!controller.signal.aborted) setError(null);
    } catch (caught) { if (!controller.signal.aborted) setError(caught); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [category, item.actionRef]);
  useEffect(() => {
    alive.current = true;
    void read();
    return () => { alive.current = false; readController.current?.abort(); writeController.current?.abort(); };
  }, [read]);
  useEffect(() => {
    if (status?.status !== 1 || status.canDownload) return undefined;
    let attempts = 0;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      if (!writeController.current) { attempts += 1; await read(true); }
      if (cancelled) return;
      if (attempts >= 6) { setNotice("原文仍在获取中，可以稍后刷新状态。"); return; }
      timer = window.setTimeout(() => { void poll(); }, 10_000);
    };
    timer = window.setTimeout(() => { void poll(); }, 10_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [status?.status, status?.canDownload, read]);
  const request = async () => {
    if (writeController.current) return;
    const controller = new AbortController(); writeController.current = controller;
    setWorking(true); setError(null);
    try {
      const next = await requestEvimedFullText(category, item.actionRef!, controller.signal);
      if (!controller.signal.aborted) { setStatus(next); await read(); }
    } catch (caught) { if (!controller.signal.aborted) setError(caught); }
    finally { if (alive.current) { writeController.current = null; setWorking(false); } }
  };
  const download = async () => {
    if (!offer || writeController.current) return;
    const controller = new AbortController(); writeController.current = controller;
    setWorking(true); setError(null); setNotice("");
    try {
      const file = await downloadEvimedFullText(category, offer, controller.signal);
      if (!controller.signal.aborted) { saveFile(file.blob, file.filename); toast.success("原文已开始下载。"); onClose(); }
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught);
        // A failed authorization never replays a charge. A new offer needs another deliberate confirmation.
        setOffer(null);
      }
    } finally { if (alive.current) { writeController.current = null; setWorking(false); } }
  };
  return <FormDialog title="原文下载" onClose={onClose} busy={working}>
    <div className="space-y-4">
      <div className="text-ui font-semibold text-text">{item.title}</div>
      {loading ? <div role="status" className="py-4 text-ui text-text-2">正在检查原文与下载权益</div>
        : error !== null ? <ActionFailure error={error} fallback="暂时无法获取原文，请重试。" onRetry={() => { void read(); }} />
          : offer ? <OfferDetails offer={offer} />
            : status?.status === 1 ? <div role="status" className="text-ui text-text-2">原文正在获取中。</div>
              : status?.canRequest ? <Note action={<Button variant="secondary" onClick={() => { void request(); }}>获取原文</Button>}>可申请获取这篇原文。</Note>
                : <Note action={<Button variant="text" size="sm" onClick={() => { void read(); }}>刷新状态</Button>}>暂时没有可下载的原文。</Note>}
      {notice && <div role="status" className="text-ui text-text-2">{notice}</div>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="text" disabled={working} onClick={onClose}>取消</Button>
        {!loading && status?.status === 1 && !offer && <Button variant="secondary" disabled={working} onClick={() => { void read(); }}>刷新状态</Button>}
        {offer && <Button loading={working} disabled={loading || error !== null} onClick={() => { void download(); }}>
          {offer.amount > 0 ? `确认下载 · ${offer.amount} 灵豆` : "确认下载"}
        </Button>}
      </div>
    </div>
  </FormDialog>;
}

function ItemActions({ category, item, compact = true, onCollectedChange }: {
  category: EvimedSearchCategory; item: EvimedSearchActionItem; compact?: boolean; onCollectedChange?(collected: boolean): void;
}) {
  const [collected, setCollected] = useState(Boolean(item.collected));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<"citation" | "download" | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => { setCollected(Boolean(item.collected)); }, [item.collected]);
  useEffect(() => () => { active.current?.abort(); }, []);
  const collect = async () => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setWorking(true); setError(null);
    try {
      const answer = await setEvimedSearchCollection(category, item.actionRef!, !collected, controller.signal);
      if (!controller.signal.aborted) { setCollected(answer.collected); onCollectedChange?.(answer.collected); }
    } catch (caught) { if (!controller.signal.aborted) setError(caught); }
    finally { if (!controller.signal.aborted) { active.current = null; setWorking(false); } }
  };
  return <div className="space-y-2">
    <div role="group" aria-label={`${item.title}的操作`} className="flex flex-wrap items-center gap-1">
      <Button variant={compact ? "text" : "secondary"} size="sm" aria-pressed={collected} loading={working} onClick={() => { void collect(); }}>
        <Star size={16} aria-hidden="true" fill={collected ? "currentColor" : "none"} />{collected ? "已收藏" : "收藏"}
      </Button>
      {category === "literature" && <>
        <Button variant={compact ? "text" : "secondary"} size="sm" onClick={() => setDialog("citation")}><Quote size={16} aria-hidden="true" />引用</Button>
        <ExportMenu category={category} actionRefs={[item.actionRef!]} compact={compact} />
      </>}
      <Button variant={compact ? "text" : "secondary"} size="sm" onClick={() => setDialog("download")}><Download size={16} aria-hidden="true" />原文下载</Button>
    </div>
    {error !== null && <ActionFailure error={error} fallback="收藏操作失败，请重试。" onRetry={() => { void collect(); }} />}
    {dialog === "citation" && createPortal(<CitationDialog category={category} item={item} onClose={() => setDialog(null)} />, document.body)}
    {dialog === "download" && createPortal(<FullTextDialog category={category} item={item} onClose={() => setDialog(null)} />, document.body)}
  </div>;
}

export function EvimedSearchActions(props: {
  category: EvimedSearchCategory; item: EvimedSearchActionItem; compact?: boolean; onCollectedChange?(collected: boolean): void; onRefresh?(): void;
}) {
  const sessionValid = useActionSessionValid(`${props.category}:${props.item.actionRef}`);
  if (!sessionValid || props.category === "trials" || !props.item.actionRef) return null;
  return <SearchActionRefresh.Provider value={props.onRefresh}><ItemActions key={`${props.category}:${props.item.actionRef}`} {...props} /></SearchActionRefresh.Provider>;
}

export function EvimedSearchBatchActions({ category, items, onClear, onRefresh }: {
  category: EvimedSearchCategory; items: readonly EvimedSearchActionItem[]; onClear?(): void; onRefresh?(): void;
}) {
  const actionRefs = [...new Set(items.map((item) => item.actionRef).filter((value): value is string => Boolean(value)))];
  const sessionValid = useActionSessionValid(`${category}:${JSON.stringify(actionRefs)}`);
  if (!sessionValid || category !== "literature" || !actionRefs.length) return null;
  return <SearchActionRefresh.Provider value={onRefresh}><div role="group" aria-label="已选文献操作" className="flex flex-wrap items-center gap-2">
    <ExportMenu key={JSON.stringify(actionRefs)} category={category} actionRefs={actionRefs} label={`导出已选 ${actionRefs.length} 篇`} compact={false} />
    {onClear && <Button variant="text" size="sm" onClick={onClear}>清空选择</Button>}
  </div></SearchActionRefresh.Provider>;
}
