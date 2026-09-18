import { cn } from "@/lib/cn";

/**
 * The EviMed mark: four evidence nodes and the three bonds that tie the
 * findings to their sources.
 *
 * Inline rather than an <img>, so it takes the theme's own accent: the file
 * version was upstream blue #2563EB beside a rust UI and a green favicon — three
 * brand colours for one product (review B §2.3). `currentColor` is `--accent`
 * (brand-700 light, brand-400 dark), so it is the same teal as the primary
 * button and the verified mark in both themes. `assets/evimed-mark.svg` is the
 * same geometry for the places a component cannot go (the favicon).
 */
export function EviMedMark({ className, label = "EviMed" }: { className?: string; label?: string }) {
  return (
    <svg viewBox="0 0 48 48" role="img" aria-label={label} className={cn("text-accent", className)}>
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={3.5}>
        <path d="M18 27 9.5 18.5M18 27 29.5 12.5M18 27l16 7" />
      </g>
      <g fill="currentColor">
        <circle cx="9" cy="18" r="5" />
        <circle cx="18" cy="27" r="5.5" />
        <circle cx="30" cy="12" r="5" />
        <circle cx="35" cy="34" r="5" />
      </g>
    </svg>
  );
}
