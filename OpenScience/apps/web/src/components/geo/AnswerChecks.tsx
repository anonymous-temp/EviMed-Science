import type { GeoAnswer } from "@/lib/geoClient";
import { safeWebHref } from "@/lib/readPages";

/** The four kinds of specified information, in the words a reader knows them by. */
const TOPIC_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["indication", "适应证"], ["dosage", "用法用量"], ["contraindication", "禁忌"], ["adverse_reaction", "不良反应"],
];

/** What a cited page was found to say about the sentence the answer attributes to it. */
const SUPPORT_WORDS: Readonly<Record<string, string>> = Object.freeze({ yes: "页面里有这么说", no: "页面里说的不一样", unclear: "页面里没有谈到" });

/**
 * What the judge found beside the statements, in the order that matters: how many of the specified information (indication, dosage,
 * contraindication, adverse reaction) agree with the label, then a claim beyond the label, safety information left out, and what the
 * links the answer cites say. Each is a line of text — a finding to read, never a stop — and a line with nothing to say is not drawn.
 */
export function AnswerChecks({ facts }: { facts: GeoAnswer["facts"] | undefined }) {
  const info = facts?.specifiedInfo;
  const checks = facts?.checks;
  const offLabel = Array.isArray(checks?.offLabel) ? checks.offLabel : [];
  const omitted = Array.isArray(checks?.omittedSafety) ? checks.omittedSafety : [];
  const links = (Array.isArray(checks?.citations) ? checks.citations : []).filter((citation) => citation?.url && (citation.exists !== null || citation.supports));
  if (!info?.decided && !offLabel.length && !omitted.length && !links.length) return null;
  return (
    <section aria-label="对照卡片结论的核对" data-geo-checks="" className="mt-10">
      <h2 className="mb-3 text-ui font-semibold text-text">对照卡片结论的核对</h2>
      <ul className="flex flex-col gap-2 text-ui text-text-2">
        {info && info.decided > 0 && (
          <li>
            指定信息：判定 {info.decided} 句，讲对 {info.correct} 句，讲错 {info.wrong} 句
            {TOPIC_WORDS.map(([key, word]) => {
              const entry = info.byTopic?.[key];
              return entry && entry.correct + entry.wrong > 0 ? `；${word} 对 ${entry.correct} 错 ${entry.wrong}` : "";
            }).join("")}
          </li>
        )}
        {offLabel.map((sentence) => <li key={sentence} data-geo-off-label="">超出说明书的说法：“{sentence}”</li>)}
        {omitted.length > 0 && <li>漏掉了 {omitted.length} 条说明书上的安全信息</li>}
        {links.map((citation) => {
          const href = safeWebHref(citation.url);
          return (
            <li key={`${citation.link}-${citation.url}`} data-geo-link-check="">
              引用的链接{href ? <a href={href} target="_blank" rel="noreferrer" className="text-text underline">{citation.url}</a> : citation.url}
              ：{citation.exists === false ? "打不开或已不存在" : citation.supports ? SUPPORT_WORDS[citation.supports] ?? "" : "能打开"}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
