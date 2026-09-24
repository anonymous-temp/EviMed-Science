import { forwardRef, type InputHTMLAttributes } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The one search box: 32 px, a quiet grey ground and no border until it has
 * focus, a 16 px glass at the start. It sits at the right of a page header or
 * of a filter row. Four hand-made search boxes (28 / 32 / 36 px, three icon
 * sizes) became this one (2026-09-23 inventory §2.5).
 *
 * `label` is the accessible name and the placeholder: 「搜索」, 「搜索工具」,
 * 「搜索记忆」 — a word, not a sentence about what can be searched.
 */
export const SearchInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: string;
  /** Width classes; the default suits a page header. */
  className?: string;
}>(function SearchInput({ label, className, placeholder, ...rest }, ref) {
  return (
    <label className={cn("relative flex h-8 w-64 min-w-0 items-center", className)}>
      <Search size={16} className="pointer-events-none absolute left-2.5 text-text-3" aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        className={cn(
          "h-8 w-full rounded border border-transparent bg-surface-2 pl-8 pr-3 text-ui text-text outline-none transition-colors duration-fast",
          "placeholder:text-text-3 hover:bg-surface-3 focus:border-focus focus:bg-surface",
          "[&::-webkit-search-cancel-button]:hidden",
        )}
        {...rest}
      />
    </label>
  );
});
