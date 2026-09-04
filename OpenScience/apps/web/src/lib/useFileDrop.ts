import { useCallback, useRef, useState, type DragEvent } from "react";

/**
 * Shared HTML5 drag-and-drop behavior for a file drop zone. Tracks whether
 * files hover the zone (an enter/leave depth counter, so crossing child
 * elements never flickers the highlight), suppresses the browser default
 * (which would open the dropped file), and hands the dropped files to the
 * caller. Spread `dropProps` onto the zone's container; render the visual
 * affordance (border highlight / overlay) from `dragging`.
 *
 * Hosted web only in practice: the desktop webview intercepts OS file drops
 * natively, so these handlers never fire there — callers gate with `disabled`.
 */
export function useFileDrop({
  onDrop,
  disabled = false,
}: {
  onDrop: (files: File[]) => void;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire in pairs as the pointer crosses child elements;
  // only a balanced leave (depth back to 0) means the pointer truly exited.
  const depth = useRef(0);

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = useCallback(
    (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    [disabled],
  );

  const onDragOver = useCallback(
    (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      // Required on every move: without preventDefault the drop event never fires.
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [disabled],
  );

  const onDragLeave = useCallback(
    (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    [disabled],
  );

  const onDropFiles = useCallback(
    (e: DragEvent) => {
      if (disabled) return;
      e.preventDefault(); // keep the browser from opening the file
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) onDrop(files);
    },
    [disabled, onDrop],
  );

  return {
    dragging,
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop: onDropFiles },
  };
}
