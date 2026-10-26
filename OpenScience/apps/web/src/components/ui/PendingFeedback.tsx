import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { announce } from "@/lib/announce";
import { formatDuration } from "@/lib/format";

type FeedbackMode = "active" | "passive" | "inactive";
const FeedbackContext = createContext<FeedbackMode>("active");

/**
 * Component: PendingFeedbackBoundary; owner: H; rules: DS21.1, DS21.4.
 * Anatomy: Context boundary around owned loading surfaces; no extra DOM.
 * Variants: Active real read, passive demonstration, inactive mounted hidden content.
 * States: Passive/inactive render placeholder children without clocks or announcements.
 * Hit area: None; descendant controls retain their own contracts.
 * Keyboard: No focus changes or keyboard interception.
 * Long content: Leaves wrapping and clipping to descendants.
 * Theme: Adds no visual styling.
 * Responsive: Follows the owner; activity is explicit rather than inferred from CSS.
 * Verification: PendingFeedback.test.tsx and GalleryPage.test.tsx; hidden native frames remain separate.
 */
export function PendingFeedbackBoundary({ mode, children }: { mode: FeedbackMode; children: ReactNode }) {
  const parent = useContext(FeedbackContext);
  return <FeedbackContext.Provider value={parent === "active" ? mode : parent}>{children}</FeedbackContext.Provider>;
}

/**
 * Component: PendingFeedback; owner: H; rules: DS21.1, AT33/34.
 * Anatomy: Delayed read placeholder followed by an elapsed/stage message with milestone announcements.
 * Variants: Caller supplies the relevant skeleton and actual read stage.
 * States: No placeholder before 300ms; elapsed at 10s; non-durable limitation at 60s.
 * Hit area: None; request admission and mutation controls remain with the producer.
 * Keyboard: No focus movement or synthetic controls.
 * Long content: Status wraps naturally.
 * Theme: Shared secondary text and spacing roles.
 * Responsive: Uses the caller's content width.
 * Verification: PendingFeedback.test.tsx fake-clock transitions and unmount reset.
 * Mount only while a read is unresolved; key by request identity when it changes
 * without unmounting. This does not turn a request into a durable job or cancel it.
 */
export function PendingFeedback({ children, stage = "正在读取内容" }: { children: ReactNode; stage?: string }) {
  const mode = useContext(FeedbackContext);
  return mode === "active" ? <TimedPendingFeedback stage={stage}>{children}</TimedPendingFeedback> : <>{children}</>;
}

function TimedPendingFeedback({ children, stage }: { children: ReactNode; stage: string }) {
  const identity = useId();
  const [startedAt] = useState(() => performance.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const update = () => setElapsed(previous => Math.max(previous, performance.now() - startedAt));
    const milestones = [300, 10_000, 60_000].map((threshold) => setTimeout(() => setElapsed(previous => Math.max(previous, threshold, performance.now() - startedAt)), threshold));
    const tick = setInterval(update, 1000);
    return () => { milestones.forEach(clearTimeout); clearInterval(tick); };
  }, [startedAt]);
  const phase = elapsed >= 60_000 ? "long" : elapsed >= 10_000 ? "slow" : "quiet";
  useEffect(() => {
    if (phase === "quiet") return;
    announce(phase === "long" ? "仍在等待本次读取。离开页面后不会保留本次请求。" : stage, { eventId: `read-${phase}`, entityId: identity });
  }, [phase, stage, identity]);
  return <>
    {elapsed >= 300 && children}
    {elapsed >= 10_000 && <div data-pending-feedback="" className="flex flex-col gap-2 p-2 text-ui text-text-2">
      <p>{stage} · 已等待 {formatDuration(elapsed)}</p>
      {elapsed >= 60_000 && <p>仍在等待本次读取。离开页面后不会保留本次请求；可以留在此处等待，或稍后重新打开。</p>}
    </div>}
  </>;
}
