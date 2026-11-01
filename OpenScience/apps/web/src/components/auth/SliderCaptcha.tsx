import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { EvimedCaptcha } from "@/lib/apiClient";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { AuthFeedback } from "./AuthFeedback";

/** Render the provider's puzzle unchanged. Only the person's movement is submitted. */
export function SliderCaptcha({ data, busy, onComplete, onRefresh }: {
  data: EvimedCaptcha;
  busy: boolean;
  onComplete: (offset: string) => void;
  onRefresh: () => void;
}) {
  const background = useRef<HTMLCanvasElement>(null);
  const piece = useRef<HTMLCanvasElement>(null);
  const [offset, setOffset] = useState(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const max = Math.max(data.canvasWidth - 40, 1);
  const pieceOffset = ((data.canvasWidth - 60) / max) * offset;

  useEffect(() => {
    let current = true;
    setReady(false); setFailed(false); setOffset(0);
    const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
    void Promise.all([load(data.canvasSrc), load(data.blockSrc)]).then(([base, block]) => {
      if (!current) return;
      const baseContext = background.current?.getContext("2d");
      const blockContext = piece.current?.getContext("2d");
      if (!baseContext || !blockContext) { setFailed(true); return; }
      baseContext.clearRect(0, 0, data.canvasWidth, data.canvasHeight);
      blockContext.clearRect(0, 0, data.canvasWidth, data.canvasHeight);
      baseContext.drawImage(base, 0, 0, data.canvasWidth, data.canvasHeight);
      blockContext.drawImage(block, data.blockX, data.blockY, data.blockWidth, data.blockHeight);
      setReady(true);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [data]);

  if (failed) return <div className="mx-auto w-full space-y-3" style={{ maxWidth: data.canvasWidth }}>
    <AuthFeedback>验证图片加载失败，请重新加载后再试。</AuthFeedback>
    <Button variant="secondary" disabled={busy} className="w-full" onClick={onRefresh}>重新加载图片</Button>
  </div>;

  return <div className="auth-captcha-puzzle mx-auto w-full" style={{ maxWidth: `min(${data.canvasWidth}px, calc((100dvh - 17rem) * ${data.canvasWidth / data.canvasHeight}))` }}>
    <div className="relative overflow-hidden rounded bg-surface-2" style={{ aspectRatio: `${data.canvasWidth} / ${data.canvasHeight}` }}>
      <canvas ref={background} width={data.canvasWidth} height={data.canvasHeight} className="absolute inset-0 h-full w-full" aria-label="安全验证拼图背景" />
      <canvas ref={piece} width={data.canvasWidth} height={data.canvasHeight} className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ transform: `translateX(${pieceOffset / data.canvasWidth * 100}%)` }} aria-hidden="true" />
      {!ready && <p role="status" className="absolute inset-0 grid place-items-center text-ui text-text-2">正在加载验证图片</p>}
      <IconButton icon={RefreshCw} label="刷新验证图片" className="absolute right-2 top-2 bg-surface" disabled={busy} onClick={onRefresh} />
    </div>
    <div className="mt-4 space-y-3">
      <Input type="range" label="向右拖动，让拼图完整对齐" min={0} max={max} step={1} value={offset}
        disabled={busy || !ready} className="cursor-grab px-0 accent-accent" onChange={event => setOffset(Number(event.target.value))}
        aria-valuetext={`拼图移动 ${offset}`} />
      <Button className="w-full" disabled={busy || !ready || offset <= 0} loading={busy} onClick={() => onComplete(String(offset))}>验证并发送短信</Button>
    </div>
  </div>;
}
