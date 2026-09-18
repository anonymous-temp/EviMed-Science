import { Link } from "react-router";
import { Compass } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { PageTitle } from "@/components/layout/PageTitle";
import { buttonClasses } from "@/components/ui/Button";

export function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <PageTitle page="页面不存在" />
      <EmptyState
        icon={Compass}
        // Not 「404 · 页面不存在」: an HTTP status is a protocol fact, not a
        // headline a reader needs (review B, NotFound P2).
        title="页面不存在"
        description="你访问的页面不存在或已被移动。"
        action={
          <Link to="/" className={buttonClasses()}>
            返回首页
          </Link>
        }
      />
    </div>
  );
}
