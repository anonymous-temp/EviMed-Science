import { Link } from "react-router";
import { Compass } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { PageTitle } from "@/components/layout/PageTitle";
import { buttonClasses } from "@/components/ui/Button";

/**
 * A wrong address: what happened, and the way back — no sentence restating the
 * title (2026-09-23 inventory §1.12). Not 「404 · 页面不存在」 either: an HTTP
 * status is a protocol fact, not a headline a reader needs (review B, NotFound
 * P2).
 */
export function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <PageTitle page="页面不存在" />
      <EmptyState
        icon={Compass}
        title="页面不存在"
        action={<Link to="/" className={buttonClasses({ variant: "secondary" })}>返回首页</Link>}
      />
    </div>
  );
}
