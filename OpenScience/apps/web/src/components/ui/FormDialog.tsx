import { isComposingKey } from "@/lib/compositionKeys";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { focusableIn, registerFocusLayer, ownsKeyboard, trapTab } from "@/lib/focusTrap";
import { useUnsavedGuard } from "@/lib/useUnsavedGuard";
import { IconButton } from "./IconButton";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Component: FormDialog; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: heading, scrolling form, persistent error summary and optional footer.
 * Variants: centered bounded form.
 * States: busy retains reachable fields; dirty exits request discard confirmation.
 * Hit area: shared IconButton and caller footer controls.
 * Keyboard: top layer traps Tab; Escape requests close; opener regains focus.
 * Long content: body scrolls independently of the footer and summary.
 * Theme: semantic surface, text and error roles in both themes.
 * Responsive: viewport padding bounds the panel on narrow screens.
 * Verification: FormDialog.test.tsx; browser/AT validation remains separate.
 */
export function FormDialog({ title, children, onClose, busy = false, dirty = false, footer, errors = [] }: {
  title: string; children: ReactNode | ((requestClose: () => void, markSaved: () => void) => ReactNode); onClose: () => void; busy?: boolean; dirty?: boolean; footer?: ReactNode;
  errors?: readonly { message: string; fieldId?: string }[];
}) {
  const panel = useRef<HTMLDivElement>(null), titleId = useId(), errorId = useId();
  const guard = useUnsavedGuard(dirty, onClose, busy);
  const requestClose = useRef(guard.requestClose); requestClose.current = guard.requestClose;
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unregister = registerFocusLayer(panel.current);
    const field = focusableIn(panel.current).find(element => element.matches("input,textarea,select"));
    (field ?? panel.current)?.focus();
    const key = (event: KeyboardEvent) => {
      if (!ownsKeyboard(panel.current, event)) return;
      if (event.key === "Escape" && !isComposingKey(event)) { event.preventDefault(); event.stopPropagation(); requestClose.current(); }
      else trapTab(panel.current, event);
    };
    document.addEventListener("keydown", key);
    return () => { unregister(); document.removeEventListener("keydown", key); trigger?.focus(); };
  }, []);
  return <>
    <div role="presentation" className="fixed inset-0 z-modal flex items-center justify-center bg-scrim p-4" onClick={event => { if (event.target === event.currentTarget) guard.requestClose(); }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={errors.length ? errorId : undefined} aria-busy={busy || undefined} className="flex max-h-full w-full max-w-xl flex-col rounded-panel border border-border bg-surface shadow-e3 focus:outline-none">
        <header className="flex shrink-0 items-center justify-between gap-3 px-6 pb-3 pt-5"><h2 id={titleId} className="text-body font-semibold text-text">{title}</h2><IconButton icon={X} label="关闭" disabled={busy} onClick={guard.requestClose} /></header>
        {errors.length > 0 && <div id={errorId} className="shrink-0 px-6 pb-3 text-ui text-error"><p>请检查以下内容：</p><ul>{errors.map((error, index) => <li key={index}>{error.fieldId ? <a href={`#${error.fieldId}`} onClick={event => { event.preventDefault(); document.getElementById(error.fieldId!)?.focus(); }}>{error.message}</a> : error.message}</li>)}</ul></div>}
        <div className="min-h-0 overflow-y-auto px-6 pb-5">{typeof children === "function" ? children(guard.requestClose, guard.markSaved) : children}</div>
        {footer && <footer className="shrink-0 border-t border-border px-6 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</footer>}
      </div>
    </div>
    {guard.confirming && <ConfirmDialog title="放弃未保存的修改？" subject={title} consequences="未保存的修改将丢失。" recovery="返回编辑可继续保留修改。" confirmLabel="放弃修改" onConfirm={guard.discard} onCancel={guard.keepEditing} />}
  </>;
}
