import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useLocation, useParams, useSearchParams } from "react-router";
import { cn } from "@/lib/cn";
import { withParam } from "@/lib/addressState";
import { fetchFrontierItem, frontierAbsence, frontierErrorMessage, frontierItemGone, hideFrontierItem, markFrontierItemRead, starFrontierItem, unhideFrontierItem, unstarFrontierItem, useFrontierFeature, type FrontierHideReason, type FrontierItemDetail } from "@/lib/frontierClient";
import { useWide } from "@/lib/useMediaQuery";
import { PageShell } from "@/components/layout/PageShell";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import type { ToolbarProps } from "@/components/ui/Toolbar";
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
  ReaderLead,
  ReaderMedia,
  ReaderNotes,
  ReaderOriginal,
  ReaderOutline,
  ReaderQuote,
  ReaderResearch,
  ReaderSameEvent,
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
 * own and the type set again 2026-10-26) and, since 2026-10-31, like a WeChat article: the title, the content, and the way to the original at
 * the foot of it (owner: 「查看正文和打开原文是重复了……打开原文应该是列在 AI 导读里」).
 *
 * Two columns from 1024 px. The left one is the article, every line on one edge: the way back, who said it and when (with what it
 * is — its genre), the title with ☆, ⋯ and 「深入研究」, the one primary, at the right of its row, the original title, then — only for an item
 * that has both a text and something written about it — ONE toolbar row in the page's band, the switch 「速读 | 正文」 and nothing else
 * (an item with no switch has no band at all), and one of two views under it. The 速读 view (the default): 速读, AI 要点 (the genre's typed
 * fields, ct-write 2026-10-24), then 「阅读原文 ↗」 and 事件后续. The text view (`?view=text`, the switch's second option, named by what the
 * text is: 正文, 摘要 or 全文): the text whole — the article, a paper's abstract or its open-access full text, in Chinese or the original —
 * its pictures and the quoted post, then 「阅读原文 ↗」. The link is one component in one place (`ReaderOriginal`) in both views, before 事件后续
 * and 继续追问, and the page has no other way out. A post (a 小红书 note, a 微博, an X post) has no switch: its 速读, its 正文 where it has words
 * beyond its title and tags, its pictures — which stand even with no words — the quoted post and 「在小红书查看原帖 ↗」; an item with nothing
 * written and no text is its title and the link. The article ends with 「继续追问」, the item's questions as chips, drawn only where
 * there are questions (the lone 「自己提问…」 said what 「深入研究」 says). The right column sticks beside it, its top on the back row: 推荐理由,
 * 出处, 专科, 标签 and, while the text is open, 本文目录. Narrower, there is no toolbar: the notes follow the article and the actions, with the
 * switch, are a bar at the window's bottom that steps aside while reading down; a long text's contents fold above it.
 *
 * The view is in the address and replaces the entry rather than pushing one, so 「‹ 前沿动态」 — the history entry the card left — still
 * returns to the list, as it was, in one press; an address with `?view=text` opens the text. Opening the page is reading the item.
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
  const written = Boolean(item.lead || item.brief);
  // A paper's abstract is offered on the strength of its DOI or its journal; when the server turns out to have none, the switch goes.
  const [noAbstract, setNoAbstract] = useState(false);
  const textKind = item.body ? readerTextKind(item, item.body) : !noAbstract && (item.abstract || item.abstractZh || abstractOffered(item)) ? "摘要" : null;
  const switchable = written && !post && textKind !== null;
  const textView = switchable && params.get("view") === "text";
  const showWritten = written && !textView;
  const showText = textKind !== null && (post || !written || textView);
  // The pictures and the quoted post stand wherever the page is not the written view of a switchable item — a picture post with no words
  // reads as its title and its pictures, and an item with nothing to switch to loses none of them.
  const showPictures = !switchable || textView;
  useFrontierReadTracking(item.id, { language, expanded: textView, url: item.url, state: item.state, arrival: frontierArrival(location.search) });
  const article = useRef<HTMLElement>(null);
  const view: ReaderViewSwitch | null = switchable ? {
    label: textKind,
    text: textView,
    onToggle: () => {
      setParams((current) => withParam(current, "view", textView ? null : "text"), { replace: true, state: location.state });
      const scroller = article.current?.closest<HTMLElement>(".overflow-y-auto");
      if (scroller && typeof scroller.scrollTo === "function") scroller.scrollTo({ top: 0 });
    },
  } : null;
  // The abstract asked for is not there: back to what was written about the item, and the switch is gone (an empty view is no view).
  const abstractMissing = useCallback(() => {
    setNoAbstract(true);
    if (params.get("view") === "text") setParams((current) => withParam(current, "view", null), { replace: true, state: location.state });
  }, [params, setParams, location.state]);
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
  // An original title beside a translated one, for an article in another language; a post's 「title」 is its own first words. A Chinese
  // source's own title is not shown under the title written from it: the rewrite is what took its hook, label or site name away.
  const originalTitle = !isSocialItem(item) && !/^zh/i.test(item.lang) && item.titleZh && item.titleRaw !== item.titleZh ? item.titleRaw : null;
  // An open text of three sections or more has its contents: in the right column, or folded above the text on a narrow screen.
  const sections = showText && item.body ? readerOutline(item.body, language, prefix) : [];
  const outline = sections.length >= 3 ? sections : [];
  const chooser = (anchorClassName: string) => (reasons > 0
    ? <FrontierHideReasonMenu key={reasons} item={item} anchorClassName={anchorClassName} onChoose={(reason) => void hide(reason)} /> : null);
  const actions = { item, more, onStar: () => void toggleStar(), onResearch: research };
  // The band's one row, from 1024 px, is the switch alone and only for an item that has one (the bar at the window's bottom has it below
  // that); the body is the tab panel it names.
  const toolbar: ToolbarProps | undefined = wide && view ? {
    label: "阅读视图",
    views: {
      label: "切换阅读视图",
      items: [{ value: "ai", label: "速读" }, { value: "text", label: view.label }],
      value: textView ? "text" : "ai",
      onChange: (next) => { if ((next === "text") !== textView) view.onToggle(); },
      panelId: `reader-view-${prefix}`,
    },
  } : undefined;
  // The title's row, from 1024 px (the walk's primary-action rule): ☆, ⋯ and the page's one primary action, 「深入研究」. The reasons of
  // 「不感兴趣」 open under ⋯.
  return (
    <PageShell
      className="[&_h1]:line-clamp-none [&_h1]:text-balance"
      width="page"
      title={item.title}
      back={back}
      eyebrow={<ReaderByline item={item} />}
      underTitle={originalTitle && <p lang={item.lang !== "und" ? item.lang : undefined} className="max-w-measure-body text-ui text-text-3">{originalTitle}</p>}
      toolbar={toolbar}
      actions={wide ? (
        <div className="relative flex items-center gap-2">
          <ReaderActions {...actions} />
          <ReaderResearch onResearch={research} />
          {chooser("absolute right-0 top-full")}
        </div>
      ) : undefined}
      asideLabel="文章操作与推荐"
      aside={wide ? <ReaderNotes item={item} reports={reports} outline={outline.length > 0 ? <ReaderOutline entries={outline} layout="inline" /> : undefined} /> : undefined}
    >
      {/* The first block stands where the band ends: its own top margin is the article's start, not a gap under it. */}
      <article ref={article} aria-label="正文" data-frontier-reader={item.id} data-genre={item.genre}
        data-reader-view={textView ? "text" : "written"} className={cn("min-w-0 [&>:first-child]:mt-0", !wide && "pb-20")}>
        <ReaderSameEvent item={item} className="mt-3" />
        {showWritten && item.lead && <ReaderLead text={item.lead} named={Boolean(toolbar?.views)} className="mt-6" />}
        {showWritten && item.brief && <ReaderBrief brief={item.brief} item={item} className="mt-8" />}
        {showText && !wide && outline.length > 0 && <div className="mt-6"><ReaderOutline entries={outline} layout="folded" /></div>}
        {showText && (item.body && textKind
          ? <ReaderText kind={textKind} text={item.body} lang={item.lang} language={language} onLanguage={setLanguage}
            ownUrl={item.url} idPrefix={prefix} named={Boolean(toolbar?.views)} className={written ? "mt-8" : "mt-6"} />
          : <ReaderAbstract item={item} language={language} onLanguage={setLanguage} onEmpty={abstractMissing} named={Boolean(toolbar?.views)}
            className={written ? "mt-8" : "mt-6"} />)}
        {showPictures && <ReaderMedia media={item.media} className="mt-6" />}
        {showPictures && item.quoted && <ReaderQuote quoted={item.quoted} platform={item.platform} language={language} className="mt-6" />}
        <ReaderOriginal item={item} className="mt-8" />
        {!textView && <ReaderFollowups item={item} className="mt-10" />}
        <ReaderAsk questions={item.ask ?? []} onAsk={ask} className="mt-10" />
        {!wide && <div className="mt-10"><ReaderNotes item={item} reports={reports} /></div>}
      </article>
      {!wide && <ReaderBar {...actions} view={view} />}
      {!wide && chooser("fixed bottom-16 right-3")}
    </PageShell>
  );
}
