import { useEffect, useState } from "react";
import { fetchWebMe, getWebProjectId } from "@/lib/apiClient";
import { WebReadinessCard } from "@/components/settings/WebReadinessCard";
import { WebResourcesCard } from "@/components/settings/WebResourcesCard";
import { WebAuditCard } from "@/components/settings/WebAuditCard";
import { WebErrorsCard } from "@/components/settings/WebErrorsCard";
import { WebSecurityCard } from "@/components/settings/WebSecurityCard";
import { WebTasksCard } from "@/components/settings/WebTasksCard";
import { GeoMarketCard } from "@/components/settings/GeoMarketCard";
import { FrontierTagsCard } from "@/components/settings/FrontierTagsCard";
import { Section } from "@/components/ui/Section";

/**
 * Component: OpsPage; owner: H; rules: DS17, DS22.1, DS22.7, AT28.
 * Anatomy: Runtime and task cards, diagnostics, and operator configuration.
 * Variants: Operator console reached from the existing guarded route.
 * States: Every card owns its independent read, action and recovery states.
 * Hit area: Card controls retain their existing targets.
 * Keyboard: Document-order sections and card actions.
 * Long content: Ledgers and configuration retain their existing list behavior.
 * Theme: Existing operation card surfaces and semantic status roles.
 * Responsive: Named sections follow the existing page measure.
 * Verification: Operator-card tests and route authorization tests.
 *
 * 「运维」 in 设置: the deployment's console, offered only to an operator
 * account — the runtime's state, the configuration check, the three operations ledgers, 前沿动态's tag tree.
 * The project plugins that were here are on 插件与技能 now, where the one
 * switch a researcher has lives.
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
      <Section title="运行与任务">
        <WebResourcesCard key={`resources-${projectId}`} />
        <WebReadinessCard />
        <WebTasksCard key={`tasks-${projectId}`} />
      </Section>
      <Section title="诊断与审计">
        <WebAuditCard key={`audit-${projectId}`} />
        <WebErrorsCard key={`errors-${projectId}`} />
        <WebSecurityCard key={`security-${projectId}`} />
      </Section>
      <GeoMarketCard />
      <FrontierTagsCard />
    </div>
  );
}
