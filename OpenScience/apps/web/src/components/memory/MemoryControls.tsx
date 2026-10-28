import { useEffect, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  fetchMemorySettings,
  getWebProjectId,
  resetMemory,
  updateMemorySettings,
  webErrorMessage,
  type WebMemorySettings,
} from "@/lib/apiClient";
import { useProjectLabels } from "@/lib/projectNames";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IconButton } from "@/components/ui/IconButton";
import { Menu } from "@/components/ui/Menu";
import { AsyncSwitch } from "@/components/ui/AsyncSwitch";

/** The three controls of the capsule, as `MemoryControls` hands them to the page that arranges them. */
export interface MemoryControlParts {
  /** 「记住这一条」: null for an account whose memory cannot take words typed on the page. */
  remember: ReactNode;
  /** The 「记忆」 switch (or the line that says it cannot be read). */
  memorySwitch: ReactNode;
  /** The 「⋯」 menu. */
  menu: ReactNode;
}

/**
 * The capsule's controls: one switch, one 「记住这一条」 and one 「⋯」 (2026-10-07 plan §3.2). The owner put the switch, the reset and
 * sharing together (2026-09-22); the menu holds the four things that are not a list: 分享与导入 · 已忘记的内容 · 当前项目（…）不使用记忆 ·
 * 重置记忆, and, where the memory takes words typed on the page, 从其他 AI 导入 beside the first (2026-10-25).
 *
 * They are one component because they share one read of the settings and one busy flag, and the page decides where each stands: the
 * memory page's left column puts the switch under the title and the button and the menu at its foot (`MemoryFrame`), so `children` is
 * handed the three as parts. Without `children` they are one row.
 *
 * 「记忆」 is one decision over two stored halves (learning and recall, owner ruling 2026-09-20); it reads on only when both are on,
 * because a switch that said 已开启 while recall was paused underneath would be untrue. 「当前项目（…）不使用记忆」 stops memory in the
 * project the shell is in — the sidebar's, which the item names — and nothing else: what a researcher on a confidential project asks for.
 * Pausing deletes nothing; the reset does, asks first, and says exactly what it clears: what the page shows (记忆, 做法 and the notes in
 * the researcher's own capsule), and none of what it does not (对话, 报告, 知识库 and the capsules others shared).
 */
export function MemoryControls({ onReset, onShare, onForgotten, onRemember, onImport, children }: {
  onReset: () => void;
  onShare: () => void;
  onForgotten: () => void;
  /** 「记住这一条」: present only for an account whose memory can take words typed on the page. */
  onRemember?: () => void;
  /** 「从其他 AI 导入」: bring in what another assistant remembered about the person; present only where memory can take words typed on the page. */
  onImport?: () => void;
  /** Where each control stands; one row when absent. */
  children?: (parts: MemoryControlParts) => ReactNode;
}) {
  const [settings, setSettings] = useState<WebMemorySettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const projectId = getWebProjectId();
  const projectName = useProjectLabels().get(projectId) ?? null;

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
  const projectPaused = settings?.pausedProjects.includes(projectId) ?? false;

  const remember = onRemember ? <Button size="md" variant="secondary" onClick={onRemember}>记住这一条</Button> : null;
  const memorySwitch = failed
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
    );
  const menu = (
    <Menu
      label="记忆设置"
      items={[
        { label: "分享与导入", onSelect: onShare },
        ...(onImport ? [{ label: "从其他 AI 导入", onSelect: onImport }] : []),
        { label: "已忘记的内容", onSelect: onForgotten },
        "separator",
        {
          label: projectName ? `当前项目（${projectName}）不使用记忆` : "当前项目不使用记忆",
          toggle: true,
          checked: projectPaused,
          disabled: !settings || busy,
          onSelect: () => {
            if (!settings) return;
            void change({
              pausedProjects: projectPaused
                ? settings.pausedProjects.filter((id) => id !== projectId)
                : [...settings.pausedProjects, projectId],
            }, projectPaused ? "当前项目已恢复使用记忆" : "当前项目已停用记忆");
          },
        },
        { label: "重置记忆", destructive: true, disabled: busy, onSelect: () => setConfirmingReset(true) },
      ]}
    >
      <IconButton icon={MoreHorizontal} label="记忆设置" />
    </Menu>
  );

  return (
    <>
      {/* An action is a button, and the memory section's buttons are `secondary` (the grey ground): bare text beside the switch read as one more
          label, not as something to press (owner, 2026-10-27). At the control height (36, as the 「⋯」 beside it, and the sidebar's current
          item): a filled 28 px button was a kind of control of its own, and a data page is held to ten. */}
      {children ? children({ remember, memorySwitch, menu }) : <>{remember}{memorySwitch}{menu}</>}
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
