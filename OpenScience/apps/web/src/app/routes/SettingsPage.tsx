import { useEffect, useRef, useState } from "react";
import { fetchWebMe, getWebProjectId } from "@/lib/apiClient";
import { PluginsCard } from "@/components/settings/PluginsCard";
import { DataFlowCard } from "@/components/settings/DataFlowCard";
import { WebProjectsCard } from "@/components/settings/WebProjectsCard";
import { ThemeSegmentedControl } from "@/components/settings/ThemeSegmentedControl";
import { Card } from "@/components/ui/Card";

/**
 * Settings: the researcher's project, not the deployment.
 *
 * Everything that used to be here and is now the kernel's — the model, the
 * provider credentials, the approval mode, the MCP server list, the skill
 * inventory — is gone rather than moved. A hosted account does not choose a
 * model or hold a provider key (the gateway does, per request), and a settings
 * page that offers a control the server will refuse is worse than one that
 * does not offer it.
 *
 * The readiness board, the runtime controls and the audit, error, security and
 * task ledgers left on 2026-09-15 for `OpsPage`. They answered operational
 * questions on a page a researcher opens to rename a project.
 */
export function SettingsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [projectId, setProjectId] = useState(() => getWebProjectId());
  const projectChanged = useRef(false);

  useEffect(() => {
    let active = true;
    const requestedProjectId = getWebProjectId();
    void fetchWebMe().then((me) => {
      if (!active || projectChanged.current || !me?.project?.id) return;
      const currentProjectId = getWebProjectId();
      // The project store may already have repaired a deleted remembered project.
      // Accept that same resolved project, but never replace a newer selection.
      if (currentProjectId === requestedProjectId || currentProjectId === me.project.id) setProjectId(me.project.id);
    }).catch(() => { /* Project-scoped cards present their own retryable API errors. */ });
    return () => { active = false; };
  }, []);

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-content px-8 py-10">
        {!embedded && (
          <>
            <h1 className="font-serif text-display font-semibold text-text">设置</h1>
            <p className="mt-2 text-body text-muted">项目、插件、数据边界与外观。</p>
          </>
        )}

        <WebProjectsCard onProjectChange={(project) => { projectChanged.current = true; setProjectId(project.id); }} />
        <PluginsCard projectId={projectId} />
        <DataFlowCard hosted model="平台提供的模型" workspace={`/workspace/${projectId}`} />

        <Card className="mt-5" title="外观" hint="主题保存在本浏览器中，跟随系统会随系统明暗自动切换。">
          <ThemeSegmentedControl />
        </Card>
      </div>
    </div>
  );
}
