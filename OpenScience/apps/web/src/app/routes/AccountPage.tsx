import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { BellRing, Folder, Gauge, Palette, Plug, UserRound, Wrench, type LucideIcon } from "lucide-react";
import { fetchWebMe } from "@/lib/apiClient";
import { fetchImStatus } from "@/lib/imClient";
import { cn } from "@/lib/cn";
import { PageShell } from "@/components/layout/PageShell";
import { AccountSection } from "@/components/settings/AccountSection";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { NotificationsSection } from "@/components/settings/NotificationsSection";
import { ProjectsSection } from "@/components/settings/ProjectsSection";
import { UsageSection } from "@/components/settings/UsageSection";
import { OpsPage } from "./OpsPage";

type SectionKey = "account" | "appearance" | "notifications" | "usage" | "connectors" | "projects" | "ops";

interface Section {
  /** The `?tab=` value. Stable: it is in links people keep and in the server's own copy. */
  key: SectionKey;
  label: string;
  icon: LucideIcon;
}

const SECTIONS: readonly Section[] = [
  { key: "account", label: "账户", icon: UserRound },
  { key: "appearance", label: "外观", icon: Palette },
  { key: "notifications", label: "通知", icon: BellRing },
  { key: "usage", label: "用量", icon: Gauge },
  { key: "connectors", label: "数据源", icon: Plug },
  { key: "projects", label: "项目", icon: Folder },
];

const OPS: Section = { key: "ops", label: "运维", icon: Wrench };

/**
 * 「设置」 (2026-09-23 plan §5.9, mockup m11): one page in the column every
 * page shares, a section column on its left — 账户 · 外观 · 通知 · 用量 · 数据源
 * · 项目, and 运维 for an operator — and the chosen section beside it, in
 * groups named outside one box, one item per row.
 *
 * It was 「账户与设置」: a title, a sentence reciting the tab names, and a
 * strip of underlined tabs over bodies in a narrower column than the header.
 * The address stays `/app/account` and each section keeps its `?tab=` value,
 * so the sidebar's gear, 「查看用量」 (`?tab=usage`), the server's own copy
 * (「设置 → 数据源」) and bookmarks all land where they did; no value opens
 * 账户, which is what the gear promises.
 */
export function AccountPage() {
  const [params] = useSearchParams();
  const [operator, setOperator] = useState(false);
  // Feishu exists only where the deployment runs the IM module: a row for a
  // switched-off subsystem would offer a scan that cannot work.
  const [imEnabled, setImEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchImStatus().then((status) => { if (active) setImEnabled(status.enabled); }).catch(() => {});
    void fetchWebMe().then((me) => { if (active) setOperator(me?.operator === true); }).catch(() => {});
    return () => { active = false; };
  }, []);

  const sections = operator ? [...SECTIONS, OPS] : SECTIONS;
  const active = sections.find((section) => section.key === params.get("tab")) ?? sections[0];

  return (
    <PageShell title="设置">
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <nav aria-label="设置分区" className="md:w-40 md:shrink-0">
          <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
            {sections.map((section) => {
              const selected = section.key === active.key;
              const Icon = section.icon;
              return (
                <li key={section.key} className="shrink-0">
                  <Link
                    to={section.key === "account" ? "/app/account" : `/app/account?tab=${section.key}`}
                    replace
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "flex h-8 items-center gap-2.5 whitespace-nowrap rounded px-2 text-ui transition-colors duration-fast",
                      selected ? "bg-surface-2 font-medium text-text" : "text-text-2 hover:bg-surface-2 hover:text-text",
                    )}
                  >
                    <Icon size={16} aria-hidden="true" className={selected ? "text-text" : "text-text-3"} />
                    {section.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          {active.key === "account" && <AccountSection imEnabled={imEnabled} />}
          {active.key === "appearance" && <AppearanceSection />}
          {active.key === "notifications" && <NotificationsSection imEnabled={imEnabled} />}
          {active.key === "usage" && <UsageSection />}
          {active.key === "connectors" && <ConnectorsSection />}
          {active.key === "projects" && <ProjectsSection />}
          {active.key === "ops" && <OpsPage />}
        </div>
      </div>
    </PageShell>
  );
}
