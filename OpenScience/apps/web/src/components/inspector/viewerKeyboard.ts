import type { KeyboardEvent } from "react";

/** Viewer shortcuts belong to the focused surface, never an editor or browser zoom. */
export function viewerKey(event: KeyboardEvent<HTMLElement | SVGSVGElement>): boolean {
  return !event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey &&
    event.target === event.currentTarget;
}
