import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { TYPE_SCALE } from "@evimed/design-tokens";

// Semantic font-size tokens, read from the token module that also builds
// tailwind.config.js's scale. Without them tailwind-merge files an unknown
// `text-*` class under text colour, so `text-ui` would falsely "conflict"
// with — and delete — `text-accent-fg`. The list used to be typed here and
// lacked `meta`, `badge` and `wordmark`: `cn("text-meta", "text-text-2")`
// silently dropped the size.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: Object.keys(TYPE_SCALE) }],
    },
  },
});

/** Merge conditional class names, resolving Tailwind conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
