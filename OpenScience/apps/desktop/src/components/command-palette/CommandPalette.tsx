import { useEffect } from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router";
import {
  Bot,
  Brain,
  FileSearch,
  FlaskConical,
  FolderTree,
  Moon,
  NotebookPen,
  Settings,
  ShieldCheck,
  SquarePen,
} from "lucide-react";
import { useUiStore, type Theme } from "@/lib/store";
import { useRuntimeStore } from "@/lib/runtime";
import { hasWebApi } from "@/lib/apiClient";
import { isTauri } from "@/lib/tauri";
import { WORKFLOW_STARTERS } from "@/components/thread/WorkflowStarters";

interface Action {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** Extra right-aligned hint (e.g. the current theme); not searched. */
  hint?: string;
  run: () => void;
}

/** Prompt for a starter workflow by id, so ⌘K and the empty-session cards stay in sync. */
const starterPrompt = (id: string) => WORKFLOW_STARTERS.find((s) => s.id === id)?.prompt ?? "";

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
  // Memory and workflow pages exist only against the hosted backend — mirror
  // the Sidebar nav so the palette never offers a dead end on the desktop.
  const hostedWeb = hasWebApi && !isTauri;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!useUiStore.getState().paletteOpen);
      }
      // Consume Esc only when the palette is open — a marked-handled Esc must
      // not also interrupt a running agent turn (LiveSessionPage listens too).
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

  // Start a new session and send a workflow prompt, then reveal that session.
  // An unknown starter id resolves to "" — never create a session for it.
  const runWorkflow = async (starterId: string) => {
    close();
    const prompt = starterPrompt(starterId);
    if (!prompt.trim()) return;
    useRuntimeStore.getState().startDraft();
    const id = await useRuntimeStore.getState().sendPrompt(prompt);
    if (id) navigate(`/live/${id}`);
  };

  const navigation: Action[] = [
    { id: "new", label: "新任务", icon: <SquarePen size={16} />, run: () => { useRuntimeStore.getState().startDraft(); go("/live"); } },
    { id: "files", label: "知识库", icon: <FolderTree size={16} />, run: () => go("/files") },
    { id: "notebooks", label: "科研笔记本", icon: <NotebookPen size={16} />, run: () => go("/notebooks") },
    ...(hostedWeb
      ? [
          { id: "memory", label: "科研记忆", icon: <Brain size={16} />, run: () => go("/memory") },
          { id: "agents", label: "科研工作流", icon: <Bot size={16} />, run: () => go("/agents") },
        ]
      : []),
    { id: "runs", label: "运行记录", icon: <FlaskConical size={16} />, run: () => go("/runs") },
  ];

  const actions: Action[] = [
    { id: "settings", label: "打开设置", icon: <Settings size={16} />, run: () => go("/settings") },
    { id: "theme", label: "切换主题", hint: THEME_LABEL[theme], icon: <Moon size={16} />, run: () => { toggleTheme(); close(); } },
    { id: "analyze", label: "分析研究数据", icon: <FileSearch size={16} />, run: () => void runWorkflow("data-analysis") },
    { id: "review", label: "核查报告与证据", icon: <ShieldCheck size={16} />, run: () => void runWorkflow("evidence-audit") },
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
