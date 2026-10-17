import { Link } from "react-router";
import { Compass } from "lucide-react";
import { PageTitle } from "@/components/layout/PageTitle";
import { buttonClasses } from "@/components/ui/Button";
import { StateScreen } from "@/components/ui/StateScreen";

/**
 * A wrong address: what happened, and the way back — no sentence restating the
 * title (2026-09-23 inventory §1.12). Not 「404 · 页面不存在」 either: an HTTP
 * status is a protocol fact, not a headline a reader needs (review B, NotFound
 * P2).
 *
 * The way back is the front door unless the address says where it used to lead: 模拟会员 and 模拟退款 were removed on 2026-10-07 and
 * their links are in old mail, so a page that knows what an address was for (`lead`) sends the reader there instead — 「回到额度」,
 * not 「返回首页」 (R19, audit D C4).
 */
export function NotFound({ lead }: { lead?: { to: string; label: string } } = {}) {
  return (
    <StateScreen
      icon={Compass}
      title="页面不存在"
      titleAs="h1"
      action={<Link to={lead?.to ?? "/"} className={buttonClasses({ variant: "secondary" })}>{lead?.label ?? "返回首页"}</Link>}
    >
      <PageTitle page="页面不存在" />
    </StateScreen>
  );
}
