import { cn } from "@/lib/cn";

/**
 * A navigation item (spec §20.6): 36 high (`h-control`), 8 px padding and
 * corner, a 16 px icon in `text-3` 8 px before 14 px text; `surface-2` under
 * the pointer, and the current one on `accent-soft` in the body colour — at the weight of the others: the ground says where the person is, and a
 * weight of its own would be a second kind of 36 px control beside the secondary buttons on every page (R19.2: 500 → 400).
 * The caller sets `aria-current` (or `aria-pressed` on a toggle) — the look
 * follows the state, it does not stand in for it.
 *
 * One recipe for every column of places: the sidebar's destinations, its
 * projects and conversations, 设置's sections and the knowledge base's
 * project-and-type rail. They were 32, 32, 32 and 30 px, each a kind of
 * control of its own on every page (2026-09-27 walk).
 */
export function navItemClasses({ current = false, className }: { current?: boolean; className?: string } = {}): string {
  return cn(
    "flex h-control w-full min-w-0 items-center gap-2 rounded px-2 text-left text-ui font-normal outline-none transition-colors duration-fast",
    current ? "bg-accent-soft text-text" : "text-text hover:bg-surface-2",
    className,
  );
}
