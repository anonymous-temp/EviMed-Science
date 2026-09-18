import { useEffect, useState } from "react";
import { ShieldCheck, UserRound, WalletMinimal } from "lucide-react";
import { useNavigate } from "react-router";
import { describeWebUsageBudget, fetchWebMe, lastWebUsageBudgetRefusal } from "@/lib/apiClient";
import { WebAccountCard } from "@/components/settings/WebAccountCard";
import { UsageCard } from "@/components/settings/UsageCard";
import { ConnectorsCard } from "@/components/settings/ConnectorsCard";
import { Card } from "@/components/ui/Card";
import { WorkbenchTabs, type WorkbenchTab } from "@/components/layout/WorkbenchTabs";
import { SettingsPage } from "./SettingsPage";
import { OpsPage } from "./OpsPage";

/**
 * Everything about the account, in one destination.
 *
 * Four rows of the old ten-row navigation pointed here in some form: the
 * account page, the settings page, the connector banner's "go set these up"
 * link, and the operations cards that shared the settings page with them. They
 * are four views of one thing now — who you are, what you have spent, which
 * data sources you have connected, and how this project is configured — with
 * the deployment console behind an allowlist (2026-09-15 walk, C6/C7/C8).
 */
export function AccountPage() {
  const navigate = useNavigate();
  const [identity, setIdentity] = useState({
    name: "",
    tenantId: "",
    projectId: "default",
    operator: false,
  });
  // Read once on entry. The refusal happened on whatever page tried to spend;
  // nothing on this page spends, so there is nothing to keep watching for.
  const [budgetRefusal] = useState(lastWebUsageBudgetRefusal);

  useEffect(() => {
    void fetchWebMe().then((me) => {
      if (!me) return;
      setIdentity({
        name: me.user.name,
        tenantId: me.tenant?.id ?? me.user.tenantId ?? me.user.id,
        projectId: me.project?.id ?? "default",
        operator: me.operator === true,
      });
    });
  }, []);

  const leaveHostedSession = () => navigate("/login", { replace: true });

  const overview = (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-content px-8 py-8">
        {/* "个人租户边界" / "一期 SaaS 采用个人账号即租户" / "独立空间" were the
            design's words for the reader, not the reader's (2026-09-16 walk,
            U13). What a researcher needs to know is that their work is theirs
            and that projects do not see each other. */}
        <Card title="你的账号与项目" hint="每个账号的数据彼此独立；同一账号下的项目也各自隔离，互相看不到对方的文件与运行记录。">
          <div className="flex items-center gap-4">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-surface-2 text-accent">
              <UserRound size={20} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-body font-medium text-text">{identity.name || "EviMed 用户"}</div>
              <div className="mt-1 truncate text-caption text-muted">
                账号 {identity.tenantId || "正在读取…"}
              </div>
            </div>
            <div className="flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-1 text-caption font-medium text-ok">
              <ShieldCheck size={13} aria-hidden="true" /> 数据独立
            </div>
          </div>
        </Card>

        {/* The ledger measures spend over rolling windows (`created_at >= now
            - interval '24 hours' / '7 days'`), so nothing resets at midnight:
            each charge frees its own share once it ages past its window. A
            hint promising a reset tomorrow would be a claim the ledger cannot
            support. */}
        {budgetRefusal && (
          <Card
            className="mt-5"
            title="额度已达上限"
            hint="本次会话中最近一次被额度拦下的请求。额度按滚动窗口计算：每笔支出分别在满 24 小时或满 7 天后自动腾出，不在固定时间重置。"
          >
            <div className="flex items-start gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warn-soft text-warn">
                <WalletMinimal size={17} aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-ui text-text">{describeWebUsageBudget(budgetRefusal)}</p>
                <p className="mt-1 text-caption text-muted">
                  记录于 {new Date(budgetRefusal.observedAt).toLocaleString("zh-CN")}
                </p>
              </div>
            </div>
          </Card>
        )}

        <UsageCard />
        <WebAccountCard onAccountDeleted={leaveHostedSession} onSignedOut={leaveHostedSession} />
      </div>
    </div>
  );

  const tabs: WorkbenchTab[] = [
    { key: "account", label: "账户与额度", render: () => overview },
    { key: "connectors", label: "数据源", render: () => (
      <div className="h-full overflow-y-auto bg-bg">
        <div className="mx-auto max-w-content px-8 py-8" id="connectors"><ConnectorsCard /></div>
      </div>
    ) },
    { key: "settings", label: "设置", render: () => <SettingsPage embedded /> },
    ...(identity.operator ? [{ key: "ops", label: "运维台", render: () => <OpsPage embedded /> }] : []),
  ];


  return (
    <WorkbenchTabs
      title="账户"
      description="你的账号、用量、数据源凭据与项目设置。"
      tabs={tabs}
    />
  );
}
