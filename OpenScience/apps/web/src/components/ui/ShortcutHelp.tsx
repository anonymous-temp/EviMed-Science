import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { isMacPlatform } from "@/lib/platform";

/** Global `?` (Shift+/) cheat sheet. Lists every keyboard shortcut the app
 *  currently binds so they are discoverable in-product; Esc/click-outside
 *  closes it and focus returns to whatever had it before. */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  // Mirror for the one-time global listener below (avoids re-binding per open).
  const openRef = useRef(false);
  openRef.current = open;
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `?` is Shift+/ on US layouts; e.key already carries the shifted char.
      // Never steal it from a field the user is typing into.
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      // Consume Esc only while the panel is open — a marked-handled Esc must
      // not also interrupt a running agent turn (LiveSessionPage listens too).
      if (e.key === "Escape" && openRef.current) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus the panel on open; hand focus back to the previously focused element
  // on close so keyboard users land where they were.
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      panelRef.current?.focus();
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current.focus();
      restoreFocusRef.current = null;
    }
  }, [open]);

  if (!open) return null;

  const mod = isMacPlatform() ? "⌘" : "Ctrl+";
  const rows: { keys: string; description: string }[] = [
    { keys: `${mod}B`, description: "收起 / 展开侧边栏" },
    { keys: `${mod}K`, description: "打开命令面板" },
    { keys: "?", description: "打开 / 关闭本面板" },
    { keys: "Esc", description: "关闭弹层；在会话页中断正在运行的任务" },
    { keys: "Enter", description: "发送消息" },
    { keys: "Shift+Enter", description: "消息换行" },
    { keys: "↑ / ↓", description: "选择斜杠命令；输入框开头按 ↑ 翻看历史输入" },
    { keys: "Tab", description: "补全选中的斜杠命令" },
  ];

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- click-outside dismisses the panel; the keyboard equivalent is the global Escape handler above.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[16vh]"
      onClick={() => setOpen(false)}
    >
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- stopPropagation only, so clicks inside do not dismiss; no activation semantics here. */}
      <div onClick={(e) => e.stopPropagation()}>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="键盘快捷键"
          tabIndex={-1}
          className="w-full max-w-md rounded-card border border-border bg-surface shadow-pop outline-none"
        >
          <header className="flex items-center gap-2 border-b border-border px-4 py-3">
            <h2 className="flex-1 text-sm font-medium text-text">键盘快捷键</h2>
            <button
              onClick={() => setOpen(false)}
              aria-label="关闭快捷键面板"
              className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
            >
              <X size={14} />
            </button>
          </header>
          <ul className="px-4 py-3">
            {rows.map((row) => (
              <li
                key={row.keys}
                className="flex items-center gap-3 border-b border-border py-2 text-ui last:border-b-0"
              >
                <kbd className="w-28 shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-center font-mono text-xs text-text ring-1 ring-border">
                  {row.keys}
                </kbd>
                <span className="text-muted">{row.description}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
