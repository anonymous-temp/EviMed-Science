import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { fetchWebMe, getWebProjectId } from "@/lib/apiClient";
import { WebReadinessCard } from "@/components/settings/WebReadinessCard";
import { WebResourcesCard } from "@/components/settings/WebResourcesCard";
import { WebAuditCard } from "@/components/settings/WebAuditCard";
import { WebErrorsCard } from "@/components/settings/WebErrorsCard";
import { WebSecurityCard } from "@/components/settings/WebSecurityCard";
import { WebTasksCard } from "@/components/settings/WebTasksCard";

/**
 * The deployment's console, separated from the product's settings.
 *
 * Until 2026-09-15 these six cards sat on the settings page, so the first
 * thing a clinical researcher met under 「设置」 was a twenty-four-item
 * readiness board, a security-event ledger and a control that stops containers
 * (§C6 of the walk). None of it is theirs to read and none of it answers a
 * question they have.
 *
 * Presentation only. `config.operatorUsers` decides who is offered the page;
 * every route these cards call keeps its own authorization, so an account that
 * reaches this component by typing the URL sees the same refusals it would
 * have seen before.
 */
export function OpsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [projectId, setProjectId] = useState(() => getWebProjectId());
  const projectChanged = useRef(false);

  useEffect(() => {
    let active = true;
    const requestedProjectId = getWebProjectId();
    void fetchWebMe().then((me) => {
      if (!active || projectChanged.current || !me?.project?.id) return;
      const currentProjectId = getWebProjectId();
      if (currentProjectId === requestedProjectId || currentProjectId === me.project.id) setProjectId(me.project.id);
    }).catch(() => { /* Each card presents its own retryable API error. */ });
    return () => { active = false; };
  }, []);

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-content px-8 py-10">
        {!embedded && (
          <PageHeader title="运维台" description="部署就绪、运行资源与三本运维账本。" />
        )}
        {/* Said inside the tab as well. The page is only ever rendered embedded
          * (AccountPage), and the notice used to render only when it was not —
          * so a console that can stop a running analysis appeared as an
          * ordinary tab with nothing saying whose it is (review B, P0). */}
        <p role="note" className="mt-2 flex items-center gap-2 rounded-input border border-strong bg-surface-2 px-3 py-2 text-ui text-text">
          <ShieldCheck size={16} className="shrink-0 text-muted" aria-hidden="true" />
          仅运维账号可见。这里的操作作用于整个部署，停止或重启会中断正在进行的研究。
        </p>
        <WebReadinessCard />
        <WebResourcesCard key={`resources-${projectId}`} />
        <WebTasksCard key={`tasks-${projectId}`} />
        <WebAuditCard key={`audit-${projectId}`} />
        <WebErrorsCard key={`errors-${projectId}`} />
        <WebSecurityCard key={`security-${projectId}`} />
      </div>
    </div>
  );
}
