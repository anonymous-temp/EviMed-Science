import { isComposingKey } from "@/lib/compositionKeys";
import { useEffect, useId, useRef, useState } from "react";
import { Input } from "./Input";
export interface ComboboxOption { id: string; label: string }
/**
 * Component: Combobox; owner: H; rules: DS21.5/9, AT49.
 * Anatomy: search input, clear button, listbox and durable feedback.
 * Variants: local options or abortable asynchronous loader.
 * States: query is independent of selected ID; loading, empty and failed.
 * Hit area: native input and 44px option rows.
 * Keyboard: arrows, Enter, Escape; IME does not select.
 * Long content: wrapping options in a scrolling list.
 * Theme: semantic surface, border and text roles.
 * Responsive: fluid width with local list overflow.
 * Verification: InputPrimitives.test.tsx; InputPrimitivesGallery; AT review pending.
 */
export function Combobox({ label, value, onChange, options = [], loadOptions, debounceMs = 250, minQueryLength = 0, disabled, clearable = true }: {
 label: string; value: string | null; onChange(id: string | null): void; options?: readonly ComboboxOption[];
 loadOptions?(query: string, signal: AbortSignal): Promise<ComboboxOption[]>; debounceMs?: number; minQueryLength?: number; disabled?: boolean; clearable?: boolean;
}) {
 const id = useId(); const [query, setQuery] = useState(""); const [open, setOpen] = useState(false); const [active, setActive] = useState(-1);
 const [remote, setRemote] = useState<ComboboxOption[]>([]); const [status, setStatus] = useState("idle"); const generation = useRef(0); const composing = useRef(false); const labels = useRef(new Map<string, string>());
 useEffect(() => {
  const current = ++generation.current; const controller = new AbortController();
  if (!loadOptions || !open || query.length < minQueryLength) { if (loadOptions) { setRemote([]); setStatus("idle"); } return () => controller.abort(); }
  setStatus("loading"); setRemote([]);
  const timer = setTimeout(() => { void Promise.resolve().then(() => loadOptions(query, controller.signal)).then(rows => { if (!controller.signal.aborted && current === generation.current) { rows.forEach(option => labels.current.set(option.id, option.label)); setRemote(rows); setStatus("ready"); } }, () => { if (!controller.signal.aborted && current === generation.current) setStatus("error"); }); }, debounceMs);
  return () => { clearTimeout(timer); controller.abort(); };
 }, [query, loadOptions, debounceMs, minQueryLength, open]);
 const rows = loadOptions ? remote : options.filter(option => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 const selected = [...options, ...remote].find(option => option.id === value);
 const choose = (option: ComboboxOption) => { onChange(option.id); setOpen(false); setQuery(""); setActive(-1); };
 return <div className="relative"><Input label={label} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-list`} aria-activedescendant={open && active >= 0 && rows[active] ? `${id}-${active}` : undefined} disabled={disabled} value={open ? query : selected?.label ?? (value ? labels.current.get(value) ?? "" : "")} onFocus={() => setOpen(true)} onChange={e => { setQuery(e.target.value); setOpen(true); setActive(-1); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={e => {
 if (composing.current || isComposingKey(e)) { if (e.key === "Escape") e.stopPropagation(); return; }
 if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQuery(""); }
 if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); setActive(index => rows.length ? index < 0 ? (e.key === "ArrowDown" ? 0 : rows.length - 1) : (index + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length : -1); }
 if (e.key === "Enter" && open) { e.preventDefault(); if (rows[active]) choose(rows[active]); }
 }} onBlur={e => { if (!e.currentTarget.parentElement?.parentElement?.contains(e.relatedTarget as Node)) setOpen(false); }} />
 {value && clearable && <button type="button" disabled={disabled} className="min-h-11 text-ui text-text-2" onClick={() => { onChange(null); setQuery(""); }}>清除{label}</button>}
 {open && <div className="rounded border border-border-control bg-surface"><ul id={`${id}-list`} role="listbox" aria-label={label} className="max-h-64 overflow-auto">{rows.map((option, index) => <li key={option.id} id={`${id}-${index}`} role="option" aria-selected={option.id === value} className={index === active ? "bg-surface-2" : ""} onMouseDown={e => e.preventDefault()}><button type="button" tabIndex={-1} className="min-h-11 w-full whitespace-normal px-3 text-left text-ui" onClick={() => choose(option)}>{option.label}</button></li>)}</ul><p role="status" className="text-ui text-text-2">{loadOptions && status === "loading" ? "正在搜索" : status === "error" ? "搜索失败，请修改查询后重试。" : query.length < minQueryLength ? `请输入至少 ${minQueryLength} 个字符。` : rows.length === 0 ? "没有匹配选项" : ""}</p></div>}
 </div>;
}
