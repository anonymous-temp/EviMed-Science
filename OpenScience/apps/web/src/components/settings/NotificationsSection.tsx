import { BellRing } from "lucide-react";
import { useFrontierFeature } from "@/lib/frontierClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { FeishuPushRow } from "./FeishuRows";
import { FrontierDigestRow } from "./FrontierDigestRow";

/**
 * 「通知」 in 设置 (2026-09-23 plan §5.9): what may reach the researcher
 * outside the inbox — Feishu where the deployment runs the IM module, the
 * 前沿 daily where the feed is offered. The inbox itself is always on, so it
 * has no row (its card said 「始终开启」 and had nothing to switch); a
 * deployment with neither has nothing to set here and says so in one line,
 * rather than a phone card that could not work.
 */
export function NotificationsSection({ imEnabled }: { imEnabled: boolean }) {
  const frontier = useFrontierFeature();
  if (frontier === "loading" && !imEnabled) return null;
  if (!imEnabled && frontier !== "on") return <EmptyState icon={BellRing} title="没有可设置的通知" />;
  return (
    <Panel title="通知">
      {imEnabled && <FeishuPushRow />}
      <FrontierDigestRow feature={frontier} />
    </Panel>
  );
}
