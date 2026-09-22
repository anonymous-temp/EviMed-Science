import { useEffect, useRef, useState } from "react";
import { fetchWebMe, getWebProjectId } from "@/lib/apiClient";
import { PluginsCard } from "@/components/settings/PluginsCard";
import { DataFlowCard } from "@/components/settings/DataFlowCard";
import { WebProjectsCard } from "@/components/settings/WebProjectsCard";
import { ArchivedConversationsCard } from "@/components/settings/ArchivedConversationsCard";
import { PageHeader } from "@/components/layout/PageHeader";
import { WorkbenchTabBody } from "@/components/layout/WorkbenchTabs";

/**
 * 「项目」: the researcher's projects, and what each one is configured with.
 *
 * This was 「设置」 until 2026-09-22 — projects, plugins, data flow and a
 * theme switch under one word — and a reader who opened 设置 for the settings
 * every product has found a project list instead. The account page now keeps
 * the conventional settings under their own tabs (`AccountPage`), and this is
 * the project tab: rename, export and delete a project, its plugins, and what
 * its workspace stores and sends.
 *
 * Everything that used to be here and is now the kernel's — the model, the
 * provider credentials, the approval mode, the MCP server list, the skill
 * inventory — is gone rather than moved. A hosted account does not choose a
 * model or hold a provider key (the gateway does, per request), and a settings
 * page that offers a control the server will refuse is worse than one that
 * does not offer it.
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

  const body = (
    <>
      <WebProjectsCard onProjectChange={(project) => { projectChanged.current = true; setProjectId(project.id); }} />
      <ArchivedConversationsCard />
      <PluginsCard projectId={projectId} />
      <DataFlowCard hosted model="平台提供的模型" workspace={`/workspace/${projectId}`} />
    </>
  );

  if (embedded) return <WorkbenchTabBody>{body}</WorkbenchTabBody>;
  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-content-wide px-6 py-6"><div className="max-w-content">
        <PageHeader title="项目" description="重命名、导出或删除项目；项目的插件与数据边界。" />
        {body}
      </div></div>
    </div>
  );
}
