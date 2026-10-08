import { useEffect, useMemo, useState } from "react";
import {
  CLAIM_TYPE_LABEL,
  claimCheckMark,
  claimMatrixSearchText,
  claimNeedsReview,
  claimSources,
  claimTypeLabel,
  type ClaimCheckState,
  type ClaimEvidence,
} from "@/lib/claimCitations";
import { cn } from "@/lib/cn";
import type { VerifiedClaim } from "@/components/markdown-viewer/ClaimCitation";
import { Button } from "@/components/ui/Button";
import { FilterChips, FilterSelect, type FilterOption } from "@/components/ui/FilterChips";
import { ScrollRegion } from "@/components/ui/ScrollRegion";
import { SearchInput } from "@/components/ui/SearchInput";
import { EvidenceMatrixDrawer, MARK_TONE_CLASS } from "./EvidenceMatrixDrawer";

type CheckFilter = "all" | "verified" | "review";
type TypeFilter = keyof typeof CLAIM_TYPE_LABEL;

const CHECK_OPTIONS: readonly FilterOption<CheckFilter>[] = [
  { value: "all", label: "全部" },
  { value: "verified", label: "已核对" },
  { value: "review", label: "需要复核" },
];
const TYPE_ORDER: readonly TypeFilter[] = ["direct", "synthesized", "derived"];

/**
 * Below this width of its own box the matrix is a list of cards: five columns need about 40 rem, and a pane
 * beside a conversation is as narrow as a phone on a wide screen. Coming back to the table takes 2 rem more,
 * so a scrollbar appearing when the list changes height cannot flip it between the two.
 */
const TABLE_MIN_WIDTH = 640;
const TABLE_RETURN_WIDTH = 672;
/** Until the box has been measured (and where it cannot be): a phone's width. */
const CARD_MEDIA = "(max-width: 767px)";

function useCards(box: HTMLElement | null): boolean {
  const [cards, setCards] = useState(() => typeof window !== "undefined" && window.matchMedia(CARD_MEDIA).matches);
  useEffect(() => {
    const media = window.matchMedia(CARD_MEDIA);
    let measured = false;
    const onMedia = () => { if (!measured) setCards(media.matches); };
    media.addEventListener("change", onMedia);
    const observer = box && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver((entries) => {
        const width = entries[entries.length - 1]?.contentRect.width ?? 0;
        if (width <= 0) return;
        measured = true;
        setCards((current) => width < (current ? TABLE_RETURN_WIDTH : TABLE_MIN_WIDTH));
      })
      : null;
    if (box) observer?.observe(box);
    return () => {
      media.removeEventListener("change", onMedia);
      observer?.disconnect();
    };
  }, [box]);
  return cards;
}

const GROUND = { bg: "bg-bg", surface: "bg-surface", "surface-2": "bg-surface-2" } as const;

/**
 * The evidence matrix as a list a reader can search (2026-10-07 audit K04): one
 * compact row per claim — its id, whether its quotation was found, the
 * sentence, the first source and the kind of claim — and a row opens the claim
 * in a drawer with everything it stands on: PICO, every quotation in full and
 * where it sits in its source. 112 conclusions with their quotations in the
 * rows were 25,000 px of table with the check pushed off the right edge.
 *
 * The check is the second column, so it is never off screen; in a box too
 * narrow for five columns (a phone, a pane) the rows are cards, so nothing
 * scrolls sideways. A search over the sentence, id,
 * source titles and quotations, a filter on the check and one on the kind of
 * claim narrow the list; the toolbar says how many of the claims it shows.
 *
 * What the check column says depends on whether the checks were read
 * (`verificationState`): 「核对中」 while they are on their way, 「暂无核对结果」
 * when they could not be read, and 「未核对」 only when they were read and this
 * claim is not among them.
 */
export function EvidenceMatrixTable({
  claims,
  verified,
  verificationState,
  runId,
  ground = "bg",
  className,
}: {
  claims: Map<string, ClaimEvidence>;
  verified?: Map<string, VerifiedClaim>;
  /** Whether the checks were read; absent, a non-empty `verified` means they were. */
  verificationState?: ClaimCheckState;
  runId?: string | null;
  /** The ground the toolbar sticks over while the list scrolls under it. */
  ground?: keyof typeof GROUND;
  /** Classes of the bordered list under the toolbar. */
  className?: string;
}) {
  const rows = useMemo(() => [...claims.values()], [claims]);
  const state: ClaimCheckState = verificationState ?? (verified && verified.size > 0 ? "ready" : "unavailable");
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const cards = useCards(box);
  const [query, setQuery] = useState("");
  const [check, setCheck] = useState<CheckFilter>("all");
  const [type, setType] = useState<TypeFilter | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const searchText = useMemo(() => new Map(rows.map((claim) => [claim.claimId, claimMatrixSearchText(claim)])), [rows]);
  const typeOptions = useMemo(
    () => TYPE_ORDER.filter((value) => rows.some((claim) => claim.claimType === value)).map((value) => ({ value, label: CLAIM_TYPE_LABEL[value] })),
    [rows],
  );
  // A check filter needs the checks: while they load, or when they cannot be read, it is not offered.
  const checkFilter: CheckFilter = state === "ready" ? check : "all";
  const marks = useMemo(
    () => new Map(rows.map((claim) => [claim.claimId, claimCheckMark(claim, verified?.get(claim.claimId), state)])),
    [rows, verified, state],
  );
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => rows.filter((claim) => {
    if (needle && !searchText.get(claim.claimId)?.includes(needle)) return false;
    if (type && claim.claimType !== type) return false;
    if (checkFilter === "all") return true;
    const mark = marks.get(claim.claimId)!;
    return checkFilter === "review" ? claimNeedsReview(mark) : mark.kind === "verified";
  }), [rows, needle, type, checkFilter, searchText, marks]);

  if (rows.length === 0) {
    return <p className="p-4 text-ui text-muted">这个证据矩阵里没有可读的结论。</p>;
  }

  const typeSelect = typeOptions.length > 1
    ? <FilterSelect label="类型" options={typeOptions} value={type} onChange={setType} allLabel="全部类型" />
    : null;
  const filtered = needle !== "" || type !== null || checkFilter !== "all";
  const clear = () => {
    setQuery("");
    setCheck("all");
    setType(null);
  };
  const open = openId ? claims.get(openId) : undefined;
  const rowData = shown.map((claim) => {
    const sources = claimSources(claim);
    const first = sources[0];
    return {
      claim,
      mark: marks.get(claim.claimId)!,
      source: first ? (first.sourceTitle ?? first.identifier ?? "来源未记录") : null,
      more: sources.length > 1 ? sources.length : 0,
    };
  });

  return (
    <div ref={setBox}>
      {/* Stuck to the top of the page from `sm` up; on a phone it is three rows high and would take a sixth of the screen. */}
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 pb-3 pt-1 sm:sticky sm:top-0 sm:z-sticky max-sm:px-4", GROUND[ground])}>
        <SearchInput
          label="搜索结论"
          size="sm"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
        />
        {state === "ready" ? (
          <FilterChips
            label="核对"
            options={CHECK_OPTIONS}
            value={checkFilter}
            onChange={setCheck}
            className="min-w-0 grow basis-72"
            trailing={typeSelect}
          />
        ) : typeSelect && <div className="min-w-0 grow basis-72">{typeSelect}</div>}
        {/* The count is of rows, which are known before the checks are: it is shown while they load too (a matrix whose checks
            never arrive — the runtime not started — still says how many rows a search left). */}
        {state === "loading" && <span role="status" className="sr-only">正在读取这些结论的核对结果</span>}
        <p aria-live="polite" className="ml-auto shrink-0 text-caption tabular-nums text-text-3">显示 {shown.length} / {rows.length} 条</p>
      </div>

      <div className={cn("overflow-hidden rounded-card border border-border bg-surface", className)}>
        {rowData.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-ui text-text-2">没有符合的结论</p>
            {filtered && <Button variant="secondary" onClick={clear}>清除筛选</Button>}
          </div>
        ) : cards ? (
          <ul aria-label="证据矩阵" className="divide-y divide-faint">
            {rowData.map(({ claim, mark, source, more }) => (
              <li key={claim.claimId} id={`matrix-${claim.claimId}`}>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  // Focused first, as the table row focuses its own button: the drawer returns focus to what held it when it
                  // opened, and a tap does not focus a button on every phone (iOS Safari), so Escape left focus in the search box.
                  onClick={(event) => { event.currentTarget.focus(); setOpenId(claim.claimId); }}
                  className="block w-full px-4 py-3 text-left hover:bg-surface-2"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-caption font-medium text-text">{claim.claimId}</span>
                    <span className={cn("text-caption", MARK_TONE_CLASS[mark.tone])}>{mark.text}</span>
                  </span>
                  <span className="mt-1 line-clamp-3 text-ui text-text">{claim.claim}</span>
                  {source && <span className="mt-1 line-clamp-1 text-caption text-text-3">{source}{more > 0 ? ` 等 ${more} 项` : ""}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          // Sideways only if the box is measured wrong for a moment (zoom, a late font): the id stays.
          <ScrollRegion label="证据矩阵">
            <table className="w-full min-w-[40rem] table-fixed border-separate border-spacing-0 text-left text-ui">
              <caption className="sr-only">证据矩阵：{rowData.length} 条结论</caption>
              <thead>
                <tr className="text-compact text-text-3">
                  <th scope="col" className={cn(HEAD, "sticky left-0 z-page w-24 bg-surface-2")}>结论</th>
                  <th scope="col" className={cn(HEAD, "w-32")}>核对</th>
                  <th scope="col" className={HEAD}>内容</th>
                  <th scope="col" className={cn(HEAD, "w-1/4")}>来源</th>
                  <th scope="col" className={cn(HEAD, "w-24")}>类型</th>
                </tr>
              </thead>
              <tbody>
                {rowData.map(({ claim, mark, source, more }) => (
                  // The click is the pointer's way onto the row; the keyboard's is the button in its first cell.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- the keyboard equivalent is the id button of this row.
                  <tr
                    key={claim.claimId}
                    id={`matrix-${claim.claimId}`}
                    onClick={(event) => {
                      // A drag that selected some text is a reading, not a request to open.
                      if (window.getSelection()?.toString()) return;
                      event.currentTarget.querySelector<HTMLElement>("[data-matrix-open]")?.focus();
                      setOpenId(claim.claimId);
                    }}
                    className="group cursor-pointer align-top hover:bg-surface-2 [&:last-child>*]:border-b-0"
                  >
                    <th scope="row" className={cn(CELL, "sticky left-0 z-page bg-surface font-normal group-hover:bg-surface-2")}>
                      <button
                        type="button"
                        data-matrix-open=""
                        aria-haspopup="dialog"
                        className="whitespace-nowrap rounded font-mono text-caption font-medium text-text hover:underline"
                      >
                        {claim.claimId}
                      </button>
                    </th>
                    <td className={cn(CELL, "text-caption", MARK_TONE_CLASS[mark.tone])}>{mark.text}</td>
                    <td className={cn(CELL, "text-text")}><p className="line-clamp-3">{claim.claim}</p></td>
                    <td className={cn(CELL, "text-caption text-text-2")}>
                      {source ? (
                        <>
                          <p className="line-clamp-2 break-words">{source}</p>
                          {more > 0 && <p className="text-text-3">等 {more} 项</p>}
                        </>
                      ) : (
                        <span className="text-text-3">—</span>
                      )}
                    </td>
                    <td className={cn(CELL, "text-caption text-text-2")}>{claimTypeLabel(claim.claimType)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </div>

      {open && (
        <EvidenceMatrixDrawer
          claim={open}
          check={verified?.get(open.claimId)}
          verificationState={state}
          runId={runId}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

const HEAD = "border-b border-border bg-surface-2 px-3 py-2 font-normal";
const CELL = "border-b border-faint px-3 py-2.5";
