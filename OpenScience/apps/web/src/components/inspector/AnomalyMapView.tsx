import { Button } from "@/components/ui/Button";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { divergingColor, parseAnomaly, type AnomalyGrid } from "@/lib/anomaly";
import { viewerKey } from "./viewerKeyboard";
import { parseFailureMessage } from "@/lib/errorText";

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
export function AnomalyMapView({ filename, text }: { filename: string; text: string }) {
  const parsed = useMemo<{ grid: AnomalyGrid | null; error: string | null }>(() => {
    try {
      return { grid: parseAnomaly(text), error: null };
    } catch (e) {
      return { grid: null, error: parseFailureMessage(e, "该异常图文件") };
    }
  }, [text]);

  if (parsed.error || !parsed.grid) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-sm items-start gap-2 rounded-card border border-border bg-surface p-4 text-ui text-muted">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          <span>无法读取此异常网格——{parsed.error ?? "未知格式"}。</span>
        </div>
      </div>
    );
  }
  return <Map filename={filename} grid={parsed.grid} />;
}

function fmtLat(v: number): string {
  return v === 0 ? "0°" : `${Math.abs(v)}°${v > 0 ? "N" : "S"}`;
}
function fmtLon(v: number): string {
  const x = ((((v + 180) % 360) + 360) % 360) - 180;
  return x === 0 || Math.abs(x) === 180 ? `${Math.abs(x)}°` : `${Math.abs(x)}°${x > 0 ? "E" : "W"}`;
}
function niceStep(span: number): number {
  for (const s of [10, 15, 30, 45, 60, 90]) if (span / s <= 8) return s;
  return 90;
}

function Map({ filename, grid }: { filename: string; grid: AnomalyGrid }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const selectionLocked = useRef(false);
  const [hover, setHover] = useState<{ lat: number; lon: number; v: number } | null>(null);

  const cols = grid.lons.length;
  const rows = grid.lats.length;
  const lonMin = grid.lons[0];
  const lonMax = grid.lons[cols - 1];
  const latMin = grid.lats[0];
  const latMax = grid.lats[rows - 1];
  const lonSpan = lonMax - lonMin || 1;
  const latSpan = latMax - latMin || 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = cols;
    canvas.height = rows;
    const image = ctx.createImageData(cols, rows);
    for (let row = 0; row < rows; row++) {
      const latIdx = rows - 1 - row; // north (max lat) at the top
      for (let col = 0; col < cols; col++) {
        const v = grid.values[latIdx][col];
        const o = (row * cols + col) * 4;
        if (!Number.isFinite(v)) {
          image.data[o] = image.data[o + 1] = image.data[o + 2] = 210;
          image.data[o + 3] = 255;
          continue;
        }
        const [r, g, b] = divergingColor(v / grid.absMax);
        image.data[o] = r;
        image.data[o + 1] = g;
        image.data[o + 2] = b;
        image.data[o + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }, [grid, cols, rows]);

  // SVG overlay coordinate space (independent of canvas pixel size).
  const W = 720;
  const H = Math.max(180, Math.round((W * latSpan) / lonSpan));
  const xAt = (lon: number) => ((lon - lonMin) / lonSpan) * W;
  const yAt = (lat: number) => ((latMax - lat) / latSpan) * H;
  const lonStep = niceStep(lonSpan);
  const latStep = niceStep(latSpan);
  const lonLines: number[] = [];
  for (let l = Math.ceil(lonMin / lonStep) * lonStep; l <= lonMax; l += lonStep) lonLines.push(l);
  const latLines: number[] = [];
  for (let l = Math.ceil(latMin / latStep) * latStep; l <= latMax; l += latStep) latLines.push(l);

  const onMove = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    if (e.type !== "click" && selectionLocked.current) return;
    selectionLocked.current = e.type === "click";
    const rect = e.currentTarget.getBoundingClientRect();
    const lon = lonMin + ((e.clientX - rect.left) / rect.width) * lonSpan;
    const lat = latMax - ((e.clientY - rect.top) / rect.height) * latSpan;
    // nearest grid cell
    const ci = grid.lons.reduce((best, lo, i) => (Math.abs(lo - lon) < Math.abs(grid.lons[best] - lon) ? i : best), 0);
    const ri = grid.lats.reduce((best, la, i) => (Math.abs(la - lat) < Math.abs(grid.lats[best] - lat) ? i : best), 0);
    setHover({ lat: grid.lats[ri], lon: grid.lons[ci], v: grid.values[ri][ci] });
  };

  return (
    <div className="flex h-full flex-col bg-[#0f1320]">
      <div className="flex items-center gap-2 border-b border-white/10 bg-black/20 px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-white/70">
          {filename} · {cols}×{rows} 网格{grid.unit ? ` · ${grid.unit}` : ""}
        </span>
      </div>

      <div className="flex flex-wrap gap-2 px-3 text-caption text-white/90">
        <label>纬度 <select aria-label="网格纬度" className="bg-black text-white" value={hover?.lat ?? grid.lats[0]} onChange={(e) => { selectionLocked.current = true; const ri = grid.lats.indexOf(Number(e.target.value)); const ci = grid.lons.indexOf(hover?.lon ?? grid.lons[0]); setHover({ lat: grid.lats[ri], lon: grid.lons[ci], v: grid.values[ri][ci] }); }}>{grid.lats.map((lat) => <option key={lat} value={lat}>{fmtLat(lat)}</option>)}</select></label>
        <label>经度 <select aria-label="网格经度" className="bg-black text-white" value={hover?.lon ?? grid.lons[0]} onChange={(e) => { selectionLocked.current = true; const ci = grid.lons.indexOf(Number(e.target.value)); const ri = grid.lats.indexOf(hover?.lat ?? grid.lats[0]); setHover({ lat: grid.lats[ri], lon: grid.lons[ci], v: grid.values[ri][ci] }); }}>{grid.lons.map((lon) => <option key={lon} value={lon}>{fmtLon(lon)}</option>)}</select></label>
        <Button variant="secondary" size="md" type="button" onClick={() => { selectionLocked.current = true; setHover({ lat: hover?.lat ?? grid.lats[0], lon: hover?.lon ?? grid.lons[0], v: grid.values[grid.lats.indexOf(hover?.lat ?? grid.lats[0])][grid.lons.indexOf(hover?.lon ?? grid.lons[0])] }); }}>读取网格</Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <div className="relative w-full max-w-read" style={{ aspectRatio: `${W} / ${H}` }}>
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full rounded-sm"
            style={{ imageRendering: "pixelated" }}
          />
          <svg
            {...{ tabIndex: 0, role: "region", "aria-label": "异常网格视图" }}
            onKeyDown={(e) => {
              if (!viewerKey(e) || e.shiftKey) return;
              if (e.key === "Escape") { selectionLocked.current = false; setHover(null); e.preventDefault(); return; }
              let ci = grid.lons.indexOf(hover?.lon ?? grid.lons[0]), ri = grid.lats.indexOf(hover?.lat ?? grid.lats[0]);
              if (e.key === "ArrowLeft") ci--; else if (e.key === "ArrowRight") ci++; else if (e.key === "ArrowUp") ri++; else if (e.key === "ArrowDown") ri--; else if (e.key === "0") { ci = 0; ri = 0; } else if (e.key !== "Enter") return;
              ci = Math.max(0, Math.min(cols - 1, ci)); ri = Math.max(0, Math.min(rows - 1, ri));
              selectionLocked.current = true;
              setHover({ lat: grid.lats[ri], lon: grid.lons[ci], v: grid.values[ri][ci] }); e.preventDefault();
            }}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
            onPointerMove={onMove}
            onClick={onMove}
            >
            {lonLines.map((l) => (
              <g key={`lon${l}`}>
                <line x1={xAt(l)} y1={0} x2={xAt(l)} y2={H} stroke="#ffffff" strokeOpacity={0.18} strokeWidth={0.75} />
                <text x={xAt(l) + 2} y={H - 4} fill="#fff" stroke="#0f1320" strokeWidth={3} paintOrder="stroke" style={{ fontSize: 10, fontFamily: "monospace" }}>
                  {fmtLon(l)}
                </text>
              </g>
            ))}
            {latLines.map((l) => (
              <g key={`lat${l}`}>
                <line x1={0} y1={yAt(l)} x2={W} y2={yAt(l)} stroke="#ffffff" strokeOpacity={0.18} strokeWidth={0.75} />
                <text x={2} y={yAt(l) - 2} fill="#fff" stroke="#0f1320" strokeWidth={3} paintOrder="stroke" style={{ fontSize: 10, fontFamily: "monospace" }}>
                  {fmtLat(l)}
                </text>
              </g>
            ))}
            {hover && (
              <g>
                <line x1={xAt(hover.lon)} y1={0} x2={xAt(hover.lon)} y2={H} stroke="#fff" strokeOpacity={0.5} strokeWidth={0.6} />
                <line x1={0} y1={yAt(hover.lat)} x2={W} y2={yAt(hover.lat)} stroke="#fff" strokeOpacity={0.5} strokeWidth={0.6} />
              </g>
            )}
          </svg>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-white/10 px-3 py-2">
        <Colorbar absMax={grid.absMax} unit={grid.unit} />
        <div role="status" className="ml-auto min-h-[1.25rem] text-right font-mono text-caption text-white/70">
          {hover ? (
            <>
              {fmtLat(hover.lat)}, {fmtLon(hover.lon)} ·{" "}
              {Number.isFinite(hover.v) ? `${hover.v > 0 ? "+" : ""}${hover.v.toPrecision(3)}` : "无数据"}
            </>
          ) : (
            <span className="text-white/70">方向键选择网格，Enter 读取；也可点击或选择坐标</span>
          )}
        </div>
      </div>
    </div>
  );
}

function Colorbar({ absMax, unit }: { absMax: number; unit?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const w = (c.width = 180);
    const h = (c.height = 10);
    const img = ctx.createImageData(w, h);
    for (let x = 0; x < w; x++) {
      const [r, g, b] = divergingColor((x / (w - 1)) * 2 - 1);
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, []);
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-caption text-white/70">−{absMax.toPrecision(3)}</span>
      <canvas ref={ref} className="h-2.5 w-44 rounded-sm ring-1 ring-white/15" />
      <span className="font-mono text-caption text-white/70">
        +{absMax.toPrecision(3)}
        {unit ? ` ${unit}` : ""}
      </span>
    </div>
  );
}
