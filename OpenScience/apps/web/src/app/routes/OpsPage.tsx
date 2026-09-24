import { useEffect, useState } from "react";
import { fetchWebMe, getWebProjectId } from "@/lib/apiClient";
import { PluginsCard } from "@/components/settings/PluginsCard";
import { WebReadinessCard } from "@/components/settings/WebReadinessCard";
import { WebResourcesCard } from "@/components/settings/WebResourcesCard";
import { WebAuditCard } from "@/components/settings/WebAuditCard";
import { WebErrorsCard } from "@/components/settings/WebErrorsCard";
import { WebSecurityCard } from "@/components/settings/WebSecurityCard";
import { WebTasksCard } from "@/components/settings/WebTasksCard";

/**
 * 「运维」 in 设置: the deployment's console, offered only to an operator
 * account — readiness, resources, the three operations ledgers, and the
 * current project's plugins (「项目插件」 moved here from 项目 on 2026-09-23:
 * a researcher has nothing to configure in it).
 *
 * Presentation only. `config.operatorUsers` decides who is offered the
 * section; every route these cards call keeps its own authorization, so an
 * account that reaches this component by typing the URL sees the same
 * refusals it would have seen before.
 *
 * The plugins card is bound to the project the account is actually in: the
 * tab's remembered project, corrected by `/api/me` when it names a project that
 * no longer exists — unless the tab has moved on to another project meanwhile.
 */
export function OpsPage() {
  const [projectId, setProjectId] = useState(() => getWebProjectId());

  useEffect(() => {
    let active = true;
    const requestedProjectId = getWebProjectId();
    void fetchWebMe().then((me) => {
      if (!active || !me?.project?.id) return;
      const currentProjectId = getWebProjectId();
      // The project store may already have repaired a deleted remembered
      // project. Accept that same resolved project, but never replace a newer
      // selection.
      if (currentProjectId === requestedProjectId || currentProjectId === me.project.id) setProjectId(me.project.id);
    }).catch(() => { /* Each card presents its own retryable API error. */ });
    return () => { active = false; };
  }, []);

  return (
    <div>
      <p role="note" className="text-caption text-text-3">这里的操作作用于整个部署：停止或重启会中断进行中的研究。</p>
      <WebReadinessCard />
      <WebResourcesCard key={`resources-${projectId}`} />
      <WebTasksCard key={`tasks-${projectId}`} />
      <WebAuditCard key={`audit-${projectId}`} />
      <WebErrorsCard key={`errors-${projectId}`} />
      <WebSecurityCard key={`security-${projectId}`} />
      <PluginsCard projectId={projectId} />
    </div>
  );
}
