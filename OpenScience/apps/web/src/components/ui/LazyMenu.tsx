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
