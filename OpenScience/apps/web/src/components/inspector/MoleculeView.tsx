import { Button } from "@/components/ui/Button";
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- Named scientific drawing regions support local keyboard navigation without application mode. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GLViewer } from "3dmol";
import { Atom, RotateCcw } from "lucide-react";
import {
  defaultStyleMode,
  isSmilesFile,
  looksLikeMacromolecule,
  moleculeFormatFor,
  smilesToMolblock,
  type MoleculeStyleMode,
} from "@/lib/molecule";
import { cn } from "@/lib/cn";
import { parseFailureMessage } from "@/lib/errorText";
import { viewerKey } from "./viewerKeyboard";
import { IconButton } from "@/components/ui/IconButton";

const STYLE_OPTIONS: Array<{ value: MoleculeStyleMode; label: string }> = [
  { value: "stick", label: "球棍" },
  { value: "sphere", label: "空间填充" },
  { value: "cartoon", label: "带状" },
];

/**
 * Anatomy: named viewer/content region, local controls and decoded readout.
 * Variants: file-format branches retain the source's scientific meaning.
 * States: setup, readable content, empty/invalid input and selected value.
 * Hit area: native controls; the drawing surface accepts pointer input.
 * Keyboard: native controls; focused drawing shortcuts never intercept editors.
 * Long content: bounded content scrolls; scientific units remain visible.
 * Theme: app chrome follows tokens; fixed scientific stages retain their palette.
 * Responsive behavior: drawing coordinates track the available container.
 * Verification: adjacent tests and ScientificViewerGallery; physical AT/touch unverified.
 */
export function MoleculeView({ filename, text }: { filename: string; text: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<GLViewer | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const format = useMemo(() => moleculeFormatFor(filename), [filename]);
  const isMacromolecule = useMemo(() => looksLikeMacromolecule(text), [text]);
  // Cartoon depicts a residue backbone — meaningless for small molecules, and
  // 3Dmol crashes reading a missing atom.resn. Offer it only for macromolecules.
  const styleOptions = useMemo(
    () => STYLE_OPTIONS.filter((o) => o.value !== "cartoon" || isMacromolecule),
    [isMacromolecule],
  );

  const [styleMode, setStyleMode] = useState<MoleculeStyleMode>(() =>
    defaultStyleMode(filename, text),
  );
  const [isDragging, setIsDragging] = useState(false);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [atomIndex, setAtomIndex] = useState(0);
  const [atomText, setAtomText] = useState("");
  const [atomCount, setAtomCount] = useState<number | null>(null);

  useEffect(() => {
    setStyleMode(defaultStyleMode(filename, text));
  }, [filename, text]);

  const resetView = useCallback(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.zoomTo();
    v.render();
  }, []);

  // Build (or rebuild) the scene whenever the file or style changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !format) return;

    let cancelled = false;
    setRendering(true);
    setError(null);
    setAtomCount(null);
    setAtomIndex(0);
    setAtomText("");
    container.replaceChildren();

    (async () => {
      try {
        // SMILES carries no coordinates — lay it out into a molblock first.
        const model = isSmilesFile(filename) ? await smilesToMolblock(text) : text;
        if (cancelled) return;
        if (!model) {
          setError("此文件中未找到化学结构。");
          return;
        }

        const $3Dmol = await import("3dmol");
        if (cancelled || !containerRef.current) return;

        const viewer = $3Dmol.createViewer(containerRef.current, { backgroundColor: "white" });
        viewerRef.current = viewer;
        viewer.setBackgroundColor(0xffffff, 0); // transparent → our white stage shows
        viewer.addModel(model, format);
        applyStyle(viewer, styleMode, isMacromolecule);
        viewer.zoomTo();
        viewer.render();
        setAtomCount(viewer.selectedAtoms({}).length);
        requestAnimationFrame(() => {
          if (!cancelled) {
            viewer.resize();
            viewer.render();
          }
        });
      } catch (e) {
        if (!cancelled) setError(parseFailureMessage(e, "该分子结构文件"));
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
      dragRef.current = null;
      viewerRef.current?.clear();
      viewerRef.current = null;
      container.replaceChildren();
    };
  }, [filename, text, format, styleMode, isMacromolecule]);

  // Keep the scene sized to its container.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const v = viewerRef.current;
      if (!v) return;
      v.resize();
      v.render();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest('[data-molecule-controls="true"]')) return;
    if (e.button !== 0 || !viewerRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    setIsDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const v = viewerRef.current;
    if (!drag || !v || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    dragRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    if (Math.abs(dx) > 0.1) v.rotate(dx * 0.45, "y");
    if (Math.abs(dy) > 0.1) v.rotate(dy * 0.45, "x");
    v.render();
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const v = viewerRef.current;
    if (!v || e.ctrlKey || e.metaKey) return;
    v.zoom(e.deltaY > 0 ? 0.9 : 1.1);
    v.render();
  }, []);

  if (!format) return <div className="p-4 text-ui text-muted">这不是可识别的化学结构文件。</div>;

  return (
    <div
      className={cn(
        "relative flex h-full min-h-[420px] w-full flex-col touch-none select-none overflow-hidden bg-white",
        isDragging ? "cursor-grabbing" : "cursor-grab",
      )}
      data-molecule-viewer="true"
      {...{ tabIndex: 0, role: "region", "aria-label": `${filename} 分子交互视图` }}
      onWheelCapture={(e) => { if (e.ctrlKey || e.metaKey) e.stopPropagation(); }}
      onKeyDown={(e) => {
        if (!viewerKey(e)) return;
        const v = viewerRef.current;
        if (e.key === "Escape") { const drag = dragRef.current; if (drag && e.currentTarget.hasPointerCapture(drag.pointerId)) e.currentTarget.releasePointerCapture(drag.pointerId); dragRef.current = null; setIsDragging(false); return; }
        if (!v) return;
        if (e.key === "0") resetView();
        else if (e.key === "+" || e.key === "=") v.zoom(1.1);
        else if (e.key === "-") v.zoom(0.9);
        else if (e.key === "Enter") {
          const atoms = v.selectedAtoms({});
          const atom = atoms[atomIndex % atoms.length];
          if (atom) { setAtomText(`原子 ${atomIndex + 1} · ${atom.elem} · x ${atom.x}, y ${atom.y}, z ${atom.z} Å`); setAtomIndex((atomIndex + 1) % atoms.length); }
        } else if (e.key.startsWith("Arrow")) {
          const dx = e.key === "ArrowLeft" ? -10 : e.key === "ArrowRight" ? 10 : 0;
          const dy = e.key === "ArrowUp" ? 10 : e.key === "ArrowDown" ? -10 : 0;
          if (e.shiftKey) { if (dx) v.rotate(dx, "y"); if (dy) v.rotate(dy, "x"); }
          else v.translate(dx, dy);
        } else return;
        v.render(); e.preventDefault();
      }}
      onLostPointerCapture={() => { dragRef.current = null; setIsDragging(false); }}
      onPointerDownCapture={onPointerDown}
      onPointerMoveCapture={onPointerMove}
      onPointerUpCapture={endDrag}
      onPointerCancelCapture={endDrag}
      onWheel={onWheel}
    >
      <div ref={containerRef} className="relative min-h-40 flex-1" aria-label={`${filename} 三维分子视图`} />

      <div className="relative order-2 rounded bg-surface p-2 text-caption text-text" data-molecule-controls="true">
        <p>聚焦视图：方向键平移，Shift+方向键旋转，+ / - 缩放，0 重置，Enter 逐个读取原子，Escape 结束拖动。</p>
        <div className="flex flex-wrap gap-2">{["左移", "右移", "上移", "下移", "左转", "右转", "放大", "缩小"].map((label, i) => <Button variant="secondary" size="md" key={label} type="button" onClick={() => { const v = viewerRef.current; if (!v) return; if (i < 4) v.translate(i === 0 ? -10 : i === 1 ? 10 : 0, i === 2 ? 10 : i === 3 ? -10 : 0); else if (i < 6) v.rotate(i === 4 ? -10 : 10, "y"); else v.zoom(i === 6 ? 1.1 : 0.9); v.render(); }}>{label}</Button>)}</div>
        <Button variant="secondary" size="md" type="button" onClick={() => { const atoms = viewerRef.current?.selectedAtoms({}) ?? []; const a = atoms[atomIndex % atoms.length]; if (a) { setAtomText(`原子 ${atomIndex + 1} · ${a.elem} · x ${a.x}, y ${a.y}, z ${a.z} Å`); setAtomIndex((atomIndex + 1) % atoms.length); } }}>读取下一个原子</Button>
        <span role="status">{atomText}</span>
      </div>
      <div
        className="absolute left-3 top-3 flex items-center gap-2 rounded-input border border-border bg-surface p-1 shadow-e2 backdrop-blur"
        data-molecule-controls="true"
      >
        <div className="flex items-center gap-1 px-1.5 text-caption text-muted">
          <Atom size={16} aria-hidden="true" /> 3D
        </div>
        <div className="flex rounded bg-surface-2 p-0.5">
          {styleOptions.map((o) => (
            <Button variant="secondary" size="md"
              key={o.value}
              aria-pressed={styleMode === o.value}
              type="button"
              onClick={() => setStyleMode(o.value)}
              className={cn(
                "rounded px-2 py-1 text-caption transition-colors",
                styleMode === o.value ? "bg-surface text-text ring-1 ring-border" : "text-muted hover:text-text",
              )}
            >
              {o.label}
            </Button>
          ))}
        </div>
        <IconButton icon={RotateCcw} label="重置视图" size="sm" onClick={resetView} />
      </div>

      <div className="pointer-events-none relative order-3 ml-auto rounded-input border border-border bg-surface px-3 py-1.5 text-caption text-muted shadow-e2 backdrop-blur">
        <span className="font-semibold text-text">{format.toUpperCase()}</span>
        {atomCount !== null && <span className="ml-2">{atomCount} 个原子</span>}
      </div>

      {(rendering || error) && (
        <div className="pointer-events-none absolute top-16 left-3 max-w-[70%] rounded-input border border-border bg-surface px-3 py-1.5 text-caption text-muted shadow-e2 backdrop-blur">
          {rendering ? "正在渲染结构" : error}
        </div>
      )}
    </div>
  );
}

/** Apply a render style, mirroring 3Dmol's Jmol color scheme conventions. */
function applyStyle(viewer: GLViewer, mode: MoleculeStyleMode, isMacromolecule: boolean) {
  if (mode === "sphere") {
    viewer.setStyle({}, { sphere: { colorscheme: "Jmol", scale: 0.36 } });
    return;
  }
  // Cartoon needs a residue backbone; on a small molecule 3Dmol dereferences a
  // missing atom.resn and throws, so only draw it for macromolecules.
  if (mode === "cartoon" && isMacromolecule) {
    viewer.setStyle({}, { cartoon: { color: "spectrum" } });
    // Ligands/hetero atoms have no secondary structure — show them as sticks.
    viewer.setStyle({ hetflag: true }, { stick: { colorscheme: "Jmol", radius: 0.12 } });
    return;
  }
  viewer.setStyle({}, { stick: { colorscheme: "Jmol", radius: 0.18 }, sphere: { colorscheme: "Jmol", scale: 0.26 } });
}
