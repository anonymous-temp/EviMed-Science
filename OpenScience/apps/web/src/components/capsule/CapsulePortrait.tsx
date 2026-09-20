import type { WebStructuredMemory } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { memoryExcerpt } from "@/lib/memoryText";

/** The filters the list below understands, and what the portrait points at. */
export type MemoryFilter = "all" | "self" | "methods" | "project" | "forgotten";

/**
 * The lines of 「EviMed 眼中的你」, in the order a reader meets a person:
 * who they are, how they work, what this project is.
 *
 * Each line is built from stored sentences and nothing else. No model rewrites
 * them for this page: a portrait that paraphrased would be a second version of
 * the person that nobody could trace back to a row, and there would be no
 * honest way to offer 「改」 on it. So a line is its records' own words joined,
 * and clicking it filters the list to exactly those records — which is also why
 * a line with no records behind it is never shown rather than shown empty.
 */
const LINES: readonly { group: string; kinds: readonly WebStructuredMemory["kind"][]; filter: MemoryFilter }[] = [
  { group: "你和你的研究方向", kinds: ["profile"], filter: "self" },
  { group: "你和你的研究方向", kinds: ["correction"], filter: "self" },
  { group: "你的做法", kinds: ["preference"], filter: "methods" },
  { group: "你的做法", kinds: ["behavior"], filter: "methods" },
  { group: "这个项目", kinds: ["project_fact", "decision"], filter: "project" },
  { group: "这个项目", kinds: ["follow_up"], filter: "project" },
];

/** At most this many lines: a portrait, not a dump. */
const MAX_LINES = 6;
/** At most this many stored sentences per line, longest-established first. */
const PER_LINE = 2;

/** A sentence ends with its own stop, whatever the record's text ended with. */
function sentence(record: WebStructuredMemory) {
  return `${memoryExcerpt(record.summary || record.value, 120).replace(/[。.;；,，\s]+$/u, "")}。`;
}

export interface PortraitLine {
  group: string;
  text: string;
  filter: MemoryFilter;
  kinds: readonly string[];
  recordIds: string[];
}

/**
 * What the portrait has to say about this account, given everything stored.
 *
 * Exported so the page can ask whether there is a portrait at all before it
 * reserves the space, and so a test can check the "no backing row, no sentence"
 * rule without rendering.
 */
export function portraitLines(records: readonly WebStructuredMemory[], learnedMethods: readonly string[] = []): PortraitLine[] {
  const usable = records.filter((record) => record.status === "active" && !record.sensitive && record.kind !== "run_summary");
  const lines: PortraitLine[] = [];
  for (const line of LINES) {
    const rows = usable
      .filter((record) => (line.kinds as readonly string[]).includes(record.kind))
      .slice(0, PER_LINE);
    if (rows.length === 0) continue;
    lines.push({
      group: line.group,
      text: rows.map(sentence).join(""),
      filter: line.filter,
      kinds: line.kinds,
      recordIds: rows.map((record) => record.id),
    });
  }
  // What the loop learned belongs under 你的做法 even when no `preference`
  // record exists: a method is the most concrete thing the platform can say
  // about how this person works.
  if (learnedMethods.length > 0) {
    lines.push({
      group: "你的做法",
      text: learnedMethods.slice(0, PER_LINE).map((name) => `${name}。`).join(""),
      filter: "methods",
      kinds: [],
      recordIds: [],
    });
  }
  const order = ["你和你的研究方向", "你的做法", "这个项目"];
  return lines
    .sort((left, right) => order.indexOf(left.group) - order.indexOf(right.group))
    .slice(0, MAX_LINES);
}

/**
 * 「EviMed 眼中的你」 — four to six sentences, grouped, every one of them
 * clickable through to the rows it was built from.
 */
export function CapsulePortrait({
  lines,
  active,
  onSelect,
}: {
  lines: readonly PortraitLine[];
  active: MemoryFilter;
  onSelect: (filter: MemoryFilter) => void;
}) {
  if (lines.length === 0) {
    return (
      <section aria-labelledby="capsule-portrait" className="rounded-card border border-border bg-surface p-5">
        <h2 id="capsule-portrait" className="text-body font-semibold text-text">EviMed 眼中的你</h2>
        <p className="mt-2 text-ui text-muted">
          还没有可写的内容。和 EviMed 做几次研究，或者在对话里说说你是谁、你习惯怎么做，这里就会写出来——不需要你填表。
        </p>
      </section>
    );
  }
  const groups = [...new Set(lines.map((line) => line.group))];
  return (
    <section aria-labelledby="capsule-portrait" className="rounded-card border border-border bg-surface p-5">
      <h2 id="capsule-portrait" className="text-body font-semibold text-text">EviMed 眼中的你</h2>
      <dl className="mt-3 space-y-3">
        {groups.map((group) => (
          <div key={group}>
            <dt className="text-caption text-muted">{group}</dt>
            {lines.filter((line) => line.group === group).map((line) => (
              <dd key={`${line.group}-${line.text}`} className="mt-1">
                <button
                  type="button"
                  onClick={() => onSelect(line.filter)}
                  aria-pressed={active === line.filter}
                  className={cn(
                    "rounded-input px-2 py-1 text-left text-ui text-text hover:bg-surface-2",
                    active === line.filter && "bg-accent-soft",
                  )}
                >
                  {line.text}
                </button>
              </dd>
            ))}
          </div>
        ))}
      </dl>
      <p className="mt-3 text-caption text-muted">点任意一句，下面只看它依据的那几条。</p>
    </section>
  );
}
