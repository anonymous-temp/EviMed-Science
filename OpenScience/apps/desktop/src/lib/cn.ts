import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Semantic font-size tokens (tailwind.config.js fontSize scale). Without
// this, tailwind-merge files unknown `text-*` classes under text-color, so
// `text-ui` would falsely "conflict" with — and delete — `text-accent-fg`.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["caption", "ui-sm", "ui", "body", "title", "display"] }],
    },
  },
});

/** Merge conditional class names, resolving Tailwind conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
