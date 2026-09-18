import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

/**
 * A list that could not be read, with the way out (the four-state rule:
 * loading, empty, error, content). A read that failed once is usually a
 * control plane that was briefly away; the alternative to 重试 is asking the
 * reader to reload the whole app — and an error shown as an empty list tells
 * them their work is gone.
 */
export function LoadError({ message, onRetry, className }: { message: string; onRetry: () => void; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-input border border-danger bg-danger-soft px-3 py-2 text-ui text-danger-strong",
        className,
      )}
    >
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        <RefreshCw size={12} aria-hidden="true" />重试
      </Button>
    </div>
  );
}
