import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { BellRing, ShieldCheck, UserRound, WalletMinimal } from "lucide-react";
import { describeWebUsageBudget, fetchWebMe, lastWebUsageBudgetRefusal } from "@/lib/apiClient";
import { WebAccountCard } from "@/components/settings/WebAccountCard";
import { PasswordCard } from "@/components/settings/PasswordCard";
import { UsageCard } from "@/components/settings/UsageCard";
import { ConnectorsCard } from "@/components/settings/ConnectorsCard";
import { FeishuCard } from "@/components/settings/FeishuCard";
import { ThemeSegmentedControl } from "@/components/settings/ThemeSegmentedControl";
import { isMacPlatform } from "@/lib/platform";
import { fetchImStatus } from "@/lib/imClient";
import { Card } from "@/components/ui/Card";
import { WorkbenchTabBody, WorkbenchTabs, type WorkbenchTab } from "@/components/layout/WorkbenchTabs";
import { SettingsPage } from "./SettingsPage";
import { OpsPage } from "./OpsPage";

/**
 * 「账户与设置」: the settings a person expects to find, in the order every
 * consumer product keeps them — the account, its appearance, its notifications,
 * what it has spent, the data sources it has connected, and its projects.
 *
 * Until 2026-09-22 the 「设置」 tab was the project's configuration (projects,
 * plugins, data flow) plus a theme switch, and the owner's reading of it was
 * that none of the conventional settings were there. They are now: password,
 * theme, language, shortcuts, notifications, data export and deletion. Each
 * tab keeps its address (`?tab=`), so bookmarks and the sidebar's links hold.
 */
export function AccountPage() {
  const navigate = useNavigate();
  const [identity, setIdentity] = useState({ name: "", operator: false });
  // Read once on entry. The refusal happened on whatever page tried to spend;
  // nothing on this page spends, so there is nothing to keep watching for.
  const [budgetRefusal] = useState(lastWebUsageBudgetRefusal);
  // Phone notifications exist only where the deployment runs the IM module: a
  // page for a switched-off subsystem would offer a scan that cannot work.
  const [imEnabled, setImEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchImStatus().then((status) => { if (active) setImEnabled(status.enabled); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    void fetchWebMe().then((me) => {
      if (!me) return;
      setIdentity({ name: me.user.name, operator: me.operator === true });
    });
  }, []);

  const leaveHostedSession = () => navigate("/login", { replace: true });

  const account = (
    <WorkbenchTabBody>
      {/* "个人租户边界" / "一期 SaaS 采用个人账号即租户" / "独立空间" were the
          design's words for the reader, not the reader's (2026-09-16 walk,
          U13). What a researcher needs to know is that their work is theirs
          and that projects do not see each other. */}
      <Card title="你的账号" hint="每个账号的数据彼此独立；同一账号下的项目也各自隔离，互相看不到对方的文件与对话。">
        <div className="flex items-center gap-4">
          <div className="grid h-11 w-11 place-items-center rounded-full bg-surface-2 text-accent">
            <UserRound size={20} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-body font-medium text-text">{identity.name || "EviMed 用户"}</div>
          </div>
          <div className="flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-1 text-caption font-medium text-ok">
            <ShieldCheck size={13} aria-hidden="true" /> 数据独立
          </div>
        </div>
      </Card>
      <PasswordCard />
      <WebAccountCard onAccountDeleted={leaveHostedSession} onSignedOut={leaveHostedSession} />
    </WorkbenchTabBody>
  );

  const appearance = (
    <WorkbenchTabBody>
      <Card title="主题" hint="保存在本浏览器中；跟随系统会随系统明暗自动切换，对话界面同步。">
        <ThemeSegmentedControl />
      </Card>
      <Card className="mt-5" title="语言" hint="界面语言随部署，暂不能单独切换。">
        <p className="text-ui text-text">简体中文</p>
      </Card>
      <Card className="mt-5" title="键盘快捷键" hint="按 ? 随时打开这份清单。">
        <ShortcutTable />
      </Card>
    </WorkbenchTabBody>
  );

  const notifications = (
    <WorkbenchTabBody>
      <Card title="站内通知" hint="研究完成、需要你决定、或者结论有变化时才会通知；涉及临床安全的放在最前。">
        <div className="flex items-center gap-3">
          <BellRing size={16} className="shrink-0 text-muted" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-ui text-text">始终开启，发到侧栏的铃铛和<Link to="/app/inbox" className="text-link hover:underline">收件箱</Link>。</p>
        </div>
      </Card>
      {imEnabled
        ? <FeishuCard />
        : (
          <Card className="mt-5" title="手机通知" hint="本部署没有启用手机推送；启用后可以在这里绑定飞书。">
            <p className="text-ui text-muted">暂不可用</p>
          </Card>
        )}
    </WorkbenchTabBody>
  );

  const usage = (
    <WorkbenchTabBody>
      {/* The ledger measures spend over rolling windows (`created_at >= now
          - interval '24 hours' / '7 days'`), so nothing resets at midnight:
          each charge frees its own share once it ages past its window. A
          hint promising a reset tomorrow would be a claim the ledger cannot
          support. */}
      {budgetRefusal && (
        <Card
          className="mb-5"
          title="额度已达上限"
          hint="本次登录中最近一次被额度拦下的请求。额度按滚动窗口计算：每笔支出分别在满 24 小时或满 7 天后自动腾出，不在固定时间重置。"
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
    </WorkbenchTabBody>
  );

  const tabs: WorkbenchTab[] = [
    { key: "account", label: "账户", render: () => account },
    { key: "appearance", label: "外观", render: () => appearance },
    { key: "notifications", label: "通知", render: () => notifications },
    { key: "usage", label: "用量与额度", render: () => usage },
    { key: "connectors", label: "数据源", render: () => <WorkbenchTabBody id="connectors"><ConnectorsCard /></WorkbenchTabBody> },
    { key: "projects", label: "项目", render: () => <SettingsPage embedded /> },
    ...(identity.operator ? [{ key: "ops", label: "运维台", render: () => <OpsPage embedded /> }] : []),
  ];

  return (
    <WorkbenchTabs
      title="账户与设置"
      description="你的账号、外观、通知、用量、数据源凭据与项目。"
      tabs={tabs}
    />
  );
}

/**
 * Every key the shell answers to. The composer's own keys belong to the
 * conversation surface and are listed as it has them, so this table and the
 * `?` panel say the same thing.
 */
function ShortcutTable() {
  const mod = isMacPlatform() ? "⌘" : "Ctrl+";
  const rows: { keys: string; description: string }[] = [
    { keys: "Enter", description: "发送消息" },
    { keys: "Shift+Enter", description: "换行" },
    { keys: `${mod}Enter`, description: "运行中插话" },
    { keys: "/", description: "调用指令或选择科研工具" },
    { keys: "@", description: "引用知识库里的资料或会话" },
    { keys: `${mod}B`, description: "收起 / 展开侧边栏" },
    { keys: "?", description: "打开 / 关闭快捷键清单" },
    { keys: "Esc", description: "关闭弹层" },
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-ui">
      {rows.map((row) => (
        <div key={row.keys} className="contents">
          <dt><kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-text">{row.keys}</kbd></dt>
          <dd className="text-text">{row.description}</dd>
        </div>
      ))}
    </dl>
  );
}
