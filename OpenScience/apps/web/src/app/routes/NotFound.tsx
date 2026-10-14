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
 */
export function NotFound() {
  return (
    <StateScreen
      icon={Compass}
      title="页面不存在"
      titleAs="h1"
      action={<Link to="/" className={buttonClasses({ variant: "secondary" })}>返回首页</Link>}
    >
      <PageTitle page="页面不存在" />
    </StateScreen>
  );
}
