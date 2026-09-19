import { useEffect, useRef } from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router";
import {
  Bell,
  Bot,
  Brain,
  FlaskConical,
  FolderTree,
  ListFilter,
  Orbit,
  Moon,
  Settings,
  SquarePen,
  UserRound,
} from "lucide-react";
import { useUiStore, type Theme } from "@/lib/store";
import { trapTab } from "@/lib/focusTrap";
import { isMacPlatform } from "@/lib/platform";

import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";

interface Action {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** Extra right-aligned hint (e.g. the current theme); not searched. */
  hint?: string;
  run: () => void;
}

const THEME_LABEL: Record<Theme, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!useUiStore.getState().paletteOpen);
      }
      if (!useUiStore.getState().paletteOpen) return;
      // Consume Esc only when the palette is open, so a marked-handled Esc is
      // not also read as a dismissal by whatever is behind it.
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
      // A modal layer keeps Tab inside it (appendix D §4).
      if (e.key === "Tab") trapTab(dialogRef.current, e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  // Focus goes into the search field on open, and back to whatever had it on close.
  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      const element = restoreFocus.current;
      if (element && document.contains(element)) element.focus();
    };
  }, [open]);

  const close = () => setOpen(false);
  const go = (to: string) => {
    navigate(to);
    close();
  };

  // The six destinations plus the views inside them. The palette may be longer
  // than the sidebar — typing a name is how someone reaches a view without
  // knowing which destination now owns it.
  const navigation: Action[] = [
    { id: "new", label: "新任务", icon: <SquarePen size={16} aria-hidden="true" />, run: () => { navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent() } }); close(); } },
    { id: "runs", label: "运行记录", icon: <FlaskConical size={16} aria-hidden="true" />, run: () => go("/app/runs") },
    { id: "files", label: "知识库", icon: <FolderTree size={16} aria-hidden="true" />, run: () => go("/app/files") },
    { id: "sources", label: "资料整理进度", icon: <ListFilter size={16} aria-hidden="true" />, run: () => go("/app/files?tab=sources") },
    { id: "memory", label: "记忆胶囊", icon: <Brain size={16} aria-hidden="true" />, run: () => go("/app/memory") },
    { id: "capsules", label: "方法", icon: <Brain size={16} aria-hidden="true" />, run: () => go("/app/memory?tab=methods") },
    { id: "capsule-timeline", label: "胶囊时间轴", icon: <Brain size={16} aria-hidden="true" />, run: () => go("/app/memory?tab=timeline") },
    { id: "autopilot", label: "主动科研", icon: <Orbit size={16} aria-hidden="true" />, run: () => go("/app/autopilot") },
    { id: "capabilities", label: "科研能力", icon: <Bot size={16} aria-hidden="true" />, run: () => go("/app/capabilities") },
    { id: "inbox", label: "收件箱", icon: <Bell size={16} aria-hidden="true" />, run: () => go("/app/inbox") },
  ];

  // Task creation travels as a native navigation intent; no prompt is submitted.
  const actions: Action[] = [
    { id: "account", label: "账户与额度", icon: <UserRound size={16} aria-hidden="true" />, run: () => go("/app/account") },
    { id: "settings", label: "打开设置", icon: <Settings size={16} aria-hidden="true" />, run: () => go("/app/account?tab=settings") },
    { id: "theme", label: "切换主题", hint: THEME_LABEL[theme], icon: <Moon size={16} aria-hidden="true" />, run: () => { toggleTheme(); close(); } },
  ];

  if (!open) return null;

  const mod = isMacPlatform() ? "⌘" : "Ctrl ";
  return (
    // The backdrop has no keyboard handler on purpose: Escape is its keyboard
    // equivalent, bound above; role="presentation" keeps it out of the tree.
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[16vh]"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="命令面板" className="w-full max-w-lg">
        <Command
          label="快捷操作"
          className="overflow-hidden rounded-card border border-border bg-surface shadow-pop"
        >
          <Command.Input
            ref={inputRef}
            placeholder="搜索操作…"
            className="w-full border-b border-border bg-transparent px-4 py-3 text-ui text-text outline-none placeholder:text-muted"
          />
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-ui text-muted">
              未找到匹配操作。
            </Command.Empty>
            <PaletteGroup heading="导航" items={navigation} />
            <PaletteGroup heading="动作" items={actions} />
          </Command.List>
          <p className="flex items-center gap-3 border-t border-border px-4 py-2 text-caption text-muted">
            <span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span>
            <span className="ml-auto">{mod}K 随时打开</span>
          </p>
        </Command>
      </div>
    </div>
  );
}

function PaletteGroup({ heading, items }: { heading: string; items: Action[] }) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted"
    >
      {items.map((a) => (
        <Command.Item
          key={a.id}
          value={a.label}
          onSelect={a.run}
          className="flex cursor-pointer items-center gap-3 rounded-input px-3 py-2 text-ui text-text data-[selected=true]:bg-surface-2"
        >
          <span className="text-muted">{a.icon}</span>
          {a.label}
          {a.hint && <span className="ml-auto text-caption text-muted">{a.hint}</span>}
        </Command.Item>
      ))}
    </Command.Group>
  );
}
