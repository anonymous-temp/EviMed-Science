import { useMemo, useState } from "react";
import { EVIDENCE_CALCULATION_LABEL_ZH } from "@evimed/domain";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { ShowMore, useShowMore } from "@/components/ui/ShowMore";
import { Toolbar, type ToolbarProps } from "@/components/ui/Toolbar";
import type { EvidenceCard, EvidenceClaim } from "@/lib/evidenceZoneClient";
import { CLAIM_STATUS_TEXT, claimSourceIndexes } from "./EvidenceClaimDetail";
import { evidenceClaimKey, evidenceClaimsAnchor, useEvidenceInspect } from "./evidenceInspect";

/** Rows listed before 「显示更多」: a programme card holds dozens of conclusions, and the page is not their stack. */
const CLAIMS_FIRST = 10;
const CLAIMS_STEP = 20;
/** A list shorter than this is read, not searched. */
const SEARCH_FROM = 12;

const CONFIDENCE: Record<string, string> = { high: "高", moderate: "中", low: "低" };

/** ✓ (the quotation was found in the source it names), ⚠ (not found, or not checkable), nothing for an estimate; in the column every title starts after. */
function RowMark({ claim }: { claim: EvidenceClaim }) {
  const mark = claim.verification?.mark;
  return (
    <span className="inline-flex w-4 justify-center">
      {mark === "✓" && <span className="text-verify-ok" aria-label="引文已核对">✓</span>}
      {mark === "⚠" && <span className="text-verify-pending" aria-label="未核对上">⚠</span>}
    </span>
  );
}

/** What a row says under the statement: the kind of claim when it is not a plain quotation, the sources it names, and why a ⚠ is one. */
function rowLine(claim: EvidenceClaim): { text: string; warn: string | null } {
  const type = claim.claimType ?? "direct";
  const kind = type === "derived" ? "推导结果"
    : type === "calculated" ? EVIDENCE_CALCULATION_LABEL_ZH
      : type === "synthesized" ? `综合结论${claim.confidence ? ` · 把握程度${CONFIDENCE[claim.confidence]}` : ""}` : null;
  const sources = claimSourceIndexes(claim);
  const status = claim.verification?.mark === "⚠" ? CLAIM_STATUS_TEXT[claim.verification.status] ?? null : null;
  return { text: [kind, sources.length > 0 ? `来源 ${sources.join("、")}` : null].filter(Boolean).join(" · "), warn: status };
}

type Status = "all" | "check";

/**
 * The card's conclusions (证据要点), as a list that opens (R19, audit D C2). Each row is one conclusion with its mark in front — ✓ its
 * quotation was found in the source it names, ⚠ it was not, or could not be checked — and a press opens the quotation in the drawer
 * (`EvidenceInspector`). They used to be a stack of eight with their quotations under them, and 「展开其余」 for the rest, which for a
 * programme card's fifty-eight was most of the page. The toolbar over the list narrows it to the ones that need checking (drawn only
 * when there is one) and searches it (drawn only past a dozen); a conclusion of an older card — a statement and nothing else — is a
 * line that opens nothing.
 */
export function EvidenceClaims({ evidence }: { evidence: EvidenceCard }) {
  const inspect = useEvidenceInspect();
  const [status, setStatus] = useState<Status>("all");
  const [query, setQuery] = useState("");
  const rows = useMemo(() => evidence.claims.map((claim, position) => ({ claim, key: evidenceClaimKey(claim, position), openable: Boolean(claim.claimId) })), [evidence.claims]);
  const needsCheck = rows.filter((row) => row.claim.verification?.mark === "⚠").length;
  const needle = query.trim().toLowerCase();
  const matching = useMemo(() => rows.filter((row) => {
    if (status === "check" && row.claim.verification?.mark !== "⚠") return false;
    if (!needle) return true;
    const quotes = [row.claim.supportQuote, ...(row.claim.supportingSources ?? []).map((bond) => bond.supportQuote)];
    return [row.claim.text, ...quotes].some((text) => text?.toLowerCase().includes(needle));
  }), [rows, status, needle]);
  const { visible, remaining, more } = useShowMore(matching, { first: CLAIMS_FIRST, step: CLAIMS_STEP, resetKey: `${status}|${needle}` });
  if (rows.length === 0) return null;

  const filtering = status !== "all" || needle !== "";
  const clear = () => { setStatus("all"); setQuery(""); };
  const toolbar: ToolbarProps | null = needsCheck > 0 || rows.length > SEARCH_FROM
    ? {
      label: "筛选证据要点",
      filters: needsCheck > 0 ? [{
        kind: "chips", label: "核对状态", value: status, onChange: (value) => setStatus(value as Status),
        options: [{ value: "all", label: "全部" }, { value: "check", label: "需要核对", count: needsCheck }],
      }] : [],
      search: rows.length > SEARCH_FROM ? { label: "搜索证据要点", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") } : undefined,
      summary: filtering ? `匹配 ${matching.length} 条` : undefined,
    }
    : null;

  return (
    <div id={evidenceClaimsAnchor(evidence.id)}>
      <Section title="证据要点" count={rows.length} toolbar={toolbar ? <Toolbar {...toolbar} className="max-sm:w-full" /> : undefined}>
        {matching.length === 0 ? (
          <Note action={<Button variant="secondary" size="sm" onClick={clear}>清除筛选</Button>}>没有符合的结论。</Note>
        ) : (
          <>
            <List label="证据要点" divided>
              {visible.map(({ claim, key, openable }) => {
                const line = rowLine(claim);
                return (
                  <ListRow
                    key={key}
                    leading={<RowMark claim={claim} />}
                    title={<span className="line-clamp-3 whitespace-pre-wrap break-words">{claim.text}</span>}
                    onOpen={inspect && openable ? () => inspect.openClaim(key) : undefined}
                    meta={(line.text || line.warn) ? (
                      <span>
                        {line.text}
                        {line.warn && <span className={line.text ? "ml-2 text-verify-pending" : "text-verify-pending"}>{line.warn}</span>}
                      </span>
                    ) : undefined}
                  />
                );
              })}
            </List>
            <ShowMore remaining={remaining} unit="条" onMore={more} />
          </>
        )}
      </Section>
    </div>
  );
}
