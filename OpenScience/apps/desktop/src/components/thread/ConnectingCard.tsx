import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { isTauri } from "@/lib/tauri";
import { isMacPlatform } from "@/lib/platform";
import { cn } from "@/lib/cn";

/** Shown while the sidecar connection is being established. The first launch
 *  initializes the local runtime environment and can take minutes, so the card
 *  paces an illustrative three-phase indicator and rotates its explanation by
 *  elapsed time (honest staging — there is no measured progress from the
 *  sidecar yet). On macOS a long wait adds a TCC permission hint, since the
 *  OS may be silently holding the boot on an approval dialog. */
const PHASES = ["初始化运行环境", "启动科研服务", "连接就绪"] as const;

function stageFor(elapsed: number): { phase: number; detail: string } {
  if (elapsed < 12) {
    return { phase: 0, detail: "首次启动需要初始化本地运行环境，通常需要一到几分钟。" };
  }
  if (elapsed < 45) {
    return { phase: 1, detail: "运行环境已就绪，正在启动科研服务并建立连接…" };
  }
  return { phase: 1, detail: "首次初始化比预期更久，请再稍候片刻。" };
}

export function ConnectingCard() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const { phase, detail } = stageFor(elapsed);
  // A macOS approval dialog (folder access, automation) can stall the first
  // boot without any signal reaching the page — name it once the wait is long.
  const showTccHint = isTauri && isMacPlatform() && elapsed >= 30;

  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card" role="status">
      <div className="flex items-center gap-2 text-sm font-medium text-text">
        <Loader2 size={14} className="animate-spin text-accent" />
        正在启动 EviMed 科研服务
      </div>
      <ol className="mt-4 flex items-center gap-2">
        {PHASES.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-5 bg-border" aria-hidden />}
            <span className="flex items-center gap-1.5 text-xs">
              <span
                className={cn(
                  "grid h-[18px] w-[18px] place-items-center rounded-full text-caption",
                  i < phase
                    ? "bg-ok/15 text-ok"
                    : i === phase
                      ? "bg-accent/15 text-accent"
                      : "bg-surface-2 text-muted",
                )}
              >
                {i < phase ? <Check size={10} strokeWidth={2.5} /> : i + 1}
              </span>
              <span className={i <= phase ? "text-text" : "text-muted"}>{label}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-sm leading-5 text-muted">{detail}</p>
      {showTccHint && (
        <p className="mt-2 text-xs leading-5 text-muted">
          如果 macOS 弹出了权限请求（如访问文件夹或自动化），请选择「允许」后继续。
        </p>
      )}
      <p className="mt-2 text-caption text-muted/70">已等待 {elapsed} 秒</p>
    </div>
  );
}
