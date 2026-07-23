import { useEffect, useRef, useState } from "react";
import { Code2, Download, Eye, ExternalLink, FileSearch, History, Loader2, X } from "lucide-react";
import type { FilePreviewInspector as FilePreviewInspectorT, FileRoot } from "@ai4s/shared";
import { previewKindForName, type PreviewKind } from "@/lib/artifacts";
import {
  base64ToBytes,
  downloadArtifact,
  downloadInlineArtifact,
  openArtifactExternally,
  previewUrl,
  probeLargeFile,
  readArtifact,
  type LargeFilePointer,
} from "@/lib/artifactFile";
import { hasWebApi, isTauri } from "@/lib/apiClient";
import { parseTableFile } from "@/lib/csv";
import { CodeViewer } from "@/components/code-viewer/CodeViewer";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { ProvenancePanel } from "./ProvenancePanel";
import { TablePreview } from "./TablePreview";
import { TableChart } from "./TableChart";
import { canChart } from "@/lib/tableChart";
import { DocxView, PptxView, XlsxView } from "./OfficePreview";
import { MoleculeView } from "./MoleculeView";
import { MeshView } from "./MeshView";
import { GenomeView } from "./GenomeView";
import { FitsView } from "./FitsView";
import { DosView } from "./DosView";
import { BandView } from "./BandView";
import { QCodeView } from "./QCodeView";
import { AnomalyMapView } from "./AnomalyMapView";
import { PhaseView } from "./PhaseView";
import { useScrollMemory } from "@/lib/scrollMemory";
import { cn } from "@/lib/cn";
import { PaneTitlebarInset } from "./RightPane";
import { toast } from "@/lib/toast";

const HTML_PREVIEW_SANDBOX = "";

/**
 * Right-pane preview for any workspace file. Strategy (no format conversion):
 * pdf / image / html — served from the local file server (http://127.0.0.1)
 * and rendered by the webview's NATIVE viewers via <iframe>/<img>;
 * csv/tsv — parsed to a table; docx/xlsx/pptx — local JS renderers fed raw
 * bytes; everything else — code/text.
 */
export function FilePreviewInspector({
  data,
  onClose,
  controls,
}: {
  data: FilePreviewInspectorT;
  onClose: () => void;
  /** Pane-level header buttons (e.g. maximize), rendered before Close. */
  controls?: React.ReactNode;
}) {
  const kind = previewKindForName(data.filename);
  const needsUrl = kind === "pdf" || kind === "image" || kind === "html" || kind === "video";
  const needsText =
    kind === "table" || kind === "text" || kind === "html" || kind === "markdown" ||
    kind === "molecule" || kind === "genome" || kind === "qcode" || kind === "anomaly" ||
    kind === "phase";
  const needsBytes =
    kind === "docx" || kind === "xlsx" || kind === "pptx" || kind === "mesh" ||
    kind === "fits" || kind === "dos" || kind === "bands";

  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(data.content ?? null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "code">(kind === "text" ? "code" : "preview");
  const [showHistory, setShowHistory] = useState(false);
  const hostedWeb = hasWebApi && !isTauri;
  const fileActionLabel = hostedWeb ? "下载文件" : "用本地应用打开";
  const fileActionTitle = hostedWeb ? "下载此文件" : "使用默认应用打开";
  const FileActionIcon = hostedWeb ? Download : ExternalLink;

  const runFileAction = async () => {
    try {
      if (hostedWeb) {
        if (data.content !== undefined) downloadInlineArtifact(data.content, data.filename);
        else await downloadArtifact(data.path, data.root, data.filename);
      } else {
        await openArtifactExternally(data.path, data.root);
      }
    } catch (e) {
      toast.error(`无法处理 ${data.filename}：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    // Reset per-file state up front: the same inspector instance is reused when
    // the user opens a different file, and the async loads below only fill in
    // what the NEW file needs — without this, the previous file's text/url/bytes
    // would linger and bleed into the new preview.
    setText(data.content ?? null);
    setUrl(null);
    setBytes(null);
    (async () => {
      try {
        if (needsUrl) {
          const u = await previewUrl(data.path, data.root);
          if (cancelled) return;
          setUrl(u);
          // Browser dev has no local server; html can still preview inline content.
          if (!u && kind !== "html") {
            setError("当前文件暂不支持在线预览。");
          }
        }
        if (needsText && data.content === undefined) {
          const f = await readArtifact(data.path, data.root);
          if (cancelled) return;
          if (f && f.encoding === "utf8") setText(f.data);
          // The file was read but isn't text — say so instead of falling
          // through to the "desktop app" note while inside the desktop app.
          else if (f) setError("这是二进制文件，暂不支持预览，请下载后查看。");
          else if (kind !== "html" && kind !== "markdown")
            setError("当前文件暂不支持在线预览。");
        }
        if (needsBytes) {
          const f = await readArtifact(data.path, data.root);
          if (cancelled) return;
          if (f && f.encoding === "base64") setBytes(base64ToBytes(f.data));
          else setError("当前文件暂不支持在线预览。");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.path, data.content, data.root, kind, needsUrl, needsText, needsBytes]);

  const canToggle =
    kind === "html" || kind === "markdown" || kind === "molecule" || kind === "genome";

  // Where the user was in this file, restored when they come back to it —
  // history browsing keeps its own offset so the two don't clobber each other.
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollMemory(
    scrollRef,
    showHistory ? `history:${data.path}` : `file:${data.path}`,
    showHistory || !loading,
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <PaneTitlebarInset />
        <span className="truncate text-sm font-medium text-text">{data.filename}</span>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">{data.artifact}</span>
        {canToggle && (
          <div className="ml-2 flex items-center gap-1 rounded-input bg-surface-2 p-0.5">
            <ToggleBtn active={tab === "preview"} onClick={() => setTab("preview")}>
              <Eye size={13} /> 预览
            </ToggleBtn>
            <ToggleBtn active={tab === "code"} onClick={() => setTab("code")}>
              <Code2 size={13} /> 源文件
            </ToggleBtn>
          </div>
        )}
        <div className="flex-1" />
        <button
          className={cn(showHistory ? "text-accent" : "text-text hover:opacity-60")}
          aria-label="版本记录"
          title="查看文件的历史版本、代码与关联对话"
          aria-pressed={showHistory}
          onClick={() => setShowHistory((v) => !v)}
        >
          <History size={14} strokeWidth={1.5} />
        </button>
        <button
          className="text-text hover:opacity-60"
          aria-label={fileActionLabel}
          title={fileActionTitle}
          onClick={() => void runFileAction()}
        >
          <FileActionIcon size={14} strokeWidth={1.5} />
        </button>
        {controls}
        <button className="text-text hover:opacity-60" aria-label="关闭预览" onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto bg-surface-2">
        {showHistory && <ProvenancePanel path={data.path} language={data.language} />}
        {!showHistory && loading && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> 正在加载 {data.filename}…
          </div>
        )}
        {!showHistory && !loading && error && (
          <PreviewError
            error={error}
            filename={data.filename}
            path={data.path}
            root={data.root}
            onOpenExternally={() => void runFileAction()}
            externalActionLabel={fileActionLabel}
            externalActionKind={hostedWeb ? "download" : "open"}
          />
        )}
        {!showHistory && !loading && !error && (
          <Body
            kind={kind}
            url={url}
            text={text}
            bytes={bytes}
            showCode={tab === "code"}
            filename={data.filename}
            path={data.path}
            language={data.language}
          />
        )}
      </div>
    </div>
  );
}

function Body({
  kind,
  url,
  text,
  bytes,
  showCode,
  filename,
  path,
  language,
}: {
  kind: PreviewKind;
  url: string | null;
  text: string | null;
  bytes: ArrayBuffer | null;
  showCode: boolean;
  filename: string;
  path: string;
  language?: string;
}) {
  if (kind === "docx" || kind === "xlsx" || kind === "pptx") {
    // Office views scroll internally (the outer pane never does), so they
    // carry their own scroll memory, keyed apart from the outer container's.
    if (!bytes) return <Note text="当前文件暂不支持在线预览。" />;
    if (kind === "docx") return <DocxView bytes={bytes} scrollKey={`office:${path}`} />;
    if (kind === "xlsx") return <XlsxView bytes={bytes} scrollKey={`office:${path}`} />;
    return <PptxView bytes={bytes} scrollKey={`office:${path}`} />;
  }
  if (kind === "mesh") {
    return bytes !== null ? (
      <MeshView filename={filename} bytes={bytes} />
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "fits") {
    return bytes !== null ? (
      <FitsView filename={filename} bytes={bytes} />
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "dos") {
    return bytes !== null ? (
      <DosView filename={filename} bytes={bytes} />
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "bands") {
    return bytes !== null ? (
      <BandView filename={filename} bytes={bytes} />
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "qcode") {
    return text !== null ? (
      <QCodeView filename={filename} text={text} />
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "anomaly") {
    return text !== null ? (
      <AnomalyMapView filename={filename} text={text} />
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "phase") {
    return text !== null ? (
      <PhaseView filename={filename} text={text} />
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "molecule") {
    if (showCode) {
      return text !== null ? (
        <div className="p-3">
          <CodeViewer code={text} language={language} />
        </div>
      ) : (
        <Note text="当前文件暂不支持在线查看源文件。" />
      );
    }
    return text !== null ? (
      <MoleculeView filename={filename} text={text} />
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "genome") {
    if (showCode) {
      return text !== null ? (
        <div className="p-3">
          <CodeViewer code={text} language={language} />
        </div>
      ) : (
        <Note text="当前文件暂不支持在线查看源文件。" />
      );
    }
    return text !== null ? (
      <GenomeView filename={filename} text={text} />
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "markdown") {
    if (showCode) {
      return text !== null ? (
        <div className="p-3">
          <CodeViewer code={text} language="markdown" />
        </div>
      ) : (
        <Note text="当前文件暂不支持在线查看源文件。" />
      );
    }
    // A document reads as a page: white paper, black text, whatever the app
    // theme — the same document-neutral canvas the Office previews use.
    return text !== null ? (
      <div className="min-h-full px-6 py-8">
        <div className="mx-auto max-w-content rounded-sm bg-white px-12 py-11 shadow-[0_1px_4px_rgba(0,0,0,.25)] max-sm:px-6 max-sm:py-7">
          <MarkdownViewer variant="document">{text}</MarkdownViewer>
        </div>
      </div>
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "html" && showCode) {
    return text !== null ? (
      <div className="p-3">
        <CodeViewer code={text} language="html" />
      </div>
    ) : (
      <Note text="当前文件暂不支持在线查看源文件。" />
    );
  }
  if (kind === "html") {
    // Served URL preferred (relative assets resolve); srcdoc as browser fallback.
    // Do not grant allow-scripts to uploaded/generated HTML in hosted Web mode.
    if (url) {
      return (
        <iframe
          title="HTML 预览"
          src={url}
          sandbox={HTML_PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          className="h-full min-h-[480px] w-full bg-white"
        />
      );
    }
    if (text !== null) {
      return (
        <iframe
          title="HTML 预览"
          srcDoc={text}
          sandbox={HTML_PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          className="h-full min-h-[480px] w-full bg-white"
        />
      );
    }
    return <Note text="当前文件暂不支持在线预览。" />;
  }
  if (kind === "pdf") {
    // The webview's native PDF viewer (WKWebView / WebView2) renders the served URL.
    return url ? (
      <iframe title="PDF 预览" src={url} className="h-full min-h-[480px] w-full" />
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "image") {
    return url ? (
      <div className="flex justify-center p-4">
        <img src={url} alt={filename} className="max-w-full rounded-sm bg-white shadow-card" />
      </div>
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "video") {
    // The preview endpoint supports Range requests, so native playback can
    // stream and seek without loading the entire research artifact in memory.
    return url ? (
      <div className="flex justify-center p-4">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- previews arbitrary user research files; caption tracks are not available for them. */}
        <video
          src={url}
          controls
          className="max-h-[80vh] max-w-full rounded-sm bg-black shadow-card"
        />
      </div>
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  if (kind === "table") {
    return text !== null ? (
      <TableView table={parseTableFile(filename, text)} />
    ) : (
      <Note text="当前文件暂不支持在线预览。" />
    );
  }
  return text !== null ? (
    <div className="p-3">
      <CodeViewer code={text} language={language} />
    </div>
  ) : (
    <Note text="当前文件暂不支持在线预览。" />
  );
}

function Note({ text }: { text: string }) {
  return <div className="p-4 text-sm text-muted">{text}</div>;
}

/** Tabular file preview with a Table ↔ Chart toggle. The Chart tab appears only
 *  when the data has a numeric column to plot (P1-5 native chart surface). */
function TableView({ table }: { table: import("@/lib/csv").ParsedTable }) {
  const [view, setView] = useState<"table" | "chart">("table");
  const chartable = canChart(table);
  return (
    <div className="flex h-full flex-col">
      {chartable && (
        <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
          <ToggleBtn active={view === "table"} onClick={() => setView("table")}>
            表格
          </ToggleBtn>
          <ToggleBtn active={view === "chart"} onClick={() => setView("chart")}>
            图表
          </ToggleBtn>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {view === "chart" && chartable ? (
          <TableChart table={table} />
        ) : (
          <TablePreview table={table} />
        )}
      </div>
    </div>
  );
}

/** Preview errors. A "too large" file gets a helpful card — the preview is
 *  capped so a huge file can't lock the app. The user can open it in the OS
 *  app, or **inspect it without loading**: the large-file probe returns a
 *  compact memory pointer (schema / shape / sample / key numbers) by streaming
 *  and sampling, so even a 90 GB file is introspected, never loaded. */
export function PreviewError({
  error,
  filename,
  path,
  root,
  onOpenExternally,
  externalActionLabel = "用本地应用打开",
  externalActionKind = "open",
}: {
  error: string;
  filename: string;
  path?: string;
  root?: FileRoot;
  onOpenExternally: () => void;
  externalActionLabel?: string;
  externalActionKind?: "open" | "download";
}) {
  const tooLarge = /too large/i.test(error);
  const [pointer, setPointer] = useState<LargeFilePointer | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const inspect = async () => {
    if (!path) return;
    setProbing(true);
    setProbeError(null);
    try {
      setPointer(await probeLargeFile(path, root));
    } catch (e) {
      setProbeError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  if (!tooLarge) return <div className="p-4 text-sm text-muted">{error}</div>;
  const ExternalActionIcon = externalActionKind === "download" ? Download : ExternalLink;
  const externalActionDescription =
    externalActionKind === "download" ? "下载后在本地查看" : "使用系统应用打开";
  return (
    <div className="p-4">
      <div className="rounded-card border border-border bg-surface p-4 text-sm text-muted">
        <div className="mb-1 font-medium text-text">{filename} 文件过大，无法直接预览</div>
        <p className="mb-3">
          为避免大文件影响页面响应，在线预览设有大小限制。你可以在不加载完整文件的情况下读取结构、规模、样本和关键指标，
          也可以{externalActionDescription}。
        </p>
        <div className="flex flex-wrap gap-2">
          {path && (
            <button
              className="inline-flex items-center gap-1.5 rounded-input border border-border bg-surface-2 px-2.5 py-1.5 text-ui text-text hover:bg-surface disabled:opacity-60"
              onClick={() => void inspect()}
              disabled={probing}
            >
              {probing ? <Loader2 size={13} className="animate-spin" /> : <FileSearch size={13} />}
              轻量检查文件
            </button>
          )}
          <button
            className="inline-flex items-center gap-1.5 rounded-input border border-border bg-surface-2 px-2.5 py-1.5 text-ui text-text hover:bg-surface"
            onClick={onOpenExternally}
          >
            <ExternalActionIcon size={13} /> {externalActionLabel}
          </button>
        </div>
        {probeError && <div className="mt-3 text-ui text-error">{probeError}</div>}
        {pointer && <LargeFilePointerPanel p={pointer} />}
      </div>
    </div>
  );
}

/** Render the probe's memory pointer as a compact, readable fact sheet. */
function LargeFilePointerPanel({ p }: { p: LargeFilePointer }) {
  if (p.error) return <div className="mt-3 text-ui text-error">{p.error}</div>;
  const fmt = (n: number) => n.toLocaleString("en-US");
  const rows: [string, string][] = [];
  if (p.format) rows.push(["格式", p.format]);
  if (p.size) rows.push(["大小", p.size + (p.gzipped ? "（已压缩）" : "")]);
  if (p.approx_rows !== undefined) rows.push(["估算行数", fmt(p.approx_rows)]);
  if (p.num_rows !== undefined) rows.push(["行数", fmt(p.num_rows)]);
  if (p.approx_reads !== undefined) rows.push(["估算读段数", fmt(p.approx_reads)]);
  if (p.approx_sequences !== undefined) rows.push(["估算序列数", fmt(p.approx_sequences)]);
  if (p.approx_variants !== undefined) rows.push(["估算变异数", fmt(p.approx_variants)]);
  if (p.n_columns !== undefined) rows.push(["列数", fmt(p.n_columns)]);
  if (p.read_length) rows.push(["读段长度", `${p.read_length.min}–${p.read_length.max}（均值 ${p.read_length.mean}）`]);
  if (p.samples?.length) rows.push(["样本", p.samples.join(", ")]);

  return (
    <div className="mt-3 rounded-input border border-border bg-surface-2 p-3">
      {p.hint && <div className="mb-2 text-ui text-text">{p.hint}</div>}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-ui-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-all font-mono text-text">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {p.columns && p.columns.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-ui-sm text-muted">数据结构</div>
          <div className="flex flex-wrap gap-1">
            {p.columns.slice(0, 40).map((c) => (
              <span key={c.name} className="rounded bg-surface px-1.5 py-0.5 font-mono text-caption text-text">
                {c.name} <span className="text-muted">{c.dtype}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {p.datasets && p.datasets.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-ui-sm text-muted">数据集</div>
          <div className="flex flex-col gap-0.5 font-mono text-caption text-text">
            {p.datasets.slice(0, 20).map((d) => (
              <span key={d.path}>{d.path} <span className="text-muted">[{d.shape.join("×")}] {d.dtype}</span></span>
            ))}
          </div>
        </div>
      )}
      {p.sample_ids && p.sample_ids.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-ui-sm text-muted">样本 ID</div>
          <div className="font-mono text-caption text-text">{p.sample_ids.slice(0, 5).join(", ")}</div>
        </div>
      )}
      {p.note && <div className="mt-2 text-caption italic text-muted">{p.note}</div>}
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded px-2 py-1 text-xs",
        active ? "bg-surface text-text shadow-card" : "text-muted hover:text-text",
      )}
    >
      {children}
    </button>
  );
}
