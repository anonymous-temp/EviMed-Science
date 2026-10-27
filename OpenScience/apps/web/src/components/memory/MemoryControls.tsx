import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  fetchMemorySettings,
  getWebProjectId,
  resetMemory,
  updateMemorySettings,
  webErrorMessage,
  type WebMemorySettings,
} from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IconButton } from "@/components/ui/IconButton";
import { Menu } from "@/components/ui/Menu";
import { AsyncSwitch } from "@/components/ui/AsyncSwitch";

/**
 * The memory page's header controls: one switch and one 「⋯」 (2026-10-07 plan
 * §3.2). The owner put the switch, the reset and sharing on the header's one
 * line (2026-09-22); the menu holds the four things that are not a list:
 * 分享与导入 · 已忘记的内容 · 本项目不使用记忆 · 重置记忆, and, where the memory takes words typed on
 * the page, 从其他 AI 导入 beside the first (2026-10-25).
 *
 * 「记忆」 is one decision over two stored halves (learning and recall, owner
 * ruling 2026-09-20); it reads on only when both are on, because a switch that
 * said 已开启 while recall was paused underneath would be untrue. 本项目不使用记忆
 * stops memory in this project only — what a researcher on a confidential
 * project asks for. Pausing deletes nothing; the reset does, asks first, and
 * says exactly what it clears: what the page shows (记忆, 做法 and the notes in
 * the researcher's own capsule), and none of what it does not (对话, 报告, 知识库
 * and the capsules others shared).
 */
export function MemoryControls({ onReset, onSettingsChanged, onShare, onForgotten, onRemember, onImport, projectId: shown }: {
  /** The project 「本项目不使用记忆」 acts on: the one the page shows. `undefined` is the shell's own project; `null` is a page showing none that can be paused (the 「未归入项目」 of the 项目 tab), where the item is off. */
  projectId?: string | null;
  onReset: () => void;
  /** A switch was changed: 项目 says 「本项目已暂停记忆」 from the same setting. */
  onSettingsChanged?: () => void;
  onShare: () => void;
  onForgotten: () => void;
  /** 「记住这一条」: present only for an account whose memory can take words typed on the page. */
  onRemember?: () => void;
  /** 「从其他 AI 导入」: bring in what another assistant remembered about the person; present only where memory can take words typed on the page. */
  onImport?: () => void;
}) {
  const [settings, setSettings] = useState<WebMemorySettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const projectId = shown === undefined ? getWebProjectId() : shown;

  useEffect(() => {
    let cancelled = false;
    fetchMemorySettings()
      .then((next) => { if (!cancelled) setSettings(next); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const refusal = (error: unknown) => `没有改成：${webErrorMessage(error, { fallback: "请稍后重试。" })}`;
  /** The write; the answer is the settings, and what reads them (the switch, the menu) takes it from here. A failure is the caller's to say. */
  const save = async (patch: Parameters<typeof updateMemorySettings>[0], done: string) => {
    setBusy(true);
    try {
      const saved = await updateMemorySettings(patch);
      setSettings(saved);
      toast.success(done);
      onSettingsChanged?.();
      return saved;
    } finally {
      setBusy(false);
    }
  };
  /** From the menu: nothing else shows a failure there, so it is a toast. */
  const change = (patch: Parameters<typeof updateMemorySettings>[0], done: string) => save(patch, done).catch((error: unknown) => { toast.error(refusal(error)); });
  const reset = async () => {
    setConfirmingReset(false);
    setBusy(true);
    try {
      await resetMemory();
      toast.success("记忆已清空。");
      onReset();
    } catch (error) {
      toast.error(`重置没有完成：${webErrorMessage(error, { fallback: "请稍后重试。" })}`);
    } finally {
      setBusy(false);
    }
  };

  const memoryOn = settings ? !settings.learningPaused && !settings.recallPaused : false;
  const projectPaused = projectId !== null && (settings?.pausedProjects.includes(projectId) ?? false);

  return (
    <>
      {/* `text`, not `secondary`: a filled 28 px button is a look of its own, and on the map and the overview — held to the data page's ten kinds of
          control — one more look is the page over budget (measured: the map was at ten, and ten with this button as it was it was eleven). */}
      {onRemember && <Button size="sm" variant="text" onClick={onRemember}>记住这一条</Button>}
      {failed
        ? <span className="text-caption text-text-3">记忆开关暂时读取不到</span>
        : settings && (
          <AsyncSwitch
            readChecked={async () => { const fresh = await fetchMemorySettings(); setSettings(fresh); return !fresh.learningPaused && !fresh.recallPaused; }}
            showLabel
            label="记忆"
            checked={memoryOn}
            pending={busy}
            errorMessage={refusal}
            onChange={async () => {
              const saved = await save({ learningPaused: memoryOn, recallPaused: memoryOn }, memoryOn ? "已暂停" : "已开启");
              return !saved.learningPaused && !saved.recallPaused;
            }}
          />
        )}
      <Menu
        label="记忆设置"
        items={[
          { label: "分享与导入", onSelect: onShare },
          ...(onImport ? [{ label: "从其他 AI 导入", onSelect: onImport }] : []),
          { label: "已忘记的内容", onSelect: onForgotten },
          "separator",
          {
            label: "本项目不使用记忆",
            toggle: true,
            checked: projectPaused,
            disabled: !settings || busy || projectId === null,
            onSelect: () => {
              if (!settings || projectId === null) return;
              void change({
                pausedProjects: projectPaused
                  ? settings.pausedProjects.filter((id) => id !== projectId)
                  : [...settings.pausedProjects, projectId],
              }, projectPaused ? "本项目已恢复使用记忆" : "本项目已停用记忆");
            },
          },
          { label: "重置记忆", destructive: true, disabled: busy, onSelect: () => setConfirmingReset(true) },
        ]}
      >
        <IconButton icon={MoreHorizontal} label="记忆设置" />
      </Menu>
      {confirmingReset && (
        <ConfirmDialog
          title="重置记忆？"
          body="将永久清空你的全部记忆、已学到的做法，以及你自己胶囊里的记录，不可撤销。对话、报告、知识库和别人分享给你的胶囊不受影响。"
          confirmLabel="清空"
          onConfirm={() => void reset()}
          onCancel={() => setConfirmingReset(false)}
        />
      )}
    </>
  );
}
