import { Link } from "react-router";
import { Compass } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";

export function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <EmptyState
        icon={Compass}
        title="404 · 页面不存在"
        description="你访问的页面不存在或已被移动。"
        action={
          <Link
            to="/"
            className="inline-block rounded-input bg-accent px-4 py-2 text-ui font-medium text-accent-fg hover:opacity-90"
          >
            返回首页
          </Link>
        }
      />
    </div>
  );
}
