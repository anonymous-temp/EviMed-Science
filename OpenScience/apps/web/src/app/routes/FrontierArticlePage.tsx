import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useLocation, useParams, useSearchParams } from "react-router";
import { withParam } from "@/lib/addressState";
import { fetchFrontierItem, frontierAbsence, frontierErrorMessage, frontierItemGone, hideFrontierItem, markFrontierItemRead, starFrontierItem, unhideFrontierItem, unstarFrontierItem, useFrontierFeature, type FrontierHideReason, type FrontierItemDetail } from "@/lib/frontierClient";
import { useWide } from "@/lib/useMediaQuery";
import { PageShell } from "@/components/layout/PageShell";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FrontierBack, evidenceFromState } from "@/components/frontier/FrontierBack";
import { useItemActions } from "@/components/frontier/FrontierCard";
import { FrontierHideReasonMenu } from "@/components/frontier/FrontierHideStrip";
import { muteSourceOf } from "@/components/frontier/frontierHide";
import {
  ReaderAbstract,
  ReaderActions,
  ReaderAsk,
  ReaderBar,
  ReaderBrief,
  ReaderByline,
  ReaderFollowups,
  ReaderInsight,
  ReaderLead,
  ReaderMedia,
  ReaderNotes,
  ReaderOutline,
  ReaderQuote,
  ReaderSameEvent,
  ReaderSourceAction,
  ReaderText,
  abstractOffered,
  isPost,
  readerOutline,
  readerTextKind,
  useReaderLanguage,
  type ReaderViewSwitch,
} from "@/components/frontier/FrontierReader";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { isSocialItem } from "@/components/frontier/frontierText";
import { toast } from "@/lib/toast";
import { frontierArrival, trackFrontierItemAction, useFrontierReadTracking } from "@/lib/frontierTracking";

type ArticleState = { kind: "loading" } | { kind: "ready"; item: FrontierItemDetail } | { kind: "gone" } | { kind: "off" } | { kind: "error"; message: string };

/**
 * A frontier item's addressed reading page, read like AIHOT's detail page (owner, 2026-10-22; its layout 2026-10-23; the text a view of its
 * own and the type set again 2026-10-26).
 *
 * Two columns from 1024 px. The left one is the article, every line on one edge: the way back, who said it and when (with what it
 * is — its genre), the title, the original title, then one of two views. The AI view (the default): AI 导读, AI 要点 (the genre's typed
 * fields, ct-write 2026-10-24), AI 解读 where there is one, 事件后续. The text view (`?view=text`, 「查看正文」 at the head of the right
 * column): the text whole — the article, a paper's abstract or its open-access full text, in Chinese or the original — its pictures and
 * the quoted post. A post shows its text in the AI view, whole, because the post is the item; an item with nothing written about it
 * shows its text alone; an item with no text has no switch. The right one sticks beside it, its top on the back row: 「查看正文」 and
 * 「打开原文 ↗」, 「深入研究」 with ☆ and ⋯, 就此提问, 推荐理由, 出处, 专科, 标签 and, while the text is open, 本文目录. Narrower, the
 * notes follow the article and the actions are a bar at the window's bottom that steps aside while reading down; a long text's contents
 * fold above it.
 *
 * The view is in the address and replaces the entry rather than pushing one, so 「‹ 前沿动态」 — the history entry the card left — still
 * returns to the list, as it was, in one press. Opening the page is reading the item.
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
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  // What the page can show: the blocks written about the item, and its text (the stored body, or a paper's abstract fetched on demand).
  const post = isPost(item);
  const written = Boolean(item.lead || item.brief || item.insight);
  const textKind = item.body ? readerTextKind(item, item.body) : item.abstract || item.abstractZh || abstractOffered(item) ? "摘要" : null;
  const switchable = written && !post && textKind !== null;
  const textView = switchable && params.get("view") === "text";
  const showWritten = written && !textView;
  const showText = textKind !== null && (post || !written || textView);
  useFrontierReadTracking(item.id, { language, expanded: textView, url: item.url, state: item.state, arrival: frontierArrival(location.search) });
  const article = useRef<HTMLElement>(null);
  const view: ReaderViewSwitch | null = switchable ? {
    label: `查看${textKind}`,
    text: textView,
    onToggle: () => {
      setParams((current) => withParam(current, "view", textView ? null : "text"), { replace: true, state: location.state });
      const scroller = article.current?.closest<HTMLElement>(".overflow-y-auto");
      if (scroller && typeof scroller.scrollTo === "function") scroller.scrollTo({ top: 0 });
    },
  } : null;
  const toggleStar = async () => {
    try {
      onItem({ ...item, state: await (item.state.starred ? unstarFrontierItem(item.id) : starFrontierItem(item.id)) });
    } catch (error) { toast.error(frontierErrorMessage(error)); }
  };
  // 「不感兴趣」 asks why first (owner, 2026-10-25): the reasons open beside the actions, and the choice — or 「不说原因，直接隐藏」 —
  // hides with it. The toast keeps 撤销, which unhides and, where the reason muted the source, unmutes it. The key opens the menu anew.
  const [reasons, setReasons] = useState(0);
  const hide = async (reason: FrontierHideReason | null) => {
    try {
      const next = await hideFrontierItem(item.id, reason ?? undefined);
      onItem({ ...item, state: next });
      trackFrontierItemAction("hide", item.id, reason ? { detail: reason } : {});
      let unmute: (() => Promise<void>) | null = null;
      if (reason === "source") {
        try { unmute = await muteSourceOf(item); } catch (error) { toast.error(frontierErrorMessage(error)); }
      }
      toast.success(unmute ? "已隐藏，并屏蔽该来源" : "已隐藏", {
        action: {
          label: "撤销",
          onClick: () => {
            void (async () => {
              try {
                onItem({ ...item, state: await unhideFrontierItem(item.id) });
                trackFrontierItemAction("unhide", item.id);
                await unmute?.();
              } catch (error) { toast.error(frontierErrorMessage(error)); }
            })();
          },
        },
      });
    } catch (error) { toast.error(frontierErrorMessage(error)); }
  };
  const { more, reports, research, ask } = useItemActions(item, { reader: true, onHide: () => setReasons((value) => value + 1) });
  // An original title beside a translated one, for an article; a post's 「title」 is its own first words.
  const originalTitle = !isSocialItem(item) && item.titleZh && item.titleRaw !== item.titleZh ? item.titleRaw : null;
  // An open text of three sections or more has its contents: in the right column, or folded above the text on a narrow screen.
  const sections = showText && item.body ? readerOutline(item.body, language, prefix) : [];
  const outline = sections.length >= 3 ? sections : [];
  const actions = { item, more, onStar: () => void toggleStar(), onResearch: research, view };
  const chooser = (anchorClassName: string) => (reasons > 0
    ? <FrontierHideReasonMenu key={reasons} item={item} anchorClassName={anchorClassName} onChoose={(reason) => void hide(reason)} /> : null);
  return (
    <PageShell
      className="[&_h1]:line-clamp-none [&_h1]:text-balance"
      width="page"
      title={item.title}
      back={back}
      eyebrow={<ReaderByline item={item} />}
      contentClassName="mt-2"
      asideLabel="文章操作与推荐"
      aside={wide ? (
        <div className="flex flex-col gap-8">
          <div className="relative">
            <ReaderActions {...actions} />
            {chooser("absolute right-0 top-20")}
          </div>
          <ReaderAsk questions={item.ask ?? []} onAsk={ask} layout="rail" />
          <ReaderNotes item={item} reports={reports} outline={outline.length > 0 ? <ReaderOutline entries={outline} layout="inline" /> : undefined} />
        </div>
      ) : undefined}
    >
      <article ref={article} aria-label="正文" data-frontier-reader={item.id} data-genre={item.genre}
        data-reader-view={textView ? "text" : "written"} className={wide ? "min-w-0" : "min-w-0 pb-20"}>
        {originalTitle && <p lang={item.lang !== "und" ? item.lang : undefined} className="mt-1 max-w-measure-body text-ui text-text-3">{originalTitle}</p>}
        <ReaderSourceAction item={item} className="mt-3" />
        <ReaderSameEvent item={item} className="mt-3" />
        {showWritten && item.lead && <ReaderLead text={item.lead} className="mt-6" />}
        {showWritten && item.brief && <ReaderBrief brief={item.brief} item={item} className="mt-8" />}
        {showWritten && item.insight && <ReaderInsight insight={item.insight} item={item} className="mt-8" />}
        {showText && !wide && outline.length > 0 && <div className="mt-6"><ReaderOutline entries={outline} layout="folded" /></div>}
        {showText && (item.body && textKind
          ? <ReaderText kind={textKind} text={item.body} lang={item.lang} language={language} onLanguage={setLanguage}
            ownUrl={item.url} idPrefix={prefix} className={written ? "mt-8" : "mt-6"} />
          : <ReaderAbstract item={item} language={language} onLanguage={setLanguage} className={written ? "mt-8" : "mt-6"} />)}
        {showText && <ReaderMedia media={item.media} className="mt-6" />}
        {showText && item.quoted && <ReaderQuote quoted={item.quoted} platform={item.platform} language={language} className="mt-6" />}
        {!textView && <ReaderFollowups item={item} className="mt-10" />}
        {!wide && <ReaderAsk questions={item.ask ?? []} onAsk={ask} layout="article" className="mt-10" />}
        {!wide && <div className="mt-10"><ReaderNotes item={item} reports={reports} /></div>}
      </article>
      {!wide && <ReaderBar {...actions} />}
      {!wide && chooser("fixed bottom-16 right-3")}
    </PageShell>
  );
}
