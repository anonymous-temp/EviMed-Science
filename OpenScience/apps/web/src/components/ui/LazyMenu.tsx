import { Component, lazy, Suspense, useState, type ComponentProps, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import type { Menu as MenuComponent } from "@/components/ui/Menu";
import { isStaleChunkError, reloadForNewRelease } from "@/lib/staleChunk";

/**
 * `Menu` behind the default 「⋯」 trigger, for a row the shell draws on every
 * page (a conversation in the sidebar).
 *
 * The menu is the popover primitive and its positioning engine, and imported
 * by the sidebar they were a fifth of the bundle every page loads before its
 * first paint (2026-09-28). Here they are their own chunk, asked for when the
 * row first renders: the stand-in is the same icon button, and a click that
 * lands before the chunk does opens the menu when it arrives.
 */
const Menu = lazy(() => import("@/components/ui/Menu").then((m) => ({ default: m.Menu })));

type LazyMenuProps = Omit<ComponentProps<typeof MenuComponent>, "children" | "defaultOpen">;

/**
 * Component: LazyMenu; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Suspense shell requests the Menu chunk on first render with an IconButton stand-in.
 * Variants: Menu props except children/defaultOpen; fixed small overflow trigger.
 * States: Loaded implementation replaces trigger shell; deferred interaction is replayed.
 * Hit area: Shared small IconButton stand-in and loaded trigger.
 * Keyboard: Trigger keyboard opens deferred Menu; Menu owns subsequent traversal.
 * Long content: Content/viewport rules delegate to Menu.
 * Theme: No additional theme; Menu and trigger retain semantic roles.
 * Responsive: Delegates placement to Menu.
 * Verification: LazyMenu.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function LazyMenu(props: LazyMenuProps) {
  const [wanted, setWanted] = useState(false);
  const standIn = (disabled: boolean) => (
    <IconButton
      icon={MoreHorizontal}
      label={props.label}
      size="sm"
      aria-haspopup="menu"
      active={wanted}
      disabled={disabled}
      onClick={() => setWanted(true)}
    />
  );
  return (
    <ChunkBoundary fallback={standIn(true)}>
      <Suspense fallback={standIn(false)}>
        <Menu {...props} defaultOpen={wanted} />
      </Suspense>
    </ChunkBoundary>
  );
}

/**
 * A chunk that would not load leaves a disabled trigger where the menu was,
 * rather than the error reaching the shell's own error element, which would
 * replace the sidebar and the conversation with it. A chunk the last release
 * replaced reloads the tab, on the same guarded path as `vite:preloadError`
 * and the route error element.
 */
class ChunkBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (isStaleChunkError(error)) reloadForNewRelease();
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
