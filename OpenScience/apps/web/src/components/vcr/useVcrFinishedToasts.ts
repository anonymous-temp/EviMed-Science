import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { isVcrTab, vcrTabPath } from "@/components/vcr/vcrTabs";
import { announceInboxChanged, fetchInboxUnreadCount, listInbox, markInboxRead, type InboxItem } from "@/lib/inboxClient";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";

/** How often the count is asked while the reader is in a study's page or conversation and the tab is visible. The route returns two integers. */
const POLL_MS = 20_000;

/** The study and tab a 「虚拟临床研究」 notice opens: its source id is `<studyId>/<tab>[/<item>]` (`vcrNotify.mjs`). */
export function vcrNoticeTarget(item: Pick<InboxItem, "source">): { studyId: string; tab: Parameters<typeof vcrTabPath>[1] } | null {
  if (item.source?.type !== "vcr") return null;
  const [studyId, tab] = String(item.source.id).split("/");
  if (!studyId) return null;
  return { studyId, tab: isVcrTab(tab) ? tab : "overview" };
}

/** The study a route is about, when the reader is on one's page: `/app/virtual-research/:studyId[/:tab]`. */
export function studyOfPath(pathname: string): string | null {
  const match = /^\/app\/virtual-research\/([^/]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * A finished computation, said where the reader is looking.
 *
 * A computation the researcher asked for in the conversation runs for minutes and ends while they are somewhere else in the same
 * study — on its page, or in the conversation. The server writes one inbox notice for it (`vcrNotify.mjs`); this turns a **new**
 * one, for the study the reader is in, into a toast with 「查看结果」 that opens the tab the result is on. Only what arrives while
 * the reader is here: what was already unread when they came is the inbox's, not a toast.
 *
 * It rides the bell's own signal — the unread count, two integers — and reads the notices only when that count moved, so the
 * page that is not a study's costs nothing and one that is costs a count every twenty seconds. A notice is toasted once.
 */
export function useVcrFinishedToasts(enabled: boolean): void {
  const location = useLocation();
  const navigate = useNavigate();
  const projectId = useProjectStore((state) => state.currentId);
  // The reader's place, read by the poll as it fires: a route change is not a reason to restart it.
  const place = useRef({ studyId: null as string | null, projectId });
  place.current = { studyId: studyOfPath(location.pathname), projectId };
  // A conversation is the study's when the shell is in the study's project; a study's page names the study itself.
  const inConversation = location.pathname.startsWith("/app/chat");
  const reading = useRef({ inConversation });
  reading.current = { inConversation };
  const goTo = useRef(navigate);
  goTo.current = navigate;

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const seen = new Set<string>();
    let primed = false;
    let lastCount = -1;

    const here = (item: InboxItem, target: { studyId: string }): boolean => {
      const { studyId, projectId: current } = place.current;
      if (studyId) return studyId === target.studyId;
      return reading.current.inConversation && Boolean(item.projectId) && item.projectId === current;
    };

    const look = async () => {
      if (!live || document.visibilityState !== "visible") return;
      const { studyId, projectId: current } = place.current;
      if (!studyId && !(reading.current.inConversation && current)) return;
      const count = await fetchInboxUnreadCount().catch(() => null);
      if (!live || !count) return;
      // Nothing changed since the last look: the count is what it was.
      if (primed && count.unreadTotal === lastCount) return;
      lastCount = count.unreadTotal;
      const page = await listInbox({ unread: true, limit: 20 }).catch(() => null);
      if (!live || !page) return;
      for (const item of page.items) {
        const target = vcrNoticeTarget(item);
        if (!target || seen.has(item.id)) continue;
        seen.add(item.id);
        // The first look only learns what is already waiting.
        if (!primed || !here(item, target)) continue;
        toast.success(item.title, {
          action: {
            label: "查看结果",
            onClick: () => {
              goTo.current(vcrTabPath(target.studyId, target.tab));
              void markInboxRead(item.id, item.revision).then(announceInboxChanged).catch(() => {});
            },
          },
        });
      }
      primed = true;
    };

    // The reader may arrive on a page where a notice is already unread: the first look is silent, so it is made at once.
    void look();
    const timer = setInterval(() => { void look(); }, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [enabled]);
}
