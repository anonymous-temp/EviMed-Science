import { useState, type MouseEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Download } from "lucide-react";
import type { FigureAnnotation, FigureBlock as FigureBlockT } from "@ai4s/shared";
import { saveBlobWithFeedback, saveTextWithFeedback } from "@/lib/download";

/**
 * A figure the agent produced. Click anywhere on the image to drop a numbered
 * pin and leave a note; `onComment` (when a live session backs it) forwards the
 * note to the agent. Existing pins open a popover showing their note.
 */
export function FigureBlock({
  block,
  onComment,
}: {
  block: FigureBlockT;
  onComment?: (annotation: FigureAnnotation, figureTitle: string) => void;
}) {
  const [pins, setPins] = useState<FigureAnnotation[]>(block.annotations ?? []);
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [note, setNote] = useState("");

  const openDraft = (x: number, y: number) => {
    setDraft({ x: clamp(x), y: clamp(y) });
    setNote("");
  };

  const onImageClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.width ? ((e.clientX - rect.left) / rect.width) * 100 : 50;
    const y = rect.height ? ((e.clientY - rect.top) / rect.height) * 100 : 50;
    openDraft(x, y);
  };

  const send = () => {
    if (!draft || !note.trim()) return;
    const annotation: FigureAnnotation = {
      index: pins.length + 1,
      note: note.trim(),
      x: draft.x,
      y: draft.y,
    };
    setPins((p) => [...p, annotation]);
    onComment?.(annotation, block.title);
    setDraft(null);
    setNote("");
  };

  return (
    <figure className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium text-text">{block.title}</span>
        <button
          className="ml-auto text-muted hover:text-text"
          aria-label="下载图表"
          onClick={() => downloadFigure(block.title, block.src)}
        >
          <Download size={15} />
        </button>
      </div>
      <div className="relative bg-white p-4">
        {block.caption && (
          <div className="mb-2 text-center text-xs text-muted">{block.caption}</div>
        )}
        <div
          className="relative cursor-crosshair"
          onClick={onImageClick}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            // No pointer coordinates from the keyboard — drop the pin at the
            // center of the figure, same draft flow as a click.
            openDraft(50, 50);
          }}
          role="button"
          tabIndex={0}
          aria-label="添加批注"
        >
          <img src={block.src} alt={block.title} className="mx-auto block max-w-full" />
        </div>

        {pins.map((a) => (
          <Popover.Root key={a.index}>
            <Popover.Trigger asChild>
              <button
                className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg shadow-pop ring-2 ring-white"
                style={{ left: `${a.x}%`, top: `${a.y}%` }}
                aria-label={`批注 ${a.index}：${a.note}`}
              >
                {a.index}
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                sideOffset={8}
                className="z-50 max-w-[260px] rounded-card border border-border bg-surface px-3 py-2 text-sm text-text shadow-pop"
              >
                {a.note}
                <Popover.Arrow className="fill-[var(--surface)]" />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        ))}

        {draft && (
          <div
            className="absolute z-50 -translate-x-1/2 translate-y-2"
            style={{ left: `${draft.x}%`, top: `${draft.y}%` }}
          >
            <div className="flex items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 shadow-pop">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg">
                {pins.length + 1}
              </span>
              <input
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") send();
                  if (e.key === "Escape") setDraft(null);
                }}
                placeholder="添加批注…"
                className="w-44 bg-transparent text-sm text-text outline-none placeholder:text-muted"
                aria-label="批注内容"
              />
              <button
                className="rounded-input bg-text px-3 py-1 text-xs font-medium text-bg disabled:opacity-40"
                onClick={send}
                disabled={!note.trim()}
              >
                发送
              </button>
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}

const clamp = (n: number) => Math.min(100, Math.max(0, n));

/**
 * Download a figure by its data-URI MIME: inline SVG decodes to its markup
 * (text save, with the desktop "Save As" dialog); bitmap data URIs (png,
 * jpeg, …) download as binary with their real extension.
 */
function downloadFigure(title: string, src: string): void {
  const m = /^data:image\/([a-zA-Z0-9.+-]+)(;base64)?,(.*)$/s.exec(src);
  if (m && m[1] === "svg+xml") {
    void saveTextWithFeedback(`${title}.svg`, m[2] ? atob(m[3]) : decodeURIComponent(m[3]), "image/svg+xml");
    return;
  }
  if (m && m[2]) {
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const bytes = Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0));
    saveBlobWithFeedback(`${title}.${ext}`, new Blob([bytes], { type: `image/${m[1]}` }));
    return;
  }
  // Not a decodable inline image (e.g. a remote URL) — keep the text save.
  void saveTextWithFeedback(`${title}.svg`, src, "image/svg+xml");
}
