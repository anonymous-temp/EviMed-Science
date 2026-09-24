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
 * The memory page's header controls: one switch and one 「⋯」 (2026-09-23 plan
 * §5.6). The owner put the switches, the reset and sharing on the header's one
 * line (2026-09-22); they were four controls in four styles — two pill
 * switches, a bordered reset and a bordered 分享与导入 — and are now 「记忆」 and
 * a menu: 本项目除外 · 重置全部记忆 · 分享与导入 · 已忘记的内容.
 *
 * 「记忆」 is one decision over two stored halves (learning and recall, owner
 * ruling 2026-09-20); it reads on only when both are on, because a switch that
 * said 已开启 while recall was paused underneath would be untrue. 本项目除外
 * stops memory in this project only — what a researcher on a confidential
 * project asks for. Pausing deletes nothing; the reset does, and asks first.
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
      const removed = await resetMemory();
      toast.success(`已删除 ${removed.structured} 条记忆。`);
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
          {
            label: "本项目除外",
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
          { label: "重置全部记忆", destructive: true, disabled: busy, onSelect: () => setConfirmingReset(true) },
          "separator",
          { label: "分享与导入", onSelect: onShare },
          { label: "已忘记的内容", onSelect: onForgotten },
        ]}
      >
        <IconButton icon={MoreHorizontal} label="记忆设置" />
      </Menu>
      {confirmingReset && (
        <ConfirmDialog
          title="重置全部记忆？"
          body="将永久删除全部记忆，不可撤销；对话、报告、知识库不受影响。"
          confirmLabel="全部删除"
          onConfirm={() => void reset()}
          onCancel={() => setConfirmingReset(false)}
        />
      )}
    </>
  );
}
