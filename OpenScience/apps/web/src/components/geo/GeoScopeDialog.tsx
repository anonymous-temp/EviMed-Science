import { useState, type FormEvent } from "react";
import { getGeoQuestions, type GeoProject } from "@/lib/geoClient";
import { geoReadScopeQuery, type GeoReadScope } from "@/lib/geoReadScope";
import { Button } from "@/components/ui/Button";
import { FilterChip } from "@/components/ui/FilterChips";
import { FormDialog } from "@/components/ui/FormDialog";
import { Input, Select } from "@/components/ui/Input";
import { useGeoLoad } from "./geoProjectData";
import { engineName, GEO_POOL_KINDS } from "./geoText";

/** A view preference, not a project mutation or a new measurement request. */
export function GeoScopeDialog({ geoId, project, initial = {}, onApply, onClose }: {
  geoId: string; project: GeoProject; initial?: GeoReadScope;
  onApply(scope: GeoReadScope): void; onClose(): void;
}) {
  const [scope, setScope] = useState<GeoReadScope>(initial);
  const [error, setError] = useState("");
  const questions = useGeoLoad(`scope-questions:${geoId}:${scope.questionVersion ?? "latest"}`, () => getGeoQuestions(geoId, scope.questionVersion));
  const selectedQuestions = useGeoLoad(`scope-selected-questions:${geoId}:${geoReadScopeQuery(initial)}`, () => initial.groupIds?.length || initial.selectionRef
    ? getGeoQuestions(geoId, initial.selectionRef ? { selectionRef: initial.selectionRef } : initial) : Promise.resolve(null));
  const data = questions.state.kind === "ready" ? questions.state.data : null;
  const engines = [...new Set([...project.engines, ...(scope.engines ?? [])])];
  const knownGroups = [...new Map([
    ...(selectedQuestions.state.kind === "ready" ? selectedQuestions.state.data?.groups ?? [] : []), ...(data?.groups ?? []),
  ].map(group => [group.id, group])).values()];
  const groups = [...knownGroups, ...(scope.groupIds ?? []).filter(id => !knownGroups.some(group => group.id === id))
    .map((id, index) => ({ id, name: `已选择的问题群 ${index + 1}`, typicalQuestion: "" }))];
  const tags = [...new Set([...(scope.clientTags ?? []), ...knownGroups.flatMap(group => group.questions.flatMap(question => question.clientTags ?? []))])].sort();
  const field = (key: "from" | "to" | "compareFrom" | "compareTo" | "timeZone", value: string) => {
    setError(""); setScope(current => ({ ...current, [key]: value || undefined, round: undefined, selectionRef: undefined }));
  };
  const toggle = (key: "engines" | "pools" | "groupIds" | "clientTags", value: string) => setScope(current => ({ ...current, selectionRef: undefined,
    [key]: current[key]?.includes(value) ? current[key]?.filter(item => item !== value) : [...(current[key] ?? []), value] }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (scope.from && scope.to && scope.from > scope.to || scope.compareFrom && scope.compareTo && scope.compareFrom > scope.compareTo) {
      setError("开始日期不能晚于结束日期。"); return;
    }
    if (Boolean(scope.compareFrom) !== Boolean(scope.compareTo)) { setError("请填写完整的对比区间。 "); return; }
    try { new Intl.DateTimeFormat("zh-CN", { timeZone: scope.timeZone || "Asia/Shanghai" }); }
    catch { setError("请填写有效时区，例如 Asia/Shanghai。"); return; }
    onApply({ ...scope, selectionRef: undefined });
  };
  return <FormDialog title="分析范围" onClose={onClose}>
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <div className="grid grid-cols-2 gap-3">
        <Input label="回答开始日期" type="date" value={scope.from ?? ""} onChange={event => field("from", event.target.value)} />
        <Input label="回答结束日期" type="date" value={scope.to ?? ""} onChange={event => field("to", event.target.value)} />
        <Input label="对比开始日期" type="date" value={scope.compareFrom ?? ""} onChange={event => field("compareFrom", event.target.value)} />
        <Input label="对比结束日期" type="date" value={scope.compareTo ?? ""} onChange={event => field("compareTo", event.target.value)} />
      </div>
      {(scope.compareFrom || scope.compareTo) && <Select label="对比方式" value={scope.comparisonMode ?? "common"}
        onChange={event => setScope(current => ({ ...current, comparisonMode: event.target.value as "common" | "separate" }))}>
        <option value="common">同一批问题与平台</option><option value="separate">分别查看两个区间</option>
      </Select>}
      <Input label="日期时区" value={scope.timeZone ?? "Asia/Shanghai"} onChange={event => field("timeZone", event.target.value)} />
      <fieldset><legend className="mb-2 text-ui">AI 平台（不选即全部）</legend><div className="flex flex-wrap gap-1">
        {engines.map(engine => <FilterChip key={engine} pressed={scope.engines?.includes(engine) ?? false} onClick={() => toggle("engines", engine)}>{engineName(engine)}</FilterChip>)}
      </div></fieldset>
      <fieldset><legend className="mb-2 text-ui">问句池（不选即全部）</legend><div className="flex flex-wrap gap-1">
        {Object.entries(GEO_POOL_KINDS).map(([value, label]) => <FilterChip key={value} pressed={scope.pools?.includes(value) ?? false} onClick={() => toggle("pools", value)}>{label}</FilterChip>)}
      </div></fieldset>
      {data?.sets.length ? <Select label="题库版本" value={scope.questionVersion ?? ""} onChange={event => setScope(current => ({ ...current,
        questionVersion: event.target.value ? Number(event.target.value) : undefined, groupIds: [], selectionRef: undefined }))}>
        <option value="">按所选观察的题库</option>{data.sets.map(set => <option key={set.version} value={set.version}>第 {set.version} 版</option>)}
      </Select> : null}
      {groups.length > 0 && <fieldset><legend className="mb-2 text-ui">问题群（不选即全部）</legend><div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
        {groups.map(group => <FilterChip key={group.id} pressed={scope.groupIds?.includes(group.id) ?? false} onClick={() => toggle("groupIds", group.id)}>{group.name || group.typicalQuestion}</FilterChip>)}
      </div></fieldset>}
      {tags.length > 0 && <fieldset><legend className="mb-2 text-ui">原表标签（不选即全部）</legend><div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
        {tags.map(tag => <FilterChip key={tag} pressed={scope.clientTags?.includes(tag) ?? false} onClick={() => toggle("clientTags", tag)}>{tag}</FilterChip>)}
      </div></fieldset>}
      {questions.state.kind === "error" && <Button variant="text" size="sm" onClick={questions.reload}>重试读取题库选项</Button>}
      {error && <p role="alert" className="text-ui text-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="text" onClick={() => onApply({})}>重置范围</Button>
        <Button variant="secondary" onClick={onClose}>取消</Button><Button type="submit">应用范围</Button>
      </div>
    </form>
  </FormDialog>;
}
