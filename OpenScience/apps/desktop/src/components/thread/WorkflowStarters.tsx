import { ChevronRight, FileSearch, LibraryBig, LineChart, Microscope } from "lucide-react";
import { cn } from "@/lib/cn";

export interface WorkflowStarter {
  id: string;
  icon: React.ReactNode;
  /** Token-based tint for the icon chip — gives the four cards a color
   *  hierarchy instead of one flat row of identical circles. */
  tone: "accent" | "ok" | "link" | "warn";
  title: string;
  description: string;
  prompt: string;
}

const TONES: Record<WorkflowStarter["tone"], string> = {
  accent: "bg-accent/10 text-accent ring-accent/25 group-hover:bg-accent/15",
  ok: "bg-ok/10 text-ok ring-ok/25 group-hover:bg-ok/15",
  link: "bg-link/10 text-link ring-link/25 group-hover:bg-link/15",
  warn: "bg-warn/10 text-warn ring-warn/25 group-hover:bg-warn/15",
};

export const WORKFLOW_STARTERS: WorkflowStarter[] = [
  {
    id: "research-question",
    icon: <Microscope size={17} strokeWidth={1.75} />,
    tone: "accent",
    title: "研究一个医学问题",
    description: "从问题澄清、证据检索到结论整理。",
    prompt: "请围绕我接下来提供的医学问题开展研究。先明确研究问题和范围，再检索并综合可靠证据，清楚区分证据、推断和不确定性。",
  },
  {
    id: "knowledge-review",
    icon: <LibraryBig size={17} strokeWidth={1.75} />,
    tone: "ok",
    title: "结合个人知识库分析",
    description: "读取已上传资料，提炼重点并交叉验证。",
    prompt: "请结合我的个人知识库资料进行分析：先识别相关文件和核心观点，再与可靠外部证据交叉验证，标出冲突、缺口和可追溯来源。",
  },
  {
    id: "data-analysis",
    icon: <LineChart size={17} strokeWidth={1.75} />,
    tone: "link",
    title: "分析研究数据",
    description: "完成数据检查、统计分析、图表和结果解释。",
    prompt: "请分析我提供的研究数据。先检查数据结构和质量，再选择合适的统计方法，生成必要图表，并把结论与代码和数据结果对应起来。",
  },
  {
    id: "evidence-audit",
    icon: <FileSearch size={17} strokeWidth={1.75} />,
    tone: "warn",
    title: "核查报告与证据",
    description: "检查引用、数字来源和结论是否可追溯。",
    prompt: "请核查我提供的报告或稿件：验证引用，找出缺少来源的数字和结论，检查图表与分析结果是否一致，并给出可执行的修订建议。",
  },
];

export function WorkflowStarters({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex min-h-[62vh] flex-col items-center justify-center">
      <div className="w-full max-w-[500px]">
        <div className="text-center">
          <div className="text-caption font-medium tracking-[0.2em] text-accent">EviMed 科研助手</div>
          <h2 className="mt-2.5 font-serif text-display leading-tight text-text">今天想研究什么？</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            直接输入问题或科研任务，也可以从下面的常用方式开始。
          </p>
        </div>

        <div className="mt-7 overflow-hidden rounded-card border border-border bg-surface shadow-card">
          {WORKFLOW_STARTERS.map((starter) => (
            <button
              key={starter.id}
              onClick={() => onPick(starter.prompt)}
              className="group flex w-full items-center gap-3.5 border-t border-border px-4 py-3.5 text-left transition-colors first:border-t-0 hover:bg-surface-2"
            >
              <span
                className={cn(
                  "grid h-9 w-9 shrink-0 place-items-center rounded-full ring-1 transition-colors",
                  TONES[starter.tone],
                )}
              >
                {starter.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-ui font-medium text-text">{starter.title}</span>
                <span className="mt-0.5 block text-xs leading-snug text-muted">{starter.description}</span>
              </span>
              <ChevronRight
                size={16}
                className="shrink-0 text-muted/60 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-muted"
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
