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
export function MemoryControls({ onReset, onShare, onForgotten }: {
  onReset: () => void;
  onShare: () => void;
  onForgotten: () => void;
}) {
  const [settings, setSettings] = useState<WebMemorySettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const projectId = getWebProjectId();

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
  const projectPaused = settings?.pausedProjects.includes(projectId) ?? false;

  return (
    <>
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
            disabled: !settings || busy,
            onSelect: () => {
              if (!settings) return;
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
