import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { CONTROL_HEIGHTS, OPACITY, TYPE_SCALE, Z_INDEX } from "@evimed/design-tokens";

// Semantic font-size tokens, read from the token module that also builds
// tailwind.config.js's scale. Without them tailwind-merge files an unknown
// `text-*` class under text colour, so `text-ui` would falsely "conflict"
// with — and delete — `text-accent-fg`. The list used to be typed here and
// lacked `meta`, `badge` and `wordmark`: `cn("text-meta", "text-text-2")`
// silently dropped the size.
//
// The same for the token heights (`h-control`, `h-sm`, …), stacking tiers
// (`z-modal`) and opacities (`opacity-disabled`): tailwind-merge does not know
// a name it has not been told, so a caller's `h-7` would sit beside the
// primitive's `h-control` instead of replacing it, and which one won would be
// stylesheet order.
const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const heights = Object.keys(CONTROL_HEIGHTS).map(kebab);

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: Object.keys(TYPE_SCALE) }],
      h: [{ h: heights }],
      "min-h": [{ "min-h": heights }],
      z: [{ z: Object.keys(Z_INDEX) }],
      opacity: [{ opacity: Object.keys(OPACITY) }],
    },
  },
});

/** Merge conditional class names, resolving Tailwind conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
