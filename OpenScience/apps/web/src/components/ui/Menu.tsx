import { useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, MoreHorizontal, type LucideIcon } from "lucide-react";
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
  onSelect: () => void;
  icon?: LucideIcon;
  /** Red text: deletes or discards something. */
  destructive?: boolean;
  disabled?: boolean;
  /** A single-choice menu marks the current option. */
  checked?: boolean;
  /**
   * An on/off item among actions (a `menuitemcheckbox`): `checked` is its
   * state, and the other items stay plain actions rather than turning the
   * whole menu into a single choice (the memory header's 「本项目除外」).
   */
  toggle?: boolean;
}

export type MenuEntry = MenuItem | "separator";

export function Menu({
  items,
  label,
  align = "end",
  children,
  className,
}: {
  items: readonly MenuEntry[];
  /** The trigger's accessible name (and the default trigger's tooltip). */
  label: string;
  align?: "start" | "end";
  children?: ReactElement;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const enabled = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]:not([disabled])") ?? [])];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = enabled();
    if (!buttons.length) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
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

  const single = items.some((item) => item !== "separator" && !item.toggle && item.checked !== undefined);

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
          onOpenAutoFocus={(event) => {
            // The first item takes focus, as in a menu — not the container.
            event.preventDefault();
            requestAnimationFrame(() => enabled()[0]?.focus());
          }}
          className={cn("z-50 min-w-40 rounded-card border border-border bg-surface p-1 shadow-pop outline-none", className)}
        >
          <div ref={list} role="menu" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown} className="flex flex-col outline-none">
            {items.map((item, index) => item === "separator" ? (
              <div key={`separator-${index}`} role="separator" className="my-1 h-px bg-border" />
            ) : (
              <button
                key={`${item.label}-${index}`}
                type="button"
                role={item.toggle ? "menuitemcheckbox" : single ? "menuitemradio" : "menuitem"}
                aria-checked={item.toggle || single ? Boolean(item.checked) : undefined}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded px-2 text-left text-ui outline-none transition-colors duration-fast",
                  "hover:bg-surface-2 focus-visible:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40",
                  item.destructive ? "text-danger" : "text-text",
                )}
              >
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
