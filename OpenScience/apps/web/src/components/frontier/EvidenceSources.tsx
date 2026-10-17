import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { ShowMore, useShowMore } from "@/components/ui/ShowMore";
import { Tag } from "@/components/ui/Tag";
import { Toolbar, type ToolbarProps } from "@/components/ui/Toolbar";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import { COVERAGE_WORDS, claimSourceIndexes, publicationLabel, safeUrl } from "./EvidenceClaimDetail";
import { useEvidenceInspect } from "./evidenceInspect";

const SOURCES_FIRST = 10;
const SOURCES_STEP = 20;
const SEARCH_FROM = 12;

type Status = "all" | "warned";

/** The address a source is on, for the line under its title: 「pubmed.ncbi.nlm.nih.gov」, not the whole URL. */
function hostOf(url: string | null): string | null {
  const safe = safeUrl(url);
  if (!safe) return null;
  try {
    return new URL(safe).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The card's sources (来源与引用), as a list that opens (R19, audit D C2). A row is one source — its number, its title, how much of it
 * the card read, how many conclusions stand on it — and a press opens the excerpt in the drawer with the way to the original and the
 * conclusions that name it. They used to be an ordered list with the excerpt under every one, which for a programme card's thirty-nine
 * made forty thousand pixels. A source with a retraction, a correction or a concern says so on its row (a tag in the safety colour,
 * the one a page uses as a matter of course), and the toolbar narrows the list to those when there are any.
 */
export function EvidenceSources({ evidence }: { evidence: EvidenceCard }) {
  const inspect = useEvidenceInspect();
  const [status, setStatus] = useState<Status>("all");
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const cited = new Map<number, number>();
    for (const claim of evidence.claims) for (const index of claimSourceIndexes(claim)) cited.set(index, (cited.get(index) ?? 0) + 1);
    return evidence.sources.map((source, position) => ({ source, index: position + 1, cited: cited.get(position + 1) ?? 0 }));
  }, [evidence.claims, evidence.sources]);
  const warned = rows.filter((row) => row.source.publicationStatus).length;
  const needle = query.trim().toLowerCase();
  const matching = useMemo(() => rows.filter((row) => {
    if (status === "warned" && !row.source.publicationStatus) return false;
    return !needle || `${row.source.title} ${hostOf(row.source.url) ?? ""}`.toLowerCase().includes(needle);
  }), [rows, status, needle]);
  const { visible, remaining, more } = useShowMore(matching, { first: SOURCES_FIRST, step: SOURCES_STEP, resetKey: `${status}|${needle}` });
  if (rows.length === 0) return null;

  const filtering = status !== "all" || needle !== "";
  const clear = () => { setStatus("all"); setQuery(""); };
  const toolbar: ToolbarProps | null = warned > 0 || rows.length > SEARCH_FROM
    ? {
      label: "筛选来源",
      filters: warned > 0 ? [{
        kind: "chips", label: "来源状态", value: status, onChange: (value) => setStatus(value as Status),
        options: [{ value: "all", label: "全部" }, { value: "warned", label: "有警示", count: warned }],
      }] : [],
      search: rows.length > SEARCH_FROM ? { label: "搜索来源", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") } : undefined,
      summary: filtering ? `匹配 ${matching.length} 个` : undefined,
    }
    : null;

  return (
    <Section title="来源与引用" count={rows.length} toolbar={toolbar ? <Toolbar {...toolbar} /> : undefined}>
      {matching.length === 0 ? (
        <Note action={<Button variant="secondary" size="sm" onClick={clear}>清除筛选</Button>}>没有符合的来源。</Note>
      ) : (
        <>
          <List label="来源与引用" divided>
            {visible.map(({ source, index, cited }) => {
              const line = [source.coverage ? COVERAGE_WORDS[source.coverage] : null, cited > 0 ? `${cited} 条结论依据它` : null, hostOf(source.url)].filter(Boolean).join(" · ");
              return (
                <ListRow
                  key={index}
                  leading={<span className="w-8 text-caption tabular-nums text-text-3">[{index}]</span>}
                  title={<span className="line-clamp-2 break-words">{source.title}</span>}
                  onOpen={inspect ? () => inspect.openSource(index) : undefined}
                  meta={line || undefined}
                  trailing={source.publicationStatus ? <Tag tone="safety">{publicationLabel(source.publicationStatus.kind)}</Tag> : undefined}
                />
              );
            })}
          </List>
          <ShowMore remaining={remaining} unit="个" onMore={more} />
        </>
      )}
    </Section>
  );
}
