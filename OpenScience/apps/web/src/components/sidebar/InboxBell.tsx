import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Bell, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { fetchInboxUnreadCount, INBOX_CHANGED_EVENT, type InboxUnreadCount } from "@/lib/inboxClient";

/** How often the bell asks while the tab is visible. The route returns two
 *  integers, so a minute is cheap; a change on this page does not wait for it
 *  (`INBOX_CHANGED_EVENT`). */
const POLL_MS = 60_000;

/** The badge's text: the real count to 99, then 「99+」. */
export function unreadBadgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** The bell's accessible name — the number, and the safety share when there is one. */
export function inboxBellLabel({ unreadTotal, safetyUnread }: InboxUnreadCount): string {
  if (unreadTotal <= 0) return "收件箱";
  const safety = safetyUnread > 0 ? `，其中 ${safetyUnread} 条涉及临床安全` : "";
  return `收件箱，${unreadTotal} 条未读${safety}`;
}

/**
 * The inbox's bell, and a small red dot when something is unread.
 *
 * A dot, not a number (2026-09-23 plan §5.2): the count is on the inbox's own
 * 「未读 N」 filter and in the bell's accessible name; in the sidebar it was
 * one more figure competing with the conversations. A 20 px glyph in a 32 px
 * hit area (WCAG 2.5.8 asks for 24).
 *
 * The count is the server's total, not a page length: it used to be
 * `items.length` of one 50-item page, so the badge saturated at 50 and 「99+」
 * could never render. Clinical-safety items are the one class allowed to
 * interrupt, so when any is unread the bell changes shape — a shield instead of
 * a bell — and says so in its name; the colour only repeats what the shape and
 * the words already carry.
 *
 * A count that cannot be read is no badge, never an error in a sidebar.
 */
export function InboxBell() {
  const navigate = useNavigate();
  const [count, setCount] = useState<InboxUnreadCount>({ unreadTotal: 0, safetyUnread: 0 });
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchInboxUnreadCount()
        .then((value) => {
          if (!active) return;
          setCount(value);
          // Announce arrivals only. Re-reading the same number every minute
          // would make a screen reader repeat it for as long as the tab is open.
          if (previous.current != null && value.unreadTotal > previous.current) {
            setAnnouncement(`收到 ${value.unreadTotal - previous.current} 条新通知`);
          }
          previous.current = value.unreadTotal;
        })
        .catch(() => { /* isolated: no badge rather than a broken sidebar */ });
    void load();
    // Only while someone is looking: a badge nobody can see is spend with no
    // reader (2026-09-16 review, D3).
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    const onChanged = () => { void load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(INBOX_CHANGED_EVENT, onChanged);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(INBOX_CHANGED_EVENT, onChanged);
    };
  }, []);

  const unread = count.unreadTotal;
  const safety = count.safetyUnread > 0;
  const Icon = safety ? ShieldAlert : Bell;
  return (
    <>
      <button
        type="button"
        onClick={() => navigate("/app/inbox")}
        aria-label={inboxBellLabel(count)}
        title={inboxBellLabel(count)}
        data-safety={safety || undefined}
        className={cn(
          "relative ml-auto grid h-8 w-8 shrink-0 place-items-center rounded hover:bg-surface-2",
          safety ? "text-danger" : "text-text-3 hover:text-text",
        )}
      >
        <Icon size={20} aria-hidden="true" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-unread ring-2 ring-surface-1"
          />
        )}
      </button>
      <span className="sr-only" aria-live="polite">{announcement}</span>
    </>
  );
}
