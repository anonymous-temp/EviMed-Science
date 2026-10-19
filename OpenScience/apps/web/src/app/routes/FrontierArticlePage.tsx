import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router";
import { fetchFrontierItem, frontierAbsence, frontierErrorMessage, frontierItemGone, hideFrontierItem, markFrontierItemRead, starFrontierItem, unstarFrontierItem, useFrontierFeature, type FrontierItemDetail } from "@/lib/frontierClient";
import { PageShell } from "@/components/layout/PageShell";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FrontierBack, evidenceFromState } from "@/components/frontier/FrontierBack";
import { FrontierArticleContent } from "@/components/frontier/FrontierDetails";
import { FrontierCard } from "@/components/frontier/FrontierCard";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { toast } from "@/lib/toast";

type ArticleState = { kind: "loading" } | { kind: "ready"; item: FrontierItemDetail } | { kind: "gone" } | { kind: "off" } | { kind: "error"; message: string };

/** A stable reading address for the texts actually preserved on a frontier item. */
export function FrontierArticlePage() {
  const feature = useFrontierFeature();
  const { itemId = "" } = useParams();
  if (feature === "off") return <FrontierOffPage />;
  return <Article key={itemId} itemId={itemId} ready={feature !== "loading"} />;
}

function Article({ itemId, ready }: { itemId: string; ready: boolean }) {
  const location = useLocation();
  const from = evidenceFromState(location.state);
  const [state, setState] = useState<ArticleState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    setState({ kind: "loading" });
    fetchFrontierItem(itemId).then((item) => {
      if (!active) return;
      setState({ kind: "ready", item });
      void markFrontierItemRead(item.id).catch((error: unknown) => { if (active) toast.error(frontierErrorMessage(error)); });
    }, (error: unknown) => {
      if (!active) return;
      setState(frontierAbsence(error) === "off" ? { kind: "off" } : frontierItemGone(error) ? { kind: "gone" } : { kind: "error", message: frontierErrorMessage(error) });
    });
    return () => { active = false; };
  }, [itemId, ready, attempt]);
  if (state.kind === "off") return <FrontierOffPage />;
  const update = async (action: "star" | "hide") => {
    if (state.kind !== "ready") return;
    const item = state.item;
    try {
      const next = await (action === "hide" ? hideFrontierItem(item.id) : item.state.starred ? unstarFrontierItem(item.id) : starFrontierItem(item.id));
      setState((current) => current.kind === "ready" ? { kind: "ready", item: { ...current.item, state: next } } : current);
      if (action === "hide") toast.success("已隐藏");
    } catch (error) { toast.error(frontierErrorMessage(error)); }
  };
  return <PageShell className="[&_h1]:line-clamp-none" width="read" title={state.kind === "ready" ? state.item.title : "前沿动态"} titleVariant="document" back={<FrontierBack historyBack={Boolean(from)} to={from?.to} label={from?.label} />}>
    {state.kind === "loading" ? <FrontierSkeleton />
      : state.kind === "error" ? <LoadError message={state.message} onRetry={() => setAttempt((value) => value + 1)} />
        : state.kind === "gone" ? <EmptyState title="这条动态已下架，不再提供。" />
          : <><FrontierArticleContent item={state.item} /><ul><FrontierCard reader item={state.item} onStar={() => void update("star")} onHide={() => void update("hide")} /></ul></>}
  </PageShell>;
}
