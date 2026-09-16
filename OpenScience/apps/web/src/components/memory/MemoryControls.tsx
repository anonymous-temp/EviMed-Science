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

type SwitchKey = "learning" | "recall" | "project";

/**
 * The researcher's own controls over memory (2026-09-16 review, M4④): pause
 * learning, pause use, leave this project out, and reset.
 *
 * Pause and reset are kept apart on purpose, as the products people already
 * trust do: a pause deletes nothing and is undone by the same switch, while a
 * reset deletes and says exactly what it deletes and what it leaves. The
 * switches are phrased as what is on, so the default state reads as three
 * things that are happening rather than three things that are not paused.
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
      <p className="mt-6 text-ui-sm text-muted">记忆开关暂时读取不到，刷新页面后再试。记忆本身不受影响。</p>
    );
  }
  if (!settings) return null;

  const projectPaused = settings.pausedProjects.includes(projectId);
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
      toast.success(`已删除 ${removed.structured} 条记忆和 ${removed.manual} 条笔记。`);
      onReset();
    } catch (error) {
      toast.error(`重置没有完成：${webErrorMessage(error, { fallback: "请稍后重试。" })}`);
    } finally {
      setBusy(null);
    }
  };

  const rows: { key: SwitchKey; label: string; on: boolean; detail: string; toggle: () => void }[] = [
    {
      key: "learning",
      label: "从对话中学习新记忆",
      on: !settings.learningPaused,
      detail: settings.learningPaused
        ? "已暂停：之后的对话不会写入新记忆，已有记忆保留。"
        : "对话结束后，EviMed 会提炼值得长期保留的背景与偏好。",
      toggle: () => void change("learning", { learningPaused: !settings.learningPaused },
        settings.learningPaused ? "已恢复学习新记忆" : "已暂停学习新记忆，已有记忆保留"),
    },
    {
      key: "recall",
      label: "回答时参考记忆",
      on: !settings.recallPaused,
      detail: settings.recallPaused
        ? "已暂停：回答不再参考科研记忆，记忆本身没有删除。方法胶囊按各自的启用状态使用。"
        : "EviMed 会按当前问题挑选相关记忆作为背景。",
      toggle: () => void change("recall", { recallPaused: !settings.recallPaused },
        settings.recallPaused ? "回答会重新参考记忆" : "回答已暂停参考记忆，记忆本身没有删除"),
    },
    {
      key: "project",
      label: "当前项目使用记忆",
      on: !projectPaused,
      detail: projectPaused
        ? "已暂停：这个项目里的对话既不学习也不参考记忆，其他项目不受影响。"
        : "只影响当前项目；关闭后这个项目既不学习也不参考记忆。",
      toggle: () => void change("project", {
        pausedProjects: projectPaused
          ? settings.pausedProjects.filter((id) => id !== projectId)
          : [...settings.pausedProjects, projectId],
      }, projectPaused ? "当前项目已恢复使用记忆" : "当前项目已暂停使用记忆"),
    },
  ];

  return (
    <section aria-labelledby="memory-controls-title" className="mt-7 rounded-card border border-border bg-surface shadow-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 id="memory-controls-title" className="text-ui font-medium text-text">记忆开关</h2>
        <Button variant="ghost" size="sm" loading={busy === "reset"} disabled={busy !== null} onClick={() => setConfirmingReset(true)}>
          {busy !== "reset" && <RotateCcw size={13} aria-hidden="true" />}
          重置全部记忆
        </Button>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-4 px-5 py-3">
            <div className="min-w-0">
              <p className="text-ui text-text">{row.label}</p>
              <p className="mt-0.5 text-ui-sm text-muted">{row.detail}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              role="switch"
              aria-checked={row.on}
              aria-label={row.label}
              loading={busy === row.key}
              disabled={busy !== null}
              onClick={row.toggle}
              className={cn("min-w-16", row.on ? "text-ok" : "text-muted")}
            >
              {row.on ? "已开启" : "已暂停"}
            </Button>
          </li>
        ))}
      </ul>
      {confirmingReset && (
        <ConfirmDialog
          title="重置全部记忆？"
          body="将永久删除这个账号的全部科研记忆：画像、偏好、项目事实、运行摘要、待确认项和手写笔记。不会删除对话与运行记录、交付文件、知识库来源和方法胶囊，上面的开关也保持不变。此操作无法撤销。"
          confirmLabel="全部删除"
          onConfirm={() => void reset()}
          onCancel={() => setConfirmingReset(false)}
        />
      )}
    </section>
  );
}
