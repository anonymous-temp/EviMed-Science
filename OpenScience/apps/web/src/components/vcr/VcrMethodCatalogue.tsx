import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { METHOD_FAMILIES, FAMILY_PURPOSES, methodEntries, methodEntryId, methodPurpose, methodTask, methodTitle, type VcrMethod } from "@/lib/vcrMethodDisplay";
import { searchMatches } from "@evimed/domain";

export function VcrMethodCatalogue({ methods, query = "", family = "all", onOpen, onSelectFamily }: { methods: VcrMethod[]; query?: string; family?: string; onOpen: (method: VcrMethod) => void; onSelectFamily?: (family: string) => void }) {
  const entries = methodEntries(methods).filter(method => (family === "all" || family === methodTask(method.method ?? method.id)) && searchMatches(query, [methodTitle(method), method.name, methodTask(method.method ?? method.id), ...Object.values(methodPurpose(method))]));
  if (family === "all" && !query.trim() && onSelectFamily) return <List label="选择计算任务" divided>{METHOD_FAMILIES.map((task, index) => {
    const rows = entries.filter(method => methodTask(method.method ?? method.id) === task);
    return rows.length > 0 ? <ListRow key={task} title={task} onOpen={() => onSelectFamily(task)} meta={<span className="text-caption text-text-2">{FAMILY_PURPOSES[index]} · {rows.length} 个工具</span>} /> : null;
  })}</List>;
  return <div data-vcr-method-catalogue="">{METHOD_FAMILIES.map(task => {
    const rows = entries.filter(method => methodTask(method.method ?? method.id) === task);
    return rows.length > 0 ? <Section key={task} title={task} count={rows.length}><List label={task} divided>{rows.map(method => {
      const text = methodPurpose(method);
      return <ListRow key={methodEntryId(method)} title={methodTitle(method)} titleProps={{ "data-vcr-method": methodEntryId(method) }} onOpen={() => onOpen(method)} meta={<span className="flex flex-col gap-1"><span>{text.purpose}</span><span className="text-caption text-text-3">需要：{text.inputs} · 得到：{text.outputs}</span><span className="text-caption text-accent">{text.action}</span></span>} />;
    })}</List></Section> : null;
  })}</div>;
}
