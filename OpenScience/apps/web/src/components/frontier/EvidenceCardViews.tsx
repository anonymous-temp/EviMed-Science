import { useState } from "react";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type {
  EvidenceAbsoluteEffect,
  EvidenceCard,
  EvidenceClinicalView,
  EvidenceFactBox,
  EvidenceFactBoxRow,
  EvidencePublicView,
} from "@/lib/evidenceZoneClient";
import { EvidenceReferences } from "./EvidenceContent";

type ClinicalRow = EvidenceClinicalView["rows"][number];
type Panel = EvidencePublicView["panels"][number];

const number = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
const signed = (value: number) => (value > 0 ? `+${number(value)}` : value < 0 ? `−${number(Math.abs(value))}` : "0");

/** Why a row has no absolute effect, in the words a reader is given. */
const ABSOLUTE_REASON: Record<string, string> = {
  no_comparison: "没有比较数据",
  counts_missing: "缺少事件数或分母",
  events_exceed_denominator: "事件数超过了人数",
  calculation_unverified: "平台计算的回执没有对上这些数字",
};
/** Why the public fact box has no row for a comparison, or none at all. */
export const FACT_BOX_REASON: Record<string, string> = {
  no_comparisons: "这张卡还没有结局比较，所以没有事实框。",
  outcome_role_missing: "比较里没有标明每个结局是获益还是不良反应，所以没有事实框。",
  counts_missing: "比较缺少事件数或分母，所以没有事实框。",
  events_exceed_denominator: "比较里的事件数超过了人数，所以没有事实框。",
  not_per_people: "比较是按人年计的，不能换算成每 1000 人，所以没有事实框。",
  calculation_unverified: "比较里的数字是平台计算的，但引擎回执没有对上这些数字，所以没有事实框。",
  nothing_usable: "没有能放进事实框的比较。",
};

function absoluteText(effect: EvidenceAbsoluteEffect): string {
  return effect.status === "computed"
    ? `${number(effect.control)} → ${number(effect.intervention)}（${signed(effect.difference)}）`
    : (ABSOLUTE_REASON[effect.reason] ?? "无法计算");
}

const columns: DataColumn<ClinicalRow>[] = [
  {
    key: "outcome", header: "结局", rowHeader: true,
    cell: (row) => (
      <span>
        {row.outcome}
        <span className="block text-caption text-text-3">{row.timeframe}</span>
        {row.platformCalculation && <span className="block text-caption text-text-3">{row.platformCalculation.label} · {row.platformCalculation.engine} · {row.platformCalculation.method}</span>}
      </span>
    ),
  },
  { key: "relative", header: "相对效应", cell: (row) => row.relativeEffect ?? "—", isEmpty: (row) => !row.relativeEffect },
  {
    key: "absolute", header: "每 1000 人（对照 → 干预）",
    cell: (row) => (
      <span>
        {absoluteText(row.absoluteEffect)}
        {row.comparator && row.intervention && row.absoluteEffect.status === "computed" && (
          <span className="block text-caption text-text-3">{row.comparator} → {row.intervention}</span>
        )}
      </span>
    ),
  },
  {
    key: "people", header: "受试者 / 研究", align: "right",
    cell: (row) => [row.participants != null ? `${row.participants.toLocaleString("zh-CN")} 人` : null, row.studies != null ? `${row.studies} 项研究` : null].filter(Boolean).join(" / ") || "—",
    isEmpty: (row) => row.participants == null && row.studies == null,
  },
  { key: "certainty", header: "证据确定性", cell: (row) => row.certainty ?? "—", isEmpty: (row) => !row.certainty },
];

/** The GRADE summary-of-findings table, one row to an outcome; every absolute figure is the server's arithmetic. */
export function EvidenceClinicalTable({ evidence, view }: { evidence: EvidenceCard; view: EvidenceClinicalView }) {
  return (
    <div className="space-y-3">
      {view.population && <p className="text-ui text-text-2">适用人群 · {view.population}</p>}
      <DataTable
        label="结局总结表"
        columns={columns}
        rows={view.rows}
        rowKey={(row) => row.title}
        minWidth="min-w-0"
        emptyText="这张卡还没有结局比较。"
        footnote={view.rows.length ? "绝对效应按每 1000 人计，由事件数和分母算出。" : undefined}
      />
      {(view.withheldCalculations?.length ?? 0) > 0 && (
        <p className="text-caption text-verify-pending">有 {view.withheldCalculations?.length} 条平台计算的结论没有对上引擎回执，没有列出。</p>
      )}
      {view.rows.some((row) => row.sourceIndexes.length > 0) && (
        <p className="text-caption text-text-3">
          数据来源
          <EvidenceReferences evidence={evidence} indexes={view.rows.flatMap((row) => row.sourceIndexes)} />
        </p>
      )}
    </div>
  );
}

function FactBoxGroup({ title, rows }: { title: string; rows: EvidenceFactBoxRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="space-y-1">
      <h4 className="text-ui font-medium text-text">{title}</h4>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.index} className="text-ui text-text-2">
            {row.outcome}（{row.timeframe}）：{row.control.label} {number(row.control.per1000)}，{row.intervention.label} {number(row.intervention.per1000)}
            <span className="text-text-3">（{signed(row.difference)}）</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Per 1000 people, one denominator for both arms; when the card cannot make one, the reason, never an empty box. */
export function EvidenceFactBoxView({ factBox }: { factBox: EvidenceFactBox }) {
  if (factBox.status !== "available") {
    return <p className="text-ui text-text-2">{(factBox.reason && FACT_BOX_REASON[factBox.reason]) ?? FACT_BOX_REASON.nothing_usable}</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-ui font-medium text-text">每 1000 人里</p>
      <FactBoxGroup title="获益" rows={factBox.benefits} />
      <FactBoxGroup title="不良反应" rows={factBox.harms} />
      {factBox.excluded.length > 0 && <p className="text-caption text-text-3">另有 {factBox.excluded.length} 个结局没有放进事实框。</p>}
    </div>
  );
}

function PanelBlock({ panel }: { panel: Panel }) {
  if (panel.status !== "written") return null;
  if (panel.key === "sourcesAndCheckDate") {
    return (
      <section className="space-y-1">
        <h4 className="text-ui font-medium text-text">{panel.label}</h4>
        <ul className="text-ui text-text-2">
          {(panel.sources ?? []).map((source, index) => <li key={index}>{source.title}</li>)}
        </ul>
        {panel.checkedAt && <p className="text-caption text-text-3">核对于 {panel.checkedAt.slice(0, 10)}</p>}
      </section>
    );
  }
  if (panel.key === "commonMisunderstandings") {
    return (
      <section className="space-y-2">
        <h4 className="text-ui font-medium text-text">{panel.label}</h4>
        <ul className="space-y-2">
          {(panel.items ?? []).map((item, index) => (
            <li key={index} className="text-ui text-text-2">
              <span className="text-text">误解：{item.misunderstanding}</span>
              <span className="block">实际：{item.correction}</span>
              <TraceMark traced={item.traced} />
            </li>
          ))}
        </ul>
      </section>
    );
  }
  return (
    <section className="space-y-1">
      <h4 className="text-ui font-medium text-text">{panel.label}</h4>
      <p className="whitespace-pre-wrap text-ui leading-relaxed text-text-2">{panel.text}</p>
      <TraceMark traced={panel.traced === true} />
    </section>
  );
}

/** Whether a plain-language sentence rests on claims whose quotations were all found. */
function TraceMark({ traced }: { traced: boolean }) {
  return traced
    ? <span className="text-caption text-verify-ok">✓ 对应已核验的结论</span>
    : <span className="text-caption text-verify-pending">⚠ 没有对应到已核验的结论</span>;
}

/** The public layout: the panels the author wrote, then the fact box. */
export function EvidencePublicLayout({ view }: { view: EvidencePublicView }) {
  const written = view.panels.filter((panel) => panel.status === "written" && panel.key !== "sourcesAndCheckDate");
  return (
    <div className="space-y-4">
      {written.length === 0 && <p className="text-ui text-text-2">作者还没有写公众版内容。</p>}
      {view.panels.map((panel) => <PanelBlock key={panel.key} panel={panel} />)}
      {(view.calculations?.length ?? 0) > 0 && (
        <section className="space-y-1">
          <h4 className="text-ui font-medium text-text">平台计算</h4>
          <ul className="space-y-1">
            {view.calculations?.map((entry) => (
              <li key={entry.claimId} className="text-ui text-text-2">
                {entry.text}
                <span className="block text-caption text-text-3">{entry.engine} · {entry.method} · 回执 {entry.receiptId}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-2">
        <h4 className="text-ui font-medium text-text">事实框</h4>
        <EvidenceFactBoxView factBox={view.factBox} />
      </section>
    </div>
  );
}

/** Whether either view has anything to show; a card with no comparison and no public text draws neither. */
export function evidenceViewsHaveContent(views: EvidenceCard["views"]): boolean {
  if (!views) return false;
  return views.clinical.rows.length > 0 || views.public.panels.some((panel) => panel.status === "written" && panel.key !== "sourcesAndCheckDate") || views.public.factBox.status === "available";
}

/** 临床版 / 公众版: two readings of the same verified claims, switched by the reader. */
export function EvidenceCardViews({ evidence }: { evidence: EvidenceCard }) {
  const [which, setWhich] = useState<"clinical" | "public">("clinical");
  const views = evidence.views;
  if (!views || !evidenceViewsHaveContent(views)) return null;
  return (
    <section className="space-y-3" aria-label="证据卡视图">
      <SegmentedControl
        aria-label="证据卡视图"
        size="sm"
        value={which}
        onChange={setWhich}
        options={[{ value: "clinical", label: "临床版" }, { value: "public", label: "公众版" }]}
      />
      {which === "clinical"
        ? <EvidenceClinicalTable evidence={evidence} view={views.clinical} />
        : <EvidencePublicLayout view={views.public} />}
    </section>
  );
}
