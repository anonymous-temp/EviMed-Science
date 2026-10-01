import { useRef, useState } from "react";
import { registerVcrSource, type VcrIntake, type VcrIntakeSeal } from "@/lib/vcrClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input, inputClasses } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";
import { VcrFacts, VcrSection } from "../vcrTabKit";
import { SourceCard } from "./SourceCard";
import { intakeErrorMessage } from "./intakeState";

/**
 * 结局封存: the two timestamps that make 「事先规定」 provable — when the
 * analysis plan was frozen, and when an outcome column was first read. Under a
 * confirmatory intended use the outcome columns are sealed at freeze and
 * unreadable to the engine and to the run until the plan is frozen; under an
 * exploratory use nothing is sealed and the package says so. The order of the
 * two times is what the study package prints on its cover (plan §6.5).
 */
export function SealNote({ seal }: { seal: VcrIntakeSeal }) {
  const rows = [
    { label: "分析计划冻结", value: seal.planFrozenAt ?? "尚未冻结" },
    { label: "结局首次读取", value: seal.outcomeFirstReadAt ?? "尚未读取" },
  ];
  return (
    <div data-vcr-seal="" className="rounded-card border border-border bg-surface-1 p-3">
      <p className="flex flex-wrap items-center gap-2 text-ui text-text">
        <span className="font-medium">结局封存</span>
        <Tag tone={seal.required && !seal.planFrozenAt ? "warn" : "neutral"}>
          {!seal.required ? "探索性：不封存" : seal.planFrozenAt ? "已解除" : "封存中"}
        </Tag>
        {seal.planFrozenAt && seal.outcomeFirstReadAt && !seal.ordered && <Tag tone="warn">结局先于计划冻结被读取</Tag>}
      </p>
      <VcrFacts rows={rows} className="mt-1" />
      {seal.note && <p className="mt-1 text-caption text-text-3">{seal.note}</p>}
      {seal.fieldsRead.length > 0 && <p className="mt-1 text-caption text-text-3">{`已读取的结局列：${seal.fieldsRead.join("、")}`}</p>}
    </div>
  );
}

const USES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "vcr", label: "虚拟临研分析" }, { value: "matching", label: "匹配与招募" },
];

/** 登记数据源: whose data it is, what it may be used for, what window of it is visible, how long it is kept. */
function RegisterSource({ studyId, options, onChanged }: { studyId: string; options: VcrIntake["options"]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [party, setParty] = useState("");
  const [uses, setUses] = useState<string[]>(["vcr"]);
  const [valueSource, setValueSource] = useState("observed");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const valid = name.trim() !== "" && uses.length > 0;

  const submit = () => {
    if (!valid || holding.current) return;
    holding.current = true;
    setBusy(true);
    registerVcrSource(studyId, {
      name, ownerParty: party, allowedUses: uses, valueSource: valueSource as "observed",
      ...(from || to ? { visibleWindow: { ...(from ? { start: from } : {}), ...(to ? { end: to } : {}) } } : {}),
      ...(until ? { retention: { until } } : {}),
    })
      .then(() => { toast.success("已登记数据源。"); setName(""); setParty(""); onChanged(); })
      .catch((error: unknown) => toast.error(intakeErrorMessage(error, "数据源暂时无法登记，请稍后重试。")))
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <Card title="登记数据源">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Input label="名称" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 合作方基线导出" maxLength={80} />
        <Input label="数据方" value={party} onChange={(event) => setParty(event.target.value)} placeholder="谁的数据" maxLength={80} />
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-ui font-medium text-text">允许的用途</legend>
          <div className="flex flex-wrap gap-4">
            {USES.map((use) => (
              <label key={use.value} className="flex items-center gap-2 text-ui text-text-2">
                <input
                  type="checkbox" checked={uses.includes(use.value)}
                  onChange={(event) => setUses((current) => (event.target.checked ? [...current, use.value] : current.filter((each) => each !== use.value)))}
                />
                {use.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor="vcr-source-value-source" className="mb-2 block text-ui font-medium text-text">值的来源</label>
          <select id="vcr-source-value-source" value={valueSource} onChange={(event) => setValueSource(event.target.value)} className={inputClasses()}>
            {options.valueSources.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <Input label="保留至" type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
        <Input label="可见时间：起" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        <Input label="可见时间：止" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        <div className="flex justify-end sm:col-span-2">
          <Button type="submit" loading={busy} disabled={!valid || busy}>登记</Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * 数据接入: the whole way from a file the researcher holds to the tables the
 * engine reads — source, files, field map, snapshot, tables, grants — and the
 * seal that keeps the outcomes closed until the plan is frozen. Patient-level
 * rows never come back to this page: it shows structure, counts and states.
 */
export function IntakePanel({ studyId, intake, onChanged }: { studyId: string; intake: VcrIntake; onChanged: () => void }) {
  if (!intake.available) {
    return (
      <VcrSection title="数据接入">
        <p data-vcr-intake-unavailable="" className="text-ui text-text-3">{intake.message ?? "本部署未接入数据平面，暂不能接入患者级数据。"}</p>
      </VcrSection>
    );
  }
  return (
    <VcrSection title="数据接入" meta={intake.sources.length ? `${intake.sources.length} 个数据源` : undefined}>
      <div data-vcr-intake="" className="flex flex-col gap-4">
        {intake.seal && (intake.seal.required || intake.seal.planFrozenAt || intake.seal.outcomeFirstReadAt) && <SealNote seal={intake.seal} />}
        {intake.sources.length === 0 && (
          <p className="text-ui text-text-3">
            {intake.canManage ? "还没有数据源。登记一个，再上传文件、说明每一列是什么，冻结成快照后引擎才能读取。" : "这个研究还没有数据源。"}
          </p>
        )}
        {intake.sources.map((source) => (
          <SourceCard
            key={source.id} studyId={studyId} source={source} snapshots={intake.snapshots}
            options={intake.options} canManage={intake.canManage} onChanged={onChanged}
          />
        ))}
        {intake.canManage && (
          intake.sources.length === 0
            ? <RegisterSource studyId={studyId} options={intake.options} onChanged={onChanged} />
            : <Disclosure summary="登记另一个数据源"><RegisterSource studyId={studyId} options={intake.options} onChanged={onChanged} /></Disclosure>
        )}
      </div>
    </VcrSection>
  );
}
