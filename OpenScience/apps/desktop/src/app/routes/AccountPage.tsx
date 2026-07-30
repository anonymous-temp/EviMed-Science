import { useEffect, useState } from "react";
import { ShieldCheck, UserRound } from "lucide-react";
import { useNavigate } from "react-router";
import { fetchWebMe } from "@/lib/apiClient";
import { ThemeSegmentedControl } from "@/app/routes/SettingsPage";
import { DataFlowCard } from "@/components/settings/DataFlowCard";
import { WebAccountCard } from "@/components/settings/WebAccountCard";
import { WebAuditCard } from "@/components/settings/WebAuditCard";
import { WebErrorsCard } from "@/components/settings/WebErrorsCard";
import { WebProjectsCard } from "@/components/settings/WebProjectsCard";
import { WebReadinessCard } from "@/components/settings/WebReadinessCard";
import { WebResourcesCard } from "@/components/settings/WebResourcesCard";
import { WebSecurityCard } from "@/components/settings/WebSecurityCard";
import { WebTasksCard } from "@/components/settings/WebTasksCard";
import { Card } from "@/components/ui/Card";

export function AccountPage() {
  const navigate = useNavigate();
  const [identity, setIdentity] = useState({
    name: "",
    tenantId: "",
    projectId: "default",
  });

  useEffect(() => {
    void fetchWebMe().then((me) => {
      if (!me) return;
      setIdentity({
        name: me.user.name,
        tenantId: me.tenant?.id ?? me.user.tenantId ?? me.user.id,
        projectId: me.project?.id ?? "default",
      });
    });
  }, []);

  const leaveHostedSession = () => navigate("/login", { replace: true });

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-content px-8 py-10">
        <h1 className="font-serif text-display font-semibold text-text">账户与托管空间</h1>
        <p className="mt-2 text-body text-muted">
          管理你的个人租户、科研项目、数据边界与服务运行状态。
        </p>

        <Card className="mt-7" title="个人租户边界" hint="一期 SaaS 采用个人账号即租户；项目是租户内的隔离单元。">
          <div className="flex items-center gap-4">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-surface-2 text-accent">
              <UserRound size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-body font-medium text-text">{identity.name || "EviMed 用户"}</div>
              <div className="mt-1 truncate font-mono text-caption text-muted">
                tenant: {identity.tenantId || "正在读取…"}
              </div>
            </div>
            <div className="flex items-center gap-1.5 rounded-full bg-ok/10 px-2.5 py-1 text-caption font-medium text-ok">
              <ShieldCheck size={13} /> 独立空间
            </div>
          </div>
        </Card>

        <WebAccountCard onAccountDeleted={leaveHostedSession} onSignedOut={leaveHostedSession} />
        <WebProjectsCard
          onProjectChange={(project) => setIdentity((current) => ({ ...current, projectId: project.id }))}
        />
        <WebResourcesCard key={`resources-${identity.projectId}`} />
        <DataFlowCard
          hosted
          model="平台托管模型"
          workspace={`/workspace/${identity.projectId}`}
        />

        <Card
          className="mt-5"
          title="外观"
          hint="主题保存在本浏览器中，跟随系统会随系统明暗自动切换。"
        >
          <ThemeSegmentedControl />
        </Card>

        <details className="mt-5 rounded-card border border-border bg-surface shadow-card">
          <summary className="cursor-pointer px-5 py-4 text-ui font-medium text-text">
            运行、审计与安全详情
          </summary>
          <div className="border-t border-border px-5 pb-5">
            <WebReadinessCard />
            <WebTasksCard key={`tasks-${identity.projectId}`} />
            <WebAuditCard key={`audit-${identity.projectId}`} />
            <WebErrorsCard key={`errors-${identity.projectId}`} />
            <WebSecurityCard key={`security-${identity.projectId}`} />
          </div>
        </details>
      </div>
    </div>
  );
}
