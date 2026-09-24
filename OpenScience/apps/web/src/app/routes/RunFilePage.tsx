import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { ArrowLeft, FileQuestion, Loader2 } from "lucide-react";
import { hasWebApi, listWebAgentRuns, type WebAgentRun } from "@/lib/apiClient";
import { extOf, extToKind, previewKindForName } from "@/lib/artifacts";
import { readArtifact } from "@/lib/artifactFile";
import { isClaimMatrixPath, safeWorkspacePath } from "@/lib/claimCitations";
import { runTitle } from "@/lib/runPresentation";
import { chatPath, openRunProject } from "@/lib/runLocation";
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
 * The kernel frame links here for a delivered file (contract C9), with the
 * claim to open as the fragment (`#CLM-003`); a quotation's
 * 「在保存的原文中定位」 opens the preserved source here with `?quote=`,
 * which is highlighted where it is.
 *
 * A report gets the full reader; a clinical evidence matrix, its table; any
 * other file, the same preview the right pane uses. The run is looked up for
 * its title, its model and its safety findings. A run this project does not
 * have is looked for in the account's other projects — a Feishu card or a
 * notice can name any of them, and the file is in its run's workspace — and
 * the shell moves there; a run no project has still shows the file, with
 * 「未注明」 where the run would have spoken.
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
  // While another project is asked for the run: this project's answer for the
  // file — most likely "not in this workspace" — is not shown meanwhile.
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setLocating(false);
    if (!hasWebApi || !runId) return;
    listWebAgentRuns()
      .then(async (runs) => {
        if (cancelled) return;
        const found = runs.find((candidate) => candidate.id === runId || candidate.sessionId === runId) ?? null;
        setRun(found);
        if (found) return;
        setLocating(true);
        // Moved: this page unmounts and reads again in the run's project.
        const moved = await openRunProject(runId).catch(() => false);
        if (!cancelled && !moved) setLocating(false);
      })
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
        else setError("无法读取此文件");
      })
      .catch((caught) => { if (!cancelled) setError(parseFailureMessage(caught, "该文件")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, readsText]);

  // Back into the conversation this file was written in. It used to be the run
  // ledger's row about it; that page was deleted on 2026-09-20, and a run with
  // no conversation to return to lands on the surface itself rather than on a
  // page that no longer exists.
  const backTo = chatPath(run?.sessionId);

  return (
    <ReportRunContext.Provider value={runId ? { runId: run?.id ?? runId, run } : null}>
      <div className="flex h-full flex-col bg-bg">
        <PageTitle page={path ? artifactDisplayName(path) : "文件"} />
        <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2 sm:px-6" data-print-hide="">
          {/* Never squeezed by a long title (at 390 px it stacked a character
            * a line), and a 30 px target: on a phone it is the way back. */}
          <Link to={backTo} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap py-1 text-ui text-link hover:underline">
            <ArrowLeft size={16} aria-hidden="true" />返回对话
          </Link>
          <span className="text-muted" aria-hidden="true">/</span>
          <h1 className="min-w-0 truncate text-ui font-semibold text-text">
            {run ? `${runTitle(run)} · ` : ""}{path ? artifactDisplayName(path) : "文件"}
          </h1>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {locating && (
            <p role="status" className="flex items-center gap-2 p-6 text-ui text-muted">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />正在打开…
            </p>
          )}
          {!locating && !path && (
            <EmptyState icon={FileQuestion} title="这个地址没有指向文件" />
          )}
          {!locating && path && readsText && loading && (
            <p role="status" className="flex items-center gap-2 p-6 text-ui text-muted">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />正在读取 {filename}…
            </p>
          )}
          {!locating && path && readsText && !loading && error && (
            <div role="alert" className="mx-auto mt-8 max-w-content rounded-card border border-border bg-surface p-5 text-ui text-text max-sm:mx-4">{error}</div>
          )}
          {!locating && path && readsText && !loading && text !== null && (
            isClaimMatrixPath(path)
              ? <MatrixPage path={path} runId={run?.id ?? runId} />
              : <ReportReader path={path} root="workspace" text={text} run={run} runId={run?.id ?? runId} layout="page" focusClaim={focusClaim} highlight={quote} />
          )}
          {!locating && path && !readsText && (
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
    // Edge to edge on a phone: the table scrolls sideways in its own box.
    <div className="mx-auto w-full max-w-content-full px-6 py-6 max-sm:px-0 max-sm:py-3">
      {document
        ? <EvidenceMatrixTable claims={document.claims} verified={verified} runId={runId} className="max-sm:rounded-none max-sm:border-x-0" />
        : <p className="text-ui text-muted max-sm:px-4">这个证据矩阵里没有可读的结论。</p>}
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
