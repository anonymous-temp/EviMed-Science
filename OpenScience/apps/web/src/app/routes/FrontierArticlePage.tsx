import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useParams } from "react-router";
import { ExternalLink, Star } from "lucide-react";
import { fetchFrontierItem, frontierAbsence, frontierErrorMessage, frontierItemGone, hideFrontierItem, markFrontierItemRead, starFrontierItem, unstarFrontierItem, useFrontierFeature, type FrontierItemDetail } from "@/lib/frontierClient";
import { PageShell } from "@/components/layout/PageShell";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { buttonClasses } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Menu } from "@/components/ui/Menu";
import { Note } from "@/components/ui/Note";
import { FrontierBack, evidenceFromState } from "@/components/frontier/FrontierBack";
import { useItemActions } from "@/components/frontier/FrontierCard";
import {
  ReaderAbstract,
  ReaderByline,
  ReaderFollowups,
  ReaderInsight,
  ReaderLead,
  ReaderMedia,
  ReaderNotes,
  ReaderQuote,
  ReaderSameEvent,
  ReaderSource,
  ReaderText,
  frontierFallbackReason,
  hasReaderNotes,
  useReaderLanguage,
} from "@/components/frontier/FrontierReader";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { EXTERNAL, isSocialItem, originalLinkLabel } from "@/components/frontier/frontierText";
import { toast } from "@/lib/toast";

type ArticleState = { kind: "loading" } | { kind: "ready"; item: FrontierItemDetail } | { kind: "gone" } | { kind: "off" } | { kind: "error"; message: string };

/**
 * A frontier item's addressed reading page, read like AIHOT's detail page (owner, 2026-10-22).
 *
 * The header is the title and the item's actions — the way to the original (「查看原文」, a post's 「在 X 查看原帖」), 收藏 and the
 * item's ⋯ (深入研究, 整理为证据卡片, 复制, 不感兴趣, following its source, event, drugs and specialties). Under it, two columns: the text
 * — who said it and when, AI 导读, AI 解读 where there is one, the full text or the abstract with 中文 / 原文, the pictures, the quoted
 * post, where it came from, 事件后续 — and at the right 推荐理由, 主题 and 标签, which fold under the text on a phone.
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
  const update = async (action: "star" | "hide") => {
    try {
      const next = await (action === "hide" ? hideFrontierItem(item.id) : item.state.starred ? unstarFrontierItem(item.id) : starFrontierItem(item.id));
      onItem({ ...item, state: next });
      if (action === "hide") toast.success("已隐藏");
    } catch (error) { toast.error(frontierErrorMessage(error)); }
  };
  const { more, reports } = useItemActions(item, { reader: true, onHide: () => void update("hide") });
  const fallback = frontierFallbackReason(item);
  // An original title beside a translated one, for an article; a post's 「title」 is its own first words.
  const originalTitle = !isSocialItem(item) && item.titleZh && item.titleRaw !== item.titleZh ? item.titleRaw : null;
  return (
    <PageShell
      className="[&_h1]:line-clamp-none"
      width="page"
      title={item.title}
      titleVariant="document"
      back={back}
      actions={(
        <>
          <a href={item.url} {...EXTERNAL} className={buttonClasses({ variant: "secondary" })}>
            {originalLinkLabel(item)}<ExternalLink size={16} aria-hidden="true" />
          </a>
          <IconButton icon={Star} label="收藏" aria-pressed={item.state.starred}
            className={item.state.starred ? "text-accent [&_svg]:fill-current" : undefined} onClick={() => void update("star")} />
          <Menu label="更多操作" items={more} />
        </>
      )}
    >
      <div className="grid grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <article aria-label="正文" className="min-w-0">
          <ReaderByline item={item} />
          {originalTitle && <p lang={item.lang !== "und" ? item.lang : undefined} className="mt-2 max-w-measure-body text-ui text-text-3">{originalTitle}</p>}
          {fallback && <Note className="mt-4" action={<a href={item.url} {...EXTERNAL} className="text-link hover:underline">阅读来源</a>}>{fallback}</Note>}
          <ReaderSameEvent item={item} className="mt-4" />
          {item.lead && <ReaderLead text={item.lead} className="mt-6" />}
          {item.insight && <ReaderInsight insight={item.insight} item={item} className="mt-8" />}
          {item.body
            ? <ReaderText kind={item.body.source === "abstract" ? "摘要" : "正文"} text={item.body} lang={item.lang} language={language} onLanguage={setLanguage} className="mt-8" />
            : <ReaderAbstract item={item} language={language} onLanguage={setLanguage} className="mt-8" />}
          <ReaderMedia media={item.media} className="mt-6" />
          {item.quoted && <ReaderQuote quoted={item.quoted} platform={item.platform} language={language} className="mt-6" />}
          <ReaderSource item={item} reports={reports} className="mt-8" />
          <ReaderFollowups item={item} className="mt-10" />
        </article>
        {hasReaderNotes(item) && <aside aria-label="推荐与主题" className="min-w-0 lg:sticky lg:top-6 lg:self-start"><ReaderNotes item={item} /></aside>}
      </div>
    </PageShell>
  );
}
