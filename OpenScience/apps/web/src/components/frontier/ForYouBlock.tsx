import { Link } from "react-router";
import type { FrontierForYou } from "@/lib/frontierClient";
import { FrontierChip } from "./FrontierChip";
import { sourceTypeTone } from "./frontierText";

/**
 * 「与你相关」 (plan §4.6): at most five items picked from the reader's memory,
 * each saying why it was picked and pointing at the memory that said so.
 *
 * Rendered only when the route answers `available` with items. With memory
 * off, or for someone the platform knows nothing about yet, the block is
 * simply not there — no empty shell, no prompt to fill in a profile. With the
 * memory service down, one quiet line says personalisation is unavailable and
 * the rest of the page carries on (plan §10.5.3).
 */
export function ForYouBlock({ forYou }: { forYou: FrontierForYou | null }) {
  if (!forYou) return null;
  if (forYou.state === "unavailable") {
    return <p className="text-caption text-muted">「与你相关」暂时不可用，其余内容照常。</p>;
  }
  if (forYou.state !== "available" || forYou.items.length === 0) return null;
  return (
    <section aria-labelledby="frontier-for-you" className="rounded-card border border-border bg-surface px-4 py-3">
      <h2 id="frontier-for-you" className="flex flex-wrap items-baseline gap-x-2 text-ui font-semibold text-text">
        与你相关
        <span className="text-caption font-normal text-muted">
          {forYou.basis === "tags" ? "按记忆胶囊里你的专科和关键词挑选" : "根据记忆胶囊里你的专科和在做的课题自动挑选"}
        </span>
      </h2>
      <ul className="mt-2 divide-y divide-faint">
        {forYou.items.map(({ item, reason }) => {
          const because = reason.text.startsWith("因为") ? reason.text : `因为你关注：${reason.text}`;
          return (
            <li key={item.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
              {item.safetyAlert
                ? <FrontierChip tone="danger">安全警示</FrontierChip>
                : item.evidenceTypeLabel
                  ? <FrontierChip tone="outline">{item.evidenceTypeLabel}</FrontierChip>
                  : item.sourceTypeLabel && <FrontierChip tone={sourceTypeTone(item.sourceType)}>{item.sourceTypeLabel}</FrontierChip>}
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 text-ui text-text hover:underline">
                {item.title}
              </a>
              {reason.memoryId
                ? <Link to={`/app/memory?record=${encodeURIComponent(reason.memoryId)}`} className="text-caption text-accent-strong hover:underline">{because}</Link>
                : <span className="text-caption text-accent-strong">{because}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
