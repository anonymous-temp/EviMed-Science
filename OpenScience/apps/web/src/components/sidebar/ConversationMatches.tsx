import { useEffect, useState } from "react";
import { NavLink } from "react-router";
import { MessageSquareText } from "lucide-react";
import { useRuntimeSessionSearch, type FrameSessionSearchItem } from "@/lib/runtimeUiBridge";

/** How long typing must pause before the kernel is asked. */
const SEARCH_DEBOUNCE_MS = 300;
/** Conversations shown under the task rows; the kernel may find more. */
const MAX_MATCHES = 6;

/**
 * Conversations whose text matches the task search, found by the kernel's own
 * full-text index (`session/search`).
 *
 * Hidden knowledge: the task rows above filter run titles, which say what a
 * run was for but not what was said in it — a researcher looking for "the
 * conversation where it quoted ASPREE" has only the words. The kernel indexes
 * every conversation of the project, but only the research frame holds the
 * connection that can ask it, so the search is offered while a frame is open
 * and this list is simply absent otherwise (`available` false), never an
 * error. Conversations already shown as a task row are not repeated.
 */
export function ConversationMatches({ query, shownSessionIds }: { query: string; shownSessionIds: ReadonlySet<string> }) {
  const { available, search } = useRuntimeSessionSearch();
  const [matches, setMatches] = useState<FrameSessionSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const needle = query.trim();

  useEffect(() => {
    setMatches([]);
    if (!available || needle.length < 2) {
      setSearching(false);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      void search(needle, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setSearching(false);
        setMatches(result.ok ? result.items : []);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [available, needle, search]);

  if (!available || needle.length < 2) return null;
  const rows = matches
    .filter((item) => /^[A-Za-z0-9_-]{1,160}$/.test(item.sessionId) && !shownSessionIds.has(item.sessionId))
    .slice(0, MAX_MATCHES);
  if (!searching && rows.length === 0) return null;

  return (
    <section aria-label="对话内容匹配" className="mt-2">
      <h3 className="px-2 py-1 text-caption font-semibold text-muted">对话内容匹配</h3>
      {searching && rows.length === 0 && <div className="px-2 py-1 text-caption text-muted">正在搜索对话…</div>}
      {rows.map((item) => (
        <NavLink
          key={item.sessionId}
          to={`/app/chat/${encodeURIComponent(item.sessionId)}`}
          className="flex items-start gap-2 rounded-input py-1.5 pl-2 pr-2 hover:bg-surface-2 aria-[current=page]:bg-accent-soft"
        >
          <MessageSquareText size={13} strokeWidth={1.75} className="mt-1 shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui text-text">{item.title || "未命名对话"}</span>
            {item.snippet && <span className="block truncate text-caption text-muted">{item.snippet}</span>}
          </span>
        </NavLink>
      ))}
    </section>
  );
}
