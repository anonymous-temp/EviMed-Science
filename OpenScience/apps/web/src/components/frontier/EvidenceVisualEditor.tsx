import { Button } from "@/components/ui/Button";
import { Input, Textarea, inputClasses } from "@/components/ui/Input";
import type { EvidenceContent } from "@/lib/evidenceZoneClient";
import { useEffect, useState } from "react";

const sourceIndexes = (value: string) => [
  ...new Set(
    value
      .split(/[,，\s]+/)
      .map(Number)
      .filter((index) => Number.isInteger(index) && index > 0),
  ),
];
function SourceIndexesInput({
  label,
  indexes,
  onChange,
  sourceCount,
}: {
  label: string;
  indexes: number[];
  onChange: (indexes: number[]) => void;
  sourceCount: number;
}) {
  const canonical = indexes.join(", ");
  const [draft, setDraft] = useState(canonical);
  useEffect(() => setDraft(canonical), [canonical]);
  return (
    <Input
      label={label}
      value={draft}
      placeholder={`1 至 ${sourceCount}，多个来源用逗号分隔`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onChange(sourceIndexes(draft))}
    />
  );
}

export function EvidenceVisualEditor({
  content,
  onChange,
  sourceCount,
}: {
  content: EvidenceContent;
  onChange: (content: EvidenceContent) => void;
  sourceCount: number;
}) {
  const comparisons = content.comparisons || [];
  const tables = content.tables || [];
  const sections = content.sections || [];
  const comparison = (
    index: number,
    patch: Partial<NonNullable<EvidenceContent["comparisons"]>[number]>,
  ) =>
    onChange({
      ...content,
      comparisons: comparisons.map((item, at) =>
        at === index ? { ...item, ...patch } : item,
      ),
    });
  const table = (
    index: number,
    patch: Partial<NonNullable<EvidenceContent["tables"]>[number]>,
  ) =>
    onChange({
      ...content,
      tables: tables.map((item, at) =>
        at === index ? { ...item, ...patch } : item,
      ),
    });
  return (
    <div className="space-y-4">
      {sections.map((item, index) => (
        <fieldset key={index} className="space-y-3 border-t border-border pt-3">
          <legend className="text-ui font-medium text-text">
            解读段落 {index + 1}
          </legend>
          <Input
            label={`段落 ${index + 1} 标题`}
            maxLength={300}
            value={item.title}
            onChange={(event) =>
              onChange({
                ...content,
                sections: sections.map((section, at) =>
                  at === index
                    ? { ...section, title: event.target.value }
                    : section,
                ),
              })
            }
          />
          <Textarea
            label={`段落 ${index + 1} 内容`}
            maxLength={12000}
            value={item.text}
            onChange={(event) =>
              onChange({
                ...content,
                sections: sections.map((section, at) =>
                  at === index
                    ? { ...section, text: event.target.value }
                    : section,
                ),
              })
            }
          />
          <SourceIndexesInput
            label={`段落 ${index + 1} 来源编号`}
            indexes={item.sourceIndexes || []}
            sourceCount={sourceCount}
            onChange={(indexes) =>
              onChange({
                ...content,
                sections: sections.map((section, at) =>
                  at === index
                    ? { ...section, sourceIndexes: indexes }
                    : section,
                ),
              })
            }
          />
          <Button
            variant="text"
            size="sm"
            onClick={() =>
              onChange({
                ...content,
                sections: sections.filter((_, at) => at !== index),
              })
            }
          >
            移除此段落
          </Button>
        </fieldset>
      ))}
      {comparisons.map((item, index) => (
        <fieldset key={index} className="space-y-3 border-t border-border pt-3">
          <legend className="text-ui font-medium text-text">
            绝对效应图 {index + 1}
          </legend>
          <Input
            label={`图 ${index + 1} 标题`}
            value={item.title}
            maxLength={300}
            onChange={(event) =>
              comparison(index, { title: event.target.value })
            }
          />
          <Input
            label={`图 ${index + 1} 结局`}
            value={item.outcome}
            maxLength={300}
            onChange={(event) =>
              comparison(index, { outcome: event.target.value })
            }
          />
          <label className="block text-ui text-text">
            图 {index + 1} 数值类型
            <select
              className={inputClasses({ className: "mt-2" })}
              value={item.measure || "risk"}
              onChange={(event) =>
                comparison(index, {
                  measure: event.target.value as "risk" | "rate",
                  denominatorUnit:
                    event.target.value === "rate" ? "person-years" : "people",
                })
              }
            >
              <option value="risk">观察期内的发生比例（人）</option>
              <option value="rate">按人年计算的发生率（人年）</option>
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label={`图 ${index + 1} 统一分母（${item.measure === "rate" ? "人年" : "人数"}）`}
              type="number"
              min={1}
              max={1000000000}
              step="any"
              value={item.denominator}
              onChange={(event) =>
                comparison(index, { denominator: Number(event.target.value) })
              }
            />
            <Input
              label={`图 ${index + 1} 观察时间`}
              value={item.timeframe}
              maxLength={300}
              onChange={(event) =>
                comparison(index, { timeframe: event.target.value })
              }
            />
            <Input
              label={`图 ${index + 1} 对照方案`}
              value={item.control.label}
              maxLength={300}
              onChange={(event) =>
                comparison(index, {
                  control: { ...item.control, label: event.target.value },
                })
              }
            />
            <Input
              label={`图 ${index + 1} 对照发生${item.measure === "rate" ? "次数" : "人数"}`}
              type="number"
              min={0}
              max={item.measure === "rate" ? undefined : item.denominator}
              step="any"
              value={item.control.events}
              onChange={(event) =>
                comparison(index, {
                  control: {
                    ...item.control,
                    events: Number(event.target.value),
                  },
                })
              }
            />
            <Input
              label={`图 ${index + 1} 比较方案`}
              value={item.intervention.label}
              maxLength={300}
              onChange={(event) =>
                comparison(index, {
                  intervention: {
                    ...item.intervention,
                    label: event.target.value,
                  },
                })
              }
            />
            <Input
              label={`图 ${index + 1} 比较发生${item.measure === "rate" ? "次数" : "人数"}`}
              type="number"
              min={0}
              max={item.measure === "rate" ? undefined : item.denominator}
              step="any"
              value={item.intervention.events}
              onChange={(event) =>
                comparison(index, {
                  intervention: {
                    ...item.intervention,
                    events: Number(event.target.value),
                  },
                })
              }
            />
          </div>
          <Input
            label={`图 ${index + 1} 相对效应与区间`}
            value={item.relativeEffect || ""}
            maxLength={1000}
            onChange={(event) =>
              comparison(index, { relativeEffect: event.target.value })
            }
          />
          <Input
            label={`图 ${index + 1} 证据确定性`}
            value={item.certainty || ""}
            maxLength={1000}
            onChange={(event) =>
              comparison(index, { certainty: event.target.value })
            }
          />
          <SourceIndexesInput
            label={`图 ${index + 1} 来源编号`}
            indexes={item.sourceIndexes}
            sourceCount={sourceCount}
            onChange={(indexes) =>
              comparison(index, { sourceIndexes: indexes })
            }
          />
          <Textarea
            label={`图 ${index + 1} 数据说明`}
            value={item.note || ""}
            maxLength={12000}
            onChange={(event) =>
              comparison(index, { note: event.target.value })
            }
          />
          <Button
            variant="text"
            size="sm"
            onClick={() =>
              onChange({
                ...content,
                comparisons: comparisons.filter((_, at) => at !== index),
              })
            }
          >
            移除此图
          </Button>
        </fieldset>
      ))}
      {tables.map((item, index) => (
        <fieldset key={index} className="space-y-3 border-t border-border pt-3">
          <legend className="text-ui font-medium text-text">
            证据表 {index + 1}
          </legend>
          <Input
            label={`表 ${index + 1} 标题`}
            value={item.title}
            maxLength={300}
            onChange={(event) => table(index, { title: event.target.value })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            {item.columns.map((column, columnIndex) => (
              <Input
                key={columnIndex}
                label={`表 ${index + 1} 列 ${columnIndex + 1} 标题`}
                value={column}
                maxLength={300}
                onChange={(event) =>
                  table(index, {
                    columns: item.columns.map((value, at) =>
                      at === columnIndex ? event.target.value : value,
                    ),
                  })
                }
              />
            ))}
          </div>
          {item.rows.map((row, rowIndex) => (
            <div key={rowIndex} className="space-y-2">
              <div className="grid gap-3 sm:grid-cols-2">
                {item.columns.map((column, columnIndex) => (
                  <Textarea
                    key={columnIndex}
                    label={`表 ${index + 1} 行 ${rowIndex + 1} · ${column || `列 ${columnIndex + 1}`}`}
                    value={row[columnIndex] || ""}
                    maxLength={3000}
                    onChange={(event) =>
                      table(index, {
                        rows: item.rows.map((value, at) =>
                          at === rowIndex
                            ? item.columns.map((_, cell) =>
                                cell === columnIndex
                                  ? event.target.value
                                  : value[cell] || "",
                              )
                            : value,
                        ),
                      })
                    }
                  />
                ))}
              </div>
              <Button
                variant="text"
                size="sm"
                onClick={() =>
                  table(index, {
                    rows: item.rows.filter((_, at) => at !== rowIndex),
                  })
                }
              >
                移除行 {rowIndex + 1}
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={item.rows.length >= 30}
              onClick={() =>
                table(index, {
                  rows: [...item.rows, item.columns.map(() => "")],
                })
              }
            >
              添加行
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={item.columns.length >= 8}
              onClick={() =>
                table(index, {
                  columns: [...item.columns, ""],
                  rows: item.rows.map((row) => [...row, ""]),
                })
              }
            >
              添加列
            </Button>
            <Button
              variant="text"
              size="sm"
              onClick={() =>
                onChange({
                  ...content,
                  tables: tables.filter((_, at) => at !== index),
                })
              }
            >
              移除此表
            </Button>
          </div>
          <SourceIndexesInput
            label={`表 ${index + 1} 来源编号`}
            indexes={item.sourceIndexes}
            sourceCount={sourceCount}
            onChange={(indexes) => table(index, { sourceIndexes: indexes })}
          />
          <Textarea
            label={`表 ${index + 1} 表注`}
            value={item.caption || ""}
            maxLength={12000}
            onChange={(event) => table(index, { caption: event.target.value })}
          />
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={sections.length >= 30}
          onClick={() =>
            onChange({
              ...content,
              sections: [
                ...sections,
                { title: "", text: "", sourceIndexes: [] },
              ],
            })
          }
        >
          添加解读段落
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={comparisons.length >= 8}
          onClick={() =>
            onChange({
              ...content,
              comparisons: [
                ...comparisons,
                {
                  title: "",
                  outcome: "",
                  denominator: 100,
                  timeframe: "",
                  control: { label: "", events: 0 },
                  intervention: { label: "", events: 0 },
                  sourceIndexes: [],
                },
              ],
            })
          }
        >
          添加绝对效应图
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={tables.length >= 8}
          onClick={() =>
            onChange({
              ...content,
              tables: [
                ...tables,
                {
                  title: "",
                  columns: ["结局", "证据结果", "解释"],
                  rows: [["", "", ""]],
                  sourceIndexes: [],
                },
              ],
            })
          }
        >
          添加证据表
        </Button>
      </div>
    </div>
  );
}

/** Removing a source never silently retargets an existing figure to another paper. */
export function removeEvidenceSource(
  content: EvidenceContent | null | undefined,
  removedIndex: number,
) {
  if (!content) return content;
  const remap = (indexes: number[] = []) =>
    indexes
      .filter((index) => index !== removedIndex)
      .map((index) => (index > removedIndex ? index - 1 : index));
  return {
    ...content,
    sections: content.sections?.map((section) => ({
      ...section,
      sourceIndexes: remap(section.sourceIndexes),
    })),
    tables: content.tables?.map((table) => ({
      ...table,
      sourceIndexes: remap(table.sourceIndexes),
    })),
    comparisons: content.comparisons?.map((comparison) => ({
      ...comparison,
      sourceIndexes: remap(comparison.sourceIndexes),
    })),
  };
}
