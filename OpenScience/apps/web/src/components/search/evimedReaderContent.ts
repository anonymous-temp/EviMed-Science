import type { EvimedSearchDetail } from "@/lib/evimedSearchClient";

export function normalizedSearchFact(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return /^(unknown|null|undefined|n\/?a|--|暂无(?:数据|信息|内容)?)$/i.test(text) ? "" : text;
}

export function searchDetailFacts(detail: EvimedSearchDetail) {
  const seen = new Set([normalizedSearchFact(detail.title)]);
  return [
    { label: "来源", value: detail.source },
    // Prefer the upstream field's label over the fallback subtitle label.
    ...detail.metadata,
    { label: "DOI", value: detail.doi ?? "" },
    { label: "补充信息", value: detail.subtitle },
  ].filter((fact) => {
    const key = normalizedSearchFact(fact.value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Only expose explicit structured-abstract labels; never infer or rewrite clinical prose. */
export function structuredAbstract(text: string): { title: string; text: string }[] | null {
  const headings = /(?:^|(?<=[.!?。；;\n])\s+)(Background|Introduction|Objectives?|Purpose|Aims?|Methods?|Materials and Methods|Results?|Discussion|Conclusions?|背景|目的|方法|结果|结论)\s*[:：]\s*/gim;
  const matches = [...text.matchAll(headings)];
  if (matches.length < 2 || text.slice(0, matches[0].index).trim()) return null;
  if (new Set(matches.map(match => match[1].toLowerCase())).size !== matches.length) return null;
  const parts = matches.map((match, index) => ({
    title: match[1],
    text: text.slice(match.index! + match[0].length, matches[index + 1]?.index ?? text.length).trim(),
  }));
  return parts.every(part => part.text) ? parts : null;
}
