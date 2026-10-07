import { forwardRef, useImperativeHandle, useRef, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/IconButton";

/**
 * The one search box: 36 px in a page header, 28 in a filter row (spec §18.3,
 * appendix E #9), a quiet grey ground and no border until it has focus, a
 * 16 px glass at the start. Four hand-made search boxes (28 / 32 / 36 px,
 * three icon sizes) became this one (2026-09-23 inventory §2.5).
 *
 * `label` is the accessible name and the placeholder: “搜索”, “搜索工具”,
 * “搜索记忆” — a word, not a sentence about what can be searched.
 *
 * It is 256 px wide, and the width of its column on a phone (`max-sm:w-full`):
 * at 390 px a 256 px box stood in a 342 px column, short of the edge and alone
 * on a row of its own. A caller that gives it a width keeps that width from
 * `sm` up; one that wants it to share a row on a phone says so
 * (`min-w-0 flex-1 sm:w-64 sm:flex-none`).
 *
 * `onClear` adds the way out of a query: a 28 px 「清除搜索」 button at the end
 * while the box holds text, and Escape in the box does the same. The browser's
 * own cancel button is hidden (it is a glyph of a different weight in every
 * engine), so without this a query could only be deleted by hand. The caller
 * empties its own state; focus returns to the box.
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
  /** Empties the query. Present: the box offers a clear button and clears on Escape. */
  onClear?: () => void;
}>(function SearchInput({ label, size = "md", className, placeholder, onClear, onKeyDown, ...rest }, ref) {
  const height = size === "sm" ? "h-sm" : "h-control";
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current as HTMLInputElement);
  const filled = onClear !== undefined && rest.value !== undefined && String(rest.value) !== "";
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Escape" || !filled) return;
    // The key cleared the query; it is not also the page's Escape (a drawer under the box stays open).
    event.preventDefault();
    event.stopPropagation();
    onClear?.();
  };
  return (
    <label className={cn("relative flex w-64 min-w-0 items-center max-sm:w-full", height, className)}>
      <Search size={16} className="pointer-events-none absolute left-2.5 text-text-3" aria-hidden="true" />
      <input
        ref={input}
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        className={cn(
          "w-full rounded border border-transparent bg-surface-2 pl-8 pr-3 text-ui text-text outline-none transition-colors duration-fast max-md:text-body",
          "placeholder:text-text-3 hover:bg-surface-3 focus:border-focus focus:bg-surface",
          "[&::-webkit-search-cancel-button]:hidden",
          height,
          filled && "pr-9",
        )}
        onKeyDown={keyDown}
        {...rest}
      />
      {filled && (
        <IconButton
          icon={X}
          label="清除搜索"
          size="sm"
          className="absolute right-0.5"
          onClick={() => {
            onClear?.();
            input.current?.focus();
          }}
        />
      )}
    </label>
  );
});
