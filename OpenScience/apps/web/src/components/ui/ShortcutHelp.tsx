import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { isMacPlatform } from "@/lib/platform";
import { trapTab } from "@/lib/focusTrap";
import { useUiStore } from "@/lib/store";
import { IconButton } from "@/components/ui/IconButton";

/** Toggles the cheat sheet from outside it: the chat frame forwards `?` when
 *  focus is inside it, where this component's own listener cannot hear it. */
export const SHORTCUT_HELP_TOGGLE_EVENT = "evimed:shortcut-help-toggle";

/** Global `?` (Shift+/) cheat sheet. Lists every keyboard shortcut the shell
 *  binds so they are discoverable in-product; Esc/click-outside closes it and
 *  focus returns to whatever had it before.
 *
 *  `?` is a single-character shortcut, so it has an off switch (设置 · 外观;
 *  WCAG 2.2 SC 2.1.4): off, the key is left alone — it types, and it is not
 *  swallowed. The conversation frame's forwarded `?` is held to the same
 *  switch where it is received (`RuntimeUiFrame`). */
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
        if (!useUiStore.getState().singleKeyShortcuts) return;
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
      // A modal layer keeps Tab inside it.
      if (e.key === "Tab" && openRef.current) trapTab(panelRef.current, e);
    };
    const onToggle = () => setOpen((v) => !v);
    window.addEventListener("keydown", onKey);
    window.addEventListener(SHORTCUT_HELP_TOGGLE_EVENT, onToggle);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SHORTCUT_HELP_TOGGLE_EVENT, onToggle);
    };
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
    { keys: "?", description: "打开 / 关闭本面板" },
    { keys: "Esc", description: "关闭弹层" },
  ];
  // The composer's own keys (send, new line, slash commands) belong to the
  // conversation surface, which lists and handles them itself. This table used
  // to repeat those of a composer that no longer exists (2026-09-16 review, U8).

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- click-outside dismisses the panel; the keyboard equivalent is the global Escape handler above.
    <div
      className="fixed inset-0 z-modal flex items-start justify-center bg-scrim pt-[16vh]"
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
          className="w-full max-w-md rounded-panel border border-border bg-surface shadow-e3 outline-none"
        >
          <header className="flex h-11 items-center gap-2 border-b border-border px-4">
            <h2 className="flex-1 text-ui font-medium text-text">键盘快捷键</h2>
            <IconButton icon={X} label="关闭快捷键面板" size="sm" onClick={() => setOpen(false)} />
          </header>
          <ul className="px-4 py-3">
            {rows.map((row) => (
              <li
                key={row.keys}
                className="flex h-9 items-center gap-3 border-b border-border text-ui last:border-b-0"
              >
                <kbd className="w-28 shrink-0 rounded bg-surface-1 px-2 py-1 text-center font-mono text-caption text-text ring-1 ring-border">
                  {row.keys}
                </kbd>
                <span className="text-muted">{row.description}</span>
              </li>
            ))}
          </ul>
          <p className="border-t border-border px-4 py-3 text-caption text-muted">
            对话输入框里的按键（发送、换行、斜杠命令）由对话界面自己处理。
          </p>
        </div>
      </div>
    </div>
  );
}
