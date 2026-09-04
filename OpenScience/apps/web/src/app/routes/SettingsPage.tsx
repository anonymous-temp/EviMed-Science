import { useEffect, useState } from "react";
import { fetchWebMe } from "@/lib/apiClient";
import { DataFlowCard } from "@/components/settings/DataFlowCard";
import { WebProjectsCard } from "@/components/settings/WebProjectsCard";
import { WebReadinessCard } from "@/components/settings/WebReadinessCard";
import { WebResourcesCard } from "@/components/settings/WebResourcesCard";
import { WebAuditCard } from "@/components/settings/WebAuditCard";
import { WebErrorsCard } from "@/components/settings/WebErrorsCard";
import { WebSecurityCard } from "@/components/settings/WebSecurityCard";
import { WebTasksCard } from "@/components/settings/WebTasksCard";

/**
 * Settings: the deployment, not the person.
 *
 * Everything that used to be here and is now the kernel's — the model, the
 * provider credentials, the approval mode, the MCP server list, the skill
 * inventory — is gone rather than moved. A hosted account does not choose a
 * model or hold a provider key (the gateway does, per request), and a settings
 * page that offers a control the server will refuse is worse than one that
 * does not offer it.
 */
export function SettingsPage() {
  const [projectId, setProjectId] = useState("default");

  useEffect(() => {
    void fetchWebMe().then((me) => {
      if (me?.project?.id) setProjectId(me.project.id);
    });
  }, []);

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-content px-8 py-10">
        <h1 className="font-serif text-display font-semibold text-text">设置</h1>
        <p className="mt-2 text-body text-muted">项目、运行资源、数据边界与服务就绪状态。</p>

        <WebProjectsCard onProjectChange={(project) => setProjectId(project.id)} />
        <WebResourcesCard key={`resources-${projectId}`} />
        <DataFlowCard hosted model="平台托管模型" workspace={`/workspace/${projectId}`} />
        <WebReadinessCard />

        <details className="mt-5 rounded-card border border-border bg-surface shadow-card">
          <summary className="cursor-pointer px-5 py-4 text-ui font-medium text-text">
            任务、审计与安全详情
          </summary>
          <div className="border-t border-border px-5 pb-5">
            <WebTasksCard key={`tasks-${projectId}`} />
            <WebAuditCard key={`audit-${projectId}`} />
            <WebErrorsCard key={`errors-${projectId}`} />
            <WebSecurityCard key={`security-${projectId}`} />
          </div>
        </details>
      </div>
    </div>
  );
}
