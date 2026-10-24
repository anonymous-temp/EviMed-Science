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
import { Switch } from "@/components/ui/Switch";

/**
 * The memory page's header controls: one switch and one 「⋯」 (2026-10-07 plan
 * §3.2). The owner put the switch, the reset and sharing on the header's one
 * line (2026-09-22); the menu holds the four things that are not a list:
 * 分享与导入 · 已忘记的内容 · 本项目不使用记忆 · 重置记忆.
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
export function MemoryControls({ onReset, onSettingsChanged, onShare, onForgotten, onRemember, projectId: shown }: {
  /** The project 「本项目不使用记忆」 acts on: the one the page shows. `undefined` is the shell's own project; `null` is a page showing none that can be paused (the 「其他」 of the 项目 tab), where the item is off. */
  projectId?: string | null;
  onReset: () => void;
  /** A switch was changed: 项目 says 「本项目已暂停记忆」 from the same setting. */
  onSettingsChanged?: () => void;
  onShare: () => void;
  onForgotten: () => void;
  /** 「记住这一条」: present only for an account whose memory can take words typed on the page. */
  onRemember?: () => void;
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

  const change = async (patch: Parameters<typeof updateMemorySettings>[0], done: string) => {
    setBusy(true);
    try {
      setSettings(await updateMemorySettings(patch));
      toast.success(done);
      onSettingsChanged?.();
    } catch (error) {
      toast.error(`没有改成：${webErrorMessage(error, { fallback: "请稍后重试。" })}`);
    } finally {
      setBusy(false);
    }
  };
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
          <Switch
            showLabel
            label="记忆"
            checked={memoryOn}
            disabled={busy}
            onChange={() => void change({ learningPaused: memoryOn, recallPaused: memoryOn }, memoryOn ? "已暂停" : "已开启")}
          />
        )}
      <Menu
        label="记忆设置"
        items={[
          { label: "分享与导入", onSelect: onShare },
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
          body="将永久清空你的全部记忆、已学到的做法和经验，以及你自己胶囊里的记录，不可撤销。对话、报告、知识库和别人分享给你的胶囊不受影响。"
          confirmLabel="清空"
          onConfirm={() => void reset()}
          onCancel={() => setConfirmingReset(false)}
        />
      )}
    </>
  );
}
