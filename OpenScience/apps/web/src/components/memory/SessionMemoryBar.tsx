import { useEffect, useState } from "react";
import { EyeOff, Layers } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { fetchMemoryChanges, fetchSessionMemory, setSessionIncognito, type SessionMemoryState } from "@/lib/memoryClient";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { SessionBackgroundPanel } from "./SessionBackgroundPanel";
import { undoChanges, writePromptMessage } from "./useMemoryWritePrompt";

/** How often an open conversation asks whether it wrote a memory by itself. */
const WRITE_PROMPT_POLL_MS = 60_000;

/**
 * The conversation's own memory controls, above the conversation: the
 * incognito switch with its indicator, and the way into 「本次用到的背景」.
 *
 * It carries the write prompt too (owner ruling 2026-09-19): a memory takes
 * effect without asking, so when this conversation writes one, the researcher
 * is told here — 「刚记住了 … 撤销」 — rather than on a page they are not on.
 *
 * Absent rather than broken when memory is off or unreachable: the
 * conversation does not depend on it.
 */
export function SessionMemoryBar({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<SessionMemoryState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState(0);

  useEffect(() => {
    let active = true;
    setState(null);
    setUnavailable(false);
    setOpen(false);
    setFresh(0);
    fetchSessionMemory(sessionId)
      .then((next) => { if (active) setState(next); })
      .catch(() => { if (active) setUnavailable(true); });
    return () => { active = false; };
  }, [sessionId]);

  useEffect(() => {
    if (unavailable) return undefined;
    let active = true;
    let since = new Date().toISOString();
    const announced = new Set<string>();
    const check = () => {
      if (document.visibilityState === "hidden") return;
      const asked = new Date().toISOString();
      void fetchMemoryChanges({ since, sessionId }).then((changes) => {
        if (!active) return;
        since = asked;
        const news = changes.filter((change) => !announced.has(`${change.id}:${change.version}`));
        if (news.length === 0) return;
        for (const change of news) announced.add(`${change.id}:${change.version}`);
        setFresh((count) => count + news.length);
        toast.success(writePromptMessage(news), { action: { label: "撤销", onClick: () => void undoChanges(news) } });
      }).catch(() => {
        // A prompt that cannot load is a prompt not shown; the panel lists
        // what this conversation wrote either way.
      });
    };
    const timer = setInterval(check, WRITE_PROMPT_POLL_MS);
    window.addEventListener("focus", check);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", check); };
  }, [sessionId, unavailable]);

  if (unavailable) return null;

  const toggle = async () => {
    if (!state) return;
    setBusy(true);
    try {
      const next = await setSessionIncognito(sessionId, !state.incognito);
      setState(next);
      toast.success(next.incognito ? "已开启无痕：这段对话不会被记住，也不再调取记忆" : "已关闭无痕：这段对话恢复使用记忆");
    } catch (error) {
      toast.error(`没有切换：${productErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const incognito = state?.incognito === true;
  return (
    <div
      data-testid="session-memory-bar"
      className={cn("flex h-10 shrink-0 items-center gap-2 border-b px-3", incognito ? "border-strong bg-surface-2" : "border-border bg-bg")}
    >
      {incognito && (
        <p role="status" className="flex min-w-0 items-center gap-1.5 text-ui text-text">
          <EyeOff size={14} aria-hidden="true" className="shrink-0" />
          <span className="truncate">无痕对话：不会记住这段对话，也不调取记忆</span>
        </p>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" disabled={!state} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <Layers size={13} aria-hidden="true" />
          本次用到的背景{fresh > 0 ? ` · 新记下 ${fresh}` : ""}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          role="switch"
          aria-checked={incognito}
          aria-label="无痕对话"
          title="开启后，这段对话不会写入记忆，也不再调取记忆和胶囊内容；项目里已装载的方法和胶囊中的基本偏好仍会生效。"
          loading={busy}
          disabled={!state || busy}
          onClick={() => void toggle()}
          className={incognito ? "text-text" : "text-muted"}
        >
          {!busy && <EyeOff size={13} aria-hidden="true" />}
          {incognito ? "无痕：开" : "无痕：关"}
        </Button>
      </div>
      {open && state && (
        <SessionBackgroundPanel sessionId={sessionId} incognito={incognito} onClose={() => setOpen(false)} onStateChange={setState} />
      )}
    </div>
  );
}
