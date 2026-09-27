import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { TOOLTIP_DELAYS } from "@evimed/design-tokens";

/**
 * A tooltip (spec §22.8, §13.10): an icon button's name, or the whole of a
 * truncated line, in a small inverse layer over the page.
 *
 *  - It shows 300 ms after the pointer arrives and at once on keyboard focus,
 *    and hides 100 ms after the pointer leaves (`TOOLTIP_DELAYS`, tokens 2.1).
 *    A click does not open it and closes one that is open: the reader has
 *    already acted on the control.
 *  - WCAG 1.4.13: the pointer can move onto the tooltip without losing it,
 *    Escape dismisses it without moving the pointer or the focus, and it
 *    stays until one of those happens.
 *  - It sits on the `z-tooltip` layer, drawn into `document.body` so no
 *    scrolling or clipped ancestor can cut it off.
 *  - Plain words only, at most 40 characters: never a link, a button, or the
 *    only place something essential is said — a dose, a source, a safety
 *    note — because a touch screen never shows it. The pointer events it
 *    listens to are a mouse's and a pen's for that reason.
 *
 * `kind` is how assistive technology hears it. A `description` tooltip adds
 * to the trigger's name, so the trigger points at it with `aria-describedby`
 * (its text stays in the document while hidden, which is what lets a screen
 * reader read it on focus). A `label` tooltip repeats a name the trigger
 * already has — an icon button's `aria-label` — so it is shown, not
 * announced a second time.
 */
export type TooltipKind = "description" | "label";

interface TriggerProps {
  ref?: Ref<HTMLElement>;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  "aria-describedby"?: string;
}

/** The space between the trigger and the tooltip, and between it and the window's edge. */
const GAP = 8;

/** Above the trigger and centred on it; below when there is no room above; never past an edge. */
function place(trigger: HTMLElement, tip: HTMLElement): void {
  const anchor = trigger.getBoundingClientRect();
  const size = tip.getBoundingClientRect();
  const above = anchor.top - size.height - GAP;
  const side = above >= GAP ? "top" : "bottom";
  const top = side === "top" ? above : anchor.bottom + GAP;
  const centred = anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.max(GAP, Math.min(centred, window.innerWidth - size.width - GAP));
  tip.style.top = `${top + window.scrollY}px`;
  tip.style.left = `${left + window.scrollX}px`;
  tip.dataset.side = side;
}

/** Whether focus arrived from the keyboard (or from code after a keyboard action). */
function keyboardFocus(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

export function Tooltip({
  content,
  kind = "description",
  defaultOpen = false,
  children,
}: {
  /** What the tooltip says: plain words, at most 40 characters. */
  content: string;
  kind?: TooltipKind;
  /** Open from the first render — the component gallery's photograph. */
  defaultOpen?: boolean;
  /** The one element it is for; it must be able to take focus. */
  children: ReactElement<TriggerProps>;
}) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const trigger = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  /** Where the pointer is, and whether the trigger holds keyboard focus. */
  const over = useRef({ trigger: false, tip: false, focus: false });
  /** Set by a pointer press on the trigger, so the focus that follows it does not open the tooltip. */
  const pressed = useRef(false);
  /** Escape was pressed: stay closed until the pointer and the focus have both left. */
  const dismissed = useRef(false);

  const clear = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  const schedule = (next: boolean, delay: number) => {
    clear();
    if (next && dismissed.current) return;
    if (delay <= 0) setOpen(next);
    else timer.current = window.setTimeout(() => setOpen(next), delay);
  };
  const leaveIfGone = () => {
    const { trigger: onTrigger, tip: onTip, focus } = over.current;
    if (onTrigger || onTip || focus) return;
    dismissed.current = false;
    schedule(false, TOOLTIP_DELAYS.hide);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Escape closes the top layer, and while it is open the tooltip is the top
  // layer: it is heard first (window, capture phase) and the key goes no
  // further, so a drawer under it is not closed by the same press.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      dismissed.current = true;
      clear();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const update = () => {
      if (trigger.current && tip.current) place(trigger.current, tip.current);
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, content]);

  const own = children.props;
  const childRef = own.ref;
  const setTrigger = useCallback((node: HTMLElement | null) => {
    trigger.current = node;
    if (typeof childRef === "function") childRef(node);
    else if (childRef && typeof childRef === "object") (childRef as { current: HTMLElement | null }).current = node;
  }, [childRef]);

  const describes = kind === "description";
  const layer = (open || describes) && typeof document !== "undefined"
    ? createPortal(
      <div
        ref={tip}
        id={id}
        role="tooltip"
        hidden={!open}
        aria-hidden={describes ? undefined : true}
        data-tooltip-kind={kind}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          over.current.tip = true;
          clear();
        }}
        onPointerLeave={() => {
          over.current.tip = false;
          leaveIfGone();
        }}
        className="absolute left-0 top-0 z-tooltip max-w-[280px] rounded-card bg-text px-2 py-1 text-caption text-bg"
      >
        {content}
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      {cloneElement(children, {
        ref: setTrigger,
        "aria-describedby": describes ? [own["aria-describedby"], id].filter(Boolean).join(" ") : own["aria-describedby"],
        onPointerEnter: (event: PointerEvent<HTMLElement>) => {
          own.onPointerEnter?.(event);
          if (event.pointerType === "touch") return;
          over.current.trigger = true;
          if (!open) schedule(true, TOOLTIP_DELAYS.show);
          else clear();
        },
        onPointerLeave: (event: PointerEvent<HTMLElement>) => {
          own.onPointerLeave?.(event);
          over.current.trigger = false;
          leaveIfGone();
        },
        onPointerDown: (event: PointerEvent<HTMLElement>) => {
          own.onPointerDown?.(event);
          pressed.current = true;
          clear();
          setOpen(false);
        },
        onFocus: (event: FocusEvent<HTMLElement>) => {
          own.onFocus?.(event);
          if (pressed.current || !keyboardFocus(event.currentTarget)) return;
          over.current.focus = true;
          schedule(true, 0);
        },
        onBlur: (event: FocusEvent<HTMLElement>) => {
          own.onBlur?.(event);
          pressed.current = false;
          over.current.focus = false;
          const { trigger: onTrigger, tip: onTip } = over.current;
          if (!onTrigger && !onTip) {
            dismissed.current = false;
            schedule(false, 0);
          }
        },
      })}
      {layer}
    </>
  );
}
