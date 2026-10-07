import { useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { VCR_RATING_LABELS_ZH, vcrModelRisk } from "@evimed/domain";
import { webErrorMessage } from "@/lib/apiClient";
import { saveVcrModelAssessment, type VcrAssessmentRecord, type VcrAssessments } from "@/lib/vcrClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { FormDialog } from "@/components/ui/FormDialog";
import { IconButton } from "@/components/ui/IconButton";
import { Input, Textarea } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Tag } from "@/components/ui/Tag";

type Rating = "" | "low" | "medium" | "high";
const RATING_OPTIONS: Array<{ value: Rating; label: string }> = [
  { value: "", label: "未评" },
  { value: "low", label: VCR_RATING_LABELS_ZH.low },
  { value: "medium", label: VCR_RATING_LABELS_ZH.medium },
  { value: "high", label: VCR_RATING_LABELS_ZH.high },
];

/** What a row says when nobody has written it yet. */
const NOT_WRITTEN = "未填写";

/** The model's name as a reader says it: the library's Chinese title, and the id only when the library no longer holds the model. */
const modelTitleOf = (record: VcrAssessmentRecord) => record.modelTitle || record.modelName;

/** What a record says in one line when it is folded: the model, and the risk the platform worked out. */
const recordLine = (record: VcrAssessmentRecord) => `${modelTitleOf(record)} · 模型风险 ${record.riskLabel ?? "待评级"}`;

/**
 * 模型评估: each model's assessment record of ICH M15 — the nine elements in the guideline's order, the model risk the platform
 * worked out from the two ratings that drive it, and the one rule that settled it. The AI writes the records while it analyses; the
 * study's lead may edit one, and an edit is the next version of that record by that person. The risk is never typed (the form has
 * no field for it and says why), and a frozen model analysis plan is not touched by an edit: the next freeze lists it.
 *
 * It is a record to check, not the page's result, so it is folded: the line names each model in Chinese with its risk, and the nine
 * rows open under it. `withoutPatients` is the patients tab saying that the assessment is about the models the study already uses
 * (a trial simulation's, say) and that no virtual patients have been generated — the two are different objects.
 */
export function VcrModelAssessments({ studyId, assessments, canEdit, onSaved, withoutPatients = false }: {
  studyId: string;
  assessments: VcrAssessments;
  canEdit: boolean;
  onSaved: () => void;
  withoutPatients?: boolean;
}) {
  const [editing, setEditing] = useState<VcrAssessmentRecord | null>(null);
  if (assessments.records.length === 0) return null;
  return (
    <div data-vcr-assessments="" className="flex flex-col gap-4">
      <Disclosure
        summary={(
          <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="font-medium text-text">{`模型评估 · ${assessments.records.length} 个模型`}</span>
            <span data-vcr-assessments-line="" className="text-caption text-text-3">{assessments.records.map(recordLine).join("；")}</span>
          </span>
        )}
      >
        <div className="flex flex-col gap-4">
          {withoutPatients && <p className="text-ui text-text-2">这些评估写的是本研究已经用到的模型；虚拟患者还没有生成。</p>}
          {assessments.records.map((record) => (
            <AssessmentCard key={record.key} record={record} canEdit={canEdit} onEdit={() => setEditing(record)} />
          ))}
        </div>
      </Disclosure>
      {editing && (
        <EditAssessment
          studyId={studyId}
          record={editing}
          plan={assessments.plan}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onSaved(); }}
        />
      )}
    </div>
  );
}

function AssessmentCard({ record, canEdit, onEdit }: { record: VcrAssessmentRecord; canEdit: boolean; onEdit: () => void }) {
  const writer = record.savedBy ? (record.savedBy.kind === "run" ? "AI 写入" : `${record.savedBy.name ?? "团队成员"} 修改`) : null;
  return (
    <Card
      header={(
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-section font-semibold text-text">{modelTitleOf(record)}</h3>
          <span className="flex-1" />
          {writer && <span className="text-caption text-text-3">{[writer, record.savedAt].filter(Boolean).join(" · ")}</span>}
          {canEdit && <Button size="sm" variant="secondary" onClick={onEdit} aria-label={`编辑模型评估：${modelTitleOf(record)}`}>编辑</Button>}
        </div>
      )}
    >
      <div data-vcr-assessment={record.key}>
        <dl className="divide-y divide-faint">
          {record.rows.map((row) => {
            const body = [row.entry, row.justification].filter(Boolean).join(row.entry && row.justification ? "：" : "");
            return (
              <div key={row.key} data-vcr-assessment-row={row.key} className="grid gap-x-3 gap-y-1 py-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <dt className="text-caption text-text-3">{row.label}</dt>
                <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-ui text-text">
                  {row.rated && (row.ratingLabel
                    ? <Tag>{row.ratingLabel}</Tag>
                    : <span className="text-text-3">{NOT_WRITTEN}</span>)}
                  {row.derived && record.riskRuleText && <span className="text-caption text-text-3">{record.riskRuleText}</span>}
                  {body
                    ? <span className="min-w-0 break-words">{body}</span>
                    : !row.rated && <span className="text-text-3">{NOT_WRITTEN}</span>}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </Card>
  );
}

/** The form's own copy of a record's fields, every text a string. */
function startFrom(record: VcrAssessmentRecord) {
  const fields = record.fields;
  return {
    questionOfInterest: fields.questionOfInterest ?? "", contextOfUse: fields.contextOfUse ?? "",
    influence: (fields.influence ?? "") as Rating, influenceJustification: fields.influenceJustification ?? "",
    consequence: (fields.consequence ?? "") as Rating, consequenceJustification: fields.consequenceJustification ?? "",
    riskJustification: fields.riskJustification ?? "",
    impact: (fields.impact ?? "") as Rating, impactJustification: fields.impactJustification ?? "",
    technicalCriteria: (fields.technicalCriteria ?? []).map((entry) => ({ criterion: entry.criterion ?? "", rationale: entry.rationale ?? "" })),
    appropriateness: fields.appropriateness ?? "", evaluation: fields.evaluation ?? "", outcome: fields.outcome ?? "",
  };
}

function EditAssessment({ studyId, record, plan, onClose, onSaved }: {
  studyId: string;
  record: VcrAssessmentRecord;
  plan: VcrAssessments["plan"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(() => startFrom(record));
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));
  // The risk is the domain's own rule, read live so the person sees what their two ratings make it; it is never sent.
  const derived = vcrModelRisk(form.influence, form.consequence);

  const save = () => {
    if (holding.current) return;
    holding.current = true;
    setBusy(true);
    void saveVcrModelAssessment(studyId, {
      key: record.key,
      ...form,
      // A criterion with no words is a blank line the person left, not a criterion.
      technicalCriteria: form.technicalCriteria.filter((entry) => entry.criterion.trim()),
    })
      .then((saved) => { toast.success(saved?.version ? `已保存为版本 ${saved.version}。` : "已保存。"); onSaved(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这条评估暂时无法保存，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <FormDialog title={`编辑模型评估：${modelTitleOf(record)}`} onClose={onClose} busy={busy}>
      <form data-vcr-assessment-edit="" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <Textarea label="关注的问题" rows={2} value={form.questionOfInterest} onChange={(event) => set("questionOfInterest", event.target.value)} />
        <Textarea label="使用情境" rows={2} value={form.contextOfUse} onChange={(event) => set("contextOfUse", event.target.value)} />

        <RatedField label="模型影响力" rating={form.influence} reason={form.influenceJustification}
          onRating={(value) => set("influence", value)} onReason={(value) => set("influenceJustification", value)} />
        <RatedField label="错误决策的后果" rating={form.consequence} reason={form.consequenceJustification}
          onRating={(value) => set("consequence", value)} onReason={(value) => set("consequenceJustification", value)} />

        <div className="flex flex-col gap-2">
          <p className="text-ui text-text">
            模型风险
            <span data-vcr-assessment-risk="" className="ml-2 font-medium">{derived ? VCR_RATING_LABELS_ZH[derived.risk] : "待评级"}</span>
          </p>
          <p className="text-caption text-text-3">模型风险由影响力和后果两项评级推算，不能直接填写。</p>
          <Textarea label="模型风险的理由" rows={2} value={form.riskJustification} onChange={(event) => set("riskJustification", event.target.value)} />
        </div>

        <RatedField label="模型冲击" rating={form.impact} reason={form.impactJustification}
          onRating={(value) => set("impact", value)} onReason={(value) => set("impactJustification", value)} />

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-ui text-text">技术标准</legend>
          {form.technicalCriteria.map((entry, index) => (
            <div key={index} className="flex items-start gap-2">
              <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                <Input aria-label={`技术标准 ${index + 1}`} value={entry.criterion}
                  onChange={(event) => set("technicalCriteria", form.technicalCriteria.map((item, at) => (at === index ? { ...item, criterion: event.target.value } : item)))} />
                <Input aria-label={`技术标准 ${index + 1} 的理由`} value={entry.rationale}
                  onChange={(event) => set("technicalCriteria", form.technicalCriteria.map((item, at) => (at === index ? { ...item, rationale: event.target.value } : item)))} />
              </div>
              <IconButton icon={Trash2} label={`删除技术标准 ${index + 1}`} size="sm"
                onClick={() => set("technicalCriteria", form.technicalCriteria.filter((_, at) => at !== index))} />
            </div>
          ))}
          <div>
            <Button size="sm" variant="secondary" type="button" onClick={() => set("technicalCriteria", [...form.technicalCriteria, { criterion: "", rationale: "" }])}>
              <Plus aria-hidden="true" className="size-4" />添加一条
            </Button>
          </div>
        </fieldset>

        <Textarea label="所拟用法的适当性" rows={2} value={form.appropriateness} onChange={(event) => set("appropriateness", event.target.value)} />
        <Textarea label="模型与模型结果的评价" rows={2} value={form.evaluation} onChange={(event) => set("evaluation", event.target.value)} />
        <Textarea label="证据评估的结论" rows={2} value={form.outcome} onChange={(event) => set("outcome", event.target.value)} />

        {plan && <p className="text-caption text-text-3">已冻结的模型分析计划不会改动；下次冻结时会列出这次修改。</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" loading={busy} disabled={busy}>保存</Button>
        </div>
      </form>
    </FormDialog>
  );
}

function RatedField({ label, rating, reason, onRating, onReason }: {
  label: string;
  rating: Rating;
  reason: string;
  onRating: (value: Rating) => void;
  onReason: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-ui text-text">{label}</span>
      <SegmentedControl<Rating> aria-label={label} size="sm" value={rating} onChange={onRating} options={RATING_OPTIONS} />
      <Textarea aria-label={`${label}的理由`} rows={2} value={reason} onChange={(event) => onReason(event.target.value)} />
    </div>
  );
}
