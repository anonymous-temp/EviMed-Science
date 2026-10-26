import { useState } from "react";
import { downloadVcrFollowupHistory, getVcrFollowupHistory, type VcrFollowupHistory as History } from "@/lib/vcrClient";
import { formatDateTime } from "@/lib/format";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/cards/EmptyState";
import { FactList } from "@/components/ui/FactList";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { VcrTabSkeleton } from "./VcrStates";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";

/** A folded reader preserves historical observations without an operational workflow. */
export function VcrFollowupHistory({ studyId, canExport }: { studyId: string; canExport: boolean }) {
  const [opened, setOpened] = useState(false);
  return <Disclosure summary="历史观察记录（只读）" onToggle={setOpened}>{opened && <HistoryPage studyId={studyId} canExport={canExport} />}</Disclosure>;
}
function HistoryPage({ studyId, canExport }: { studyId: string; canExport: boolean }) {
  const [offset, setOffset] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const { state, reload } = useVcrLoad(`${studyId}:followup-history:${offset}`, () => getVcrFollowupHistory(studyId, offset));
  if (state.kind === "loading") return <VcrTabSkeleton rows={2} />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const download = () => {
    setDownloading(true);
    void downloadVcrFollowupHistory(studyId, data.page.offset, data.page.limit)
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "本页历史观察暂时无法下载，请稍后重试。" })))
      .finally(() => setDownloading(false));
  };
  return <div className="flex flex-col gap-4">
    {data.notice && <Note action={canExport && data.episodes.length ? <Button size="sm" variant="text" loading={downloading} onClick={download}>下载本页 CSV</Button> : null}>{data.notice}</Note>}
    {!data.episodes.length ? <EmptyState title="没有可读取的历史观察" /> : data.episodes.map(episode => <Episode key={episode.id} episode={episode} />)}
    {(data.page.offset > 0 || data.page.nextOffset !== null) && <div className="flex flex-wrap gap-3">
      <Button variant="secondary" size="sm" disabled={data.page.offset === 0} onClick={() => setOffset(Math.max(0, data.page.offset - data.page.limit))}>上一页历史记录</Button>
      <Button variant="secondary" size="sm" disabled={data.page.nextOffset === null} onClick={() => { if (data.page.nextOffset !== null) setOffset(data.page.nextOffset); }}>下一页历史记录</Button>
    </div>}
  </div>;
}
/** A source date has only its declared precision; only offset-bearing instants are localized. */
const time = (value: string | null) => {
  if (!value) return "未记录";
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return instant && Number.isFinite(Date.parse(value)) ? formatDateTime(value) : value;
};
const valueText = (value: string | number | boolean | null) => value === null ? "未记录" : typeof value === "boolean" ? value ? "是" : "否" : String(value);
function Episode({ episode }: { episode: History["episodes"][number] }) {
  return <Section title={episode.label || "历史观察"} level="sub">
    <FactList rows={[{ label: "患者编号", value: episode.subjectKey }, { label: "观察窗口", value: `${time(episode.windowStart)} 至 ${time(episode.windowEnd)}` }, ...(episode.exitDate ? [{ label: "退出日期", value: time(episode.exitDate) }] : []), ...(episode.exitReason ? [{ label: "退出原因", value: episode.exitReason }] : [])]} />
    {episode.measurements.length > 0 && <DataTable label="保留的历史观察值" rows={episode.measurements.map((row, index) => ({ ...row, key: `${episode.id}:${index}` }))} rowKey={row => row.key} columns={[
      { key: "label", header: "观察项", rowHeader: true, cell: row => row.label },
      { key: "value", header: "取值", cell: row => `${valueText(row.value)}${row.unit ? ` ${row.unit}` : ""}` },
      { key: "at", header: "记录时间", cell: row => time(row.at) },
    ]} />}
  </Section>;
}
