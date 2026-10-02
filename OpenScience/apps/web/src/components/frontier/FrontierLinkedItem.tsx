import { useEffect, useRef, useState } from "react";
import { fetchFrontierItem, frontierErrorMessage, hideFrontierItem, starFrontierItem, unstarFrontierItem, type FrontierItem } from "@/lib/frontierClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { toast } from "@/lib/toast";
import { FrontierCard } from "./FrontierCard";
import { FrontierSkeleton } from "./FrontierSkeleton";

/** A linked announcement fails independently of the rest of the feed. */
export function FrontierLinkedItem({ id }: { id: string }) {
  return <section aria-label="相关动态" className="mt-5">
    <h2 className="text-ui font-medium text-text">相关动态</h2>
    <LinkedItem key={id} id={id} />
  </section>;
}
function LinkedItem({ id }: { id: string }) {
  const generation = useRef(0);
  const [item, setItem] = useState<FrontierItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    generation.current += 1;
    setLoading(true); setError(null); setItem(null);
    fetchFrontierItem(id).then((next) => { if (active) setItem(next); }, (caught: unknown) => {
      if (active) setError(frontierErrorMessage(caught));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; generation.current += 1; };
  }, [id, attempt]);
  if (loading) return <FrontierSkeleton />;
  if (error) return <LoadError message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!item || item.state.hidden) return <EmptyState title="这条动态已隐藏" />;
  const update = async (action: "star" | "hide") => {
    const current = generation.current;
    try {
      const state = await (action === "hide" ? hideFrontierItem(item.id) : item.state.starred ? unstarFrontierItem(item.id) : starFrontierItem(item.id));
      if (current === generation.current) setItem({ ...item, state });
    } catch (caught) { if (current === generation.current) toast.error(frontierErrorMessage(caught)); }
  };
  return <ul><FrontierCard item={item} onStar={() => void update("star")} onHide={() => void update("hide")} /></ul>;
}
