import { useEffect } from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router";
import {
  Bot,
  Brain,
  FlaskConical,
  FolderTree,
  Moon,
  NotebookPen,
  Settings,
  SquarePen,
  UserRound,
} from "lucide-react";
import { useUiStore, type Theme } from "@/lib/store";

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!useUiStore.getState().paletteOpen);
      }
      // Consume Esc only when the palette is open, so a marked-handled Esc is
      // not also read as a dismissal by whatever is behind it.
      if (e.key === "Escape" && useUiStore.getState().paletteOpen) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const close = () => setOpen(false);
  const go = (to: string) => {
    navigate(to);
    close();
  };

  const navigation: Action[] = [
    { id: "new", label: "新任务", icon: <SquarePen size={16} />, run: () => go("/app/chat") },
    { id: "runs", label: "运行记录", icon: <FlaskConical size={16} />, run: () => go("/app/runs") },
    { id: "files", label: "知识库", icon: <FolderTree size={16} />, run: () => go("/app/files") },
    { id: "notebooks", label: "科研笔记本", icon: <NotebookPen size={16} />, run: () => go("/app/notebooks") },
    { id: "memory", label: "科研记忆", icon: <Brain size={16} />, run: () => go("/app/memory") },
    { id: "capabilities", label: "能力模板", icon: <Bot size={16} />, run: () => go("/app/capabilities") },
  ];

  // The palette navigates and changes appearance; it no longer starts a
  // conversation. Starting one means typing into the session surface, and that
  // surface is a frame on another origin — a prompt this shell "sent" would
  // have had to travel through a store the shell no longer owns, which is how
  // a palette entry becomes a button that does nothing.
  const actions: Action[] = [
    { id: "account", label: "账户与额度", icon: <UserRound size={16} />, run: () => go("/app/account") },
    { id: "settings", label: "打开设置", icon: <Settings size={16} />, run: () => go("/app/settings") },
    { id: "theme", label: "切换主题", hint: THEME_LABEL[theme], icon: <Moon size={16} />, run: () => { toggleTheme(); close(); } },
  ];

  if (!open) return null;

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- click-outside dismisses the palette; the keyboard equivalent is the global Escape handler above.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[16vh]"
      onClick={close}
    >
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- stopPropagation only, so clicks inside do not dismiss; no activation semantics here. */}
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg">
        <Command
          label="快捷操作"
          className="overflow-hidden rounded-card border border-border bg-surface shadow-pop"
        >
          <Command.Input
            autoFocus
            placeholder="搜索操作…"
            className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-text outline-none placeholder:text-muted"
          />
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
              未找到匹配操作。
            </Command.Empty>
            <PaletteGroup heading="导航" items={navigation} />
            <PaletteGroup heading="动作" items={actions} />
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function PaletteGroup({ heading, items }: { heading: string; items: Action[] }) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted"
    >
      {items.map((a) => (
        <Command.Item
          key={a.id}
          value={a.label}
          onSelect={a.run}
          className="flex cursor-pointer items-center gap-3 rounded-input px-3 py-2 text-sm text-text data-[selected=true]:bg-surface-2"
        >
          <span className="text-muted">{a.icon}</span>
          {a.label}
          {a.hint && <span className="ml-auto text-xs text-muted">{a.hint}</span>}
        </Command.Item>
      ))}
    </Command.Group>
  );
}
