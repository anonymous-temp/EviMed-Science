import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { ArrowLeft, FileQuestion, Loader2 } from "lucide-react";
import { hasWebApi, listWebAgentRuns, type WebAgentRun } from "@/lib/apiClient";
import { extOf, extToKind, previewKindForName } from "@/lib/artifacts";
import { readArtifact } from "@/lib/artifactFile";
import { isClaimMatrixPath, safeWorkspacePath } from "@/lib/claimCitations";
import { runTitle } from "@/lib/runPresentation";
import { artifactDisplayName } from "@/lib/artifactNames";
import { parseFailureMessage } from "@/lib/errorText";
import { PageTitle } from "@/components/layout/PageTitle";
import { EmptyState } from "@/components/cards/EmptyState";
import { ReportReader } from "@/components/report/ReportReader";
import { EvidenceMatrixTable } from "@/components/report/EvidenceMatrixTable";
import { useClaimMatrix } from "@/components/report/useClaimMatrix";
import { ReportRunContext } from "@/components/report/ReportRunContext";

const FilePreviewInspector = lazy(() => import("@/components/inspector/FilePreviewInspector").then((m) => ({ default: m.FilePreviewInspector })));

const CLAIM_ID = /^CLM-\d{3,6}$/;

/**
 * One file of one run, on its own page: `/app/runs/:runId/files/*`.
 *
 * The kernel frame's 交付物 and 依据 tabs post `open-artifact` and land here
 * (contract C9), with the claim to open as the fragment (`#CLM-003`); the runs
 * page links here as 「阅读」; a quotation's 「在保存的原文中定位」 opens the
 * preserved source here with `?quote=`, which is highlighted where it is.
 *
 * A report gets the full reader; a clinical evidence matrix, its table; any
 * other file, the same preview the right pane uses. The run is looked up for
 * its title, its model and its safety findings; a run this project does not
 * have still shows the file, with 「未注明」 where the run would have spoken.
 */
export function RunFilePage() {
  const params = useParams();
  const runId = params.runId ?? "";
  const path = useMemo(() => decodedPath(params["*"] ?? ""), [params]);
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const hashClaim = location.hash.replace(/^#/, "");
  const focusClaim = CLAIM_ID.test(hashClaim) ? hashClaim : CLAIM_ID.test(searchParams.get("claim") ?? "") ? searchParams.get("claim") : null;
  const quote = searchParams.get("quote");
  const filename = path ? path.slice(path.lastIndexOf("/") + 1) : "";
  const kind = filename ? previewKindForName(filename) : null;

  const [run, setRun] = useState<WebAgentRun | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRun(null);
    if (!hasWebApi || !runId) return;
    listWebAgentRuns()
      .then((runs) => { if (!cancelled) setRun(runs.find((candidate) => candidate.id === runId || candidate.sessionId === runId) ?? null); })
      .catch(() => { /* the file still reads without its run */ });
    return () => { cancelled = true; };
  }, [runId]);

  const readsText = kind === "markdown" || (path != null && isClaimMatrixPath(path));
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    if (!path || !readsText) {
      setLoading(false);
      return;
    }
    setLoading(true);
    readArtifact(path, "workspace")
      .then((file) => {
        if (cancelled) return;
        if (file && file.encoding === "utf8") setText(file.data);
        else setError("这个文件读不出来：它不在这个项目的工作区里，或者不是文本文件。");
      })
      .catch((caught) => { if (!cancelled) setError(parseFailureMessage(caught, "该文件")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, readsText]);

  const backTo = run ? `/app/runs?run=${encodeURIComponent(run.id)}` : "/app/runs";

  return (
    <ReportRunContext.Provider value={runId ? { runId: run?.id ?? runId, run } : null}>
      <div className="flex h-full flex-col bg-bg">
        <PageTitle page={path ? artifactDisplayName(path) : "文件"} />
        <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-6 py-3" data-print-hide="">
          <Link to={backTo} className="inline-flex items-center gap-1 text-ui text-link hover:underline">
            <ArrowLeft size={14} aria-hidden="true" />运行记录
          </Link>
          <span className="text-muted" aria-hidden="true">/</span>
          <h1 className="min-w-0 truncate text-ui font-semibold text-text">
            {run ? `${runTitle(run)} · ` : ""}{path ? artifactDisplayName(path) : "文件"}
          </h1>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!path && (
            <EmptyState icon={FileQuestion} title="这个地址没有指向文件" description="从运行记录里打开一个交付物，或检查链接是否完整。" />
          )}
          {path && readsText && loading && (
            <p role="status" className="flex items-center gap-2 p-6 text-ui text-muted">
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />正在读取 {filename}…
            </p>
          )}
          {path && readsText && !loading && error && (
            <div role="alert" className="mx-auto mt-8 max-w-content rounded-card border border-border bg-surface p-5 text-ui text-text">{error}</div>
          )}
          {path && readsText && !loading && text !== null && (
            isClaimMatrixPath(path)
              ? <MatrixPage path={path} runId={run?.id ?? runId} />
              : <ReportReader path={path} root="workspace" text={text} run={run} runId={run?.id ?? runId} layout="page" focusClaim={focusClaim} highlight={quote} />
          )}
          {path && !readsText && (
            <Suspense fallback={<p className="p-6 text-ui text-muted">正在打开预览…</p>}>
              <div className="h-full">
                <FilePreviewInspector
                  data={{ variant: "file", path, filename, artifact: extToKind(extOf(filename)), root: "workspace" }}
                  onClose={() => window.history.back()}
                />
              </div>
            </Suspense>
          )}
        </div>
      </div>
    </ReportRunContext.Provider>
  );
}

function MatrixPage({ path, runId }: { path: string; runId: string }) {
  const { document, verified } = useClaimMatrix(path, "workspace");
  return (
    <div className="mx-auto w-full max-w-content-full px-6 py-6">
      {document
        ? <EvidenceMatrixTable claims={document.claims} verified={verified} runId={runId} />
        : <p className="text-ui text-muted">这个证据矩阵里没有可读的主张。</p>}
    </div>
  );
}

/** The splat, one segment decoded at a time, then held to a workspace path. */
function decodedPath(splat: string): string | null {
  try {
    return safeWorkspacePath(splat.split("/").map((segment) => decodeURIComponent(segment)).join("/")) ?? null;
  } catch {
    return null;
  }
}
