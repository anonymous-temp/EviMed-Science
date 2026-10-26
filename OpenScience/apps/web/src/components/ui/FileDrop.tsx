import { useId, useState, type ReactNode } from "react";
export type FileDropState = "transferring" | "transferred" | "processing" | "searchable" | "failed";
export interface FileDropItem { id: string; name: string; state: FileDropState; error?: string; transferredBytes?: number; totalBytes?: number }
const words: Record<FileDropState, string> = { transferring: "正在传输", transferred: "已传输，等待读取", processing: "正在读取", searchable: "可以搜索", failed: "失败" };
/**
 * Component: FileDrop; owner: H; rules: DS21.1/4, AT23/49.
 * Anatomy: native picker and drop surface share validation; per-file outcomes.
 * Variants: multiple files with caller-owned transfer state.
 * States: transferred, processing and searchable are separate; failed retains filename.
 * Hit area: full padded label opens picker; native input remains keyboard accessible.
 * Keyboard: native picker activation; drag is optional.
 * Long content: filenames wrap, per-file messages remain visible.
 * Theme: semantic surface, control border and error roles.
 * Responsive: fluid width with wrapping filenames.
 * Verification: InputPrimitives.test.tsx; SourcesPage upload; manual upload pending.
 */
export function FileDrop({ label, hint, accept, disabled, validate, onFiles, items = [] }: { label: string; hint?: ReactNode; accept?: string; disabled?: boolean; validate?(file: File): string | null; onFiles(files: File[]): void; items?: readonly FileDropItem[] }) {
 const id = useId(); const [refused, setRefused] = useState<string[]>([]);
 const receive = (files: File[]) => { if (disabled) return; const failures: string[] = []; const accepted = files.filter(file => { const error = validate?.(file); if (error) failures.push(`${file.name}：${error}`); return !error; }); setRefused(failures); if (accepted.length) onFiles(accepted); };
 return <section aria-label={label} onDragOver={e => { if (!disabled && e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); receive(Array.from(e.dataTransfer.files)); } }} className="rounded border border-dashed border-border-control p-3"><label htmlFor={id} className="flex min-h-11 cursor-pointer items-center text-ui">{label}（也可拖入文件）</label><input id={id} aria-describedby={hint != null ? `${id}-hint` : undefined} type="file" multiple accept={accept} disabled={disabled} onChange={e => { receive(Array.from(e.target.files ?? [])); e.target.value = ""; }} className="max-w-full text-ui" />{hint != null && <p id={`${id}-hint`} className="mt-2 text-caption text-text-2">{hint}</p>}{refused.length > 0 && <p role="alert" className="text-ui text-error">{refused.join("；")}</p>}<ul aria-live="polite">{items.map(item => <li key={item.id} className="break-words text-ui">{item.name}：{words[item.state]}{item.error && `（${item.error}）`}{item.state === "transferring" && item.totalBytes != null && item.totalBytes > 0 && item.transferredBytes != null && <progress aria-label={`${item.name}传输进度`} value={item.transferredBytes} max={item.totalBytes} />}</li>)}</ul></section>;
}
