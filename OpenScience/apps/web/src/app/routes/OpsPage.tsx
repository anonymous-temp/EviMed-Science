import { useEffect, useState } from "react";
import { fetchWebMe, getWebProjectId } from "@/lib/apiClient";
import { EvolutionPanel } from "@/components/evolution/EvolutionPanel";
import { WebReadinessCard } from "@/components/settings/WebReadinessCard";
import { WebResourcesCard } from "@/components/settings/WebResourcesCard";
import { WebAuditCard } from "@/components/settings/WebAuditCard";
import { WebErrorsCard } from "@/components/settings/WebErrorsCard";
import { WebSecurityCard } from "@/components/settings/WebSecurityCard";
import { WebTasksCard } from "@/components/settings/WebTasksCard";
import { GeoMarketCard } from "@/components/settings/GeoMarketCard";

/**
 * 「运维」 in 设置: the deployment's console, offered only to an operator
 * account — the runtime's state, the configuration check, the three operations ledgers, and
 * 「循证进化」, the evolution engine's tools and plans (it sat under the
 * research-tool grid until 2026-10-07: an operator's panel beneath a
 * researcher's page, and it had no business there). The project plugins that
 * were here are on 插件与技能 now, where the one switch a researcher has lives.
 *
 * Presentation only. `config.operatorUsers` decides who is offered the
 * section; every route these cards call keeps its own authorization, so an
 * account that reaches this component by typing the URL sees the same
 * refusals it would have seen before.
 *
 * The cards are bound to the project the account is actually in: the tab's
 * remembered project, corrected by `/api/me` when it names a project that no
 * longer exists — unless the tab has moved on to another project meanwhile.
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
      {/* What is running now first; whether the configuration holds second — the order an operator asks in. */}
      <WebResourcesCard key={`resources-${projectId}`} />
      <WebReadinessCard />
      <WebTasksCard key={`tasks-${projectId}`} />
      <WebAuditCard key={`audit-${projectId}`} />
      <WebErrorsCard key={`errors-${projectId}`} />
      <WebSecurityCard key={`security-${projectId}`} />
      <GeoMarketCard />
      <EvolutionPanel />
    </div>
  );
}
