import { useEffect, useId, useState, type ReactNode } from "react";
import { useLocation, useParams } from "react-router";
import { fetchFrontierItem, frontierAbsence, frontierErrorMessage, frontierItemGone, hideFrontierItem, markFrontierItemRead, starFrontierItem, unstarFrontierItem, useFrontierFeature, type FrontierItemDetail } from "@/lib/frontierClient";
import { useWide } from "@/lib/useMediaQuery";
import { PageShell } from "@/components/layout/PageShell";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { Note } from "@/components/ui/Note";
import { FrontierBack, evidenceFromState } from "@/components/frontier/FrontierBack";
import { useItemActions } from "@/components/frontier/FrontierCard";
import {
  ReaderAbstract,
  ReaderActions,
  ReaderBar,
  ReaderByline,
  ReaderFollowups,
  ReaderInsight,
  ReaderLead,
  ReaderMedia,
  ReaderNotes,
  ReaderOutline,
  ReaderQuote,
  ReaderSameEvent,
  ReaderSource,
  ReaderText,
  frontierFallbackReason,
  readerOutline,
  useReaderLanguage,
} from "@/components/frontier/FrontierReader";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { EXTERNAL, isSocialItem } from "@/components/frontier/frontierText";
import { toast } from "@/lib/toast";

type ArticleState = { kind: "loading" } | { kind: "ready"; item: FrontierItemDetail } | { kind: "gone" } | { kind: "off" } | { kind: "error"; message: string };

/**
 * A frontier item's addressed reading page, read like AIHOT's detail page (owner, 2026-10-22; its layout 2026-10-23).
 *
 * Two columns from 1024 px. The left one is the article, every line on one edge: the way back, who said it and when, the title, the
 * original title, AI 导读, AI 解读 where there is one, the full text or the abstract with 中文 / 原文, the pictures, the quoted post,
 * where it came from with 「打开原文 ↗」, 事件后续. The right one sticks beside it, its top on the back row: 「打开原文 ↗」 with ☆ and ⋯,
 * 「深入研究」, 推荐理由, 专科, 标签 and 本文目录. Narrower, the notes follow the text and the actions are a bar at the window's bottom
 * that steps aside while reading down; a long text's contents fold above it.
 *
 * Opening the page is reading the item. The way back returns to the list it was opened from, as it was (`FrontierBack` with the
 * history entry the card left), or to 前沿动态 from anywhere else.
 */
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
  const back = <FrontierBack historyBack={Boolean(from)} to={from?.to} label={from?.label} />;
  if (state.kind !== "ready") {
    return (
      <PageShell width="page" title="前沿动态" titleVariant="document" back={back}>
        {state.kind === "loading" ? <FrontierSkeleton />
          : state.kind === "error" ? <LoadError message={state.message} onRetry={() => setAttempt((value) => value + 1)} />
            : <EmptyState title="这条动态已下架，不再提供。" />}
      </PageShell>
    );
  }
  return <ArticleBody item={state.item} back={back} onItem={(item) => setState({ kind: "ready", item })} />;
}

function ArticleBody({ item, back, onItem }: { item: FrontierItemDetail; back: ReactNode; onItem: (item: FrontierItemDetail) => void }) {
  const [language, setLanguage] = useReaderLanguage();
  const wide = useWide();
  const prefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [textOpen, setTextOpen] = useState(false);
  const update = async (action: "star" | "hide") => {
    try {
      const next = await (action === "hide" ? hideFrontierItem(item.id) : item.state.starred ? unstarFrontierItem(item.id) : starFrontierItem(item.id));
      onItem({ ...item, state: next });
      if (action === "hide") toast.success("已隐藏");
    } catch (error) { toast.error(frontierErrorMessage(error)); }
  };
  const { more, reports, research } = useItemActions(item, { reader: true, onHide: () => void update("hide") });
  const fallback = frontierFallbackReason(item);
  // An original title beside a translated one, for an article; a post's 「title」 is its own first words.
  const originalTitle = !isSocialItem(item) && item.titleZh && item.titleRaw !== item.titleZh ? item.titleRaw : null;
  // A text of three sections or more has its contents: in the right column, or folded above the text on a narrow screen.
  const sections = item.body ? readerOutline(item.body, language, prefix) : [];
  const outline = sections.length >= 3 ? sections : [];
  const actions = { item, more, onStar: () => void update("star"), onResearch: research };
  return (
    <PageShell
      className="[&_h1]:line-clamp-none"
      width="page"
      title={item.title}
      titleVariant="document"
      back={back}
      eyebrow={<ReaderByline item={item} />}
      contentClassName="mt-2"
      asideLabel="文章操作与推荐"
      aside={wide ? (
        <div className="flex flex-col gap-8">
          <ReaderActions {...actions} />
          <ReaderNotes item={item} outline={outline.length > 0 ? <ReaderOutline entries={outline} layout="inline" onReveal={() => setTextOpen(true)} /> : undefined} />
        </div>
      ) : undefined}
    >
      <article aria-label="正文" className={wide ? "min-w-0" : "min-w-0 pb-20"}>
        {originalTitle && <p lang={item.lang !== "und" ? item.lang : undefined} className="max-w-measure-body text-ui text-text-3">{originalTitle}</p>}
        {fallback && <Note className="mt-4" action={<a href={item.url} {...EXTERNAL} className="text-link hover:underline">阅读来源</a>}>{fallback}</Note>}
        <ReaderSameEvent item={item} className="mt-4" />
        {item.lead && <ReaderLead text={item.lead} className="mt-6" />}
        {item.insight && <ReaderInsight insight={item.insight} item={item} className="mt-8" />}
        {!wide && outline.length > 0 && <div className="mt-8"><ReaderOutline entries={outline} layout="folded" onReveal={() => setTextOpen(true)} /></div>}
        {item.body
          ? <ReaderText kind={item.body.source === "abstract" ? "摘要" : "正文"} text={item.body} lang={item.lang} language={language} onLanguage={setLanguage}
            ownUrl={item.url} idPrefix={prefix} open={textOpen} onOpen={() => setTextOpen(true)} className="mt-8" />
          : <ReaderAbstract item={item} language={language} onLanguage={setLanguage} className="mt-8" />}
        <ReaderMedia media={item.media} className="mt-6" />
        {item.quoted && <ReaderQuote quoted={item.quoted} platform={item.platform} language={language} className="mt-6" />}
        <ReaderSource item={item} reports={reports} className="mt-8" />
        <ReaderFollowups item={item} className="mt-10" />
        {!wide && <div className="mt-10"><ReaderNotes item={item} /></div>}
      </article>
      {!wide && <ReaderBar {...actions} />}
    </PageShell>
  );
}
