import { useRef, useState, type KeyboardEvent, type ReactElement, type AnchorHTMLAttributes } from "react";
import { useHref, useLinkClickHandler } from "react-router";
import * as Popover from "@radix-ui/react-popover";
import { Check, Loader2, MoreHorizontal, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/IconButton";

/**
 * The one dropdown menu: a row's 「⋯」, a filter's 「更多 ▾」, a header's
 * overflow. There were three hand-written menus with three item recipes
 * (2026-09-23 inventory §2.2); this one positions itself (the popover
 * primitive the report reader already uses), closes on Escape or an outside
 * click and returns focus to its trigger, and moves between items with the
 * arrow keys, Home and End, as a menu does.
 *
 * With no `children` the trigger is the quiet 「⋯」 icon button; otherwise the
 * single child element is the trigger (it must accept a ref — a DOM element
 * or a forwardRef component).
 */
export interface MenuItem {
  label: string;
  /** A destination retains native link semantics, including modified-click navigation. */
  to?: string;
  state?: unknown;
  onSelect: () => void;
  icon?: LucideIcon;
  /** Red text: deletes or discards something. */
  destructive?: boolean;
  disabled?: boolean;
  /** Busy items retain their label and expose activity while guarding repeat intent. */
  loading?: boolean;
  /** A single-choice menu marks the current option. */
  checked?: boolean;
  /**
   * An on/off item among actions (a `menuitemcheckbox`): `checked` is its
   * state, and the other items stay plain actions rather than turning the
   * whole menu into a single choice (the memory header's 「本项目除外」).
   */
  toggle?: boolean;
}

/**
 * A quiet label over a group of items (「我的项目」, 「虚拟临床研究」): not an item — it takes no focus, is skipped by the
 * arrow keys, and selects nothing.
 */
export interface MenuHeading {
  heading: string;
}

export type MenuEntry = MenuItem | MenuHeading | "separator";

/**
 * Component: ActionLink; owner: H; rules: DS21, DS22.2/AT52.
 * Anatomy: A stable native anchor with a router-owned destination and state.
 * Variants: Enabled or inert, including menuitem semantics supplied by its owner.
 * States: Inert removes href while preserving the focused anchor and busy label.
 * Hit area: Caller uses shared Button/Menu geometry.
 * Keyboard: Router click handler preserves modified navigation; inert links cannot open destinations.
 * Long content: Caller owns wrapping.
 * Theme: Caller owns semantic action roles.
 * Responsive: No layout policy.
 * Verification: HeaderActions.test.tsx; browser context-menu/focus checks remain separate.
 */
export function ActionLink({ to, state, inert, onClick, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; state?: unknown; inert?: boolean }) {
  const href = useHref(to);
  const click = useLinkClickHandler<HTMLAnchorElement>(to, { state, target: props.target });
  return <a {...props} role={props.role ?? 'link'} tabIndex={props.tabIndex ?? 0} href={inert ? undefined : href}
    onClick={event => { if (inert) { event.preventDefault(); return; } onClick?.(event); if (!event.defaultPrevented) click(event); }}
    onAuxClick={event => { if (inert) event.preventDefault(); else props.onAuxClick?.(event); }}>{children}</a>;
}

/**
 * Component: Menu; owner: H; rules: DS21, DS22.2–DS22.4/AT52–AT54, DESIGN.md component adoption.
 * Anatomy: Caller/default trigger plus portalled grouped menu with checks and separators.
 * Variants: start/end alignment; destructive and disabled items.
 * States: Local open state; caller owns selected/disabled facts.
 * Hit area: Trigger geometry is caller-owned; menu rows are h-8.
 * Keyboard: Arrow/Home/End traversal, native selection and Escape/focus return.
 * Long content: Item labels truncate; long menus scroll within Radix-reported available height.
 * Theme: Surface/border/text and destructive roles; shared motion policy.
 * Responsive: Radix collision placement and available-size limits keep popup scrolling local.
 * Verification: Primitives.test.tsx and LazyMenu.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function Menu({
  items,
  label,
  align = "end",
  children,
  className,
  defaultOpen = false,
}: {
  items: readonly MenuEntry[];
  /** The trigger's accessible name (and the default trigger's tooltip). */
  label: string;
  align?: "start" | "end";
  children?: ReactElement;
  className?: string;
  /** Open on mount: `LazyMenu`'s stand-in was clicked before this arrived. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const list = useRef<HTMLDivElement>(null);
  const enabled = () => [...(list.current?.querySelectorAll<HTMLElement>('[role^=menuitem]:not([disabled]):not([aria-disabled="true"])') ?? [])];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = enabled();
    if (!buttons.length) return;
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (at + 1) % buttons.length
      : event.key === "ArrowUp" ? (at - 1 + buttons.length) % buttons.length
        : event.key === "Home" ? 0
          : event.key === "End" ? buttons.length - 1
            : null;
    if (next === null) {
      if (event.key === "Tab") setOpen(false);
      return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  };

  const single = items.some((item) => item !== "separator" && !("heading" in item) && !item.toggle && item.checked !== undefined);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild aria-haspopup="menu">
        {children ?? <IconButton icon={MoreHorizontal} label={label} size="sm" active={open} />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          side="bottom"
          sideOffset={4}
          collisionPadding={8}
          // The press that dismisses a menu is the menu's alone: a menu opened inside a drawer or a dialog must not hand the same
          // Escape on to it (the layer listens on the document, and Radix's own listener runs first and does not stop it).
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onOpenAutoFocus={(event) => {
            // The first item takes focus, as in a menu — not the container.
            event.preventDefault();
            requestAnimationFrame(() => enabled()[0]?.focus());
          }}
          // The popover tier (60), above a dialog, so a menu opened inside one
          // is still seen (spec §7.4); drops 4 px as it opens.
          className={cn("z-popover max-h-[var(--radix-popover-content-available-height)] min-w-40 max-w-[var(--radix-popover-content-available-width)] overflow-y-auto animate-menu-in rounded-card border border-border bg-surface p-1 shadow-e2 outline-none", className)}
        >
          <div ref={list} role="menu" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown} className="flex flex-col outline-none">
            {items.map((item, index) => item === "separator" ? (
              <div key={`separator-${index}`} role="separator" className="my-1 h-px bg-border" />
            ) : "heading" in item ? (
              <div key={`heading-${index}`} role="presentation" className="px-2 pb-1 pt-2 text-meta text-text-3">{item.heading}</div>
            ) : item.to !== undefined ? (
              <ActionLink key={`${item.label}-${index}`} to={item.to} state={item.state} inert={item.disabled || item.loading} role={item.toggle ? "menuitemcheckbox" : single ? "menuitemradio" : "menuitem"} aria-checked={item.toggle || single ? Boolean(item.checked) : undefined} aria-disabled={item.disabled || item.loading || undefined} aria-busy={item.loading || undefined}
                onAuxClick={event => { if (item.disabled || item.loading) event.preventDefault(); }}
                onClick={event => { if (item.disabled || item.loading) { event.preventDefault(); return; } setOpen(false); item.onSelect(); }}
                className={cn("flex min-h-8 items-center rounded px-2 text-ui text-text outline-none hover:bg-surface-2 focus-visible:bg-surface-2", item.disabled && "opacity-disabled", item.destructive && "text-danger")}>{item.loading && <Loader2 size={16} aria-hidden="true" className="shrink-0 animate-spin" />}{item.icon && <item.icon size={16} aria-hidden="true" />}{item.label}{(single || item.toggle) && item.checked && <Check size={16} aria-hidden="true" />}</ActionLink>
            ) : (
              <button
                key={`${item.label}-${index}`}
                type="button"
                role={item.toggle ? "menuitemcheckbox" : single ? "menuitemradio" : "menuitem"}
                aria-checked={item.toggle || single ? Boolean(item.checked) : undefined}
                disabled={item.disabled || item.loading}
                aria-busy={item.loading || undefined}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded px-2 text-left text-ui outline-none transition-colors duration-fast",
                  "hover:bg-surface-2 focus-visible:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-disabled",
                  item.destructive ? "text-danger" : "text-text",
                )}
              >
                {item.loading && <Loader2 size={16} aria-hidden="true" className="shrink-0 animate-spin" />}
                {item.icon && <item.icon size={16} className="shrink-0 text-text-3" aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {(single || item.toggle) && item.checked && <Check size={16} className="shrink-0 text-accent" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
