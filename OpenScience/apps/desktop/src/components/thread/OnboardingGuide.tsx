import { useState } from "react";
import { Cable, MessagesSquare, PackageCheck, X } from "lucide-react";

/** First-run three-step guide shown above the workflow starters on an empty
 *  draft. Existing accounts with prior sessions never see it, while an
 *  explicit dismissal is also persisted for a new account in this browser. */
const DISMISS_KEY = "ai4s.onboarding.dismissed";

const STEPS = [
  {
    icon: Cable,
    title: "连接科研服务",
    description: "首次使用会自动准备科研运行环境，可能需要几分钟。",
  },
  {
    icon: MessagesSquare,
    title: "选择工作流或直接提问",
    description: "从下方常用方式开始，或在输入框描述任意科研任务。",
  },
  {
    icon: PackageCheck,
    title: "查看产物与运行记录",
    description: "产出文件在右侧面板查看，每次任务可在「运行记录」追溯。",
  },
];

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false; // storage blocked — show the bar, just don't persist
  }
}

export function OnboardingGuide({ hasPriorSessions = false }: { hasPriorSessions?: boolean }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed || hasPriorSessions) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // best-effort persistence only
    }
  };

  return (
    <section
      aria-label="新手引导"
      className="relative rounded-card border border-border bg-surface px-5 py-4 shadow-card"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="关闭引导"
        className="absolute right-3 top-3 rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
      >
        <X size={14} strokeWidth={1.75} />
      </button>
      <h2 className="font-serif text-body font-semibold text-text">第一次使用？三步开始</h2>
      <ol className="mt-3 grid gap-3 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex items-start gap-2.5">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/10 text-accent ring-1 ring-accent/25">
              <step.icon size={13} strokeWidth={1.75} />
            </span>
            <span className="min-w-0">
              <span className="block text-ui font-medium text-text">
                {i + 1}. {step.title}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-muted">
                {step.description}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
