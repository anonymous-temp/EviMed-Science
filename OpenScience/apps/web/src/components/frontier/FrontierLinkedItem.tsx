import { useEffect, useRef, useState } from "react";
import { fetchFrontierItem, frontierErrorMessage, frontierItemGone, hideFrontierItem, starFrontierItem, unstarFrontierItem, type FrontierItem } from "@/lib/frontierClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { Button } from "@/components/ui/Button";
import { toast } from "@/lib/toast";
import { FrontierCard } from "./FrontierCard";
import { FrontierSkeleton } from "./FrontierSkeleton";

/**
 * A linked announcement fails independently of the rest of the feed. An item that is gone for good
 * (unpublished, its source switched off) is not a failure to retry: the link is dead, and the
 * reader is told so in one grey line and closes it, where a read that failed offers 「重试」.
 */
export function FrontierLinkedItem({ id, onClose }: { id: string; onClose: () => void }) {
  const generation = useRef(0);
  const [item, setItem] = useState<FrontierItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    generation.current += 1;
    setLoading(true); setError(null); setItem(null); setGone(false);
    fetchFrontierItem(id).then((next) => { if (active) setItem(next); }, (caught: unknown) => {
      if (!active) return;
      if (frontierItemGone(caught)) setGone(true); else setError(frontierErrorMessage(caught));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; generation.current += 1; };
  }, [id, attempt]);

  if (gone) {
    return (
      <div className="mt-5 flex flex-wrap items-center gap-x-3 text-ui text-text-3">
        <span>这条动态已下架，不再提供。</span>
        <Button variant="text" size="sm" onClick={onClose}>关闭</Button>
      </div>
    );
  }
  const update = async (current: FrontierItem, action: "star" | "hide") => {
    const at = generation.current;
    try {
      const state = await (action === "hide" ? hideFrontierItem(current.id) : current.state.starred ? unstarFrontierItem(current.id) : starFrontierItem(current.id));
      if (at === generation.current) setItem({ ...current, state });
    } catch (caught) { if (at === generation.current) toast.error(frontierErrorMessage(caught)); }
  };
  return (
    <section aria-label="相关动态" className="mt-5">
      <h2 className="text-ui font-medium text-text">相关动态</h2>
      {loading ? <FrontierSkeleton />
        : error ? <LoadError message={error} onRetry={() => setAttempt((n) => n + 1)} />
          : !item || item.state.hidden ? <EmptyState title="这条动态已隐藏" />
            : <ul><FrontierCard item={item} onStar={() => void update(item, "star")} onHide={() => void update(item, "hide")} /></ul>}
    </section>
  );
}
