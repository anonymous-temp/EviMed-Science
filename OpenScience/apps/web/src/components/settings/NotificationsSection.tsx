import { BellRing } from "lucide-react";
import { useFrontierFeature } from "@/lib/frontierClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { FeishuRow, useImStatus } from "./FeishuRows";
import { FrontierDigestRow } from "./FrontierDigestRow";

/**
 * 「通知」 in 设置 (2026-09-23 plan §5.9): where the notices go. Each switch
 * says where its notice is delivered — always the inbox, and Feishu too when
 * the account has bound it and left the push on (「，并推送到飞书」) — so a row
 * is never a bare label (2026-10-07 audit, S03). Feishu is bound, switched and
 * unbound in its own row here: binding used to live under 账户 and the push
 * switch here, which left a bot bound in one tab and turned on in another.
 *
 * The inbox itself is always on, so it has no row; a deployment with neither
 * Feishu nor the feed has nothing to set here and says so in one line, rather
 * than a phone card that could not work.
 */
export function NotificationsSection({ imEnabled }: { imEnabled: boolean }) {
  const frontier = useFrontierFeature();
  const im = useImStatus(imEnabled);
  if (frontier === "loading" && !imEnabled) return null;
  if (!imEnabled && frontier !== "on") return <EmptyState icon={BellRing} title="没有可设置的通知" />;
  const toFeishu = imEnabled && im.binding?.notifications === true ? "，并推送到飞书" : "";
  return (
    <Panel title="通知">
      {imEnabled && <FeishuRow im={im} />}
      <FrontierDigestRow feature={frontier} description={`每天的医学前沿日报，发到收件箱${toFeishu}`} />
      <FrontierDigestRow feature={frontier} switchKey="frontierWeekly" label="前沿周刊" description={`每周的医学前沿周刊，发到收件箱${toFeishu}`} />
      <FrontierDigestRow feature={frontier} switchKey="frontierSafety" label="相关安全警示" description={`药品安全公告，发到收件箱${toFeishu}`} />
    </Panel>
  );
}
