import type {
  EvidenceCard,
  EvidenceContent as Content,
} from "@/lib/evidenceZoneClient";

export const evidenceSourceId = (cardId: string, index: number) =>
  `evidence-source-${encodeURIComponent(cardId)}-${index}`;

export function EvidenceReferences({
  evidence,
  indexes = [],
}: {
  evidence: EvidenceCard;
  indexes?: number[];
}) {
  const valid = [...new Set(indexes)].filter(
    (index) =>
      Number.isInteger(index) && index > 0 && index <= evidence.sources.length,
  );
  return valid.length ? (
    <span className="ml-2 inline-flex flex-wrap gap-2 text-caption">
      {valid.map((index) => (
        <a
          key={index}
          href={`#${evidenceSourceId(evidence.id, index)}`}
          aria-label={`查看来源 ${index}`}
          className="text-accent hover:underline"
        >
          [{index}]
        </a>
      ))}
    </span>
  ) : null;
}

const number = (value: number) =>
  value.toLocaleString("zh-CN", { maximumFractionDigits: 8 });
const denominatorUnit = (
  comparison: NonNullable<Content["comparisons"]>[number],
) => (comparison.measure === "rate" ? "人年" : "人");
const eventUnit = (comparison: NonNullable<Content["comparisons"]>[number]) =>
  comparison.measure === "rate" ? "次" : "人";
const validComparison = (
  comparison: NonNullable<Content["comparisons"]>[number],
) =>
  Number.isFinite(comparison.denominator) &&
  comparison.denominator > 0 &&
  [comparison.control.events, comparison.intervention.events].every(
    (events) =>
      Number.isFinite(events) &&
      events >= 0 &&
      (comparison.measure === "rate" || events <= comparison.denominator),
  );

export function EvidenceContent({ evidence }: { evidence: EvidenceCard }) {
  const content = evidence.content;
  if (!content) return null;
  return (
    <>
      {(content.population || content.context) && (
        <section className="space-y-2">
          {content.population && (
            <p className="text-ui leading-relaxed text-text-2">
              <span className="font-medium text-text">适用人群 · </span>
              {content.population}
            </p>
          )}
          {content.context && (
            <p className="whitespace-pre-wrap text-ui leading-relaxed text-text-2">
              {content.context}
            </p>
          )}
        </section>
      )}
      {content.comparisons?.filter(validComparison).map((comparison, index) => {
        const maximum =
          comparison.measure === "rate"
            ? Math.max(
                comparison.control.events,
                comparison.intervention.events,
                1,
              )
            : comparison.denominator;
        return (
          <figure
            key={index}
            className="space-y-3 rounded-card border border-border p-4"
          >
            <figcaption className="text-ui font-medium text-text">
              {comparison.title}
              <EvidenceReferences
                evidence={evidence}
                indexes={comparison.sourceIndexes}
              />
            </figcaption>
            <p className="text-caption text-text-2">
              {comparison.outcome} · 每 {number(comparison.denominator)}{" "}
              {denominatorUnit(comparison)} · {comparison.timeframe}
            </p>
            <div className="space-y-3">
              {[comparison.control, comparison.intervention].map(
                (arm, armIndex) => (
                  <div key={armIndex} className="space-y-1">
                    <div className="flex flex-wrap justify-between gap-x-3 text-caption text-text-2">
                      <span>{arm.label}</span>
                      <span className="tabular-nums">
                        {number(arm.events)} {eventUnit(comparison)} /{" "}
                        {number(comparison.denominator)}{" "}
                        {denominatorUnit(comparison)}
                      </span>
                    </div>
                    <svg
                      viewBox="0 0 100 3"
                      className="block w-full"
                      role="img"
                      aria-label={`${arm.label}：每 ${number(comparison.denominator)} ${denominatorUnit(comparison)}发生${comparison.outcome} ${number(arm.events)} ${eventUnit(comparison)}`}
                    >
                      <rect width="100" height="3" className="fill-surface-3" />
                      <rect
                        width={(arm.events / maximum) * 100}
                        height="3"
                        className={
                          armIndex === 1 ? "fill-accent" : "fill-text-3"
                        }
                      />
                    </svg>
                  </div>
                ),
              )}
            </div>
            <div className="flex justify-between text-meta text-text-3">
              <span>0</span>
              <span>
                {comparison.measure === "rate"
                  ? `${number(maximum)} 次 / ${number(comparison.denominator)} 人年`
                  : `${number(maximum)} 人`}
              </span>
            </div>
            {comparison.relativeEffect && (
              <p className="text-caption text-text-2">
                相对效应 · {comparison.relativeEffect}
              </p>
            )}
            {comparison.certainty && (
              <p className="text-caption text-text-2">
                证据确定性 · {comparison.certainty}
              </p>
            )}
            {comparison.note && (
              <p className="whitespace-pre-wrap text-caption leading-relaxed text-text-3">
                {comparison.note}
              </p>
            )}
          </figure>
        );
      })}
      {content.tables?.map((table, index) => (
        <figure key={index} className="min-w-0 space-y-2">
          {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable evidence table must be reachable by keyboard. */}
          <div
            className="overflow-x-auto rounded-card border border-border"
            tabIndex={0}
            role="region"
            aria-label={table.title}
          >
            <table className="w-full text-left text-caption text-text-2">
              <caption className="p-3 text-left text-ui font-medium text-text">
                {table.title}
                <EvidenceReferences
                  evidence={evidence}
                  indexes={table.sourceIndexes}
                />
              </caption>
              <thead className="bg-surface-2">
                <tr>
                  {table.columns.map((column, columnIndex) => (
                    <th
                      scope="col"
                      key={columnIndex}
                      className="p-3 font-medium text-text"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {table.columns.map((_, columnIndex) =>
                      columnIndex === 0 ? (
                        <th
                          scope="row"
                          key={columnIndex}
                          className="p-3 align-top font-medium"
                        >
                          {row[columnIndex] || "—"}
                        </th>
                      ) : (
                        <td
                          key={columnIndex}
                          className="whitespace-pre-wrap p-3 align-top"
                        >
                          {row[columnIndex] || "—"}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
          {table.caption && (
            <figcaption className="whitespace-pre-wrap text-caption leading-relaxed text-text-3">
              {table.caption}
            </figcaption>
          )}
        </figure>
      ))}
      {content.sections?.map((section, index) => (
        <section key={index}>
          <h3 className="mb-2 text-ui font-medium text-text">
            {section.title}
            <EvidenceReferences
              evidence={evidence}
              indexes={section.sourceIndexes}
            />
          </h3>
          <p className="whitespace-pre-wrap text-ui leading-relaxed text-text-2">
            {section.text}
          </p>
        </section>
      ))}
    </>
  );
}
