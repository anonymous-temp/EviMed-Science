import { isComposingKey } from "@/lib/compositionKeys";
import { useUnsavedGuard } from "@/lib/useUnsavedGuard";
import { ConfirmDialog } from "./ConfirmDialog";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { focusableIn, trapTab, registerFocusLayer, isTopFocusLayer } from "@/lib/focusTrap";
import { IconButton } from "@/components/ui/IconButton";

/**
 * Component: Drawer; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: heading, scrolling body and optional sticky footer.
 * Variants: right drawer or bottom sheet; bare content option.
 * States: dirty exits share unsaved guard; busy blocks dismissal.
 * Hit area: shared close IconButton.
 * Keyboard: top layer traps Tab; Escape requests close and focus returns.
 * Long content: body scrolls while footer stays reachable.
 * Theme: semantic surface and border.
 * Responsive: full width below maximum; bottom sheet bounded at 85vh.
 * Verification: focusTrap.test.ts and FormDialog.test.tsx; browser/AT remain separate.
 */
export function Drawer({
  title,
  description,
  onClose,
  children,
  actions,
  footer,
  className,
  widthClassName = "max-w-xl",
  bare = false,
  placement = "right",
  dirty = false,
  busy = false,
}: {
  /** Names the dialog; with `bare`, it must be text (it becomes the label). */
  title: ReactNode;
  /** One quiet line under the title. */
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Controls placed in the header, left of the close button. */
  actions?: ReactNode;
  /** The bar stuck to the bottom of the panel, below the scrolling body. */
  footer?: ReactNode;
  className?: string;
  widthClassName?: string;
  /** The content brings its own header and close control (a file preview, say). */
  bare?: boolean;
  /** `bottom`: a sheet rising from the window's bottom edge. */
  placement?: "right" | "bottom";
  dirty?: boolean;
  busy?: boolean;
}) {
  const sheet = placement === "bottom";
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const guard = useUnsavedGuard(dirty, onClose, busy);
  const close = useRef(guard.requestClose);
  close.current = guard.requestClose;

  useEffect(() => {
    const unregister = registerFocusLayer(panelRef.current);
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The panel itself takes focus, announced by its title. Focusing the corner 关闭 here showed that button's tooltip
    // unasked, and the tooltip — the top layer while it is up — took the reader's first Escape, so every drawer needed
    // two presses to close (the release-11 walk of the evidence matrix). Tab from the panel reaches 关闭 first.
    if (panelRef.current) panelRef.current.focus();
    else focusableIn(panelRef.current)[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      // A dialog opened from inside the drawer (a confirmation, an edit form) is a modal layer of its
      // own: while it is up Tab and Escape are its, not this panel's, or one Escape would close both.
      if (!isTopFocusLayer(panelRef.current)) return;
      if (event.key === "Escape" && !isComposingKey(event)) {
        // Handled: another listener on the document (the sidebar's, below `lg`) must not close its own layer with the same press.
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else {
        trapTab(panelRef.current, event);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      unregister();
      document.removeEventListener("keydown", onKey);
      trigger?.focus();
    };
  }, []);

  return (<>
    {/* Escape is the keyboard equivalent of clicking the presentation backdrop. */}
    <div
      role="presentation"
      className={cn("fixed inset-0 z-drawer flex bg-scrim", sheet ? "items-end justify-center" : "justify-end")}
      onClick={(event) => { if (event.target === event.currentTarget) close.current(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby={bare ? undefined : titleId}
        aria-label={bare && typeof title === "string" ? title : undefined}
        aria-describedby={description && !bare ? descriptionId : undefined}
        className={cn(
          // Slides in 24 px; a pure fade under reduced motion (the distance
          // token is 0 there), which is why this is not `motion-safe:` only.
          "flex w-full flex-col border-border bg-surface shadow-e3 focus:outline-none",
          sheet ? "max-h-[85vh] rounded-t-panel border-t animate-toast-in" : cn("h-full border-l animate-drawer-in", widthClassName),
          className,
        )}
      >
        {bare ? (
          <div className="min-h-0 flex-1">{children}</div>
        ) : (
          <>
            <header className={cn("flex items-start gap-3 border-b border-border", sheet ? "px-4 py-3" : "px-6 py-4")}>
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-title font-semibold text-text">{title}</h2>
                {description && <p id={descriptionId} className="mt-1 text-caption text-muted">{description}</p>}
              </div>
              {actions}
              {/* The dialog's corner close: a 36 px icon button (spec §17.2). */}
              <IconButton ref={closeRef} icon={X} label="关闭" disabled={busy} onClick={() => close.current()} />

            </header>
            <div className={cn("min-h-0 flex-1 overflow-y-auto", sheet ? "px-4 py-4" : "px-6 py-6")}>{children}</div>
            {footer && (
              <footer className={cn("shrink-0 border-t border-border bg-surface pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]", sheet ? "px-4" : "px-6")}>{footer}</footer>
            )}
          </>
        )}
      </div>
    </div>
    {guard.confirming && <ConfirmDialog title="放弃未保存的修改？" consequences="未保存的修改将丢失。" recovery="返回编辑可继续保留修改。" confirmLabel="放弃修改" onConfirm={guard.discard} onCancel={guard.keepEditing} />}
  </>);
}
