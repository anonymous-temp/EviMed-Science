import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { focusableIn, trapTab } from "@/lib/focusTrap";
import { IconButton } from "@/components/ui/IconButton";

/**
 * A panel that slides over the page from the right: a capability's card, a
 * file's preview, a report beside the run it came from.
 *
 * It is a modal dialog in every sense a keyboard or a screen reader can tell
 * (appendix D §4): `role="dialog"` named by its heading, focus moved in on
 * open and trapped while open, Escape and the backdrop close it, and focus
 * goes back to whatever opened it. The shell had four hand-rolled overlays
 * that each did some of this.
 */
export function Drawer({
  title,
  description,
  onClose,
  children,
  actions,
  className,
  widthClassName = "max-w-xl",
  bare = false,
}: {
  /** Names the dialog; with `bare`, it must be text (it becomes the label). */
  title: ReactNode;
  /** One quiet line under the title. */
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Controls placed in the header, left of the close button. */
  actions?: ReactNode;
  className?: string;
  widthClassName?: string;
  /** The content brings its own header and close control (a file preview, say). */
  bare?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (closeRef.current) closeRef.current.focus();
    else focusableIn(panelRef.current)[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      // A dialog opened from inside the drawer (a confirmation, an edit form) is a modal layer of its
      // own: while it is up Tab and Escape are its, not this panel's, or one Escape would close both.
      const layer = event.target instanceof Element ? event.target.closest('[aria-modal="true"]') : null;
      if (layer && layer !== panelRef.current) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
      } else {
        trapTab(panelRef.current, event);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      trigger?.focus();
    };
  }, []);

  return (
    // The backdrop has no keyboard handler on purpose: Escape is its keyboard
    // equivalent, bound above; role="presentation" keeps it out of the tree.
    <div
      role="presentation"
      className="fixed inset-0 z-drawer flex justify-end bg-scrim"
      onClick={(event) => { if (event.target === event.currentTarget) close.current(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={bare ? undefined : titleId}
        aria-label={bare && typeof title === "string" ? title : undefined}
        aria-describedby={description && !bare ? descriptionId : undefined}
        className={cn(
          // Slides in 24 px; a pure fade under reduced motion (the distance
          // token is 0 there), which is why this is not `motion-safe:` only.
          "flex h-full w-full flex-col border-l border-border bg-surface shadow-e3 animate-drawer-in",
          widthClassName,
          className,
        )}
      >
        {bare ? (
          <div className="min-h-0 flex-1">{children}</div>
        ) : (
          <>
            <header className="flex items-start gap-3 border-b border-border px-6 py-4">
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-title font-semibold text-text">{title}</h2>
                {description && <p id={descriptionId} className="mt-1 text-caption text-muted">{description}</p>}
              </div>
              {actions}
              {/* The dialog's corner close: a 36 px icon button (spec §17.2). */}
              <IconButton ref={closeRef} icon={X} label="关闭" onClick={() => close.current()} />

            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">{children}</div>
          </>
        )}
      </div>
    </div>
  );
}
