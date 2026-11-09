import type { VcrPeopleRecord } from "@/lib/vcrClient";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { numberText } from "./vcrText";

/**
 * 虚拟患者记录: the records of virtual people this study holds, each with how many people it holds, what its covariates came from, whether it was made for
 * the model as it is now, how many of its people lie outside the range the model was fitted on, and which comparisons ran on it.
 *
 * Hidden knowledge:
 *  - **A record is not a patient set.** Its people are drawn once from a published model's population level and are not real persons; a run on it
 *    is conditional on the one study it was made in. Nothing in this list is a patient's, so there is no row to open.
 *  - **The list says only what the record says of itself.** "为更早的一版模型造的" and the out-of-range count are the engine's own report of the
 *    record, shown here because a run on it carries them into its premises and the person should see them where the record is.
 * Component: VcrPeopleRecords; owner: VCR; rules: DESIGN.md patients tab, one object per section.
 * Anatomy: Section with one line per record and its tags.
 * Variants: none (the section is absent when the study has no record).
 * States: static; the page's own reload refreshes it.
 * Hit area: none; nothing here is pressed.
 * Keyboard: native list.
 * Long content: lines wrap.
 * Theme: shared section and tag.
 * Responsive: one column.
 * Verification: VcrPeopleRecords.test.tsx.
 */
export function VcrPeopleRecords({ records }: { records: readonly VcrPeopleRecord[] }) {
  if (records.length === 0) return null;
  return (
    <Section title="虚拟患者记录" count={numberText(records.length, 0)}>
      <ul data-vcr-people-records="" className="flex flex-col gap-4">
        {records.map((record) => {
          const facts: Fact[] = [
            { label: "怎么来的", value: record.source },
            { label: "为哪个模型造的", value: record.madeFor },
            ...(record.outside ? [{ label: "超出拟合范围", value: `${numberText(record.outside.people, 0)} 个人的基线 MMSE 在模型拟合所用试验的入组范围${record.outside.range?.length === 2 ? `（${record.outside.range[0]}–${record.outside.range[1]} 分）` : ""}之外，他们的结果是外推。` }] : []),
            { label: "用在", value: record.usedBy.length ? record.usedBy.join("；") : "还没有比较用到它" },
          ];
          return (
            <li key={record.id} data-vcr-people-record="" className="flex flex-col gap-2">
              <span className="flex flex-wrap items-center gap-2 text-ui text-text">
                <span>{`${numberText(record.people, 0)} 个虚拟患者`}</span>
                {!record.current && <Tag tone="warn">为更早的模型造的</Tag>}
                {record.outside && <Tag tone="warn">{`${numberText(record.outside.people, 0)} 人超出拟合范围`}</Tag>}
              </span>
              <FactList rows={facts} />
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
