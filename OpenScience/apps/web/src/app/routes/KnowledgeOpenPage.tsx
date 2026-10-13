import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { FileQuestion } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { buttonClasses } from "@/components/ui/Button";
import { WebApiError } from "@/lib/apiClient";
import { getWebProjectId } from "@/lib/apiClient";
import { SHARED_SCOPE, readKnowledgeAddress, readerPath } from "@/lib/knowledgeNav";
import { productErrorMessage } from "@/lib/productClient";
import { getKnowledgePageAt } from "@/lib/sourceClient";

/**
 * A compiled file named by its place (`/app/files/open?project=&tree=&path=`): where a mark of the memory map and a link from
 * outside land. It reads the file and goes to the document's own page in the reader, replacing itself, so the way back is
 * what the person came from. A file that is not there (a recompile moved it) is one sentence and the way to the pages.
 */
export function KnowledgeOpenPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const address = useMemo(() => readKnowledgeAddress(params), [params]);
  const [state, setState] = useState<{ phase: "loading" } | { phase: "missing" } | { phase: "error"; message: string }>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!address) { setState({ phase: "missing" }); return undefined; }
    let active = true;
    setState({ phase: "loading" });
    void (async () => {
      try {
        const page = await getKnowledgePageAt(address.projectId, address.tree, address.path);
        if (!active) return;
        const scope = address.projectId === getWebProjectId() ? null : address.projectId;
        navigate(readerPath(page.sourceId, { scope: scope === SHARED_SCOPE ? null : scope, kind: "wiki", q: "" }), { replace: true });
      } catch (failure) {
        if (!active) return;
        if (failure instanceof WebApiError && (failure.status === 404 || failure.status === 400)) setState({ phase: "missing" });
        else setState({ phase: "error", message: `无法打开这一页：${productErrorMessage(failure)}` });
      }
    })();
    return () => { active = false; };
  }, [address, attempt, navigate]);
  const pages = address && address.projectId !== getWebProjectId() ? `/app/files?scope=${encodeURIComponent(address.projectId)}&kind=wiki` : "/app/files?kind=wiki";
  return (
    <PageShell title="知识页">
      {state.phase === "loading" && <p role="status" className="text-ui text-text-3">正在打开</p>}
      {state.phase === "error" && <LoadError message={state.message} onRetry={() => setAttempt((value) => value + 1)} />}
      {state.phase === "missing" && (
        <EmptyState icon={FileQuestion} title="这一页现在没有找到，可能已被重新整理。"
          action={<Link to={pages} className={buttonClasses({ variant: "secondary" })}>回到知识页</Link>} />
      )}
    </PageShell>
  );
}
