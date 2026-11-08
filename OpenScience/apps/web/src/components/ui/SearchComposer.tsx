import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";
import { ArrowUp, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Textarea } from "@/components/ui/Input";

/** One query surface: the editor and its submit action below. The category is the sidebar's directory (2026-11-08), not a control here. */
export const SearchComposer = forwardRef<HTMLTextAreaElement, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onSubmit"> & {
  label: string;
  onSubmit(): void;
  onClear(): void;
}>(function SearchComposer({ label, onSubmit, onClear, onKeyDown, ...props }, ref) {
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => input.current as HTMLTextAreaElement);
  const filled = Boolean(String(props.value ?? "").trim());
  const resize = useCallback(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, []);
  useLayoutEffect(resize, [props.value, resize]);
  useEffect(() => {
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);
  return (
    <div data-search-composer="" className="rounded-composer border border-border-control bg-surface shadow-e1 transition-colors duration-fast focus-within:border-focus focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-focus">
      <div>
        <div className="px-4 pb-2 pt-4 md:px-6">
          <Textarea ref={input} aria-label={label} aria-multiline="true" rows={2}
            className="min-h-20 max-h-60 resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 text-ui focus:outline-transparent focus-visible:outline-transparent"
            onKeyDown={event => {
              onKeyDown?.(event);
              if (event.defaultPrevented || event.key !== "Escape" || !filled) return;
              event.preventDefault(); event.stopPropagation(); onClear();
            }} {...props} />
        </div>
        <div className="flex justify-end px-4 pb-4 md:px-6">
          <div className="flex h-form-primary shrink-0 items-center justify-end gap-2">
            {filled && <IconButton icon={X} label="清除搜索" onClick={() => { onClear(); input.current?.focus(); }} />}
            <Button size="lg" disabled={props.disabled || !filled} onClick={onSubmit}><ArrowUp size={16} aria-hidden="true" />检索</Button>
          </div>
        </div>
      </div>
    </div>
  );
});
