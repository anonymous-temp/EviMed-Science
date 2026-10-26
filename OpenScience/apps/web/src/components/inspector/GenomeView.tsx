/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- Named scientific drawing regions support local keyboard navigation without application mode. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Dna, Minus, Plus, RotateCcw } from "lucide-react";
import { extOf } from "@/lib/artifacts";
import {
  formatBp,
  genomeFormat,
  packRows,
  parseGenome,
  type GenomeFeature,
} from "@/lib/genome";
import { cn } from "@/lib/cn";
import { iconButtonClasses } from "@/components/ui/IconButton";
import { viewerKey } from "./viewerKeyboard";
import { Tooltip } from "@/components/ui/Tooltip";

const ROW_H = 15;
const MAX_ROWS = 60; // cap drawn rows so a dense contig can't blow up the DOM
const RULER_H = 26;
const MIN_SPAN = 20; // don't zoom past ~20 bp

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
export function GenomeView({ filename, text }: { filename: string; text: string }) {
  const format = useMemo(() => genomeFormat(extOf(filename)), [filename]);
  const data = useMemo(
    () => (format ? parseGenome(text, format) : null),
    [format, text],
  );

  const [contigIdx, setContigIdx] = useState(0);
  const contig = data?.contigs[contigIdx];

  // Features on the selected contig, and a stable row assignment for them.
  const { contigFeatures, rows } = useMemo(() => {
    if (!data || !contig) return { contigFeatures: [] as GenomeFeature[], rows: [] as number[] };
    const cf = data.features.filter((f) => f.chrom === contig.name);
    return { contigFeatures: cf, rows: packRows(cf) };
  }, [data, contig]);

  // Category → color index (by type for GFF/GTF, else by strand).
  const categories = useMemo(() => categorize(contigFeatures, format), [contigFeatures, format]);

  const [view, setView] = useState<{ start: number; end: number } | null>(null);
  const [width, setWidth] = useState(760);
  const [hover, setHover] = useState<{ f: GenomeFeature; x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; startBp: number; span: number } | null>(null);

  const [dragging, setDragging] = useState(false);
  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    const box = boxRef.current;
    if (drag && box?.hasPointerCapture(drag.pointerId)) box.releasePointerCapture(drag.pointerId);
  }, []);

  // Reset the viewport to the whole contig when the contig changes.
  useEffect(() => {
    endDrag();
    if (!contig) return setView(null);
    const pad = Math.max(1, Math.round((contig.max - contig.min) * 0.02));
    setView({ start: Math.max(0, contig.min - pad), end: contig.max + pad });
    setHover(null);
  }, [contig, endDrag]);

  const viewMounted = view !== null;
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 760));
    ro.observe(el);
    setWidth(el.clientWidth || 760);
    return () => ro.disconnect();
  }, [viewMounted]);

  if (!format) return <div className="p-4 text-ui text-muted">这不是可识别的基因组注释文件。</div>;
  if (!data || data.features.length === 0 || !contig)
    return <div className="p-4 text-ui text-muted">此 {format.toUpperCase()} 文件中未找到特征。</div>;

  if (!view) return <div role="status" className="p-4 text-muted">正在准备基因组视图</div>;

  const extent = { start: Math.max(0, contig.min - 1), end: contig.max + 1 };
  const span = Math.max(MIN_SPAN, view.end - view.start);
  const xOf = (bp: number) => ((bp - view.start) / span) * width;
  const rowsShown = Math.min(MAX_ROWS, rows.length ? Math.max(...rows) + 1 : 1);
  const bodyH = rowsShown * ROW_H + 8;

  const clampView = (start: number, end: number) => {
    let s = start;
    let e = end;
    const sp = Math.max(MIN_SPAN, Math.min(e - s, extent.end - extent.start));
    if (s < extent.start) {
      s = extent.start;
      e = s + sp;
    }
    if (e > extent.end) {
      e = extent.end;
      s = e - sp;
    }
    return { start: Math.max(extent.start, s), end: e };
  };

  const zoomAt = (factor: number, atX: number) => {
    const cursorBp = view.start + (atX / width) * span;
    const newSpan = Math.max(MIN_SPAN, Math.min(span * factor, extent.end - extent.start));
    const start = cursorBp - (atX / width) * newSpan;
    setView(clampView(start, start + newSpan));
  };

  const visible = contigFeatures
    .map((f, i) => ({ f, row: rows[i] }))
    .filter((d) => d.row < MAX_ROWS && xOf(d.f.end + 1) >= 0 && xOf(d.f.start) <= width);

  // Ruler ticks at "nice" round base-pair intervals.
  const ticks = niceTicks(view.start, view.end, 6);

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-caption">
        <span className="flex items-center gap-1 text-muted">
          <Dna size={16} aria-hidden="true" /> {format.toUpperCase()}
        </span>
        {data.contigs.length > 1 ? (
          <select
            className="rounded-input border border-strong bg-surface px-2 py-1 text-caption text-text outline-none focus:border-focus-input"
            value={contigIdx}
            onChange={(e) => setContigIdx(Number(e.target.value))}
            aria-label="序列片段"
          >
            {data.contigs.map((c, i) => (
              <option key={c.name} value={i}>
                {c.name} ({c.count})
              </option>
            ))}
          </select>
        ) : (
          <span className="font-mono text-text">{contig.name}</span>
        )}
        <span className="text-muted">
          {formatBp(view.start)}–{formatBp(view.end)} · {contig.count} 个特征
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <IconBtn label="放大" onClick={() => zoomAt(0.6, width / 2)}>
            <Plus size={16} aria-hidden="true" />
          </IconBtn>
          <IconBtn label="缩小" onClick={() => zoomAt(1.66, width / 2)}>
            <Minus size={16} aria-hidden="true" />
          </IconBtn>
          <IconBtn
            label="重置视图"
            onClick={() => setView({ start: extent.start, end: extent.end })}
          >
            <RotateCcw size={16} aria-hidden="true" />
          </IconBtn>
        </div>
      </div>

      {categories.list.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-caption text-muted">
          {categories.list.map((c) => (
            <span key={c.label} className="flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ background: `var(--series-${c.color})` }}
              />
              {c.label}
            </span>
          ))}
        </div>
      )}

      <div
        ref={boxRef}
        {...{ tabIndex: 0, role: "region", "aria-label": `${filename} 基因组视图` }}
        onKeyDown={(e) => {
          if (!viewerKey(e)) return;
          if (e.key === "Escape") { endDrag(); return; }
          if (e.key === "Enter" && contigFeatures[0]) { setHover({ f: contigFeatures[0], x: 0, y: 0 }); e.preventDefault(); }
          if (e.shiftKey) return;
          if (e.key === "+" || e.key === "=") { zoomAt(0.6, width / 2); e.preventDefault(); }
          if (e.key === "-") { zoomAt(1.66, width / 2); e.preventDefault(); }
          if (e.key === "0") { setView(extent); e.preventDefault(); }
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            const delta = span * (e.key === "ArrowLeft" ? -0.1 : 0.1);
            setView(clampView(view.start + delta, view.end + delta)); e.preventDefault();
          }
        }}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        className={cn("relative flex-1 overflow-hidden", dragging ? "cursor-grabbing" : "cursor-grab")}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { pointerId: e.pointerId, x: e.clientX, startBp: view.start, span };
          setDragging(true);
          setHover(null);
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d || d.pointerId !== e.pointerId) return;
          const dxBp = ((e.clientX - d.x) / width) * d.span;
          setView(clampView(d.startBp - dxBp, d.startBp - dxBp + d.span));
        }}
        onPointerUp={(e) => { if (dragRef.current?.pointerId === e.pointerId) endDrag(); }}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) return;
          const rect = e.currentTarget.getBoundingClientRect();
          zoomAt(e.deltaY > 0 ? 1.2 : 0.83, e.clientX - rect.left);
        }}
      >
        <svg width={width} height={RULER_H + bodyH} className="block">
          {/* Ruler */}
          <line x1={0} y1={RULER_H - 0.5} x2={width} y2={RULER_H - 0.5} stroke="var(--border)" />
          {ticks.map((t) => (
            <g key={t}>
              <line x1={xOf(t)} y1={RULER_H - 5} x2={xOf(t)} y2={RULER_H} stroke="var(--border)" />
              <text x={xOf(t) + 3} y={RULER_H - 8} fontSize={10} fill="var(--muted)" fontFamily="ui-monospace, monospace">
                {formatBp(t)}
              </text>
            </g>
          ))}
          {/* Features */}
          {visible.map(({ f, row }, i) => {
            const x = xOf(f.start);
            const w = Math.max(2, xOf(f.end + 1) - x);
            const y = RULER_H + 4 + row * ROW_H;
            const color = `var(--series-${categories.colorOf(f)})`;
            return (
              <rect
                key={`${f.start}-${f.end}-${i}`}
                x={x}
                y={y}
                width={w}
                height={ROW_H - 4}
                rx={2}
                fill={color}
                opacity={hover?.f === f ? 1 : 0.85}
                onPointerEnter={(e) => {
                  const rect = boxRef.current?.getBoundingClientRect();
                  setHover({ f, x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
                }}
                onPointerLeave={() => setHover((h) => (h?.f === f ? null : h))}
              />
            );
          })}
        </svg>

        {hover && (
          <div
            className="pointer-events-none absolute z-sticky max-w-xs rounded-input border border-border bg-surface px-2.5 py-1.5 text-caption shadow-e2"
            style={{ left: Math.min(hover.x + 12, width - 200), top: hover.y + 12 }}
          >
            {hover.f.name && <div className="font-semibold text-text">{hover.f.name}</div>}
            <div className="font-mono text-muted">
              {hover.f.chrom}:{formatBp(hover.f.start)}–{formatBp(hover.f.end)}
              {hover.f.strand ? ` (${hover.f.strand})` : ""}
            </div>
            {(hover.f.type || hover.f.score !== undefined) && (
              <div className="text-muted">
                {[hover.f.type, hover.f.score !== undefined ? `评分 ${hover.f.score}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
          </div>
        )}
      </div>

      <div role="status" className="px-3 text-caption text-text">{hover ? `${hover.f.name ?? "特征"} · ${hover.f.chrom}:${hover.f.start}–${hover.f.end} · ${hover.f.strand ?? ""} · ${hover.f.score ?? ""}` : "选择特征以读取数值"}</div>
      <details className="px-3 text-caption"><summary>特征数据</summary><ul className="max-h-40 overflow-auto">{contigFeatures.map((f, i) => <li key={i}><button type="button" onClick={() => setHover({ f, x: 0, y: 0 })}>{f.name ?? "特征"} · {f.chrom}:{f.start}–{f.end} {f.strand} {f.score}</button></li>)}</ul></details>
      <p className="px-3 text-caption text-muted">聚焦视图：左右方向键平移，+ / - 缩放，0 重置，Enter 读取，Escape 结束拖动。</p>
      <div className="border-t border-border px-3 py-1 text-caption text-muted">
        拖动平移 · 滚轮缩放
        {rows.length > 0 && Math.max(...rows) + 1 > MAX_ROWS && ` · 共 ${Math.max(...rows) + 1} 行，显示前 ${MAX_ROWS} 行`}
        {data.truncated && " · 文件太大，只读取了前 50,000 个特征"}
      </div>
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip content={label} kind="label">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={iconButtonClasses({ size: "sm" })}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Assign each feature a stable palette color (1..8) by type (GFF/GTF) or strand. */
function categorize(features: GenomeFeature[], format: string | null) {
  const keyOf = (f: GenomeFeature): string =>
    format === "gff" || format === "gtf" ? (f.type ?? "feature") : (f.strand ? `strand ${f.strand}` : "feature");
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const f of features) {
    const k = keyOf(f);
    if (!counts.has(k)) order.push(k);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  order.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  const index = new Map(order.map((k, i) => [k, (i % 8) + 1]));
  return {
    list: order.map((label) => ({ label, color: index.get(label)! })),
    colorOf: (f: GenomeFeature) => index.get(keyOf(f)) ?? 1,
  };
}

/** Round tick positions across [start,end] at a 1/2/5×10ⁿ interval. */
function niceTicks(start: number, end: number, target: number): number[] {
  const span = end - start;
  if (span <= 0) return [start];
  const rough = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = rough / mag <= 1 ? mag : rough / mag <= 2 ? 2 * mag : rough / mag <= 5 ? 5 * mag : 10 * mag;
  const ticks: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t);
  return ticks;
}
