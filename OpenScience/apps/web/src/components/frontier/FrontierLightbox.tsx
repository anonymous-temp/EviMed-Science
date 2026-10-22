import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { trapTab } from "@/lib/focusTrap";
import { IconButton } from "@/components/ui/IconButton";
import type { FrontierMedia } from "@/lib/frontierClient";

/**
 * An item's pictures at full size over the page, on the page's own ground (AIHOT's `Lightbox`, MIT, reduced to what a reader of one
 * post needs): the picture, its description, 「N / M」, and the way to the previous and the next. Escape and a press on the ground
 * close it, the arrow keys step, Tab stays inside, and closing puts focus back on the tile that opened it.
 */
export function FrontierLightbox({ media, index, onIndex, onClose }: {
  media: readonly FrontierMedia[];
  /** The picture shown; null while closed. */
  index: number | null;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const state = useRef({ index, count: media.length, onIndex, onClose });
  state.current = { index, count: media.length, onIndex, onClose };
  const open = index !== null && Boolean(media[index]);

  useEffect(() => {
    if (!open) return undefined;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      const { index: at, count, onIndex: go, onClose: close } = state.current;
      if (event.key === "Escape") { event.stopPropagation(); close(); return; }
      if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && at !== null && count > 1) {
        event.preventDefault();
        go((at + (event.key === "ArrowRight" ? 1 : -1) + count) % count);
        return;
      }
      trapTab(panel.current, event);
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); trigger?.focus(); };
  }, [open]);

  if (!open || index === null) return null;
  const picture = media[index];
  const many = media.length > 1;
  const step = (by: number) => onIndex((index + by + media.length) % media.length);
  return (
    // The ground closes the viewer; the dialog is the picture and its controls (the buttons stand at the window's edges).
    <div role="presentation" className="fixed inset-0 z-modal flex items-center justify-center bg-bg p-4"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={many ? `图片 ${index + 1} / ${media.length}` : "图片"}
        tabIndex={-1}
        className="flex max-h-full max-w-full flex-col items-center gap-3 outline-none"
      >
        <div className="fixed right-4 top-4 flex items-center gap-2">
          {many && <span className="text-caption tabular-nums text-text-2">{index + 1} / {media.length}</span>}
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </div>
        {many && <IconButton icon={ChevronLeft} label="上一张" onClick={() => step(-1)} className="fixed left-4 top-1/2 -translate-y-1/2" />}
        <img src={picture.url} alt={picture.alt ?? ""} className="max-h-[80vh] max-w-[88vw] rounded-card object-contain" />
        {picture.alt && <p className="max-w-measure text-caption text-text-2">{picture.alt}</p>}
        {many && <IconButton icon={ChevronRight} label="下一张" onClick={() => step(1)} className="fixed right-4 top-1/2 -translate-y-1/2" />}
      </div>
    </div>
  );
}
