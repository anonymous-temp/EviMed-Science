import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  fetchMemorySettings,
  getWebProjectId,
  resetMemory,
  updateMemorySettings,
  webErrorMessage,
  type WebMemorySettings,
} from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type SwitchKey = "memory" | "project";

/**
 * The memory switches, as one row of the page header: the switch, the
 * per-project exception, and the reset behind a confirmation.
 *
 * It was a card of its own — a titled section with a paragraph under each
 * switch — above the list it governs, and the owner's reading of it was that
 * two switches and a reset do not earn a section (2026-09-22: 「记忆开关 重置
 * 不就俩按钮吗，有必要单独占那么大地方吗」). ChatGPT keeps the same three
 * controls as one line of its memory settings; Claude keeps one switch. So
 * this renders three controls and nothing else, and what each does is its
 * tooltip.
 *
 * Two switches, not three: 「从对话中学习新记忆」 and 「回答时参考记忆」 were
 * one decision (owner ruling 2026-09-20), so they are set together, and the
 * store still holds them apart. The per-project exception is what tells this
 * apart from a global switch: it stops memory in this project only, which is
 * the one thing a researcher on a confidential project asks for.
 *
 * Pause and reset stay apart, as the products people already trust keep them: a
 * pause deletes nothing and is undone by the same switch, while a reset deletes
 * and says exactly what it deletes and what it leaves.
 */
export function MemoryControls({ onReset }: { onReset: () => void }) {
  const [settings, setSettings] = useState<WebMemorySettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<SwitchKey | "reset" | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const projectId = getWebProjectId();

  useEffect(() => {
    let cancelled = false;
    fetchMemorySettings()
      .then((next) => { if (!cancelled) setSettings(next); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  if (failed) {
    return (
      <p className="text-caption text-muted" title="记忆本身不受影响">记忆开关暂时读取不到</p>
    );
  }
  if (!settings) return null;

  const projectPaused = settings.pausedProjects.includes(projectId);
  // On only when both halves are on: a page that said 「已开启」 while recall was
  // paused underneath would be telling the researcher something untrue.
  const memoryOn = !settings.learningPaused && !settings.recallPaused;
  const change = async (key: SwitchKey, patch: Parameters<typeof updateMemorySettings>[0], done: string) => {
    setBusy(key);
    try {
      setSettings(await updateMemorySettings(patch));
      toast.success(done);
    } catch (error) {
      toast.error(`没有改成：${webErrorMessage(error, { fallback: "请稍后重试。" })}`);
    } finally {
      setBusy(null);
    }
  };
  const reset = async () => {
    setConfirmingReset(false);
    setBusy("reset");
    try {
      const removed = await resetMemory();
      toast.success(`已删除 ${removed.structured} 条记忆。`);
      onReset();
    } catch (error) {
      toast.error(`重置没有完成：${webErrorMessage(error, { fallback: "请稍后重试。" })}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-memory-controls="">
      <Toggle
        label="让 EviMed 记住并使用"
        text="记忆"
        on={memoryOn}
        busy={busy === "memory"}
        disabled={busy !== null}
        title={memoryOn
          ? "对话结束后自动记下值得长期保留的内容，之后回答时按当前问题挑相关的用上。关掉后不再记下新的，也不再使用已有的；已记下的都保留着。"
          : "已暂停：不再记下新的，也不再在回答时使用已有的。已记下的都保留着。"}
        onToggle={() => void change("memory", { learningPaused: memoryOn, recallPaused: memoryOn },
          memoryOn ? "已暂停，已记下的都保留着" : "已恢复：之后会继续记下并使用")}
      />
      <Toggle
        label="本项目不使用记忆"
        text="本项目除外"
        on={projectPaused}
        busy={busy === "project"}
        disabled={busy !== null}
        title={projectPaused
          ? "这个项目里的对话既不记下也不使用记忆，其他项目不受影响。"
          : "打开后，只有这个项目既不记下也不使用记忆，其他项目不受影响。"}
        onToggle={() => void change("project", {
          pausedProjects: projectPaused
            ? settings.pausedProjects.filter((id) => id !== projectId)
            : [...settings.pausedProjects, projectId],
        }, projectPaused ? "本项目已恢复使用记忆" : "本项目已停用记忆")}
      />
      <Button
        variant="ghost"
        size="sm"
        loading={busy === "reset"}
        disabled={busy !== null}
        title="永久删除这个账号的全部记忆；对话、报告、知识库和收到的胶囊都不动。"
        onClick={() => setConfirmingReset(true)}
      >
        {busy !== "reset" && <RotateCcw size={13} aria-hidden="true" />}
        重置全部记忆
      </Button>
      {confirmingReset && (
        <ConfirmDialog
          title="重置全部记忆？"
          body="将永久删除这个账号的全部记忆：EviMed 对你的理解、你的做法、项目事实、做过的研究和待确认项。不会删除对话与报告、知识库里的资料、收到的胶囊，上面的开关也保持不变。此操作无法撤销。"
          confirmLabel="全部删除"
          onConfirm={() => void reset()}
          onCancel={() => setConfirmingReset(false)}
        />
      )}
    </div>
  );
}

/**
 * One switch, drawn as the products people know draw one: a short name and
 * a track that slides. The accessible name is the whole sentence (`label`);
 * the visible word is the short one.
 */
function Toggle({ label, text, on, busy, disabled, title, onToggle }: {
  label: string;
  text: string;
  on: boolean;
  busy: boolean;
  disabled: boolean;
  title: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-busy={busy || undefined}
      title={title}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex h-8 items-center gap-2 rounded-full border border-border bg-surface px-3 text-ui text-text hover:border-strong disabled:opacity-60",
      )}
    >
      <span>{text}</span>
      <span
        aria-hidden="true"
        className={cn(
          "relative h-4 w-7 shrink-0 rounded-full transition-colors duration-fast",
          on ? "bg-accent" : "bg-strong",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-3 w-3 rounded-full bg-surface transition-[left] duration-fast",
            on ? "left-3.5" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}
