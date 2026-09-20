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
 * Two switches, and a reset behind a confirmation.
 *
 * There were three: 「从对话中学习新记忆」, 「回答时参考记忆」 and
 * 「当前项目使用记忆」. The first two are one decision — nobody wants a
 * platform that keeps learning things it will never use, or that uses things it
 * has stopped learning — and splitting them made the page ask the researcher to
 * reason about the platform's internals to answer a question about themselves
 * (owner ruling 2026-09-20: 三个开关并成两个). They are set together now, and
 * the store still holds them apart, so a deployment or a script that paused one
 * of them keeps that state until this switch is next touched.
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
      <p className="text-ui text-muted">记忆开关暂时读取不到，刷新页面后再试。记忆本身不受影响。</p>
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

  const rows: { key: SwitchKey; label: string; on: boolean; detail: string; toggle: () => void }[] = [
    {
      key: "memory",
      label: "让 EviMed 记住并使用",
      on: memoryOn,
      detail: memoryOn
        ? "对话结束后自动记下值得长期保留的内容，之后回答时按当前问题挑相关的用上。"
        : "已暂停：不再记下新的，也不再在回答时使用已有的。已记下的都保留着。",
      toggle: () => void change("memory", { learningPaused: memoryOn, recallPaused: memoryOn },
        memoryOn ? "已暂停，已记下的都保留着" : "已恢复：之后会继续记下并使用"),
    },
    {
      key: "project",
      label: "本项目不使用记忆",
      on: projectPaused,
      detail: projectPaused
        ? "这个项目里的对话既不记下也不使用记忆，其他项目不受影响。"
        : "打开后，只有这个项目既不记下也不使用记忆。",
      toggle: () => void change("project", {
        pausedProjects: projectPaused
          ? settings.pausedProjects.filter((id) => id !== projectId)
          : [...settings.pausedProjects, projectId],
      }, projectPaused ? "本项目已恢复使用记忆" : "本项目已停用记忆"),
    },
  ];

  return (
    <section aria-labelledby="memory-controls-title" className="rounded-card border border-border bg-surface">
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
              <p className="mt-0.5 text-ui text-muted">{row.detail}</p>
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
              className={cn("min-w-16", row.on === (row.key === "memory") ? "text-ok" : "text-muted")}
            >
              {row.on ? "已开启" : "已关闭"}
            </Button>
          </li>
        ))}
      </ul>
      {confirmingReset && (
        <ConfirmDialog
          title="重置全部记忆？"
          body="将永久删除这个账号的全部记忆：EviMed 对你的理解、你的做法、项目事实、做过的研究和待确认项。不会删除对话与报告、知识库里的资料、收到的胶囊，上面的开关也保持不变。此操作无法撤销。"
          confirmLabel="全部删除"
          onConfirm={() => void reset()}
          onCancel={() => setConfirmingReset(false)}
        />
      )}
    </section>
  );
}
