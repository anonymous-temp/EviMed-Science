import { forwardRef, type InputHTMLAttributes } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The one search box: 36 px in a page header, 28 in a filter row (spec §18.3,
 * appendix E #9), a quiet grey ground and no border until it has focus, a
 * 16 px glass at the start. Four hand-made search boxes (28 / 32 / 36 px,
 * three icon sizes) became this one (2026-09-23 inventory §2.5).
 *
 * `label` is the accessible name and the placeholder: “搜索”, “搜索工具”,
 * “搜索记忆” — a word, not a sentence about what can be searched.
 *
 * Focus is the border turning `--focus`; the outline stays transparent (the
 * global text-field rule), which is what forced-colours mode paints.
 */
export const SearchInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> & {
  label: string;
  /** `md` 36 in a page header; `sm` 28 inside a filter row. */
  size?: "sm" | "md";
  /** Width classes; the default suits a page header. */
  className?: string;
}>(function SearchInput({ label, size = "md", className, placeholder, ...rest }, ref) {
  const height = size === "sm" ? "h-sm" : "h-control";
  return (
    <label className={cn("relative flex w-64 min-w-0 items-center", height, className)}>
      <Search size={16} className="pointer-events-none absolute left-2.5 text-text-3" aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        className={cn(
          "w-full rounded border border-transparent bg-surface-2 pl-8 pr-3 text-ui text-text outline-none transition-colors duration-fast max-md:text-body",
          "placeholder:text-text-3 hover:bg-surface-3 focus:border-focus focus:bg-surface",
          "[&::-webkit-search-cancel-button]:hidden",
          height,
        )}
        {...rest}
      />
    </label>
  );
});
